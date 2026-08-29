// ─────────────────────────────────────────────────────────────────────────────
// Amazon upload endpoints — multi-source linkage WITHOUT synthetic keys.
//
//   1. POST /api/upload/amazon-sale-orders   (current sale source)
//        Current 14-column Sale Order export. Natural key is
//        (Amazon Order Id, Merchant SKU); no Order Reports step is required.
//
//   Legacy Order Reports and Order Summary endpoints remain API-compatible but
//   are not exposed in Data Hub.
//
//   3. POST /api/upload/amazon-fba-returns
//        FBA returns CSV. Natural key = license-plate-number (LPN). Stored
//        directly as returns.order_item_id. Links to orders by (order_id, sku).
//
//   4. POST /api/upload/amazon-flex-returns
//        Flex returns CSV. Natural key = RMA ID. Same direct-storage model.
//        WATCH OUT: file's "SKU" column is FNSKU; "mSKU" column is the seller SKU.
//
//   5. POST /api/upload/amazon-settlement   (long format)
//        Envelope (1 row) → amazon_settlements; lines (17k+) → amazon_settlement_lines.
//        Linkage to orders at QUERY TIME (not stored):
//          - order_item_code populated  → JOIN orders ON order_item_id (exact)
//          - only order_id populated    → JOIN orders ON order_id  (e.g. Fulfillment
//            Fee Refund rows which have no sku/item-code)
//          - neither populated          → true non-order line (storage, ads, …)
//
// No synthetic AMZ-{order_id}-{sku} keys are computed anywhere. The
// composite_key columns on orders/returns/amazon_settlement_lines exist from
// an earlier migration but are now always NULL for new ingests.
//
// CRITICAL VOCABULARY (verified across all 4 file formats):
//   - "seller SKU"  = the sellable code (joins to sku_master.listing_sku)
//   - "FNSKU"       = Amazon barcode (X001…)
//   - "ASIN"        = Amazon catalog ID (B0…)
//   File column name → meaning:
//     Sale Orders:     Merchant SKU=seller, FNSKU=fnsku, ASIN=asin
//     Order Reports:   sku=seller, (no fnsku), asin=asin
//     FBA returns:     sku=seller, fnsku=fnsku, asin=asin
//     Flex returns:    mSKU=seller, SKU=fnsku ⚠️, ASIN=asin
//     Settlement:      sku=seller
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import multer  from 'multer';
import { createRequire } from 'module';
import { getPool, isDbConfigured } from '../db/index.js';
import { AMAZON_BRAND } from '../services/amazonSettlementRollups.js';
import { clearSkuSettlementBenchmarkCache } from '../services/skuSettlementBenchmark.js';
import { notifySkuSettlementBenchmarkAfterImport } from '../services/skuSettlementNotifications.js';
import {
  cacheAmazonReconciliation,
  invalidateAmazonReconciliationCache,
  readAmazonReconciliationCache,
} from '../services/amazonReconciliationCache.js';
import {
  amazonMonthRange,
  CATEGORY_CASE_SQL,
  fetchAmazonNonOrderReport,
  fetchAmazonSettlementSummary,
} from '../services/amazonSettlementReports.js';
import { replaceAmazonSettlement } from '../services/amazonSettlementIngest.js';
import { refreshAmazonSettlementReportingRollups } from '../services/amazonSettlementReportingRollups.js';
import { refreshOrderSettlementTotals } from '../services/orderSettlementTotals.js';
import {
  AMAZON_CALCULATION_BASES,
  AMAZON_FEE_CATALOG,
  AMAZON_FEE_CODE_CASE_SQL,
  AMAZON_PROGRAMS,
  AMAZON_RECONCILABLE_FEE_CODES,
  buildAmazonFeeComparison,
} from '../services/amazonReconciliation.js';
import { logUpload, saveSkippedRows } from '../services/uploadLog.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { forEachDbBatch } from '../utils/dbBatch.js';
import { pagination } from '../utils/requestParams.js';
import { optionalNumber as num, optionalString as str } from '../utils/valueParsers.js';
import { requireAdmin } from '../utils/authMiddleware.js';

const router  = express.Router();
const upload  = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, parts: 20 },
});
const reqXlsx = createRequire(import.meta.url);
const XLSX    = reqXlsx('xlsx');

// ── Helpers ─────────────────────────────────────────────────────────────────
function parseAllSheets(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false, raw: false });
  const sheets = [];
  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    if (rows.length < 2) continue;
    const headers = rows[0].map(h => (h + '').trim());
    const data    = rows.slice(1).filter(r => r.some(c => c !== ''));
    sheets.push({ sheetName, headers, data });
  }
  return sheets;
}

function parseFile(buffer, preferredSheets = []) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false, raw: false });
  const sheetName = preferredSheets.find(n => wb.SheetNames.includes(n)) || wb.SheetNames[0];
  const ws   = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (rows.length < 2) return { headers: [], data: [] };
  const headers = rows[0].map(h => (h + '').trim());
  const data    = rows.slice(1).filter(r => r.some(c => c !== ''));
  return { headers, data };
}

// Build a header→column index map for fast lookup. Header normalization handles:
//  - trailing/leading whitespace (e.g. Amazon's "order-item-id ")
//  - case differences
//  - underscore vs hyphen vs space
export function buildHeaderIndex(headers) {
  const idx = {};
  headers.forEach((h, i) => {
    if (!h) return;
    const raw  = (h + '').trim();
    const norm = raw.toLowerCase().replace(/[\s_-]+/g, '');
    idx[raw]  = i;
    idx[norm] = i;
  });
  return idx;
}

export function hasHeader(idx, ...candidates) {
  return candidates.some((candidate) => {
    const norm = (candidate + '').toLowerCase().replace(/[\s_-]+/g, '');
    return Object.prototype.hasOwnProperty.call(idx, norm);
  });
}

// Get a value from a row using multiple candidate header names. First match wins.
function getCell(row, idx, ...candidates) {
  for (const c of candidates) {
    const norm = (c + '').toLowerCase().replace(/[\s_-]+/g, '');
    if (idx[c]      != null) return (row[idx[c]]      ?? '').toString().trim();
    if (idx[norm]   != null) return (row[idx[norm]]   ?? '').toString().trim();
  }
  return '';
}

function int(v) {
  const n = num(v);
  return Number.isSafeInteger(n) ? n : null;
}
function bool(v) {
  if (v == null || v === '') return null;
  const s = (v + '').trim().toLowerCase();
  if (['true','yes','y','1'].includes(s)) return true;
  if (['false','no','n','0'].includes(s)) return false;
  return null;
}

function invalidOptionalNumber(value, label, { whole = false, positive = false } = {}) {
  const text = str(value);
  if (text == null) return null;
  const parsed = num(text);
  if (parsed == null) return `${label} is invalid: ${text}`;
  if (whole && !Number.isSafeInteger(parsed)) return `${label} must be a whole number`;
  if (positive && parsed < 1) return `${label} must be a positive whole number`;
  return null;
}

function invalidOptionalDate(value, label) {
  const text = str(value);
  return text && !dt(text) ? `${label} is invalid: ${text}` : null;
}

function invalidOptionalBoolean(value, label) {
  const text = str(value);
  return text && bool(text) == null ? `${label} must be Yes/No or True/False` : null;
}

// Legacy Amazon endpoints remain callable for existing integrations. Validate
// populated typed cells before their rows can touch the canonical orders table.
export function validateLegacyAmazonOrderRow(row, idx, { report = false } = {}) {
  const dateHeaders = report
    ? [[['purchase-date'], 'purchase-date']]
    : [[['Order Date', 'order-date', 'purchase-date', 'Customer S', 'Customer Shipment Date'], 'order date']];
  const quantityHeaders = report
    ? ['quantity', 'quantity']
    : ['QTY', 'quantity'];
  const financialHeaders = report
    ? [
        ['item-price', 'item-price'], ['item-tax', 'item-tax'],
        ['shipping-price', 'shipping-price'], ['shipping-tax', 'shipping-tax'],
        ['gift-wrap-price', 'gift-wrap-price'], ['gift-wrap-tax', 'gift-wrap-tax'],
        ['item-promotion-discount', 'item-promotion-discount'], ['ship-promotion-discount', 'ship-promotion-discount'],
      ]
    : [[['Selling Prices', 'Selling Price', 'item-price', 'Product Amount'], 'selling price']];

  for (const [headers, label] of dateHeaders) {
    const error = invalidOptionalDate(getCell(row, idx, ...headers), label);
    if (error) return error;
  }
  const quantityError = invalidOptionalNumber(getCell(row, idx, ...quantityHeaders), quantityHeaders[1], { whole: true, positive: true });
  if (quantityError) return quantityError;
  for (const [headers, label] of financialHeaders) {
    const candidates = Array.isArray(headers) ? headers : [headers];
    const error = invalidOptionalNumber(getCell(row, idx, ...candidates), label);
    if (error) return error;
  }
  if (report) {
    for (const [header, label] of [
      ['is-business-order', 'is-business-order'], ['is-replacement-order', 'is-replacement-order'],
      ['is-exchange-order', 'is-exchange-order'], ['is-iba', 'is-iba'],
    ]) {
      const error = invalidOptionalBoolean(getCell(row, idx, header), label);
      if (error) return error;
    }
  }
  const currency = str(getCell(row, idx, 'currency'));
  if (currency && !/^[A-Z]{3}$/i.test(currency)) return `currency must be a three-letter code: ${currency}`;
  return null;
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function positiveInteger(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function strictSaleAmount(value, label, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return required ? { error: `${label} is empty` } : { value: 0 };
  const parsed = num(text);
  if (parsed == null) return { error: `invalid ${label}: ${text}` };
  if (parsed < 0) return { error: `${label} cannot be negative` };
  return { value: parsed };
}

// The current Sale Orders export is the primary Amazon sales source. Validate
// every financial input before calculating invoice totals so bad spreadsheet
// cells can never become zero-valued sales records.
export function parseAmazonSaleOrderRow(row, idx) {
  const orderId = str(getCell(row, idx, 'Amazon Order Id'));
  const sku = str(getCell(row, idx, 'Merchant SKU'));
  const fnsku = str(getCell(row, idx, 'FNSKU'));
  const asin = str(getCell(row, idx, 'ASIN'));
  if (!orderId) return { error: 'Amazon Order Id is empty' };
  if (!sku) return { error: 'Merchant SKU is empty' };
  if (!fnsku) return { error: 'FNSKU is empty' };
  if (!asin) return { error: 'ASIN is empty' };

  const rawShipmentDate = getCell(row, idx, 'Customer Shipment Date');
  const shipmentDate = dt(rawShipmentDate);
  if (!shipmentDate) return { error: `Customer Shipment Date is empty or invalid${rawShipmentDate ? `: ${rawShipmentDate}` : ''}` };
  const quantity = positiveInteger(getCell(row, idx, 'Quantity'));
  if (quantity == null) return { error: 'Quantity must be a positive whole number' };
  const currency = str(getCell(row, idx, 'Currency')).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'Currency must be a three-letter code' };

  const productAmount = strictSaleAmount(getCell(row, idx, 'Product Amount'), 'Product Amount', { required: true });
  const shippingAmount = strictSaleAmount(getCell(row, idx, 'Shipping Amount'), 'Shipping Amount');
  const giftAmount = strictSaleAmount(getCell(row, idx, 'Gift Amount'), 'Gift Amount');
  if (productAmount.error || shippingAmount.error || giftAmount.error) {
    return productAmount.error ? productAmount : (shippingAmount.error ? shippingAmount : giftAmount);
  }

  return {
    values: {
      orderId,
      sku,
      fnsku,
      asin,
      shipmentDate,
      quantity,
      currency,
      productAmount: productAmount.value,
      shippingAmount: shippingAmount.value,
      giftAmount: giftAmount.value,
    },
  };
}

function strictOptionalInteger(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return { value: null };
  if (!/^\d+$/.test(text)) return { error: `${label} must be a whole number` };
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? { value: parsed }
    : { error: `${label} must be a whole number` };
}

export function parseAmazonSettlementLine(row, idx, { fallbackSettlementId = null } = {}) {
  const currentSettlementId = str(getCell(row, idx, 'settlement-id'));
  const settlementId = currentSettlementId || fallbackSettlementId || null;
  const transactionType = str(getCell(row, idx, 'transaction-type'));
  const amountType = str(getCell(row, idx, 'amount-type'));
  const amountDescription = str(getCell(row, idx, 'amount-description'));
  const rawAmount = getCell(row, idx, 'amount');

  // Summary/envelope rows do not carry the line-item trinity and are handled
  // separately. They should not be counted as malformed transactions.
  if (!transactionType && !amountType && !amountDescription && !rawAmount) return { skip: true };
  if (!settlementId) return { error: 'settlement-id is missing for a transaction line' };
  if (!transactionType) return { error: 'transaction-type is empty' };
  if (!amountType) return { error: 'amount-type is empty' };
  if (!amountDescription) return { error: 'amount-description is empty' };
  const amount = num(rawAmount);
  if (amount == null) return { error: `invalid amount: ${rawAmount || '(empty)'}` };

  const rawPostedDate = getCell(row, idx, 'posted-date');
  const postedDate = rawPostedDate ? dt(rawPostedDate) : null;
  if (rawPostedDate && !postedDate) return { error: `invalid posted-date: ${rawPostedDate}` };
  const quantity = strictOptionalInteger(getCell(row, idx, 'quantity-purchased'), 'quantity-purchased');
  if (quantity.error) return quantity;
  const rawCurrency = str(getCell(row, idx, 'currency'));
  const currency = rawCurrency ? rawCurrency.toUpperCase() : 'INR';
  if (!/^[A-Z]{3}$/.test(currency)) return { error: `invalid currency: ${rawCurrency}` };
  const rawOrderItemCode = str(getCell(row, idx, 'order-item-code'));

  return {
    scientificOrderItemCode: Boolean(rawOrderItemCode && looksScientific(rawOrderItemCode)),
    values: {
      settlement_id:          settlementId,
      posted_date:            postedDate,
      posted_at:              dtIso(getCell(row, idx, 'posted-date-time') || rawPostedDate),
      transaction_type:       transactionType,
      amount_type:            amountType,
      amount_description:     amountDescription,
      amount,
      order_id:               str(getCell(row, idx, 'order-id')) || null,
      merchant_order_id:      str(getCell(row, idx, 'merchant-order-id')),
      shipment_id:            str(getCell(row, idx, 'shipment-id')),
      adjustment_id:          str(getCell(row, idx, 'adjustment-id')),
      // Scientific notation indicates Excel precision loss. Keep this linkage
      // unset instead of inventing a rounded, potentially wrong item ID.
      order_item_code:        rawOrderItemCode && !looksScientific(rawOrderItemCode) ? rawOrderItemCode : null,
      merchant_order_item_id: str(getCell(row, idx, 'merchant-order-item-id')),
      sku:                    str(getCell(row, idx, 'sku', 'SKU')) || null,
      quantity:               quantity.value,
      fulfillment_id:         str(getCell(row, idx, 'fulfillment-id')),
      promotion_id:           str(getCell(row, idx, 'promotion-id')),
      marketplace_name:       str(getCell(row, idx, 'marketplace-name')),
      currency,
      marketplace:            'amazon',
    },
  };
}

// Amazon Flex provides two separate signals:
// - "Returned with OTP" describes the handover method.
// - "Returned to Seller" confirms the item reached the seller.
// Only the latter can mark a return as received in our system.
export function isFlexReturnDelivered(returnStatus) {
  return (returnStatus || '').trim().toLowerCase() === 'returned to seller';
}

export function flexReturnItemKey({
  rmaId,
  sellerSku,
  reverseTrackingId,
  forwardTrackingId,
  shipmentId,
  orderId,
  rowNumber,
}) {
  if (rmaId && sellerSku) return `${rmaId}-${sellerSku}`;

  // Undelivered/RTO rows commonly have no RMA. Tracking + seller SKU stays
  // stable even if Amazon changes the row order in a later export.
  const trackingId = reverseTrackingId || forwardTrackingId || shipmentId;
  if (trackingId && sellerSku) return `FLEX-TRACK-${trackingId}-${sellerSku}`;

  // Last-resort compatibility key for malformed rows with no stable ID.
  return `FLEX-NORMA-${orderId}-${rowNumber}`;
}

function amazonReturnText(value, label, { required = false, max = 500 } = {}) {
  const text = str(value);
  if (required && !text) return { error: `${label} is empty` };
  if (text && text.length > max) return { error: `${label} must be ${max} characters or fewer` };
  return { value: text };
}

function amazonReturnDate(value, label, { required = false } = {}) {
  const text = str(value);
  if (!text) return required ? { error: `${label} is empty` } : { value: null };
  const valueDate = dt(text);
  return valueDate ? { value: valueDate } : { error: `${label} is invalid: ${text}` };
}

export function parseAmazonFbaReturnRow(row, idx) {
  const orderId = amazonReturnText(getCell(row, idx, 'order-id'), 'order-id', { required: true });
  const lpn = amazonReturnText(getCell(row, idx, 'license-plate-number'), 'license-plate-number', { required: true });
  const sku = amazonReturnText(getCell(row, idx, 'sku'), 'sku', { required: true });
  const returnDate = amazonReturnDate(getCell(row, idx, 'return-date'), 'return-date', { required: true });
  const disposition = amazonReturnText(getCell(row, idx, 'detailed-disposition'), 'detailed-disposition', { required: true });
  const quantity = positiveInteger(getCell(row, idx, 'quantity'));
  if (orderId.error || lpn.error || sku.error || returnDate.error || disposition.error) {
    return orderId.error ? orderId : (lpn.error ? lpn : (sku.error ? sku : (returnDate.error ? returnDate : disposition)));
  }
  if (quantity == null) return { error: 'quantity must be a positive whole number' };

  const reason = str(getCell(row, idx, 'reason'));
  const orderItemId = `${lpn.value}-${orderId.value}`;
  return {
    values: {
      order_item_id: orderItemId,
      return_id: lpn.value,
      license_plate_number: lpn.value,
      order_id: orderId.value,
      sku: sku.value,
      fsn: str(getCell(row, idx, 'asin')),
      asin: str(getCell(row, idx, 'asin')),
      fnsku: str(getCell(row, idx, 'fnsku')),
      product_title: str(getCell(row, idx, 'product-name')),
      quantity,
      warehouse_id: str(getCell(row, idx, 'fulfillment-center-id')),
      disposition: disposition.value,
      return_result: disposition.value,
      return_reason: reason,
      customer_comment: str(getCell(row, idx, 'customer-comments')),
      return_sub_reason: str(getCell(row, idx, 'customer-comments')),
      return_date: returnDate.value,
      return_date_time: dtIso(getCell(row, idx, 'return-date')),
      return_approval_date: returnDate.value,
      fulfilment_type: 'FBA',
      return_type: (reason === 'UNDELIVERABLE_REFUSED' || reason === 'UNDELIVERABLE_UNKNOWN') ? 'RTO' : 'CUSTOMER_RETURN',
      marketplace: 'amazon',
    },
  };
}

export function parseAmazonFlexReturnRow(row, idx) {
  const orderId = amazonReturnText(getCell(row, idx, 'Customer Order ID', 'customer-order-id', 'order-id'), 'Customer Order ID', { required: true });
  const sellerSku = amazonReturnText(getCell(row, idx, 'mSKU', 'msku'), 'mSKU', { required: true });
  const rmaId = amazonReturnText(getCell(row, idx, 'RMA ID', 'rma-id'), 'RMA ID');
  const shipmentId = amazonReturnText(getCell(row, idx, 'Shipment ID', 'shipment-id'), 'Shipment ID').value;
  const forwardTrackingId = amazonReturnText(getCell(row, idx, 'Forward Leg Tracking ID'), 'Forward Leg Tracking ID').value;
  const reverseTrackingId = amazonReturnText(getCell(row, idx, 'Reverse Leg Tracking ID'), 'Reverse Leg Tracking ID').value;
  const pickupDate = amazonReturnDate(getCell(row, idx, 'Pick -up date', 'Pick-up date', 'Pickup date'), 'Pick-up date');
  const updatedDate = amazonReturnDate(getCell(row, idx, 'Last Updated On', 'last-updated-on'), 'Last Updated On');
  const units = positiveInteger(getCell(row, idx, 'Units'));
  const rawOtp = getCell(row, idx, 'Returned with OTP');
  const returnedWithOtp = bool(rawOtp);
  const transitDays = strictOptionalInteger(getCell(row, idx, 'Days In-transit'), 'Days In-transit');
  const completeDays = strictOptionalInteger(getCell(row, idx, 'Days Since Return Complete'), 'Days Since Return Complete');
  if (orderId.error || sellerSku.error || rmaId.error || pickupDate.error || updatedDate.error) {
    return orderId.error ? orderId : (sellerSku.error ? sellerSku : (rmaId.error ? rmaId : (pickupDate.error ? pickupDate : updatedDate)));
  }
  if (!rmaId.value && !(reverseTrackingId || forwardTrackingId || shipmentId)) {
    return { error: 'RMA ID or a tracking/shipment ID is required for a stable return identity' };
  }
  if (units == null) return { error: 'Units must be a positive whole number' };
  if (rawOtp && returnedWithOtp == null) return { error: 'Returned with OTP must be Yes or No' };
  if (transitDays.error || completeDays.error) return transitDays.error ? transitDays : completeDays;

  const orderItemId = flexReturnItemKey({
    rmaId: rmaId.value, sellerSku: sellerSku.value, reverseTrackingId, forwardTrackingId, shipmentId,
    orderId: orderId.value, rowNumber: 0,
  });
  return {
    values: {
      order_item_id: orderItemId,
      return_id: rmaId.value || orderItemId,
      rma_id: rmaId.value,
      order_id: orderId.value,
      sku: sellerSku.value,
      fnsku: str(getCell(row, idx, 'SKU')),
      fsn: str(getCell(row, idx, 'ASIN')),
      asin: str(getCell(row, idx, 'ASIN')),
      shipment_id: shipmentId,
      quantity: units,
      units,
      forward_tracking_id: forwardTrackingId,
      reverse_logistics_tracking_id: reverseTrackingId,
      return_status: str(getCell(row, idx, 'Return Status')),
      carrier: str(getCell(row, idx, 'Carrier')),
      return_requested_date: pickupDate.value,
      return_approval_date: updatedDate.value,
      returned_with_otp: returnedWithOtp,
      days_in_transit: transitDays.value,
      days_since_return_complete: completeDays.value,
      return_reason: str(getCell(row, idx, 'Return Reason')),
      return_type: str(getCell(row, idx, 'Return Type')) || 'CUSTOMER_RETURN',
      fulfilment_type: 'Flex',
      marketplace: 'amazon',
    },
  };
}

async function markFlexReturnsReceived(pool, returnRows) {
  const receivedByOrderItem = new Map();
  for (const row of returnRows) {
    if (!isFlexReturnDelivered(row.return_status) || !row.return_approval_date) continue;
    receivedByOrderItem.set(row.order_item_id, row.return_approval_date);
  }

  const received = [...receivedByOrderItem.entries()];
  if (!received.length) return 0;

  await forEachDbBatch(received, 4, async (batch) => {
    const values = [];
    const placeholders = batch.map(([orderItemId, receivedDate], i) => {
      const offset = i * 4;
      values.push(
        orderItemId,
        receivedDate,
        'amazon',
        'Auto-marked from Amazon Flex status: Returned to Seller. Condition not provided by Amazon.'
      );
      return `($${offset + 1}, $${offset + 2}::date, NULL, $${offset + 3}, $${offset + 4})`;
    }).join(', ');

    await pool.query(`
      INSERT INTO returns_received (order_item_id, received_date, is_bad_return, notes, marketplace)
      VALUES ${placeholders}
      ON CONFLICT (order_item_id) DO UPDATE SET
        received_date = COALESCE(returns_received.received_date, EXCLUDED.received_date),
        notes = COALESCE(returns_received.notes, EXCLUDED.notes),
        marketplace = EXCLUDED.marketplace
    `, values);

    const orderItemIds = batch.map(([orderItemId]) => orderItemId);
    await pool.query(`
      UPDATE returns r
      SET is_received = TRUE,
          received_date = COALESCE(r.received_date, rr.received_date)
      FROM returns_received rr
      WHERE r.order_item_id = rr.order_item_id
        AND r.order_item_id = ANY($1::text[])
    `, [orderItemIds]);
  }, { preferredSize: 250 });

  return received.length;
}

function dt(v) { return normalizeSqlDate(v); }
function dtIso(v) {
  if (!v) return null;
  const s = (v + '').trim();
  if (!s) return null;
  // Amazon uses ISO 8601 with TZ — Date handles it directly
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// NOTE: composite_key synthesis (AMZ-{order_id}-{sku}) has been REMOVED.
// Going forward we rely on natural keys:
//   - orders.order_item_id   = real 14-digit Amazon order-item-id (Order Reports)
//   - returns.order_item_id  = LPN (FBA)  /  RMA ID (Flex)  — both naturally unique
//   - amazon_settlement_lines.order_item_code = real 14-digit when available, else NULL
// Cross-source joins use (order_id, sku) pairs at query time, OR order_id alone
// for rows that have no sku (e.g. Fulfillment Fee Refund lines).

// Detect if a numeric value looks like XLSX-mangled scientific notation
// e.g. "6.29776E+13" — means user uploaded the XLSX instead of CSV/TSV and
// lost precision in the 14-digit order-item-code.
function looksScientific(v) {
  return typeof v === 'string' && /^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(v.trim());
}

// ── Amazon Zone Logic ────────────────────────────────────────────────────────
function calculateAmazonZone(fromCity, fromState, toCity, toState) {
  if (!fromCity || !fromState || !toCity || !toState) return 'National';

  const fCity = (fromCity + '').toUpperCase().trim();
  const fState = (fromState + '').toUpperCase().trim();
  const tCity = (toCity + '').toUpperCase().trim();
  const tState = (toState + '').toUpperCase().trim();

  if (fCity === tCity && fCity !== '') return 'Local';
  if ((fCity === 'BHIWANDI' && ['MUMBAI', 'NAVI MUMBAI', 'BOMBAY', 'KALYAN'].includes(tCity)) ||
      (['MUMBAI', 'NAVI MUMBAI', 'BOMBAY', 'KALYAN'].includes(fCity) && tCity === 'BHIWANDI')) {
    return 'Local';
  }
  if (['BANGALORE', 'BENGALURU'].includes(fCity) && ['BANGALORE', 'BENGALURU'].includes(tCity)) {
    return 'Local';
  }

  const region1 = ["CHANDIGARH", "DELHI", "HARYANA", "HIMACHAL PRADESH", "JAMMU AND KASHMIR", "PUNJAB", "RAJASTHAN", "UTTARAKHAND", "UTTAR PRADESH-ZONE A"];
  const region2 = ["DADRA AND NAGAR", "DIU AND DAMAN", "GUJARAT", "MADHYA PRADESH", "MAHARASHTRA"];
  const region3 = ["ANDAMAN AND NICOBAR", "ANDHRA PRADESH", "GOA", "KARNATAKA", "KERALA", "PONDICHERRY", "TAMIL NADU", "TELANGANA", "LAKSHADWEEP"];
  const region4 = ["ARUNACHAL PRADESH", "ASSAM", "BIHAR", "CHHATTISGARH", "JHARKHAND", "MANIPUR", "MEGHALAYA", "MIZORAM", "NAGALAND", "ODISHA", "SIKKIM", "TRIPURA", "WEST BENGAL", "UTTAR PRADESH-ZONE B"];

  const upZoneBCities = ["AYODHYA", "AZAMGARH", "BASTI", "DEVIPATAN", "GORAKHPUR", "MIRZAPUR", "PRAYAGRAJ", "VARANASI"];
  const ncrCities = ["NOIDA", "GHAZIABAD", "GREATER NOIDA"];

  const resolveStateZone = (state, city) => {
    if (state === "UTTAR PRADESH") {
      if (upZoneBCities.includes(city)) return "UTTAR PRADESH-ZONE B";
      return "UTTAR PRADESH-ZONE A";
    }
    return state;
  };

  const fResolved = resolveStateZone(fState, fCity);
  const tResolved = resolveStateZone(tState, tCity);

  if ((fState === "HARYANA" && tState === "UTTAR PRADESH" && ncrCities.includes(tCity)) ||
      (tState === "HARYANA" && fState === "UTTAR PRADESH" && ncrCities.includes(fCity))) {
    return 'Regional';
  }

  const getRegion = (s) => {
    if (region1.includes(s)) return 1;
    if (region2.includes(s)) return 2;
    if (region3.includes(s)) return 3;
    if (region4.includes(s)) return 4;
    return 0;
  };

  const fRegion = getRegion(fResolved);
  const tRegion = getRegion(tResolved);

  if (fRegion !== 0 && fRegion === tRegion) return 'Regional';
  return 'National';
}

// Run a batched UPSERT. Each row is an object {col: value}. The fields[] array
// fixes the column order. keyCol is the conflict target.
async function batchUpsert(pool, table, keyCol, fields, rowObjs, updateOnConflict = true) {
  if (!rowObjs.length) return { inserted: 0, updated: 0 };
  const cols    = fields.join(', ');
  const updates = fields.filter(f => f !== keyCol).map(f => `${f} = EXCLUDED.${f}`).join(', ');
  let totalInserted = 0;
  let totalUpdated  = 0;

  // Deduplicate within payload, keeping last occurrence
  const seen = new Map();
  for (const r of rowObjs) {
    const k = r[keyCol];
    if (k != null && k !== '') seen.set(k, r);
  }
  const deduped = [...seen.values()];

  await forEachDbBatch(deduped, fields.length, async batch => {
    const values = [];
    const groups = batch.map(r => {
      const start = values.length;
      for (const f of fields) values.push(r[f] ?? null);
      return `(${fields.map((_, ci) => `$${start + ci + 1}`).join(',')})`;
    });
    const conflictClause = updateOnConflict
      ? `ON CONFLICT (${keyCol}) DO UPDATE SET ${updates}, uploaded_at = NOW() RETURNING (xmax = 0) AS inserted`
      : `ON CONFLICT (${keyCol}) DO NOTHING RETURNING 1`;
    const sql = `INSERT INTO ${table} (${cols}) VALUES ${groups.join(',')} ${conflictClause}`;
    const { rows } = await pool.query(sql, values);
    if (updateOnConflict) {
      for (const row of rows) {
        if (row.inserted) totalInserted++;
        else              totalUpdated++;
      }
    } else {
      totalInserted += rows.length;
    }
  });
  return { inserted: totalInserted, updated: totalUpdated };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) POST /amazon-order-reports
//    Primary order ingest from "order file.xlsx" (Amazon Order Reports).
//    38 columns. Real 14-digit order-item-id.  Reads ALL sheets.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/amazon-order-reports', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const marketplace = 'amazon';
  let totalInserted = 0, totalUpdated = 0, totalSkipped = 0;
  const allSkipped = [];
  const newFCs = new Set();

  try {
    const pool   = getPool();
    
    // Fetch FC Map for Amazon Zone classification
    const fcMap = new Map();
    try {
      const { rows } = await pool.query('SELECT fc_code, city, state, fc_type FROM amazon_fc_master');
      for (const r of rows) fcMap.set(r.fc_code.toUpperCase(), r);
    } catch (e) {
      console.warn('[amazonUpload] Failed to load FC map:', e.message);
    }
    
    const sheets = parseAllSheets(req.file.buffer);
    req.file.buffer = null;
    if (!sheets.length) return res.status(400).json({ error: 'No data sheets found in file' });

    const orderRows = [];   // collected across all sheets
    let rowCounter  = 0;
    const seenKeys  = new Set();

    for (const { sheetName, headers, data } of sheets) {
      const idx = buildHeaderIndex(headers);

      for (let i = 0; i < data.length; i++) {
        rowCounter++;
        const row = data[i];
        const orderId = str(getCell(row, idx, 'amazon-order-id', 'order-id', 'Order ID'));
        const itemId  = str(getCell(row, idx, 'order-item-id'));  // header has trailing space — handled by buildHeaderIndex
        const sku     = str(getCell(row, idx, 'sku', 'SKU'));

        // Real Amazon order-item-id is the natural PK. If it's missing, skip the
        // row (we no longer synthesize AMZ-{order_id}-{sku}).
        if (!orderId || !itemId || !sku) {
          totalSkipped++;
          allSkipped.push({
            rowNum: rowCounter + 1,
            reason: !orderId ? 'amazon-order-id is empty'
                  : !itemId  ? 'order-item-id is empty — Order Reports MUST have this column populated'
                             : 'sku is empty',
            data: { sheet: sheetName, headers: headers.slice(0, 5), row: row.slice(0, 5) },
          });
          continue;
        }

        const validationError = validateLegacyAmazonOrderRow(row, idx, { report: true });
        if (validationError) {
          totalSkipped++;
          allSkipped.push({
            rowNum: rowCounter + 1,
            reason: validationError,
            data: { sheet: sheetName, headers: headers.slice(0, 8), row: row.slice(0, 8) },
          });
          continue;
        }

        // In-file duplicate guard: if the same real order-item-id appears twice
        // in the upload (rare — only on Amazon's side), keep the last occurrence.
        // batchUpsert dedupes by PK so we don't need to track here.
        seenKeys.add(itemId);

        const fulCh = str(getCell(row, idx, 'fulfillment-channel'));
        let fulfilType = fulCh;
        if (fulCh) {
          const f = fulCh.toLowerCase();
          if (f === 'amazon' || f === 'afn') fulfilType = 'FBA';
          else if (f === 'merchant' || f === 'mfn') fulfilType = 'Flex';
        }

        const orderObj = {
          order_item_id:           itemId,
          order_id:                orderId,
          merchant_order_id:       str(getCell(row, idx, 'merchant-order-id')),
          sku,
          fsn:                     str(getCell(row, idx, 'asin', 'ASIN')),  // ASIN stored as fsn (existing FK convention)
          product_name:            str(getCell(row, idx, 'product-name')),
          category:                (sku || "").startsWith("EJ") ? "Sarees & Dress Materials" : "Women's Kurtas & Kurtis",  // Logic based on SKU prefix
          fulfilment_type:         fulfilType,
          selling_channel:         str(getCell(row, idx, 'sales-channel')),
          order_channel:           str(getCell(row, idx, 'order-channel')),
          url:                     str(getCell(row, idx, 'url')),
          ship_service_level:      str(getCell(row, idx, 'ship-service-level')),
          order_date:              dt(getCell(row, idx, 'purchase-date')),
          purchase_date_time:      dtIso(getCell(row, idx, 'purchase-date')),
          last_updated_date:       dtIso(getCell(row, idx, 'last-updated-date')),
          order_status:            str(getCell(row, idx, 'order-status')),
          item_status:             str(getCell(row, idx, 'item-status')),
          qty:                     int(getCell(row, idx, 'quantity')),
          currency:                str(getCell(row, idx, 'currency')),
          final_invoice_amount:    num(getCell(row, idx, 'item-price')),
          item_tax:                num(getCell(row, idx, 'item-tax')),
          shipping_fee:            num(getCell(row, idx, 'shipping-price')),
          shipping_tax:            num(getCell(row, idx, 'shipping-tax')),
          gift_wrap_price:         num(getCell(row, idx, 'gift-wrap-price')),
          gift_wrap_tax:           num(getCell(row, idx, 'gift-wrap-tax')),
          item_promotion_discount: num(getCell(row, idx, 'item-promotion-discount')),
          ship_promotion_discount: num(getCell(row, idx, 'ship-promotion-discount')),
          delivery_city:           str(getCell(row, idx, 'ship-city')),
          delivery_state:          str(getCell(row, idx, 'ship-state')),
          delivery_pincode:        str(getCell(row, idx, 'ship-postal-code')),
          ship_country:            str(getCell(row, idx, 'ship-country')),
          promotion_ids:           str(getCell(row, idx, 'promotion-ids')),
          is_business_order:       bool(getCell(row, idx, 'is-business-order')),
          purchase_order_number:   str(getCell(row, idx, 'purchase-order-number')),
          price_designation:       str(getCell(row, idx, 'price-designation')),
          fulfilled_by:            str(getCell(row, idx, 'fulfilled-by')),
          is_replacement_order:    bool(getCell(row, idx, 'is-replacement-order')),
          is_exchange_order:       bool(getCell(row, idx, 'is-exchange-order')),
          original_order_id:       str(getCell(row, idx, 'original-order-id')),
          is_iba:                  bool(getCell(row, idx, 'is-iba')),
          brand_name:              AMAZON_BRAND,
          brand:                   AMAZON_BRAND,
          marketplace,
        };

        const fcCode = str(getCell(row, idx, 'fc', 'fulfillment-center-id'));
        let shippingZone = 'National';
        if (fcCode) {
          const uFcCode = fcCode.toUpperCase();
          const fcInfo = fcMap.get(uFcCode);
          if (fcInfo) {
            shippingZone = calculateAmazonZone(
              fcInfo.city, fcInfo.state, 
              orderObj.delivery_city, orderObj.delivery_state
            );
            if (fcInfo.fc_type) {
              orderObj.fulfilment_type = fcInfo.fc_type;
            }
          } else {
            // New FC detected
            newFCs.add(uFcCode);
            orderObj.fulfilment_type = 'FBA'; // Default to FBA for unknown FCs
          }
        }
        orderObj.shipping_zone = shippingZone;
        
        orderRows.push(orderObj);
      }
    }

    // ── UPSERT by (order_id, sku) — same natural key as Order Summary, so the
    // two uploaders converge on the same row whichever loads first. We can't
    // use batchUpsert's single-column-conflict helper here because our conflict
    // target is the partial unique index uq_orders_amazon_natural. Do it
    // explicitly per-row (batched for speed).
    const FIELDS = [
      'order_item_id','order_id','merchant_order_id','sku','fsn','product_name',
      'fulfilment_type','selling_channel','order_channel','url','ship_service_level',
      'order_date','purchase_date_time','last_updated_date','order_status','item_status',
      'qty','currency','final_invoice_amount','item_tax','shipping_fee','shipping_tax',
      'gift_wrap_price','gift_wrap_tax','item_promotion_discount','ship_promotion_discount',
      'delivery_city','delivery_state','delivery_pincode','ship_country','promotion_ids',
      'is_business_order','purchase_order_number','price_designation','fulfilled_by',
      'is_replacement_order','is_exchange_order','original_order_id','is_iba','brand_name','brand','marketplace',
      'shipping_zone','category'
    ];
    // Dedupe within this upload — keep last by (order_id, sku)
    const seenInUpload = new Map();
    for (const r of orderRows) seenInUpload.set(`${r.order_id}|${r.sku}`, r);
    const dedupedRows = [...seenInUpload.values()];
    if (!dedupedRows.length) {
      throw inputError('No valid Amazon Order Report rows were found. Review skipped-row reasons and correct the file before retrying.');
    }

    const updateSetParts = FIELDS
      .filter(f => f !== 'order_id' && f !== 'sku' && f !== 'marketplace')
      .map(f => `${f} = COALESCE(EXCLUDED.${f}, orders.${f})`).join(',\n            ');

    await forEachDbBatch(dedupedRows, FIELDS.length, async batch => {
      const values = [];
      const groups = batch.map(r => {
        const start = values.length;
        for (const f of FIELDS) values.push(r[f] ?? null);
        return `(${FIELDS.map((_, ci) => `$${start + ci + 1}`).join(',')})`;
      });
      const { rows: rrows } = await pool.query(`
        INSERT INTO orders (${FIELDS.join(',')}) VALUES ${groups.join(',')}
        ON CONFLICT (order_id, sku) WHERE marketplace = 'amazon' DO UPDATE SET
            ${updateSetParts},
            uploaded_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, values);
      for (const r of rrows) {
        if (r.inserted) totalInserted++;
        else            totalUpdated++;
      }
    });

    // Backfill from any existing settlement data (no-op if none uploaded yet)
    let backfilled = null;
    try {
      backfilled = await backfillOrdersFromSettlement(
        pool,
        dedupedRows.map(row => row.order_id),
      );
    } catch (e) {
      console.warn('[amazon-order-reports backfill]', e.message);
    }
    await refreshOrderSettlementTotals(pool);

    const logId = await logUpload(pool, 'amazon_order_reports', req.file.originalname, marketplace,
                                  totalInserted, totalUpdated, totalSkipped, 'ok');
    try { await saveSkippedRows(pool, logId, allSkipped); } catch {}

    res.json({
      ok: true,
      inserted: totalInserted, updated: totalUpdated, skipped: totalSkipped,
      total: rowCounter,
      sheets: sheets.map(s => ({ name: s.sheetName, rows: s.data.length })),
      ordersBackfilled: backfilled,
      logId,
    });
  } catch (e) {
    console.error('[amazon-order-reports]', e);
    try { await logUpload(getPool(), 'amazon_order_reports', req.file?.originalname, marketplace,
                          totalInserted, totalUpdated, totalSkipped, 'error', e.message); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2) POST /amazon-order-summary  — PRIMARY SALE SOURCE
//
//    Ingests the standard Amazon Order Summary export (16 cols):
//      Order ID, FNSKU, SKU, ASIN, Category, Fulfilment Type, Warehouse,
//      Order Date, QTY, Ship From City/State, Ship to City/State,
//      Selling Prices, Selling Zones, Shipping Zones
//
//    This is the canonical sale source. The Order Summary file has no
//    order-item-id column, so orders inserted here have order_item_id=NULL.
//    The natural key is (order_id, sku) under a partial UNIQUE index on
//    marketplace='amazon'. ON CONFLICT updates the row.
//
//    The real Amazon order-item-id arrives LATER via the Order Reports
//    uploader (POST /amazon-order-reports), which UPSERTs on the same
//    (order_id, sku) natural key and backfills order_item_id.
// ═════════════════════════════════════════════════════════════════════════════
// Current Amazon Sale Order export. This replaces the two-step Summary +
// Order Reports workflow and uses (order_id, merchant SKU) as the natural key.
router.post('/amazon-sale-orders', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const marketplace = 'amazon';
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const skippedRows = [];

  try {
    const pool = getPool();
    const { headers, data } = parseFile(req.file.buffer, ['Sale Orders', 'Orders', 'Sheet1']);
    req.file.buffer = null;
    if (!headers.length) return res.status(400).json({ error: 'File has no readable headers' });

    const requiredHeaders = [
      'Customer Shipment Date', 'Merchant SKU', 'FNSKU', 'ASIN', 'FC',
      'Quantity', 'Amazon Order Id', 'Currency', 'Product Amount',
      'Shipping Amount', 'Gift Amount', 'Shipment To City',
      'Shipment To State', 'Shipment To Postal Code',
    ];
    const normalizedHeaders = new Set(headers.map(header =>
      String(header).toLowerCase().replace(/[\s_-]+/g, ''),
    ));
    const missingHeaders = requiredHeaders.filter(header =>
      !normalizedHeaders.has(header.toLowerCase().replace(/[\s_-]+/g, '')),
    );
    if (missingHeaders.length) {
      return res.status(400).json({
        error: `This is not the current Amazon Sale Order template. Missing columns: ${missingHeaders.join(', ')}`,
      });
    }

    const fcMap = new Map();
    try {
      const { rows } = await pool.query('SELECT fc_code, city, state, fc_type FROM amazon_fc_master');
      for (const row of rows) fcMap.set(String(row.fc_code).toUpperCase(), row);
    } catch (error) {
      console.warn('[amazon-sale-orders] FC lookup unavailable:', error.message);
    }

    const idx = buildHeaderIndex(headers);
    const byNaturalKey = new Map();
    const affectedOrderIds = new Set();
    const newFCs = new Set();

    for (let index = 0; index < data.length; index++) {
      const row = data[index];
      const parsed = parseAmazonSaleOrderRow(row, idx);
      if (parsed.error) {
        skipped++;
        skippedRows.push({
          rowNum: index + 2,
          reason: parsed.error,
          data: { row: row.slice(0, 14) },
        });
        continue;
      }
      const {
        orderId, sku, fnsku, asin, shipmentDate, quantity, currency,
        productAmount, shippingAmount: saleShippingAmount, giftAmount: saleGiftAmount,
      } = parsed.values;

      const fcCode = str(getCell(row, idx, 'FC'))?.toUpperCase() || null;
      const deliveryCity = str(getCell(row, idx, 'Shipment To City'));
      const deliveryState = str(getCell(row, idx, 'Shipment To State'));
      const fcInfo = fcCode ? fcMap.get(fcCode) : null;
      let fulfilmentType = fcInfo?.fc_type || (fcCode === 'QWHF' ? 'Flex' : 'FBA');
      let shippingZone = 'National';
      if (fcInfo) {
        shippingZone = calculateAmazonZone(
          fcInfo.city,
          fcInfo.state,
          deliveryCity,
          deliveryState,
        );
      } else if (fcCode && fcCode !== 'QWHF') {
        newFCs.add(fcCode);
      }
      if (!fcCode) fulfilmentType = null;

      const invoiceAmount = productAmount + saleShippingAmount + saleGiftAmount;
      const record = {
        order_id: orderId,
        sku,
        fnsku,
        fsn: asin,
        warehouse_id: fcCode,
        fulfilment_type: fulfilmentType,
        order_date: shipmentDate,
        purchase_date_time: dtIso(getCell(row, idx, 'Customer Shipment Date')) || `${shipmentDate}T00:00:00.000Z`,
        qty: quantity,
        currency,
        product_amount: productAmount,
        sale_shipping_amount: saleShippingAmount,
        sale_gift_amount: saleGiftAmount,
        final_invoice_amount: invoiceAmount,
        delivery_city: deliveryCity,
        delivery_state: deliveryState,
        delivery_pincode: str(getCell(row, idx, 'Shipment To Postal Code')),
        brand_name: AMAZON_BRAND,
        brand: AMAZON_BRAND,
        marketplace,
        shipping_zone: shippingZone,
        category: (sku || "").startsWith("EJ") ? "Sarees & Dress Materials" : "Women's Kurtas & Kurtis",
      };

      const key = `${orderId}|${sku}`;
      if (byNaturalKey.has(key)) {
        const existing = byNaturalKey.get(key);
        existing.qty = (existing.qty || 0) + (record.qty || 0);
        existing.product_amount = (existing.product_amount || 0) + (record.product_amount || 0);
        existing.sale_shipping_amount = (existing.sale_shipping_amount || 0) + (record.sale_shipping_amount || 0);
        existing.sale_gift_amount = (existing.sale_gift_amount || 0) + (record.sale_gift_amount || 0);
        existing.final_invoice_amount = (existing.final_invoice_amount || 0) + (record.final_invoice_amount || 0);
      } else {
        byNaturalKey.set(key, record);
      }
      affectedOrderIds.add(orderId);
    }

    const rows = [...byNaturalKey.values()];
    if (!rows.length) throw inputError('No valid Amazon Sale Order rows were found. Review skipped-row reasons and correct the file before retrying.');
    const fields = [
      'order_id', 'sku', 'fnsku', 'fsn', 'warehouse_id', 'fulfilment_type',
      'order_date', 'purchase_date_time', 'qty', 'currency', 'product_amount',
      'sale_shipping_amount', 'sale_gift_amount', 'final_invoice_amount',
      'delivery_city', 'delivery_state', 'delivery_pincode', 'brand_name', 'brand', 'marketplace',
      'shipping_zone', 'category',
    ];
    const updateSet = fields
      .filter(field => !['order_id', 'sku', 'marketplace'].includes(field))
      .map(field => `${field} = COALESCE(EXCLUDED.${field}, orders.${field})`)
      .join(',\n            ');

    await forEachDbBatch(rows, fields.length, async batch => {
      const values = [];
      const groups = batch.map(record => {
        const start = values.length;
        for (const field of fields) values.push(record[field] ?? null);
        return `(${fields.map((_, column) => `$${start + column + 1}`).join(',')})`;
      });
      const result = await pool.query(`
        INSERT INTO orders (${fields.join(',')}) VALUES ${groups.join(',')}
        ON CONFLICT (order_id, sku) WHERE marketplace = 'amazon' DO UPDATE SET
            ${updateSet},
            uploaded_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, values);
      for (const resultRow of result.rows) {
        if (resultRow.inserted) inserted++;
        else updated++;
      }
    });

    let backfilled = null;
    try {
      backfilled = await backfillOrdersFromSettlement(pool, [...affectedOrderIds]);
    } catch (error) {
      console.warn('[amazon-sale-orders] settlement backfill:', error.message);
    }
    await refreshOrderSettlementTotals(pool);

    const logId = await logUpload(
      pool,
      'amazon_sale_orders',
      req.file.originalname,
      marketplace,
      inserted,
      updated,
      skipped,
      'ok',
    );
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}

    res.json({
      ok: true,
      processed: inserted + updated,
      inserted,
      updated,
      skipped,
      total: data.length,
      logId,
      newFCs: [...newFCs],
      ordersBackfilled: backfilled,
    });
  } catch (error) {
    console.error('[amazon-sale-orders]', error);
    try {
      await logUpload(
        getPool(),
        'amazon_sale_orders',
        req.file?.originalname,
        marketplace,
        inserted,
        updated,
        skipped,
        'error',
        error.message,
      );
    } catch {}
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Legacy endpoint retained for API compatibility; it is no longer shown in
// Data Hub and should not be used for new uploads.
router.post('/amazon-order-summary', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const marketplace = 'amazon';
  let inserted = 0, updated = 0, skipped = 0;
  const skippedRows = [];

  try {
    const pool = getPool();
    const { headers, data } = parseFile(req.file.buffer, ['Orders Details', 'Orders', 'Sheet1']);
    req.file.buffer = null;
    if (!headers.length) return res.status(400).json({ error: 'File has no readable headers' });

    const idx = buildHeaderIndex(headers);
    const seen = new Set();
    const affectedOrderIds = new Set();
    const newFCs = new Set();

    for (let i = 0; i < data.length; i++) {
      const row     = data[i];
      const orderId = str(getCell(row, idx, 'Order ID', 'amazon-order-id', 'order-id', 'Amazon Order Id'));
      const sku     = str(getCell(row, idx, 'SKU', 'sku', 'Merchant SKU'));

      if (!orderId || !sku) {
        skipped++;
        skippedRows.push({
          rowNum: i + 2,
          reason: !orderId ? 'Order ID is empty' : 'SKU is empty',
          data: { row: row.slice(0, 8) },
        });
        continue;
      }

      const validationError = validateLegacyAmazonOrderRow(row, idx);
      if (validationError) {
        skipped++;
        skippedRows.push({
          rowNum: i + 2,
          reason: validationError,
          data: { row: row.slice(0, 8) },
        });
        continue;
      }

      const dedupKey = `${orderId}|${sku}`;
      if (seen.has(dedupKey)) continue;   // file-internal dup, keep first
      seen.add(dedupKey);
      affectedOrderIds.add(orderId);

      const fnsku        = str(getCell(row, idx, 'FNSKU', 'fnsku'));
      const fsn          = str(getCell(row, idx, 'ASIN', 'asin'));
      let category = str(getCell(row, idx, 'Category', 'category'));
      if (!category && sku) {
        category = sku.startsWith("EJ") ? "Sarees & Dress Materials" : "Women's Kurtas & Kurtis";
      }
      let fulType        = str(getCell(row, idx, 'Fulfilment Type', 'Fulfillment Type', 'fulfilment-type'));
      if (fulType) {
        const f = fulType.toLowerCase();
        if (f === 'amazon' || f === 'afn') fulType = 'FBA';
        else if (f === 'merchant' || f === 'mfn') fulType = 'Flex';
      }
      const warehouseId  = str(getCell(row, idx, 'Warehouse', 'warehouse', 'Warehouse ID', 'FC'));
      
      let shippingZone = str(getCell(row, idx, 'Shipping Zones', 'Shipping Zone'));
      if (warehouseId) {
        const uFcCode = warehouseId.toUpperCase();
        if (uFcCode === 'QWHF') {
          if (!fulType) fulType = 'Flex';
        } else {
          if (!fulType) {
             fulType = 'FBA';
             newFCs.add(uFcCode);
          }
        }
      }

      const orderDate    = dt(getCell(row, idx, 'Order Date', 'order-date', 'purchase-date', 'Customer S', 'Customer Shipment Date'));
      const qty          = int(getCell(row, idx, 'QTY', 'Qty', 'quantity'));
      const shipFromCity = str(getCell(row, idx, 'Ship From City', 'ship-from-city'));
      const shipFromSt   = str(getCell(row, idx, 'Ship From State', 'ship-from-state'));
      const deliveryCity = str(getCell(row, idx, 'Ship to City', 'ship-city', 'Shipment To City'));
      const deliveryStat = str(getCell(row, idx, 'Ship to State', 'ship-state', 'Shipment To State'));
      const sellingPrice = num(getCell(row, idx, 'Selling Prices', 'Selling Price', 'item-price', 'Product Amount'));
      const sellingZone  = str(getCell(row, idx, 'Selling Zones', 'Selling Zone'));

      // UPSERT on (order_id, sku) where marketplace='amazon' — the partial
      // unique index uq_orders_amazon_natural makes this work. order_item_id
      // stays NULL until Order Reports uploader fills it in.
      try {
        const res2 = await pool.query(`
          INSERT INTO orders (
            order_id, sku, fnsku, fsn, category, fulfilment_type, warehouse_id,
            ship_from_city, ship_from_state, delivery_city, delivery_state,
            final_invoice_amount, qty, order_date, selling_zone, shipping_zone, brand_name, brand, marketplace
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, 'amazon'
          )
          ON CONFLICT (order_id, sku) WHERE marketplace = 'amazon' DO UPDATE SET
            fnsku                = COALESCE(EXCLUDED.fnsku,                orders.fnsku),
            fsn                  = COALESCE(EXCLUDED.fsn,                  orders.fsn),
            category             = COALESCE(EXCLUDED.category,             orders.category),
            fulfilment_type      = COALESCE(EXCLUDED.fulfilment_type,      orders.fulfilment_type),
            warehouse_id         = COALESCE(EXCLUDED.warehouse_id,         orders.warehouse_id),
            ship_from_city       = COALESCE(EXCLUDED.ship_from_city,       orders.ship_from_city),
            ship_from_state      = COALESCE(EXCLUDED.ship_from_state,      orders.ship_from_state),
            delivery_city        = COALESCE(EXCLUDED.delivery_city,        orders.delivery_city),
            delivery_state       = COALESCE(EXCLUDED.delivery_state,       orders.delivery_state),
            final_invoice_amount = COALESCE(EXCLUDED.final_invoice_amount, orders.final_invoice_amount),
            qty                  = COALESCE(EXCLUDED.qty,                  orders.qty),
            order_date           = COALESCE(EXCLUDED.order_date,           orders.order_date),
            selling_zone         = COALESCE(EXCLUDED.selling_zone,         orders.selling_zone),
            shipping_zone        = COALESCE(EXCLUDED.shipping_zone,        orders.shipping_zone),
            brand_name           = EXCLUDED.brand_name,
            brand                = EXCLUDED.brand,
            uploaded_at          = NOW()
          RETURNING (xmax = 0) AS inserted
        `, [orderId, sku, fnsku, fsn, category, fulType, warehouseId,
            shipFromCity, shipFromSt, deliveryCity, deliveryStat,
            sellingPrice, qty, orderDate, sellingZone, shippingZone, AMAZON_BRAND]);
        if (res2.rows[0]?.inserted) inserted++;
        else                        updated++;
      } catch (e) {
        skipped++;
        skippedRows.push({ rowNum: i + 2, reason: `Insert failed: ${e.message}`, data: { orderId, sku } });
      }
    }

    // If settlement data was uploaded earlier, populate per-fee columns now
    // that the orders rows exist. No-op if amazon_settlement_lines is empty.
    let backfilled = null;
    if (inserted + updated === 0) {
      throw inputError('No valid Amazon Order Summary rows were found. Review skipped-row reasons and correct the file before retrying.');
    }
    try {
      backfilled = await backfillOrdersFromSettlement(pool, [...affectedOrderIds]);
    } catch (e) {
      console.warn('[amazon-order-summary backfill]', e.message);
    }
    await refreshOrderSettlementTotals(pool);

    const logId = await logUpload(pool, 'amazon_order_summary', req.file.originalname, marketplace,
                                  inserted, updated, skipped, 'ok');
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}

    res.json({
      ok: true, inserted, updated, skipped, total: data.length, logId,
      ordersBackfilled: backfilled,
      newFCs: Array.from(newFCs),
      hint: inserted > 0
        ? 'Orders inserted without order-item-id (Order Summary has no such column). Upload Order Reports next to attach real 14-digit Amazon order-item-ids for payment linkage.'
        : null,
    });
  } catch (e) {
    console.error('[amazon-order-summary]', e);
    try { await logUpload(getPool(), 'amazon_order_summary', req.file?.originalname, marketplace,
                          inserted, updated, skipped, 'error', e.message); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3) POST /amazon-fba-returns
//    Amazon FBA Returns CSV. Columns:
//      return-date,order-id,sku,asin,fnsku,product-name,quantity,
//      fulfillment-center-id,detailed-disposition,reason,license-plate-number,
//      customer-comments
//
//    Natural key: license-plate-number (LPN, e.g. "LPNDEL2R70172809") — one per
//    physical return barcode. We store this DIRECTLY as `order_item_id` (no
//    synthesis). Cross-source linkage to orders uses (order_id, sku) at query
//    time, not a stored composite key.
//    fulfilment_type is hardcoded 'FBA'.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/amazon-fba-returns', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const marketplace = 'amazon';
  let inserted = 0, updated = 0, skipped = 0;
  const skippedRows = [];

  try {
    const pool = getPool();
    const { headers, data } = parseFile(req.file.buffer);
    req.file.buffer = null;
    if (!headers.length) return res.status(400).json({ error: 'File has no readable headers' });

    const idx = buildHeaderIndex(headers);
    if (!hasHeader(idx, 'license-plate-number', 'return-date', 'detailed-disposition')) {
      return res.status(400).json({ error: 'Invalid file format. Please upload an FBA Returns file.' });
    }

    const rows = [];
    const seen = new Set();

    for (let i = 0; i < data.length; i++) {
      const parsed = parseAmazonFbaReturnRow(data[i], idx);
      if (parsed.error) {
        skipped++;
        skippedRows.push({ rowNum: i + 2, reason: parsed.error, data: { row: data[i].slice(0, 12) } });
        continue;
      }
      if (seen.has(parsed.values.order_item_id)) {
        skipped++;
        skippedRows.push({ rowNum: i + 2, reason: 'Duplicate LPN + order-id in this file', data: { row: data[i].slice(0, 12) } });
        continue;
      }
      seen.add(parsed.values.order_item_id);
      rows.push(parsed.values);
    }

    if (!rows.length) throw inputError('No valid FBA return rows were found. Review the skipped-row details and upload a corrected file.');

    const FIELDS = [
      'order_item_id','return_id','license_plate_number','order_id','sku',
      'fsn','asin','fnsku','product_title','quantity','warehouse_id','disposition','return_result',
      'return_reason','customer_comment','return_sub_reason','return_date','return_date_time',
      'return_approval_date','fulfilment_type','return_type','marketplace',
    ];

    const r = await batchUpsert(pool, 'returns', 'order_item_id', FIELDS, rows);
    inserted = r.inserted;
    updated  = r.updated;

    const logId = await logUpload(pool, 'amazon_fba_returns', req.file.originalname, marketplace,
                                  inserted, updated, skipped, 'ok');
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}
    clearSkuSettlementBenchmarkCache('amazon');

    res.json({ ok: true, inserted, updated, skipped, total: data.length, logId });
  } catch (e) {
    console.error('[amazon-fba-returns]', e);
    try { await logUpload(getPool(), 'amazon_fba_returns', req.file?.originalname, marketplace,
                          inserted, updated, skipped, 'error', e.message); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4) POST /amazon-flex-returns
//    Amazon Flex (Seller Flex) returns reconciliation CSV. Columns:
//      Return Type,Customer Order ID,Shipment ID,SKU,mSKU,ASIN,
//      External ID1,External ID2,External ID3,Units,
//      Forward Leg Tracking ID,Reverse Leg Tracking ID,RMA ID,
//      Return Status,Carrier,Pick -up date,Last Updated On,
//      Returned with OTP,Days In-transit,Days Since Return Complete,Return Reason
//
//    ⚠️ COLUMN NAME SWAP:
//      file's  "SKU"  = FNSKU (Amazon barcode like X002…)
//      file's  "mSKU" = seller SKU  (joins to orders.sku)
// ═════════════════════════════════════════════════════════════════════════════
router.post('/amazon-flex-returns', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const marketplace = 'amazon';
  let inserted = 0, updated = 0, skipped = 0;
  const skippedRows = [];

  try {
    const pool = getPool();
    const { headers, data } = parseFile(req.file.buffer);
    req.file.buffer = null;
    if (!headers.length) return res.status(400).json({ error: 'File has no readable headers' });

    const idx = buildHeaderIndex(headers);
    if (!hasHeader(idx, 'RMA ID', 'Customer Order ID', 'Return Type')) {
      return res.status(400).json({ error: 'Invalid file format. Please upload an Amazon Flex Returns file.' });
    }
    const byNaturalKey = new Map();

    for (let i = 0; i < data.length; i++) {
      const parsed = parseAmazonFlexReturnRow(data[i], idx);
      if (parsed.error) {
        skipped++;
        skippedRows.push({ rowNum: i + 2, reason: parsed.error, data: { row: data[i].slice(0, 18) } });
        continue;
      }
      const record = parsed.values;

      if (byNaturalKey.has(record.order_item_id)) {
        const existing = byNaturalKey.get(record.order_item_id);
        existing.quantity = (existing.quantity || 0) + (record.quantity || 0);
        existing.units = (existing.units || 0) + (record.units || 0);
      } else {
        byNaturalKey.set(record.order_item_id, record);
      }
    }

    const rows = [...byNaturalKey.values()];
    if (!rows.length) throw inputError('No valid Flex return rows were found. Review the skipped-row details and upload a corrected file.');

    const FIELDS = [
      'order_item_id','return_id','rma_id','order_id','sku','fnsku','fsn','asin',
      'shipment_id','quantity','units','forward_tracking_id','reverse_logistics_tracking_id',
      'return_status','carrier','return_requested_date','return_approval_date','returned_with_otp',
      'days_in_transit','days_since_return_complete','return_reason','return_type',
      'fulfilment_type','marketplace',
    ];

    const r = await batchUpsert(pool, 'returns', 'order_item_id', FIELDS, rows);
    inserted = r.inserted;
    updated  = r.updated;
    const receivedMarked = await markFlexReturnsReceived(pool, rows);

    const logId = await logUpload(pool, 'amazon_flex_returns', req.file.originalname, marketplace,
                                  inserted, updated, skipped, 'ok');
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}
    clearSkuSettlementBenchmarkCache('amazon');

    res.json({ ok: true, inserted, updated, skipped, total: data.length, receivedMarked, logId });
  } catch (e) {
    console.error('[amazon-flex-returns]', e);
    try { await logUpload(getPool(), 'amazon_flex_returns', req.file?.originalname, marketplace,
                          inserted, updated, skipped, 'error', e.message); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5) POST /amazon-settlement   (LONG-FORMAT REWRITE)
//
//    Flat-File Settlement V2 — 24 columns. Row 1 = envelope (settlement-id +
//    dates + total-amount only); rows 2+ = line items with the trinity:
//      transaction-type × amount-type × amount-description + signed amount.
//
//    Inserts:
//      - one row into amazon_settlements  (envelope)
//      - many rows into amazon_settlement_lines (each fee/tax/refund/principal)
//
//    Links each line back to orders (at query time, not stored):
//      - order_item_code present (real 14-digit) → exact match on orders.order_item_id
//      - only order_id present                   → fan-out match on orders.order_id
//                                                  (e.g. Fulfillment Fee Refund lines)
//      - neither present                         → true non-order (storage, ads, …)
//
//    Guards against XLSX precision loss in order-item-code (scientific notation).
// ═════════════════════════════════════════════════════════════════════════════
router.post('/amazon-settlement', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const marketplace = 'amazon';
  let envelopeInserted = 0, linesInserted = 0, replacedLines = 0, skipped = 0;
  let scientificWarning = false;
  let pool;
  const skippedRows = [];

  try {
    pool = getPool();
    const { headers, data } = parseFile(req.file.buffer);
    req.file.buffer = null;
    if (!headers.length) return res.status(400).json({ error: 'File has no readable headers' });

    const idx = buildHeaderIndex(headers);
    if (!hasHeader(idx, 'settlement-id', 'amount-description', 'amount-type')) {
      return res.status(400).json({ error: 'Invalid file format. Please upload an Amazon Settlement (Payment) file.' });
    }

    // ── Envelopes (Summary rows) ─────────────────────────────────────────────
    const envelopes = new Map();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const sid = str(getCell(row, idx, 'settlement-id'));
      const rawTotalAmount = getCell(row, idx, 'total-amount');
      const totalAmt = num(rawTotalAmount);
      const txType   = str(getCell(row, idx, 'transaction-type'));
      if (sid && rawTotalAmount && !txType && totalAmt == null) {
        skipped++;
        skippedRows.push({ rowNum: i + 2, reason: `invalid total-amount: ${rawTotalAmount}`, data: { row: row.slice(0, 12) } });
        continue;
      }
      // Envelope detection: settlement-id present, and either total-amount
      // present OR no transaction-type (i.e. it's the summary row, not a line).
      if (sid && (totalAmt != null || !txType)) {
        envelopes.set(sid, {
          sid, totalAmt,
          startDt: dt(getCell(row, idx, 'settlement-start-date')),
          endDt:   dt(getCell(row, idx, 'settlement-end-date')),
          depDt:   dt(getCell(row, idx, 'deposit-date')),
        });
      }
    }

    // ── Line items (data rows) ──────────────────────────────────────────────
    const lines = [];
    let lastSeenSid = null;

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const currentSid = str(getCell(row, idx, 'settlement-id'));
      if (currentSid) lastSeenSid = currentSid;
      const parsed = parseAmazonSettlementLine(row, idx, { fallbackSettlementId: lastSeenSid });
      if (parsed.skip) {
        continue;
      }
      if (parsed.error) {
        skipped++;
        skippedRows.push({ rowNum: i + 2, reason: parsed.error, data: { row: row.slice(0, 16) } });
        continue;
      }
      if (parsed.scientificOrderItemCode) {
        scientificWarning = true;
      }
      lines.push(parsed.values);
    }

    if (!lines.length) {
      throw inputError('Settlement report has no valid transaction lines. Review skipped-row reasons and correct the file before retrying.');
    }
    if (lines.some(line => !line.settlement_id)) {
      throw inputError('Every settlement line needs a settlement-id or a valid envelope row');
    }

    const settlementIds = [...new Set(lines.map(line => line.settlement_id))];

    const totalRows = data.length;
    data.length = 0;

    let allAffectedOrderIds = new Set();
    let totalSkuResolved = 0;

    // Process each settlement sequentially
    for (const sid of settlementIds) {
      const settlementLines = lines.filter(line => line.settlement_id === sid);
      const envelope = envelopes.get(sid) || null;

      const replacement = await replaceAmazonSettlement({
        pool,
        settlementId: sid,
        envelope,
        filename: req.file.originalname,
        lines: settlementLines,
      });

      envelopeInserted += replacement.envelopeInserted;
      linesInserted += replacement.linesInserted;
      replacedLines += replacement.replacedLines;

      replacement.affectedOrderIds.forEach(id => allAffectedOrderIds.add(id));

      const skuResolved = await resolveOrphanSkus(pool, sid);
      totalSkuResolved += skuResolved.totalResolved;
      // A resolver can update SKU/item-code linkage after the transactional
      // replacement. Rebuild this settlement once more so the reporting read
      // model reflects that final linkage before the upload response returns.
      await refreshAmazonSettlementReportingRollups(pool, sid);
    }

    // ── Backfill orders table from settlement aggregates ────────────────────
    const ordersBackfilled = await backfillOrdersFromSettlement(
      pool,
      allAffectedOrderIds,
      { resetMissing: true },
    );
    await refreshOrderSettlementTotals(pool);

    const logId = await logUpload(pool, 'amazon_settlement', req.file.originalname, marketplace,
                                  linesInserted, replacedLines, skipped, 'ok');
    await saveSkippedRows(pool, logId, skippedRows);
    clearSkuSettlementBenchmarkCache('amazon');
    void notifySkuSettlementBenchmarkAfterImport(pool, 'amazon')
      .catch(error => console.warn('[sku settlement notification]', error.message));

    res.json({
      ok: true,
      settlement_ids:   settlementIds,
      envelopeInserted,
      linesInserted,
      replacedLines,
      skipped,
      total:            totalRows,
      skuResolution:    totalSkuResolved,
      ordersBackfilled,        // { rowsUpdated, distinctOrders }
      scientificNotationWarning: scientificWarning
        ? 'order-item-code values appear to have been corrupted to scientific notation by XLSX. Linkage via order_id is unaffected, but for exact item-level match download the settlement as CSV/TSV instead of XLSX.'
        : null,
      logId,
    });
  } catch (e) {
    console.error('[amazon-settlement]', e);
    try {
      const logPool = pool || getPool();
      const logId = await logUpload(logPool, 'amazon_settlement', req.file?.originalname, marketplace,
        linesInserted, 0, skipped, 'error', e.message);
      await saveSkippedRows(logPool, logId, skippedRows);
    } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveOrphanSkus — backfill sku on settlement lines that arrived without one.
//
// Targets: Fulfillment Fee Refund rows (and any other rows with NULL sku that
// have an order_id). For each, finds the matching ORIGINAL charge and copies
// its sku.
//
// Three-phase strategy, applied in order:
//
//   Phase A: Order has only 1 distinct SKU
//            → directly assign that SKU. Trivial, no ambiguity.
//
//   Phase B+C: Order has multiple SKUs. Find originals matching
//            (order_id, amount_description, ABS(amount)). Use ROW_NUMBER()
//            to pair the Nth refund to the Nth original — this handles BOTH:
//            (B) unique amount match (different SKUs with different fees)
//            (C) same-amount group (same product different colors — same FBA
//                fee). Greedy 1:1 pairing keeps per-SKU sums correct.
//
//   Phase D: No matching original in DB. Leaves sku NULL. The line stays in
//            order-level reports (joined by order_id alone). These are
//            typically refunds for charges that landed in a previous
//            settlement period not present in this DB.
//
// Optionally scoped to a single settlement_id; pass null to run globally.
// Idempotent — re-running has no effect on already-resolved rows.
// ═════════════════════════════════════════════════════════════════════════════
async function resolveOrphanSkus(pool, settlementId = null) {
  const scope = settlementId ? `AND l.settlement_id = $1` : '';
  const args  = settlementId ? [settlementId] : [];

  // Snapshot how many orphans we started with (for reporting)
  const before = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM amazon_settlement_lines l
     WHERE l.sku IS NULL
       AND l.order_id IS NOT NULL
       AND l.transaction_type = 'Fulfillment Fee Refund'
       ${scope}
  `, args);
  const orphansBefore = before.rows[0].n;

  // ── Phase A: single-SKU orders ──────────────────────────────────────────
  const phaseA = await pool.query(`
    WITH target_orders AS (
      SELECT DISTINCT l.order_id
      FROM amazon_settlement_lines l
      WHERE l.sku IS NULL
        AND l.order_id IS NOT NULL
        AND l.transaction_type = 'Fulfillment Fee Refund'
        ${scope}
    ),
    single_sku_orders AS (
      SELECT source.order_id,
             MAX(source.sku) AS sku,
             MAX(source.order_item_code) AS order_item_code
      FROM amazon_settlement_lines source
      JOIN target_orders target ON target.order_id = source.order_id
      WHERE source.sku IS NOT NULL
      GROUP BY source.order_id
      HAVING COUNT(DISTINCT source.sku) = 1
    )
    UPDATE amazon_settlement_lines AS l
       SET sku = sub.sku, order_item_code = sub.order_item_code
      FROM single_sku_orders sub
     WHERE l.order_id = sub.order_id
       AND l.sku IS NULL
       AND l.transaction_type = 'Fulfillment Fee Refund'
       ${scope}
    RETURNING l.id
  `, args);

  // ── Phase B+C: multi-SKU orders — window-function pairing ───────────────
  // For each (order_id, amount_description, ABS(amount)) group, pair the Nth
  // refund row to the Nth original-charge row by row_number.
  const phaseBC = await pool.query(`
    WITH refunds_to_resolve AS (
      SELECT id, order_id, amount_description, amount,
             ROW_NUMBER() OVER (
               PARTITION BY order_id, amount_description, ABS(amount)
               ORDER BY posted_at NULLS LAST, id
             ) AS rn
        FROM amazon_settlement_lines l
       WHERE l.transaction_type = 'Fulfillment Fee Refund'
         AND l.sku IS NULL
         AND l.order_id IS NOT NULL
         ${scope}
    ),
    originals_indexed AS (
      SELECT original.order_id, original.amount_description, ABS(original.amount) AS abs_amt,
             original.sku, original.order_item_code,
             ROW_NUMBER() OVER (
               PARTITION BY original.order_id, original.amount_description, ABS(original.amount)
               ORDER BY original.posted_at NULLS LAST, original.id
             ) AS rn
      FROM amazon_settlement_lines original
      JOIN (SELECT DISTINCT order_id FROM refunds_to_resolve) target
        ON target.order_id = original.order_id
      WHERE original.transaction_type IN ('Order','Refund')
        AND original.sku IS NOT NULL
        AND original.amount IS NOT NULL
    )
    UPDATE amazon_settlement_lines AS l
       SET sku = o.sku, order_item_code = o.order_item_code
      FROM refunds_to_resolve r
      JOIN originals_indexed o
        ON  r.order_id           = o.order_id
       AND  r.amount_description = o.amount_description
       AND  ABS(r.amount)        = o.abs_amt
       AND  r.rn                 = o.rn
     WHERE l.id = r.id
    RETURNING l.id
  `, args);

  // How many remain orphans
  const after = await pool.query(`
    SELECT COUNT(*)::int AS n
      FROM amazon_settlement_lines l
     WHERE l.sku IS NULL
       AND l.order_id IS NOT NULL
       AND l.transaction_type = 'Fulfillment Fee Refund'
       ${scope}
  `, args);
  const stillOrphan = after.rows[0].n;

  return {
    orphansBefore,
    phaseA_resolved:  phaseA.rowCount,
    phaseBC_resolved: phaseBC.rowCount,
    totalResolved:    phaseA.rowCount + phaseBC.rowCount,
    stillOrphan,
    pctResolved: orphansBefore ? +(100 * (orphansBefore - stillOrphan) / orphansBefore).toFixed(1) : 100,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /amazon-settlement/resolve-skus
//   Manually re-run the SKU resolver across all existing settlement data.
//   Useful after data corrections, schema changes, or when historical files
//   are loaded retroactively.
//   Body: { settlement_id?: string }   — restrict to one settlement if provided
// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
// backfillOrdersFromSettlement — populate orders.{settlement_amount, commission,
// fixed_fee, pick_pack_fee, shipping_fee, tcs, tds, spf_amount} from the
// long-format amazon_settlement_lines table.
//
// This is the bridge that makes Amazon orders show up in every existing
// dashboard endpoint. Without it: orders.settlement_amount stays NULL for
// Amazon → dashboards show ₹0 settlement for every Amazon order.
//
// Mapping (settlement category → orders column):
//   order_revenue (Order+Refund)    → (informational only; not written)
//   order_commission                → commission
//   order_closing_fee + tech_fee    → fixed_fee   (Amazon's flat overhead)
//   order_fba_fee                   → pick_pack_fee  (FBA Weight Handling+P&P)
//   order_shipping                  → shipping_fee
//   order_tcs                       → tcs
//   order_tds                       → tds
//   inventory_reimbursement         → spf_amount (Amazon's lost-item credits)
//   sum of ALL amounts              → settlement_amount  (the net deposit value)
//
// Values are stored SIGNED — same convention Amazon uses (deductions negative).
// Idempotent: re-running overwrites with the latest aggregate across every
// settlement for each affected order. A null scope performs a full repair.
// ═════════════════════════════════════════════════════════════════════════════
async function backfillOrdersFromSettlement(pool, affectedOrderIds = null, { resetMissing = false } = {}) {
  const scopedOrderIds = Array.isArray(affectedOrderIds)
    ? [...new Set(affectedOrderIds.filter(Boolean))]
    : null;
  if (scopedOrderIds && !scopedOrderIds.length) {
    return { rowsUpdated: 0, distinctOrders: 0 };
  }

  const params = scopedOrderIds ? [scopedOrderIds] : [];
  const lineScope = scopedOrderIds ? 'AND l.order_id = ANY($1::text[])' : '';
  const orderScope = scopedOrderIds ? 'AND order_id = ANY($1::text[])' : '';
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    if (resetMissing) {
      // A replacement file may remove an old fee or order entirely.
      await client.query(`
        UPDATE orders SET
          settlement_amount = 0,
          return_received_amount = 0,
          commission = 0,
          fixed_fee = 0,
          pick_pack_fee = 0,
          shipping_fee = 0,
          tcs = 0,
          tds = 0,
          spf_amount = 0
        WHERE marketplace = 'amazon' ${orderScope}
      `, params);
    }

    const { rowCount } = await client.query(`
    WITH classified AS (
      SELECT
        l.order_id, l.sku, l.amount, l.transaction_type, l.amount_description,
        ${CATEGORY_CASE_SQL} AS category
      FROM amazon_settlement_lines l
      WHERE l.order_id IS NOT NULL AND l.sku IS NOT NULL ${lineScope}
    ),
    pivoted AS (
      SELECT
        order_id, sku,

        -- ── Sale Amount = Principal + Product Tax from Order rows only ──
        -- This is what the customer ACTUALLY paid for this line item
        -- (post-discount, inclusive of GST). User example:
        --   Principal 951.43 + Product Tax 47.57 = ₹999.00
        COALESCE(SUM(amount) FILTER (
          WHERE transaction_type = 'Order'
            AND amount_description IN ('Principal','Product Tax')
        ), 0) AS gross_sale_amount,

        -- Net Settlement = SUM of everything in this (order_id, sku) group
        -- across ALL settlement files (SUMIF behavior). User example: ₹914.22
        COALESCE(SUM(amount),                                                                    0) AS settlement_amount,

        -- Refund principal (negative when customer returned)
        COALESCE(SUM(amount) FILTER (
          WHERE transaction_type = 'Refund' AND amount_description = 'Principal'
        ), 0) AS return_received_amount,

        -- Per-fee category totals (signed; deductions negative)
        COALESCE(SUM(amount) FILTER (WHERE category = 'order_commission'),                       0) AS commission,
        COALESCE(SUM(amount) FILTER (WHERE category IN ('order_closing_fee','order_tech_fee')),  0) AS fixed_fee,
        COALESCE(SUM(amount) FILTER (WHERE category = 'order_fba_fee'),                          0) AS pick_pack_fee,
        COALESCE(SUM(amount) FILTER (WHERE category = 'order_shipping'),                         0) AS shipping_fee,
        COALESCE(SUM(amount) FILTER (WHERE category = 'order_tcs'),                              0) AS tcs,
        COALESCE(SUM(amount) FILTER (WHERE category = 'order_tds'),                              0) AS tds,
        COALESCE(SUM(amount) FILTER (WHERE category = 'inventory_reimbursement'),                0) AS spf_amount,

        BOOL_OR(transaction_type = 'Refund') AS has_refund
      FROM classified
      GROUP BY order_id, sku
    )
    UPDATE orders o SET
      -- Gross sale amount (only overwrite if settlement actually has a value)
      final_invoice_amount   = COALESCE(NULLIF(p.gross_sale_amount, 0), o.final_invoice_amount),
      settlement_amount      = p.settlement_amount,
      return_received_amount = ABS(p.return_received_amount),

      commission        = p.commission,
      fixed_fee         = p.fixed_fee,
      pick_pack_fee     = p.pick_pack_fee,
      shipping_fee      = p.shipping_fee,
      tcs               = p.tcs,
      tds               = p.tds,
      spf_amount        = p.spf_amount,
      brand_name        = '${AMAZON_BRAND}',
      brand             = '${AMAZON_BRAND}',

      -- Reflect the refund in orders_status if not already set
      orders_status     = CASE
                            WHEN p.has_refund AND COALESCE(o.orders_status,'') = '' THEN 'Returned'
                            ELSE o.orders_status
                          END
    FROM pivoted p
    WHERE o.order_id = p.order_id
      AND o.sku      = p.sku
      AND o.marketplace = 'amazon'
    RETURNING o.id
    `, params);
    await client.query('COMMIT');
    return { rowsUpdated: rowCount, distinctOrders: rowCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /amazon-settlement/backfill-orders
//   Manually re-run the orders backfill across all existing settlement data.
//   Run after correcting settlement data, or once after deploying this code
//   to populate orders for previously-uploaded Amazon settlements.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/amazon-settlement/backfill-orders', express.json(), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await backfillOrdersFromSettlement(getPool());
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[amazon-settlement/backfill-orders]', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/amazon-settlement/resolve-skus', express.json(), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const settlementId = req.body?.settlement_id || null;
    const result = await resolveOrphanSkus(getPool(), settlementId);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[amazon-settlement/resolve-skus]', e);
    res.status(500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /amazon-settlement/pivot
//   Pivots the row-wise settlement lines into a wide, column-wise P&L view.
//   ONE row per (order_id, sku, order_item_code) with SUM(amount) per fee
//   category — exactly like Flipkart's columnar settlement format, so the
//   data is directly comparable across marketplaces.
//
//   Query params:
//     month         — restrict to YYYY-MM by posted_date (e.g. "2026-05")
//     settlement_id — restrict to one settlement
//     order_id      — restrict to one order
//     sku           — restrict to one SKU
//     fulfilment    — 'FBA' | 'Flex'  (joined from orders table)
//     page, pageSize (default 1, 100; max 1000)
//
//   Response shape:
//     {
//       grand:        { gross_principal, taxes_total, ... net_amount, line_count, order_count },
//       rows:         [ per-(order_id, sku) pivoted rows enriched with order data ],
//       pagination:   { page, pageSize, total }
//     }
// ═════════════════════════════════════════════════════════════════════════════
router.get('/amazon-settlement/pivot', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });

  try {
    const pool = getPool();
    const { settlement_id, month, order_id, sku, fulfilment } = req.query;
    // only_multi_settlement=true → only return (order_id, sku) pairs that
    // appear in MORE than one settlement file. Useful for surfacing orders
    // that were settled in one payout and refunded later in another.
    // only_with_refund=true → only return orders that have at least one
    // Refund or Fulfillment Fee Refund line.
    const onlyMultiSettlement = String(req.query.only_multi_settlement || '').toLowerCase() === 'true';
    const onlyWithRefund      = String(req.query.only_with_refund      || '').toLowerCase() === 'true';
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 100, maxPageSize: 1000 });

    // ── WHERE clause builder ─────────────────────────────────────────────────
    const where = ['l.order_id IS NOT NULL'];
    const params = [];
    const push = (clause, ...vals) => { vals.forEach(v => params.push(v)); where.push(clause); };

    if (settlement_id) push(`l.settlement_id = $${params.length+1}`, settlement_id);
    const monthRange = amazonMonthRange(month);
    if (monthRange) {
      params.push(monthRange.start, monthRange.end);
      where.push(
        `l.posted_date >= $${params.length - 1}::date`,
        `l.posted_date < $${params.length}::date`,
      );
    }
    if (order_id)      push(`l.order_id = $${params.length+1}`, order_id);
    if (sku)           push(`l.sku = $${params.length+1}`, sku);
    if (fulfilment) {
      params.push(fulfilment);
      where.push(`EXISTS (
        SELECT 1 FROM orders fulfilment_order
        WHERE fulfilment_order.order_id = l.order_id
          AND fulfilment_order.sku = l.sku
          AND fulfilment_order.marketplace = 'amazon'
          AND fulfilment_order.fulfilment_type = $${params.length}
      )`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    // ── Pivot CTE ───────────────────────────────────────────────────────────
    // 1. Classify each line by category (reuses the global CATEGORY_CASE_SQL).
    // 2. GROUP BY (order_id, sku, order_item_code) with SUM(...) FILTER per
    //    category to pivot.
    // 3. LEFT JOIN orders so the wide row also carries order_date, qty,
    //    fulfilment_type, brand_name, final_invoice_amount, warehouse, etc.
    const pivotSql = `
      WITH classified AS (
        SELECT
          l.id, l.order_id, l.sku, l.order_item_code, l.settlement_id,
          l.posted_date, l.transaction_type, l.amount, l.amount_description,
          ${CATEGORY_CASE_SQL} AS category
        FROM amazon_settlement_lines l
        ${whereSql}
      ),
      pivoted AS (
        SELECT
          c.order_id,
          c.sku,
          MAX(c.order_item_code)                                        AS order_item_code,
          MAX(c.settlement_id)                                          AS last_settlement_id,
          COUNT(DISTINCT c.settlement_id)                               AS settlement_count,
          ARRAY_AGG(DISTINCT c.settlement_id ORDER BY c.settlement_id)  AS settlement_ids,
          MIN(c.posted_date)                                            AS first_posted,
          MAX(c.posted_date)                                            AS last_posted,
          COUNT(*)                                                      AS line_count,

          -- ── Transaction-type breakdown (proves multi-payout aggregation) ──
          COUNT(*) FILTER (WHERE c.transaction_type = 'Order')                  AS lines_order,
          COUNT(*) FILTER (WHERE c.transaction_type = 'Refund')                 AS lines_refund,
          COUNT(*) FILTER (WHERE c.transaction_type = 'Fulfillment Fee Refund') AS lines_fee_refund,
          (COUNT(*) FILTER (WHERE c.transaction_type = 'Refund') > 0)           AS has_refund,
          (COUNT(*) FILTER (WHERE c.transaction_type = 'Fulfillment Fee Refund') > 0) AS has_fee_refund,

          -- ── Revenue (positive on Order, negative on Refund) ─────────
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_revenue' AND c.transaction_type='Order'),  0) AS gross_principal,
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_revenue' AND c.transaction_type='Refund'), 0) AS refund_principal,

          -- ── Sale Amount = Principal + Product Tax from Order rows only ──
          -- Matches what the customer actually paid (post-discount, incl GST).
          COALESCE(SUM(c.amount) FILTER (
            WHERE c.transaction_type = 'Order'
              AND c.amount_description IN ('Principal','Product Tax')
          ), 0) AS sale_amount,

          -- ── Customer-paid passthroughs ──────────────────────────────
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_tax'),         0) AS taxes_total,
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_shipping'),    0) AS shipping_total,
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_gift_wrap'),   0) AS gift_wrap_total,

          -- ── Amazon fees (deductions; will be negative) ──────────────
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_commission'),   0) AS commission_total,
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_fba_fee'),      0) AS fba_fee_total,
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_closing_fee'),  0) AS closing_fee_total,
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_tech_fee'),     0) AS tech_fee_total,

          -- ── Statutory deductions ────────────────────────────────────
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_tcs'),          0) AS tcs_total,
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_tds'),          0) AS tds_total,

          -- ── Promotions (Amazon-funded vs seller-funded discounts) ───
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='order_promotion'),    0) AS promotion_total,

          -- ── Per-order credits ───────────────────────────────────────
          COALESCE(SUM(c.amount) FILTER (WHERE c.category='inventory_reimbursement'),                0) AS inventory_reimbursement,
          COALESCE(SUM(c.amount) FILTER (WHERE c.transaction_type='Fulfillment Fee Refund'),         0) AS fee_refunds,

          -- ── Net (sum of everything) ─────────────────────────────────
          COALESCE(SUM(c.amount), 0) AS net_settled
        FROM classified c
        GROUP BY c.order_id, c.sku
      )
      SELECT
        p.*,
        o.order_item_id           AS real_order_item_id,
        o.order_date,
        o.qty,
        o.fulfilment_type,
        o.brand_name,
        o.category                AS product_category,
        o.warehouse_id,
        o.shipping_zone,
        o.final_invoice_amount    AS expected_revenue,
        sm.master_sku,
        sm.cogs
      FROM pivoted p
      LEFT JOIN orders o
        ON o.order_id = p.order_id AND o.sku = p.sku AND o.marketplace = 'amazon'
      LEFT JOIN (
        SELECT
          listing_sku,
          COALESCE(
            MAX(master_sku) FILTER (WHERE marketplace = 'amazon'),
            MAX(master_sku)
          ) AS master_sku,
          COALESCE(
            MAX(cogs) FILTER (WHERE marketplace = 'amazon'),
            MAX(cogs)
          ) AS cogs
        FROM sku_master
        WHERE marketplace IN ('amazon', 'all')
        GROUP BY listing_sku
      ) sm ON sm.listing_sku = p.sku
      WHERE 1=1
        ${onlyMultiSettlement ? 'AND p.settlement_count > 1' : ''}
        ${onlyWithRefund      ? 'AND (p.has_refund OR p.has_fee_refund)' : ''}
      ORDER BY p.first_posted DESC NULLS LAST, p.order_id, p.sku
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    // ── Grand totals (across the filtered set, before pagination) ───────────
    const grandSql = `
      WITH classified AS (
        SELECT
          l.id, l.order_id, l.sku, l.settlement_id, l.transaction_type, l.amount, l.amount_description,
          ${CATEGORY_CASE_SQL} AS category
        FROM amazon_settlement_lines l
        ${whereSql}
      ),
      per_order AS (
        -- One row per (order_id, sku) with its settlement_count — used to count
        -- how many orders span multiple settlement payouts.
        SELECT
          order_id,
          sku,
          COUNT(DISTINCT settlement_id) AS settlement_count,
          BOOL_OR(transaction_type IN ('Refund', 'Fulfillment Fee Refund')) AS has_refund
        FROM classified
        GROUP BY order_id, sku
      ),
      eligible AS (
        SELECT order_id, sku, settlement_count
        FROM per_order
        WHERE 1=1
          ${onlyMultiSettlement ? 'AND settlement_count > 1' : ''}
          ${onlyWithRefund ? 'AND has_refund' : ''}
      )
      SELECT
        COUNT(*)                                                   AS line_count,
        (SELECT COUNT(*) FROM eligible)                            AS order_count,
        (SELECT COUNT(*) FROM eligible WHERE settlement_count > 1) AS multi_settlement_order_count,
        COUNT(DISTINCT settlement_id)                              AS settlement_count,
        COALESCE(SUM(amount) FILTER (WHERE category='order_revenue' AND transaction_type='Order'),  0) AS gross_principal,
        COALESCE(SUM(amount) FILTER (WHERE category='order_revenue' AND transaction_type='Refund'), 0) AS refund_principal,
        -- Sale Amount = Principal + Product Tax (what customer paid, incl GST)
        COALESCE(SUM(amount) FILTER (
          WHERE transaction_type='Order' AND amount_description IN ('Principal','Product Tax')
        ),                                                                                          0) AS sale_amount,
        COALESCE(SUM(amount) FILTER (WHERE category='order_tax'),                                   0) AS taxes_total,
        COALESCE(SUM(amount) FILTER (WHERE category='order_shipping'),                              0) AS shipping_total,
        COALESCE(SUM(amount) FILTER (WHERE category='order_gift_wrap'),                             0) AS gift_wrap_total,
        COALESCE(SUM(amount) FILTER (WHERE category='order_commission'),                            0) AS commission_total,
        COALESCE(SUM(amount) FILTER (WHERE category='order_fba_fee'),                               0) AS fba_fee_total,
        COALESCE(SUM(amount) FILTER (WHERE category='order_closing_fee'),                           0) AS closing_fee_total,
        COALESCE(SUM(amount) FILTER (WHERE category='order_tech_fee'),                              0) AS tech_fee_total,
        COALESCE(SUM(amount) FILTER (WHERE category='order_tcs'),                                   0) AS tcs_total,
        COALESCE(SUM(amount) FILTER (WHERE category='order_tds'),                                   0) AS tds_total,
        COALESCE(SUM(amount) FILTER (WHERE category='order_promotion'),                             0) AS promotion_total,
        COALESCE(SUM(amount) FILTER (WHERE category='inventory_reimbursement'),                     0) AS inventory_reimbursement,
        COALESCE(SUM(amount) FILTER (WHERE transaction_type='Fulfillment Fee Refund'),              0) AS fee_refunds,
        COALESCE(SUM(amount),                                                                       0) AS net_settled
      FROM classified
      JOIN eligible
        ON eligible.order_id = classified.order_id
       AND eligible.sku IS NOT DISTINCT FROM classified.sku
    `;

    const [pivotRes, grandRes] = await Promise.all([
      pool.query(pivotSql, params),
      pool.query(grandSql, params),
    ]);

    res.json({
      filters: { settlement_id, month, order_id, sku, fulfilment },
      grand:   grandRes.rows[0],
      rows:    pivotRes.rows,
      pagination: { page, pageSize, total: Number(grandRes.rows[0]?.order_count || 0) },
    });
  } catch (e) {
    console.error('[amazon-settlement/pivot]', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Classification — buckets a settlement line into a P&L category.
//
// Used as a SQL CASE expression so we can do all classification in-DB.
// Categories:
//   order_revenue          — Principal price (positive on Order, negative on Refund)
//   order_tax              — Product Tax, Shipping Tax
//   order_shipping         — Shipping, Shipping discount
//   order_promotion        — Promo rebates, Product tax discount, Shipping discount-tax
//   order_commission       — Refund commission (only refund lines reveal a commission line in this format)
//   order_fba_fee          — FBA Weight Handling, Pick & Pack, Inbound, etc. (+ GST sub-lines)
//   order_closing_fee      — Fixed closing fee, Fixed closing fee IGST/CGST/SGST
//   order_tech_fee         — Technology Fee + GST
//   order_tcs              — ItemTCS lines
//   order_tds              — ItemTDS lines
//
//   inventory_reimbursement — FBA Inventory Reimbursement (per-order credits — has order-id)
//   removal_fee            — RemovalComplete + GST (no order-id)
//   storage_fee            — FBAStorageFee, LongTermStorageFee (monthly, no order-id)
//   ads_billing            — SponsoredProducts / SponsoredBrands ads spend
//   subscription_fee       — Subscription/Pro Seller monthly
//   service_fee            — generic service/account fees
//   lost_package_credit    — "Reimbursement for Lost packages"
//   other_credit / other_debit — anything else, split by amount sign
// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════
// GET /amazon-settlement/non-order
//   Aggregates and lists deductions/credits that are NOT tied to a specific
//   order (or whose order_id has no matching row in the orders table).
//
//   Returns:
//     totals[]  — per-category sum + count
//     lines[]   — every individual non-order row (paginated)
//
//   Query params:
//     settlement_id — restrict to one settlement (default: all)
//     month         — restrict to YYYY-MM by posted_date
//     page, pageSize (default 1, 100)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/amazon-settlement/non-order', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    res.json(await fetchAmazonNonOrderReport(getPool(), req.query));
  } catch (e) {
    console.error('[amazon-settlement/non-order]', e);
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

function amazonRuleError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function amazonRuleValue(body, ...keys) {
  return keys.find(key => Object.prototype.hasOwnProperty.call(body, key))
    ? body[keys.find(key => Object.prototype.hasOwnProperty.call(body, key))]
    : undefined;
}

function amazonRuleText(value, label, { fallback = null, max = 120 } = {}) {
  if (value == null || String(value).trim() === '') return fallback;
  const text = str(value);
  if (!text || text.length > max) throw amazonRuleError(`${label} must contain 1 to ${max} characters`);
  return text;
}

function amazonRuleNumber(value, label, { fallback, required = false, min = 0, max = 1_000_000_000, whole = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) throw amazonRuleError(`${label} is required`);
    return fallback;
  }
  const parsed = num(value);
  if (parsed == null || parsed < min || parsed > max || (whole && !Number.isSafeInteger(parsed))) {
    throw amazonRuleError(`${label} must be ${whole ? 'a whole number' : `a number from ${min} to ${max}`}`);
  }
  return parsed;
}

function amazonRuleDate(value, label) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = normalizeSqlDate(value);
  if (!parsed) throw amazonRuleError(`${label} must be a valid date`);
  return parsed;
}

function amazonRuleBoolean(value) {
  if (value == null || value === '') return true;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  throw amazonRuleError('is_active must be true or false');
}

export function parseAmazonRulePayload(body = {}) {
  const feeCode = (amazonRuleText(amazonRuleValue(body, 'fee_code', 'feeCode'), 'Fee type', { fallback: '', max: 80 }) || '').toLowerCase();
  const program = (amazonRuleText(amazonRuleValue(body, 'program'), 'Program', { fallback: 'ALL', max: 10 }) || 'ALL').toUpperCase();
  const basis = (amazonRuleText(amazonRuleValue(body, 'calculation_basis', 'calculationBasis'), 'Calculation basis', { fallback: 'per_unit', max: 30 }) || 'per_unit').toLowerCase();
  const rate = amazonRuleNumber(amazonRuleValue(body, 'rate'), 'Rate', { required: true });
  const taxRate = amazonRuleNumber(amazonRuleValue(body, 'tax_rate', 'taxRate'), 'GST rate', { fallback: 0.18, max: 1 });
  const priceMin = amazonRuleNumber(amazonRuleValue(body, 'price_min', 'priceMin'), 'Order-value From', { fallback: 0 });
  const priceMax = amazonRuleNumber(amazonRuleValue(body, 'price_max', 'priceMax'), 'Order-value To', { fallback: 999999 });
  const startDate = amazonRuleDate(amazonRuleValue(body, 'start_date', 'startDate'), 'Start date');
  const endDate = amazonRuleDate(amazonRuleValue(body, 'end_date', 'endDate'), 'End date');

  if (!AMAZON_RECONCILABLE_FEE_CODES.includes(feeCode)) {
    throw amazonRuleError('Choose a supported Amazon fee type');
  }
  if (!AMAZON_PROGRAMS.includes(program)) {
    throw amazonRuleError('Program must be ALL, FBA, or FLEX');
  }
  if (!AMAZON_CALCULATION_BASES.includes(basis)) {
    throw amazonRuleError('Calculation basis must be per_order_line, per_unit, or percent_of_sale');
  }
  if (priceMax < priceMin) throw amazonRuleError('Order-value range is invalid');
  if (startDate && endDate && endDate < startDate) throw amazonRuleError('End date cannot be before start date');

  const sellerAccount = amazonRuleText(amazonRuleValue(body, 'seller_account', 'sellerAccount'), 'Seller account', { fallback: 'default', max: 50 });
  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/i.test(sellerAccount)) throw amazonRuleError('Seller account may contain only letters, numbers, hyphens, and underscores');
  const category = amazonRuleText(amazonRuleValue(body, 'category'), 'Category', { fallback: 'ALL', max: 120 }) || 'ALL';
  const weightSlab = amazonRuleText(amazonRuleValue(body, 'weight_slab', 'weightSlab'), 'Weight slab', { fallback: null, max: 50 });
  const notes = amazonRuleText(amazonRuleValue(body, 'notes'), 'Notes', { fallback: null, max: 1000 });
  const priority = amazonRuleNumber(amazonRuleValue(body, 'priority'), 'Priority', { fallback: 0, min: -1000, max: 1000, whole: true });

  return [
    sellerAccount,
    feeCode,
    program,
    category,
    AMAZON_BRAND,
    weightSlab,
    startDate,
    endDate,
    priceMin,
    priceMax,
    basis,
    rate,
    taxRate,
    priority,
    amazonRuleBoolean(amazonRuleValue(body, 'is_active', 'isActive')),
    notes,
  ];
}

export async function getAmazonRateRules(pool, sellerAccount = 'default') {
  const result = await pool.query(`
    SELECT id, seller_account, fee_code, program, category, brand_name, weight_slab,
           start_date, end_date, price_min, price_max, calculation_basis, rate,
           tax_rate, priority, is_active, notes, created_at, updated_at
    FROM amazon_rate_card_rules
    WHERE seller_account = $1 AND is_active = TRUE
    ORDER BY fee_code, program, category, price_min, weight_slab NULLS FIRST, start_date DESC NULLS LAST, id DESC
  `, [sellerAccount]);
  return result.rows;
}

export async function fetchAmazonReconciliationRows(pool, query = {}) {
  const cacheKey = JSON.stringify({
    seller_account: String(query.seller_account || 'default').trim() || 'default',
    settlement_id: query.settlement_id || null,
    month: query.month || null,
    order_id: query.order_id || null,
  });
  const cached = readAmazonReconciliationCache(cacheKey);
  if (cached) return cached;

  const task = fetchAmazonReconciliationRowsUncached(pool, query).catch(error => {
    invalidateAmazonReconciliationCache();
    throw error;
  });
  cacheAmazonReconciliation(cacheKey, task);
  return task;
}

async function fetchAmazonReconciliationRowsUncached(pool, query = {}) {
  const sellerAccount = String(query.seller_account || 'default').trim() || 'default';
  const filters = ['r.order_id IS NOT NULL'];
  const params = [];
  const add = (clause, value) => { params.push(value); filters.push(clause.replace('?', `$${params.length}`)); };
  if (query.settlement_id) add('r.settlement_id = ?', query.settlement_id);
  let requestedMonth = query.month;
  if (String(query.latest || '').toLowerCase() === 'true') {
    const latest = await pool.query(`
      SELECT TO_CHAR(MAX(posted_month), 'YYYY-MM') AS month
      FROM amazon_order_settlement_rollups
      WHERE posted_month > DATE '1970-01-01'
    `);
    requestedMonth = latest.rows[0]?.month || null;
  }
  const monthRange = amazonMonthRange(requestedMonth);
  if (monthRange) {
    params.push(monthRange.start, monthRange.end);
    filters.push(`r.posted_month >= $${params.length - 1}::date`, `r.posted_month < $${params.length}::date`);
  }
  if (query.order_id) add('r.order_id = ?', query.order_id);

  const rowResult = await pool.query(`
    WITH ledger AS (
      SELECT
        r.order_id,
        NULLIF(r.sku, '') AS sku,
        MIN(r.first_posted) AS first_posted,
        MAX(r.last_posted) AS last_posted,
        SUM(r.line_count) AS line_count,
        SUM(r.order_line_count) AS order_line_count,
        SUM(r.refund_line_count) AS refund_line_count,
        BOOL_OR(r.has_refund) AS has_refund,
        BOOL_OR(r.has_fee_refund) AS has_fee_refund,
        MAX(r.settlement_quantity) AS settlement_quantity,
        SUM(r.sale_amount) AS sale_amount,
        SUM(r.refund_amount) AS refund_amount,
        SUM(r.principal_amount) AS principal_amount,
        SUM(r.product_tax_amount) AS product_tax_amount,
        SUM(r.shipping_amount) AS shipping_amount,
        SUM(r.shipping_tax_amount) AS shipping_tax_amount,
        SUM(r.shipping_discount_amount) AS shipping_discount_amount,
        SUM(r.shipping_tax_discount_amount) AS shipping_tax_discount_amount,
        SUM(r.tcs_amount) AS tcs_amount,
        SUM(r.tds_amount) AS tds_amount,
        SUM(r.net_settlement) AS net_settlement,
        BOOL_OR(r.has_fba_pick_pack) AS has_fba_pick_pack,
        BOOL_OR(r.has_technology_fee) AS has_technology_fee,
        BOOL_OR(r.has_weight_handling) AS has_weight_handling,
        ${AMAZON_FEE_CATALOG.map(fee => `SUM(r.${fee.code}_base) AS ${fee.code}_base, SUM(r.${fee.code}_tax) AS ${fee.code}_tax, SUM(r.${fee.code}_credit) AS ${fee.code}_credit`).join(',\n        ')}
      FROM amazon_order_settlement_rollups r
      WHERE ${filters.join(' AND ')}
      GROUP BY r.order_id, r.sku
    )
    SELECT ledger.*, o.order_date, o.qty AS order_quantity, o.category,
           COALESCE(o.brand_name, '${AMAZON_BRAND}') AS brand_name,
           COALESCE(o.seller_account, 'default') AS seller_account,
           o.weight_slab,
           CASE
             WHEN ledger.has_fba_pick_pack AND ledger.has_technology_fee THEN 'MIXED'
             WHEN ledger.has_fba_pick_pack THEN 'FBA'
             WHEN ledger.has_technology_fee THEN 'FLEX'
             ELSE 'UNKNOWN'
           END AS program,
           COALESCE(NULLIF(o.qty, 0), NULLIF(ledger.settlement_quantity, 0), 1) AS quantity
    FROM ledger
    LEFT JOIN orders o
      ON o.marketplace = 'amazon'
      AND o.order_id = ledger.order_id
      AND o.sku IS NOT DISTINCT FROM ledger.sku
    WHERE COALESCE(o.seller_account, 'default') = $${params.length + 1}
    ORDER BY ledger.last_posted DESC NULLS LAST, ledger.order_id, ledger.sku
  `, [...params, sellerAccount]);
  return rowResult.rows;
}

// GET /api/upload/amazon-settlement/reconciliation
// Order/SKU fee ledger with actual charged amounts, configured expected amounts,
// and a separate refund-credit treatment. It never compares a refund event to
// a sale rate card.
router.get('/amazon-settlement/reconciliation', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const sellerAccount = String(req.query.seller_account || 'default').trim() || 'default';
    const [rawRows, rules] = await Promise.all([
      fetchAmazonReconciliationRows(getPool(), req.query),
      getAmazonRateRules(getPool(), sellerAccount),
    ]);
    const comparedRows = rawRows.map(row => ({ ...row, fees: buildAmazonFeeComparison(row, rules) }));
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 100, maxPageSize: 500 });
    const summary = {
      orderLines: comparedRows.length,
      saleLines: 0,
      refundLines: 0,
      grossSales: 0,
      refundValue: 0,
      netSettlement: 0,
      actualFees: 0,
      expectedFees: 0,
      potentialOvercharge: 0,
      configuredComparisons: 0,
      unconfiguredCharges: 0,
      fbaLines: 0,
      flexLines: 0,
      mixedLines: 0,
      unknownProgramLines: 0,
    };
    const feeBreakdown = Object.fromEntries(AMAZON_FEE_CATALOG.map(fee => [fee.code, {
      code: fee.code, label: fee.label, actualBase: 0, actualTax: 0, credits: 0,
      actualTotal: 0, expectedTotal: 0, variance: 0, chargeLines: 0,
      configuredLines: 0, unconfiguredLines: 0,
    }]));

    for (const row of comparedRows) {
      const saleAmount = Number(row.sale_amount || 0);
      const refundAmount = Math.abs(Number(row.refund_amount || 0));
      summary.grossSales += saleAmount;
      summary.refundValue += refundAmount;
      summary.netSettlement += Number(row.net_settlement || 0);
      if (saleAmount > 0) summary.saleLines += 1;
      if (row.has_refund) summary.refundLines += 1;
      const programKey = String(row.program || 'UNKNOWN').toUpperCase();
      if (programKey === 'FBA') summary.fbaLines += 1;
      else if (programKey === 'FLEX') summary.flexLines += 1;
      else if (programKey === 'MIXED') summary.mixedLines += 1;
      else summary.unknownProgramLines += 1;

      for (const fee of Object.values(row.fees)) {
        const bucket = feeBreakdown[fee.code];
        bucket.actualBase += fee.actualBase;
        bucket.actualTax += fee.actualTax;
        bucket.credits += fee.credits;
        bucket.actualTotal += fee.actualTotal;
        if (fee.actualTotal > 0) bucket.chargeLines += 1;
        summary.actualFees += fee.actualTotal;
        if (fee.expectedTotal != null) {
          bucket.expectedTotal += fee.expectedTotal;
          bucket.variance += fee.variance;
          bucket.configuredLines += 1;
          summary.expectedFees += fee.expectedTotal;
          summary.configuredComparisons += 1;
          if (fee.variance > 0) summary.potentialOvercharge += fee.variance;
        } else if (fee.actualTotal > 0) {
          bucket.unconfiguredLines += 1;
          summary.unconfiguredCharges += 1;
        }
      }
    }

    for (const key of Object.keys(summary)) {
      if (typeof summary[key] === 'number' && !key.endsWith('Lines') && !key.endsWith('Comparisons') && key !== 'orderLines') {
        summary[key] = Number(summary[key].toFixed(2));
      }
    }
    const normalizedBreakdown = Object.values(feeBreakdown).map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? Number(value.toFixed(2)) : value]),
    ));

    res.json({
      filters: { month: req.query.month || null, settlement_id: req.query.settlement_id || null, seller_account: sellerAccount },
      feeCatalog: AMAZON_FEE_CATALOG,
      rules,
      summary,
      feeBreakdown: normalizedBreakdown,
      rows: comparedRows.slice(offset, offset + pageSize),
      pagination: { page, pageSize, total: comparedRows.length },
    });
  } catch (error) {
    console.error('[amazon-settlement/reconciliation]', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Fee-rate rules are admin controlled. Operators can use the reconciliation
// screen, but only an admin can change the expected commercial terms.
router.get('/amazon-settlement/rate-rules', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const sellerAccount = String(req.query.seller_account || 'default').trim() || 'default';
    const rows = await getAmazonRateRules(getPool(), sellerAccount);
    res.json({ feeCatalog: AMAZON_FEE_CATALOG, rules: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/amazon-settlement/rate-rules', requireAdmin, async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const values = parseAmazonRulePayload(req.body);
    const result = await getPool().query(`
      INSERT INTO amazon_rate_card_rules (
        seller_account, fee_code, program, category, brand_name, weight_slab,
        start_date, end_date, price_min, price_max, calculation_basis, rate,
        tax_rate, priority, is_active, notes
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14,$15,$16
      ) RETURNING *
    `, values);
    invalidateAmazonReconciliationCache();
    res.status(201).json({ rule: result.rows[0] });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/amazon-settlement/rate-rules/:id', requireAdmin, async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const values = parseAmazonRulePayload(req.body);
    const ruleId = positiveInteger(req.params.id);
    if (ruleId == null) throw amazonRuleError('Rate rule id must be a positive whole number');
    const result = await getPool().query(`
      UPDATE amazon_rate_card_rules SET
        seller_account=$1, fee_code=$2, program=$3, category=$4, brand_name=$5,
        weight_slab=$6, start_date=$7::date, end_date=$8::date, price_min=$9,
        price_max=$10, calculation_basis=$11, rate=$12, tax_rate=$13,
        priority=$14, is_active=$15, notes=$16, updated_at=NOW()
      WHERE id=$17
      RETURNING *
    `, [...values, ruleId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Rate rule not found' });
    invalidateAmazonReconciliationCache();
    res.json({ rule: result.rows[0] });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/amazon-settlement/rate-rules/:id', requireAdmin, async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const ruleId = positiveInteger(req.params.id);
    if (ruleId == null) throw amazonRuleError('Rate rule id must be a positive whole number');
    const result = await getPool().query('DELETE FROM amazon_rate_card_rules WHERE id = $1 RETURNING id', [ruleId]);
    if (!result.rowCount) return res.status(404).json({ error: 'Rate rule not found' });
    invalidateAmazonReconciliationCache();
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /amazon-settlement/summary  — used by frontend AmazonSettlementReady panel
// Returns headline KPIs across all settlement lines.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/amazon-settlement/summary', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    res.json(await fetchAmazonSettlementSummary(getPool()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
