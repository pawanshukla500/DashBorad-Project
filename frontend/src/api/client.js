import axios from 'axios';
import { auth } from './firebase';

const api = axios.create({
  baseURL: `${import.meta.env.VITE_API_BASE_URL || ''}/api`.replace(/([^:]\/)\/+/g, '$1'),
});

// Financial reports are read many times while a user moves between workspaces.
// Keep a very short, per-Firebase-user cache in memory so the browser can reuse
// a response from (for example) Dashboard on Sales, while still revalidating on
// focus and immediately clearing after a successful write.  This is deliberately
// not localStorage: report data must disappear on reload/sign-out and never be
// shared between browser users.
const READ_CACHE_TTL_MS = 12_000;
const readCache = new Map();
const inFlightReads = new Map();
const readVersions = new Map();
let readCacheGeneration = 0;

function stableSerialize(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function cloneCachedData(data) {
  // API responses are JSON. Cloning prevents one screen from mutating the
  // shared cached object that another screen will render.
  return typeof structuredClone === 'function' ? structuredClone(data) : data;
}

function cacheScope() {
  return auth.currentUser?.uid || 'anonymous';
}

function isCacheableRead(config = {}) {
  return config.cache !== false && !config.responseType;
}

function readCacheKey(url, config = {}) {
  const params = { ...(config.params || {}) };
  delete params._refresh;
  return `${cacheScope()}|${url}|${stableSerialize(params)}`;
}

export function invalidateApiReadCache() {
  // Keep an invalidation generation even though the per-key version map is
  // cleared. Otherwise a pre-invalidation request and a new request for the
  // same key can both be version 0, allowing the old response to re-cache
  // financial data after a refresh or write.
  readCacheGeneration += 1;
  readCache.clear();
  inFlightReads.clear();
  readVersions.clear();
}

const rawGet = api.get.bind(api);
api.get = (url, config = {}) => {
  if (!isCacheableRead(config)) return rawGet(url, config);

  const key = readCacheKey(url, config);
  const forceRefresh = Object.prototype.hasOwnProperty.call(config.params || {}, '_refresh');
  const generation = readCacheGeneration;
  const version = forceRefresh
    ? (readVersions.get(key) || 0) + 1
    : (readVersions.get(key) || 0);
  readVersions.set(key, version);
  if (forceRefresh) readCache.delete(key);

  const now = Date.now();
  const cached = readCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return Promise.resolve({ ...cached.response, data: cloneCachedData(cached.data) });
  }
  if (cached) readCache.delete(key);

  const existing = inFlightReads.get(key);
  if (!forceRefresh && existing) return existing.then(response => ({ ...response, data: cloneCachedData(response.data) }));

  const requestConfig = { ...config };
  delete requestConfig.cache;
  delete requestConfig.cacheTtlMs;
  const request = rawGet(url, requestConfig)
    .then(response => {
      const ttl = Number.isFinite(config.cacheTtlMs)
        ? Math.max(0, config.cacheTtlMs)
        : READ_CACHE_TTL_MS;
      if (ttl > 0 && readCacheGeneration === generation && readVersions.get(key) === version) {
        readCache.set(key, {
          data: cloneCachedData(response.data),
          response,
          expiresAt: Date.now() + ttl,
        });
      }
      return response;
    })
    .finally(() => {
      if (inFlightReads.get(key) === request) inFlightReads.delete(key);
    });
  inFlightReads.set(key, request);
  return request;
};

// Every API request uses a fresh Firebase ID token. There is no app-created
// JWT/session token in localStorage and PostgreSQL never authenticates a user.
api.interceptors.request.use(async config => {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor to handle errors inside Blob responses and automatic network retries
api.interceptors.response.use(
  response => {
    // A completed write can change any derived dashboard/report total. Clear
    // the short-lived read cache rather than trying to guess every affected URL.
    if (!['get', 'head', 'options'].includes(String(response.config?.method || 'get').toLowerCase())) {
      invalidateApiReadCache();
    }
    return response;
  },
  async error => {
    // A development restart or a short VPS/database network interruption
    // should not turn a dashboard page into an error state. Retry only safe
    // reads: replaying a write after a broken connection could duplicate an
    // upload or configuration update.
    const method = String(error.config?.method || 'get').toLowerCase();
    const isRead = ['get', 'head', 'options'].includes(method);
    const isNetworkError = error.message === 'Network Error'
      || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_NETWORK'].includes(error.code);
    const databaseErrorMessage = String(error.response?.data?.error || '');
    const isDatabaseUnavailable = [500, 503].includes(error.response?.status)
      && (
        error.response?.data?.code === 'DB_UNAVAILABLE'
        || /database connection is temporarily unavailable/i.test(databaseErrorMessage)
      );
    const retryCount = Number(error.config?.__transientRetries || 0);
    if (isRead && (isNetworkError || isDatabaseUnavailable) && retryCount < 3) {
      // 0.75s, 1.5s, then 3s. This covers nodemon's process hand-off without
      // repeatedly reissuing a failing request forever.
      await new Promise(resolve => setTimeout(resolve, 750 * (2 ** retryCount)));
      return api.request({ ...error.config, __transientRetries: retryCount + 1 });
    }

    if (
      error.response &&
      error.response.data instanceof Blob &&
      error.response.data.type === 'application/json'
    ) {
      try {
        const text = await error.response.data.text();
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) {
          // Override error message with the actual backend error message
          error.message = parsed.error;
        }
      } catch (e) {
        // Ignore JSON parse errors and proceed with original error
      }
    }

    // The backend intentionally holds business routes briefly while startup
    // schema checks finish, preventing lock queues and pool exhaustion. This
    // response is emitted before any mutation handler runs, so retrying it is
    // safe even for upload/save requests.
    const startupRetryCount = Number(error.config?.__databaseStartupRetries || 0);
    if (
      error.response?.status === 503
      && error.response?.data?.code === 'DATABASE_STARTING'
      && startupRetryCount < 8
    ) {
      await new Promise(resolve => setTimeout(resolve, 750));
      return api.request({ ...error.config, __databaseStartupRetries: startupRetryCount + 1 });
    }
    return Promise.reject(error);
  }
);

function p(filters = {}) {
  const params = {};
  if (filters.startDate)   params.startDate   = filters.startDate;
  if (filters.endDate)     params.endDate     = filters.endDate;
  if (filters.category)    params.category    = filters.category;
  if (filters.region)      params.region      = filters.region;
  if (filters.status)      params.status      = filters.status;
  if (filters.groupBy)     params.groupBy     = filters.groupBy;
  if (filters.marketplace) params.marketplace = filters.marketplace;
  if (filters.brand)       params.brand       = filters.brand;
  if (filters.sellerAccount || filters.seller_account) {
    params.seller_account = filters.sellerAccount || filters.seller_account;
  }
  // Used only by read-only report endpoints to bypass their short-lived cache
  // after an explicit user refresh. It is not a business filter.
  if (filters._refresh)    params._refresh    = filters._refresh;
  return params;
}

export const fetchData        = ()            => api.post('/fetch').then(r => r.data);
export const fetchAmazonFcMaster = ()         => api.get('/amazon-fc').then(r => r.data);
export const saveAmazonFc = (body)            => api.post('/amazon-fc', body).then(r => r.data);
export const removeAmazonFc = (code)          => api.delete(`/amazon-fc/${encodeURIComponent(code)}`).then(r => r.data);
export const fetchSummary            = (f) => api.get('/summary',             { params: p(f) }).then(r => r.data);
export const fetchMarketplaceSummary = (f) => api.get('/marketplace-summary', { params: p(f) }).then(r => r.data);
export const fetchSalesTrend  = (f)           => api.get('/sales-trend', { params: p(f) }).then(r => r.data);
export const fetchReturnTrend = (f)           => api.get('/return-trend', { params: p(f) }).then(r => r.data);
export const fetchTopProducts = (f, limit=10) => api.get('/top-products', { params: { ...p(f), limit } }).then(r => r.data);
export const fetchReturnReasons     = (f)       => api.get('/return-reasons',      { params: p(f) }).then(r => r.data);
export const fetchSkuReturnSummary  = (f, skuView = 'listing') => api.get('/sku-return-summary', { params: { ...p(f), skuView } }).then(r => r.data);
export const fetchSkuOrders         = (sku, page=1) => api.get('/sku-orders', { params: { sku, page } }).then(r => r.data);
export const fetchReturnTypes   = (f)         => api.get('/return-types', { params: p(f) }).then(r => r.data);
export const fetchCategoryBreakdown = (f)     => api.get('/category-breakdown', { params: p(f) }).then(r => r.data);
export const fetchFeeBreakdown  = (f)         => api.get('/fee-breakdown', { params: p(f) }).then(r => r.data);
export const fetchFilters       = (refreshToken) => api.get('/filters', { params: refreshToken ? { _refresh: refreshToken } : {} }).then(r => r.data);
export const fetchOrders  = (f, page=1)       => api.get('/orders', { params: { ...p(f), page } }).then(r => r.data);
export const fetchReturns = (f, page=1)       => api.get('/returns', { params: { ...p(f), page } }).then(r => r.data);
export const fetchPlatformSummary = (f)       => api.get('/platform/summary', { params: p(f) }).then(r => r.data);

// Single order detail (SQL order + return + settlement rows merged)
export const fetchOrderDetail = (orderItemId) => api.get(`/order/${orderItemId}`).then(r => r.data);

// Save reconciliation report snapshot to SQL
export const pushSettlementReport = () => api.post('/settlement/push-report').then(r => r.data);

// Full P&L from SQL orders, returns, and settlements
export const fetchProfitLoss = (f) => api.get('/profit-loss', { params: p(f) }).then(r => r.data);

// Monthly Statement (PDF upload + SQL save)
export const uploadStatement      = (formData) => api.post('/statement/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
export const fetchStatementData   = ()          => api.get('/statement/data').then(r => r.data);
// Monthly Statement computed from FK Settlement SQL tables
export const fetchMonthlyStatement = (filters = {})    => api.get('/settlement/monthly-statement', { params: p(filters) }).then(r => r.data);
// Reconciliation Statement: FK Deducted vs VB Export Calculated per fee line
export const fetchRecoStatement     = (filters = {})    => api.get('/settlement/reco-statement', { params: p(filters) }).then(r => r.data);
// Sale Statement: order-date based view — sale, returns, FK fees, bank received, carry forward
export const fetchSaleStatement     = (filters = {})    => api.get('/settlement/sale-statement', { params: p(filters) }).then(r => r.data);
// Month P&L: order-month grouped — sale, returns, all fees, bank received, carry forward, pending
export const fetchMonthPL = (marketplace) => api.get('/settlement/month-pl', { params: marketplace && marketplace !== 'all' ? { marketplace } : {} }).then(r => r.data);
// Non-order NEFT charge drilldown (storage, ads, google_ads, spf) for a given payment month
export const fetchNonOrderDetail = (source, month, marketplace) =>
  api.get('/settlement/non-order-detail', { params: { source, month, ...(marketplace ? { marketplace } : {}) } }).then(r => r.data);
// Per-order FK actual fees vs RC expected fees comparison for a given order month
export const fetchOrderFeeCompare = (month, opts = {}) =>
  api.get('/settlement/order-fee-compare', { params: { month, ...opts } }).then(r => r.data);
// Per-order fee drill-down: returns each order with FK charged, RC expected, sale amount
// fee = 'collection_fee' | 'commission' | 'fixed_fee' | 'pick_pack_fee' | 'shipping_fee' | etc.
export const fetchOrderFeeDetail = (fee, month, marketplace = null) =>
  api.get('/settlement/order-fee-detail', {
    params: { fee, month, ...(marketplace && marketplace !== 'all' ? { marketplace } : {}) }
  }).then(r => r.data);
// Fee anomaly detection: compare current month fees vs previous month, returns severity-ranked list
// month = 'YYYY-MM' | 'latest' (auto-detects most recent settlement month)
export const fetchFeeLeaks = (marketplace = 'flipkart', month = 'all', feeType = 'all', page = 1, pageSize = 100) =>
  api.get('/settlement/fee-leaks', {
    params: { marketplace, month, feeType, page, pageSize }
  }).then(r => r.data);

// Settlement
export const fetchSettlementSummary  = (f) => api.get('/settlement/summary', { params: p(f) }).then(r => r.data);
export const fetchSettlementTrend    = (f) => api.get('/settlement/trend',   { params: p(f) }).then(r => r.data);
export const fetchSettlementOrders   = (f, page=1, status='', pageSize=50) =>
  api.get('/settlement/orders', { params: { ...p(f), page, pageSize, ...(status ? { settlementStatus: status } : {}) } }).then(r => r.data);
export const fetchUnsettledSummary   = (f) => api.get('/settlement/unsettled-summary', { params: p(f) }).then(r => r.data);

// Order Tracker — returns template, tracker list, unsettled orders
export const downloadReturnsTemplate = () =>
  api.get('/upload/returns/template', { responseType: 'blob' }).then(r => r.data);
export const fetchReturnsTracker = (filter = 'all', marketplace = null, page = 1, pageSize = 100) =>
  api.get('/upload/returns/tracker', { params: { filter, ...(marketplace ? { marketplace } : {}), page, pageSize } }).then(r => r.data);
export const fetchUnsettledOrders = (marketplace = null) =>
  api.get('/upload/unsettled-orders', { params: marketplace ? { marketplace } : {} }).then(r => r.data);

// Rate Card
export const fetchRateCardCategories = ()      => api.get('/rate-card/categories').then(r => r.data);
export const calculateRateCardFees   = (body)  => api.post('/rate-card/calculate', body).then(r => r.data);
export const compareMarketplaceFees  = (body)  => api.post('/rate-card/compare', body).then(r => r.data);
export const fetchRateCardReconcile  = (f)     => api.get('/rate-card/reconcile', { params: p(f) }).then(r => r.data);
export const fetchRateCardFeeSummary = (f)     => api.get('/rate-card/fee-summary', { params: p(f) }).then(r => r.data);
export const refreshRateCard         = ()      => api.post('/rate-card/refresh').then(r => r.data);

// RC Entry Reconciliation (RC entry → matching orders with expected vs actual fee)
export const fetchRcEntryReco   = (marketplace = 'flipkart', sellerAccount = 'default', refreshToken) =>
  api.get('/rate-card/rc-entry-reco', { params: { marketplace, seller_account: sellerAccount, ...(refreshToken ? { _refresh: refreshToken } : {}) } }).then(r => r.data);
export const fetchRcEntryOrders = (feeType, rcId, marketplace = 'flipkart', sellerAccount = 'default', page = 1, pageSize = 50) =>
  api.get('/rate-card/rc-entry-orders', { params: { fee_type: feeType, rc_id: rcId, marketplace, seller_account: sellerAccount, page, pageSize } }).then(r => r.data);

// Disputes
export const updateDisputeStatus = (payload) => api.post('/disputes', payload).then(r => r.data);

// Exports
export const fetchMonthlyDetailedReport = (month, marketplace = 'flipkart') => 
  api.get('/export/monthly-detailed', { params: { month, marketplace } }).then(r => r.data);
export const fetchSkuSettlementBenchmark = (marketplace = 'flipkart', month = '') =>
  api.get('/export/sku-settlement/benchmark', { params: { marketplace, ...(month ? { month } : {}) } }).then(r => r.data);
export const sendSkuSettlementBenchmarkNotification = (marketplace, month) =>
  api.post('/export/sku-settlement/notify', { marketplace, ...(month ? { month } : {}) }).then(r => r.data);

// Marketplace account management
export const fetchMarketplaceAccounts = (marketplace) => api.get('/rate-card/accounts', { params: { marketplace } }).then(r => r.data);
export const createMarketplaceAccount = (body)        => api.post('/rate-card/accounts', body).then(r => r.data);
export const deleteMarketplaceAccount = (accountId, marketplace) =>
  api.delete(`/rate-card/accounts/${encodeURIComponent(accountId)}`, { params: { marketplace } }).then(r => r.data);

// Rate Card Config CRUD (seller_account scoped)
export const fetchRateCardConfig       = (type, marketplace = 'flipkart', sellerAccount = 'default') =>
  api.get(`/rate-card/config/${type}`, { params: { marketplace, seller_account: sellerAccount } }).then(r => r.data);
export const fetchRateCardCategoryList = (marketplace = 'flipkart', sellerAccount = 'default', includeBrands = false) =>
  api.get('/rate-card/config/categories', { params: { marketplace, seller_account: sellerAccount, includeBrands } }).then(r => r.data);
export const downloadRateCardTemplate = (mp, sellerAccount) => api.get('/rate-card/config/template', { params: { marketplace: mp, seller_account: sellerAccount }, responseType: 'blob' }).then(r => r.data);
export const addRateCardRow    = (type, body)       => api.post(`/rate-card/config/${type}`, body).then(r => r.data);
export const updateRateCardRow = (type, id, body)   => api.put(`/rate-card/config/${type}/${id}`, body).then(r => r.data);
export const deleteRateCardRow = (type, id, marketplace = 'flipkart', sellerAccount = 'default', notify = true) =>
  api.delete(`/rate-card/config/${type}/${id}`, { params: { marketplace, seller_account: sellerAccount, notify } }).then(r => r.data);
export const seedRateCard         = ()           => api.post('/rate-card/config/seed').then(r => r.data);
export const saveRateCardPeriod   = (type, body) => api.post(`/rate-card/config/${type}/save-period`, body).then(r => r.data);
export const fetchFeeIntelligence = (refreshToken) => api.get('/rate-card/intelligence', { params: refreshToken ? { _refresh: refreshToken } : {} }).then(r => r.data);
// AI-powered rate card screenshot parser (uses Gemini Vision on backend)
export const parseRateCardImage   = (body)       => api.post('/rate-card/parse-image', body).then(r => r.data);
export const fetchRateCardVersions = (marketplace = 'flipkart', sellerAccount = 'default') =>
  api.get('/rate-card/versions', { params: { marketplace, seller_account: sellerAccount } }).then(r => r.data);
export const createRateCardVersion = (body) =>
  api.post('/rate-card/versions', body).then(r => r.data);
export const publishRateCardVersion = (id) =>
  api.post(`/rate-card/versions/${id}/publish`).then(r => r.data);
export const rollbackRateCardVersion = (id) =>
  api.post(`/rate-card/versions/${id}/rollback`).then(r => r.data);
export const fetchRateCardNotificationStatus = () =>
  api.get('/rate-card/notifications').then(r => r.data);
export const sendRateCardNotificationTest = () =>
  api.post('/rate-card/notifications/test').then(r => r.data);
export const fetchRateCardConfigStatus = (marketplace = 'flipkart', sellerAccount = 'default', refreshToken) =>
  api.get('/rate-card/config-status', { params: { marketplace, seller_account: sellerAccount, ...(refreshToken ? { _refresh: refreshToken } : {}) } }).then(r => r.data);
export const fetchMpInvoiceRateAudit = (marketplace = 'myntra', sellerAccount = '') =>
  api.get('/mp-settlement/invoices/rate-audit', { params: { marketplace, ...(sellerAccount ? { seller_account: sellerAccount } : {}) } }).then(r => r.data);


// RC Entry Reconciliation (RC entry → matching orders with expected vs actual fee)

// Disputes

// Exports

// Marketplace account management

// Rate Card Config CRUD (seller_account scoped)
// AI-powered rate card screenshot parser (uses Gemini Vision on backend)

// Upload Management
export const fetchUploadStatus   = ()         => api.get('/upload/status').then(r => r.data);
export const fetchUploadHistory  = (params = {}) => api.get('/upload/history', { params }).then(r => r.data);
// sku_master.{master_sku, cogs}.
//   filters: { settlement_id?, month? (YYYY-MM), order_id?, sku?, fulfilment? (FBA|Flex),
//              only_multi_settlement?, only_with_refund?, page?, pageSize? }
//
//   Each row aggregates ACROSS ALL settlement payouts (SUMIF-style) for the
//   same (order_id, sku) — so an order settled in May and refunded in June
//   shows as ONE row with both halves netted, plus settlement_count=2.
//
//   only_multi_settlement=true  → only rows where settlement_count > 1
//                                 (the trickiest to reconcile manually)
//   only_with_refund=true       → only rows that have at least one Refund or
//                                 Fulfillment Fee Refund line
export const fetchAmazonSettlementPivot = (filters = {}) => {
  const {
    settlement_id, month, order_id, sku, fulfilment,
    only_multi_settlement, only_with_refund,
    page = 1, pageSize = 100,
  } = filters;
  return api.get('/upload/amazon-settlement/pivot', {
    params: {
      ...(settlement_id          ? { settlement_id } : {}),
      ...(month                  ? { month         } : {}),
      ...(order_id               ? { order_id      } : {}),
      ...(sku                    ? { sku           } : {}),
      ...(fulfilment             ? { fulfilment    } : {}),
      ...(only_multi_settlement  ? { only_multi_settlement: 'true' } : {}),
      ...(only_with_refund       ? { only_with_refund:      'true' } : {}),
      page, pageSize,
    },
  }).then(r => r.data);
};

// Reconciliation (Marketplace Settlement line-by-line analysis)
export const fetchReconcileSummary  = (f)           => api.get('/reconcile/summary',   { params: p(f) }).then(r => r.data);
export const fetchReconcileItems    = (f, page=1, pageSize=50) =>
  api.get('/reconcile/items', { params: { ...p(f), page, pageSize } }).then(r => r.data);
export const fetchUnsettledItems    = (f, page=1, pageSize=50) => {
  const params = typeof f === 'object' && f !== null ? { ...p(f), page, pageSize } : { page: f || 1, pageSize: page || 50 };
  return api.get('/reconcile/unsettled', { params }).then(r => r.data);
};
export const fetchNonOrderDeductions = (f) => api.get('/reconcile/non-order', { params: p(f) }).then(r => r.data);
export const fetchRateAudit          = (f) => api.get('/reconcile/rate-audit', { params: p(f) }).then(r => r.data);
export const fetchMyntraMonthlySummary = (f) => api.get('/mp-settlement/monthly-summary', { params: p(f) }).then(r => r.data);
export const fetchUnifiedLinkup = (f = {}) => api.get('/reconcile/unified-linkup', { params: p(f) }).then(r => r.data);

// Aliases
export const fetchReconciliationSummary = fetchReconcileSummary;
export const fetchReconciliationItems   = fetchReconcileItems;

// Charges Config
export const fetchCharges       = ()              => api.get('/charges').then(r => r.data);
export const updateCharge       = (key, body)     => api.put(`/charges/${key}`, body).then(r => r.data);
export const addCustomCharge    = (body)          => api.post('/charges', body).then(r => r.data);
export const deleteCustomCharge = (key)           => api.delete(`/charges/${key}`).then(r => r.data);

// SKU Master (listing SKU → master SKU + COGS mapping)
export const fetchSkuMaster      = (marketplace, search, page = 1) =>
  api.get('/upload/sku-master', { params: { marketplace, search, page } }).then(r => r.data);
export const fetchUnmappedSkus   = () =>
  api.get('/upload/sku-master/unmapped').then(r => r.data);
export const uploadSkuMasterFile = (formData) =>
  api.post('/upload/sku-master', formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
export const addSkuMasterRow     = (body) => api.post('/upload/sku-master/row', body).then(r => r.data);
export const updateSkuMasterRow  = (id, body) => api.put(`/upload/sku-master/${id}`, body).then(r => r.data);
export const deleteSkuMasterRow  = (id) => api.delete(`/upload/sku-master/${id}`).then(r => r.data);
export const clearSkuMaster      = (marketplace) =>
  api.delete('/upload/sku-master', { params: { marketplace } }).then(r => r.data);

// VB EXPORT SKU Master & Unmerged System
export const mergeSingleSku     = (body) => api.post('/upload/sku-master/merge-single', body).then(r => r.data);
export const fetchVbExportSkus  = (params = {}) => api.get('/upload/vb-export-skus', { params }).then(r => r.data);
export const updateVbExportSku  = (sku, body) => api.put(`/upload/vb-export-sku/${encodeURIComponent(sku)}`, body).then(r => r.data);
export const fetchUnmergedSkus  = (f) => api.get('/profit-analysis/unmerged-skus', { params: p(f) }).then(r => r.data);

// Brand backfill — propagate sku_master.brand_name to all orders
export const backfillBrands = (force = false) => api.post('/upload/backfill-brands', { force }).then(r => r.data);

// Brand-wise Sales Analysis
export const fetchBrandSales    = (f) => api.get('/brand-sales',    { params: p(f) }).then(r => r.data);
export const fetchBrandTopSkus  = (f) => api.get('/brand-top-skus', { params: p(f) }).then(r => r.data);

// Profit Analysis (revenue – FK fees – COGS = gross profit, by category/month/SKU/brand)
export const fetchProfitAnalysis = (f, sellerAccount) =>
  api.get('/profit-analysis', { params: { ...p(f), ...(sellerAccount ? { sellerAccount } : {}) } }).then(r => r.data);

// VB Export SKU prefilled template download
export const downloadVbExportPrefilledTemplate = () =>
  api.get('/upload/template/vb-export-prefilled', { responseType: 'blob' }).then(r => r.data);

// Insights & Intelligence
export const fetchInsightsMarketplaceSummary = (f = {}) => api.get('/insights/marketplace-summary', { params: { startDate: f.startDate, endDate: f.endDate, ...(f._refresh ? { _refresh: f._refresh } : {}) } }).then(r => r.data);
export const fetchReturnHeatmap   = (f = {}, mp) => api.get('/insights/return-heatmap', { params: { startDate: f.startDate, endDate: f.endDate, marketplace: mp, ...(f._refresh ? { _refresh: f._refresh } : {}) } }).then(r => r.data);
export const fetchRtoRisk         = (f = {}, mp) => api.get('/insights/rto-risk',      { params: { startDate: f.startDate, endDate: f.endDate, marketplace: mp, ...(f._refresh ? { _refresh: f._refresh } : {}) } }).then(r => r.data);
export const fetchFulfilmentPl    = (f = {}, mp) => api.get('/insights/fulfilment-pl', { params: { startDate: f.startDate, endDate: f.endDate, marketplace: mp, ...(f._refresh ? { _refresh: f._refresh } : {}) } }).then(r => r.data);
export const fetchCashFlow        = (mp, refreshToken) => api.get('/insights/cash-flow', { params: { marketplace: mp, ...(refreshToken ? { _refresh: refreshToken } : {}) } }).then(r => r.data);

// Order / item ID search across orders, settlements, returns
export const searchOrder = (q) => api.get('/search-order', { params: { q } }).then(r => r.data);

// Returns received upload
export const uploadReturnsReceived    = (formData) => api.post('/upload/returns-received', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 900000 }).then(r => r.data);
export const fetchReturnsReceivedSummary = ()       => api.get('/upload/returns-received/summary').then(r => r.data);
export const fetchReturnsMismatch       = (page=1)   => api.get('/upload/returns-received/mismatches', { params: { page } }).then(r => r.data);

// SPF tracking
export const fetchSpfSummary   = () => api.get('/upload/spf-summary').then(r => r.data);
export const fetchSpfTracking  = (page=1) => api.get('/upload/spf-tracking', { params: { page } }).then(r => r.data);
export const markSpfReceived   = (body)   => api.post('/upload/spf-mark-received', body).then(r => r.data);

// Multi-marketplace settlement (invoice + ledger based)
export const fetchMpConfig          = ()              => api.get('/mp-settlement/config').then(r => r.data);
export const updateMpConfig         = (mp, body)      => api.patch(`/mp-settlement/config/${mp}`, body).then(r => r.data);
export const addMpConfig            = (body)          => api.post('/mp-settlement/config', body).then(r => r.data);

export const fetchMpInvoices        = (mp, status = '', page = 1, pageSize = 50, sellerAccount = '', refreshToken) =>
  api.get('/mp-settlement/invoices', { params: { marketplace: mp, status, page, pageSize, ...(sellerAccount ? { seller_account: sellerAccount } : {}), ...(refreshToken ? { _refresh: refreshToken } : {}) } }).then(r => r.data);
export const fetchMpInvoiceSummary  = (mp, sellerAccount = '') => api.get('/mp-settlement/invoices/summary', { params: { ...(mp ? { marketplace: mp } : {}), ...(sellerAccount ? { seller_account: sellerAccount } : {}) } }).then(r => r.data);
export const addMpInvoice           = (body)          => api.post('/mp-settlement/invoices', body).then(r => r.data);
export const updateMpInvoice        = (id, body)      => api.put(`/mp-settlement/invoices/${id}`, body).then(r => r.data);
export const deleteMpInvoice        = (id)            => api.delete(`/mp-settlement/invoices/${id}`).then(r => r.data);
export const clearMpInvoices        = (mp, sellerAccount = '') => api.delete('/mp-settlement/invoices', { params: { marketplace: mp, ...(sellerAccount ? { seller_account: sellerAccount } : {}) } }).then(r => r.data);
export const uploadMpInvoices       = (mp, formData, sellerAccount = '')  => api.post('/mp-settlement/invoices/upload', formData, { params: { marketplace: mp, ...(sellerAccount ? { seller_account: sellerAccount } : {}) }, headers: { 'Content-Type': 'multipart/form-data' }, timeout: 900000 }).then(r => r.data);
export const downloadMpInvoiceTemplate = (mp)        => api.get(`/mp-settlement/invoices/template`, { params: { marketplace: mp }, responseType: 'blob' }).then(r => r.data);
export const uploadMyntraData       = (type, formData, sellerAccount) =>
  api.post(`/upload/myntra/${type}`, formData, { params: { seller_account: sellerAccount }, headers: { 'Content-Type': 'multipart/form-data' }, timeout: 900000 }).then(r => r.data);
export const downloadMyntraTemplate = (type) =>
  api.get(`/upload/myntra/template/${type}`, { responseType: 'blob' }).then(r => r.data);

export const fetchMpLedger          = (mp, type, page = 1, pageSize = 50) =>
  api.get('/mp-settlement/ledger', { params: { marketplace: mp, entry_type: type, page, pageSize } }).then(r => r.data);
export const fetchMpLedgerSummary   = (mp)            => api.get('/mp-settlement/ledger/summary', { params: mp ? { marketplace: mp } : {} }).then(r => r.data);
export const uploadMpLedger         = (mp, formData)  => api.post(`/mp-settlement/ledger/upload?marketplace=${mp}`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
export const clearMpLedger          = (mp)            => api.delete('/mp-settlement/ledger', { params: { marketplace: mp } }).then(r => r.data);
export const patchMpLedgerEntry     = (id, body)      => api.patch(`/mp-settlement/ledger/${id}`, body).then(r => r.data);
export const downloadMpLedgerTemplate = (mp)         => api.get(`/mp-settlement/ledger/template`, { params: { marketplace: mp }, responseType: 'blob' }).then(r => r.data);

// Export helpers intentionally walk every page instead of assuming that one
// very large response contains the full report. The previous 99,999-row
// request silently truncated workspaces with more historical rows than that.
// Keep export responses out of the short-lived report cache: retaining several
// 50k-row payloads can otherwise make a normal browser session memory-heavy.
const EXPORT_PAGE_SIZE = 50_000;
const EXCEL_MAX_DATA_ROWS = 1_048_575;

async function fetchAllPages(url, params) {
  const first = await api.get(url, {
    params: { ...params, page: 1, pageSize: EXPORT_PAGE_SIZE },
    cache: false,
  });
  const firstPayload = first.data || {};
  if (!Array.isArray(firstPayload.data)) {
    throw new Error('The export response did not include a row list. No partial file was created.');
  }

  const total = Number(firstPayload.total);
  const expectedRows = Number.isSafeInteger(total) && total >= 0 ? total : firstPayload.data.length;
  if (expectedRows > EXCEL_MAX_DATA_ROWS) {
    throw new Error(`This export has ${expectedRows.toLocaleString()} rows, above Excel's ${EXCEL_MAX_DATA_ROWS.toLocaleString()}-row worksheet limit. Narrow the filters and export in parts.`);
  }

  const rows = [...firstPayload.data];
  for (let page = 2; rows.length < expectedRows; page += 1) {
    const next = await api.get(url, {
      params: { ...params, page, pageSize: EXPORT_PAGE_SIZE },
      cache: false,
    });
    const batch = next.data?.data;
    if (!Array.isArray(batch) || batch.length === 0) {
      throw new Error('The report changed while the export was being collected. No partial file was created; please retry.');
    }
    rows.push(...batch);
  }
  return rows.slice(0, expectedRows);
}

export const fetchAllOrders = (filters) =>
  fetchAllPages('/orders', { ...p(filters), includeRc: 'false' });
export const fetchAllReturns = (filters) =>
  fetchAllPages('/returns', p(filters));
export const fetchAllSettlement = (filters, status = '') =>
  fetchAllPages('/settlement/orders', { ...p(filters), ...(status ? { settlementStatus: status } : {}) });

// ── Return Tracking ────────────────────────────────────────────────────────────
export const fetchReturnTracking  = (f = {})     => api.get('/returns/tracking', {
  params: { ...p(f), page: f.page || 1, limit: f.limit || 50 },
}).then(r => r.data);
export const updateReturnTracking = (body)       => api.post('/returns/tracking', body).then(r => r.data);
export const uploadReturnTrackingBulk = (marketplace, formData) => api.post(`/returns/tracking/upload?marketplace=${marketplace}`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
export const downloadReturnTrackingData = (marketplace) => api.get(`/returns/tracking/download?marketplace=${marketplace}`, { responseType: 'blob' }).then(r => r.data);

// ── User Authentication & Management APIs ────────────────────────────────────
export const syncUser         = (payload)         => api.post('/auth/sync-user', payload).then(r => r.data);
export const fetchMe          = ()                => api.get('/auth/me').then(r => r.data);
export const fetchUsers       = ()                => api.get('/auth/users').then(r => r.data);
export const createUser      = (userData)        => api.post('/auth/users', userData).then(r => r.data);
export const updateUserRole   = (id, role)        => api.put(`/auth/users/${id}/role`, { role }).then(r => r.data);
export const deleteUser       = (id)              => api.delete(`/auth/users/${id}`).then(r => r.data);

// Exception inbox and audit history
export const fetchExceptions = (includeResolved = false) =>
  api.get('/exceptions', { params: includeResolved ? { includeResolved: 'true' } : {} }).then(r => r.data);
export const updateExceptionStatus = (key, status, note = '') =>
  api.post(`/exceptions/${encodeURIComponent(key)}/status`, { status, note }).then(r => r.data);
export const fetchAuditEvents = ({ page = 1, pageSize = 50, action = '', actor = '' } = {}) =>
  api.get('/audit', { params: { page, pageSize, ...(action ? { action } : {}), ...(actor ? { actor } : {}) } }).then(r => r.data);

export const fetchCatalogCogs = (marketplace, search, page = 1) =>
  api.get('/upload/catalog-cogs', { params: { marketplace, search, page } }).then(r => r.data);
export const fetchUnmappedCatalogs = (marketplace) =>
  api.get('/upload/catalog-cogs/unmapped', { params: marketplace ? { marketplace } : {} }).then(r => r.data);
export const uploadCatalogCogsFile = (formData) =>
  api.post('/upload/catalog-cogs', formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
export const addCatalogCogsRow = (body) => api.post('/upload/catalog-cogs/row', body).then(r => r.data);
export const updateCatalogCogsRow = (id, body) => api.put(`/upload/catalog-cogs/${id}`, body).then(r => r.data);
export const deleteCatalogCogsRow = (id) => api.delete(`/upload/catalog-cogs/${id}`).then(r => r.data);
export const clearCatalogCogs = (marketplace) =>
  api.delete('/upload/catalog-cogs', { params: { marketplace } }).then(r => r.data);

// ── AI APIs ──────────────────────────────────────────────────────────────────
export const fetchLinkageHealth  = (marketplace) =>
  api.get('/upload/linkage-health', { params: marketplace ? { marketplace } : {} }).then(r => r.data);
export const saveUploadRemark    = (id, remark) => api.post(`/upload/log/${id}/remark`, { remark }).then(r => r.data);
export const fetchSkippedRows    = (id, page=1) => api.get(`/upload/log/${id}/skipped`, { params: { page } }).then(r => r.data);
export const clearUploadData     = (type, marketplace, reason) =>
  api.delete(`/upload/clear/${type}`, {
    params: marketplace ? { marketplace } : {},
    data: { reason },
  }).then(r => r.data);
export const downloadTemplate    = (type)     => api.get(`/upload/template/${type}`, { responseType: 'blob' }).then(r => r.data);
export const uploadDataFile      = (type, formData) =>
  api.post(`/upload/${type}`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 300000,
  }).then(r => r.data);
export const uploadFkSettlement  = (formData) =>
  api.post('/upload/flipkart-settlement', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 30000,
  }).then(r => r.data);
export const pollFkProgress = (jobId) =>
  api.get(`/upload/flipkart-settlement/progress/${jobId}`).then(r => r.data);

// Amazon Settlement

export const uploadMeeshoSettlement = (formData) =>
  api.post('/upload/meesho-settlement', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 300000,
  }).then(r => r.data);

export const uploadAmazonSettlement    = (formData) =>
  api.post('/upload/amazon-settlement', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 900000,
  }).then(r => r.data);
export const pollAmazonSettlementProgress = (jobId) =>
  api.get(`/upload/amazon-settlement/progress/${jobId}`).then(r => r.data);
export const fetchAmazonSettlementSummary = () =>
  api.get('/upload/amazon-settlement/summary').then(r => r.data);
export const fetchAmazonNonOrder = ({ settlement_id, month, page = 1, pageSize = 100 } = {}) =>
  api.get('/upload/amazon-settlement/non-order', {
    params: { ...(settlement_id ? { settlement_id } : {}), ...(month ? { month } : {}), page, pageSize },
  }).then(r => r.data);
export const resolveAmazonSettlementSkus = (settlement_id = null) =>
  api.post('/upload/amazon-settlement/resolve-skus', settlement_id ? { settlement_id } : {}).then(r => r.data);
export const backfillAmazonOrders = () =>
  api.post('/upload/amazon-settlement/backfill-orders').then(r => r.data);
export const fetchAmazonReconciliation = (filters = {}) =>
  api.get('/upload/amazon-settlement/reconciliation', { params: filters }).then(r => r.data);
export const fetchAmazonRateRules = (sellerAccount = 'default') =>
  api.get('/upload/amazon-settlement/rate-rules', { params: { seller_account: sellerAccount } }).then(r => r.data);
export const createAmazonRateRule = (body) =>
  api.post('/upload/amazon-settlement/rate-rules', body).then(r => r.data);
export const updateAmazonRateRule = (id, body) =>
  api.put(`/upload/amazon-settlement/rate-rules/${id}`, body).then(r => r.data);
export const deleteAmazonRateRule = (id) =>
  api.delete(`/upload/amazon-settlement/rate-rules/${id}`).then(r => r.data);

export const fetchOutstandingSummary = (params = {}) =>
  api.get('/reconcile/outstanding/summary', { params }).then(r => r.data);
export const fetchOutstandingOrders = (params = {}) =>
  api.get('/reconcile/outstanding/orders', { params }).then(r => r.data);
export const fetchOutstandingInvoices = (params = {}) =>
  api.get('/reconcile/outstanding/invoices', { params }).then(r => r.data);
export const fetchOutstandingConfig = () =>
  api.get('/reconcile/outstanding/config').then(r => r.data);
export const updateOutstandingConfig = (channelKey, body) =>
  api.put(`/reconcile/outstanding/config/${channelKey}`, body).then(r => r.data);


