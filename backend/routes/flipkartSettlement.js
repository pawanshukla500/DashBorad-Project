import express  from 'express';
import multer   from 'multer';
import { createRequire } from 'module';
import { getPool, isDbConfigured } from '../db/index.js';
import { buildDateFormatMap, normalizeSqlDate, summarizeDateFormats } from '../utils/dateNormalizer.js';
import { logUpload } from '../services/uploadLog.js';
import { forEachDbBatch, UPLOAD_BATCH_SIZE } from '../utils/dbBatch.js';
import { optionalNumber as num, optionalString as str } from '../utils/valueParsers.js';
import { clearSkuSettlementBenchmarkCache } from '../services/skuSettlementBenchmark.js';
import { notifySkuSettlementBenchmarkAfterImport } from '../services/skuSettlementNotifications.js';
import { refreshOrderSettlementTotals } from '../services/orderSettlementTotals.js';
import { spreadsheetFileFilter } from '../utils/uploadSecurity.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, parts: 20 },
  fileFilter: spreadsheetFileFilter,
});
const req2   = createRequire(import.meta.url);
const XLSX   = req2('xlsx');

// ── Helpers ────────────────────────────────────────────────────────────────────
function normalize(s) { return (s + '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function int(v)  { const n = num(v); return n === null || !Number.isInteger(n) ? null : n; }
function dt(v, hint) { return normalizeSqlDate(v, hint); }
function isInvalidNumber(raw, parsed) { return str(raw) != null && parsed == null; }

// Build normalized-header → column-index map from a worksheet's header row
function buildColIdx(ws, headerRowNum = 1) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false, raw: false });
  const headerRow = (rows[headerRowNum] || []).map(h => (h + '').replace(/\r\n/g, ' ').trim());
  const colIdx = {};
  headerRow.forEach((h, i) => { if (h) colIdx[normalize(h)] = i; });
  return { colIdx, data: rows.slice(headerRowNum + 1).filter(r => r.some(c => c !== '' && c !== null)) };
}

// Find column index: exact normalized match first, then startsWith
function ci(colIdx, normPrefix) {
  if (colIdx[normPrefix] !== undefined) return colIdx[normPrefix];
  const hit = Object.keys(colIdx).find(k => k.startsWith(normPrefix));
  return hit !== undefined ? colIdx[hit] : -1;
}

// Get field value from a data row
function gv(row, colIdx, normPrefix) {
  const idx = ci(colIdx, normPrefix);
  return idx >= 0 ? (row[idx] ?? '') : '';
}

function labelFromPrefix(prefix) {
  return prefix.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/date$/i, ' date');
}

async function getSheetDateFormats(data, getter, datePrefixes) {
  return buildDateFormatMap({
    rows: data,
    dateFields: datePrefixes.map(key => ({ key, label: labelFromPrefix(key) })),
    valueFor: (row, key) => getter(row, key),
  });
}

// Detect new columns not in our known set (for alerting on new deductions)
function findUnknownCols(colIdx, knownPrefixes) {
  return Object.keys(colIdx).filter(k => !knownPrefixes.some(p => k.startsWith(p) || p.startsWith(k)));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// Release the event loop so other HTTP requests can be served between chunks
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

// Generic batched INSERT for pg — positional params, large batches (pg limit: 65535)
async function batchSimpleInsert(pool, table, colDefs, rows) {
  if (!rows.length) return 0;
  const colNames = colDefs.map(([n]) => n).join(', ');
  let inserted   = 0;

  await forEachDbBatch(rows, colDefs.length, async batch => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const values = [];
        const valueGroups = batch.map((row) => {
          const startIdx = values.length;
          values.push(...row);
          return `(${row.map((_, ci) => `$${startIdx + ci + 1}`).join(', ')})`;
        });
        await pool.query(`INSERT INTO ${table} (${colNames}) VALUES ${valueGroups.join(', ')}`, values);
        inserted += batch.length;
        break;
      } catch (err) {
        const msg = err.message || '';
        const transient = /econnreset|connection|timeout/i.test(msg);
        if (!transient || attempt === 5) throw err;
        await sleep(3000 * attempt);
      }
    }
  });
  return inserted;
}

// autoWiden is a no-op in PostgreSQL — all string columns are TEXT (no length limit)
async function autoWiden() { return false; }

// Delete existing rows by NEFT IDs (before re-inserting) to support re-uploads
async function deleteByNeftIds(pool, tableName, neftIds) {
  if (!neftIds.length) return;
  await forEachDbBatch(neftIds, 1, async batch => {
    await pool.query(`DELETE FROM ${tableName} WHERE neft_id = ANY($1)`, [batch]);
  }, { preferredSize: UPLOAD_BATCH_SIZE });
}

// ── Column definitions for fk_settlement_orders bulk insert ───────────────────
const ORDER_COLS = [
  ['neft_id'],                 ['neft_type'],               ['payment_date'],
  ['bank_settlement'],         ['input_gst_tcs'],           ['income_tax_credits'],
  ['order_id'],                ['order_item_id'],           ['sale_amount'],
  ['total_offer_amount'],      ['my_share'],                ['customer_addons'],
  ['marketplace_fee'],         ['taxes'],                   ['offer_adjustments'],
  ['protection_fund'],         ['refund'],                  ['tier'],
  ['commission_rate'],         ['commission'],              ['fixed_fee'],
  ['collection_fee'],          ['pick_pack_fee'],           ['shipping_fee'],
  ['reverse_shipping'],        ['no_cost_emi_fee'],         ['installation_fee'],
  ['tech_visit_fee'],          ['uninstallation_fee'],      ['customer_addon_recovery'],
  ['franchise_fee'],           ['shopsy_marketing_fee'],    ['cancellation_fee'],
  ['tcs'],                     ['tds'],                     ['gst_on_mp_fees'],
  ['offer_amount_discount_mp'],['item_gst_rate'],           ['discount_mp_fees'],
  ['gst_on_discount'],         ['total_discount_mp_fee'],   ['offer_adjustment_detail'],
  ['dead_weight'],             ['dimensions'],              ['volumetric_weight'],
  ['chargeable_weight_source'],['chargeable_weight_type'],  ['chargeable_weight_slab'],
  ['shipping_zone'],           ['order_date'],              ['dispatch_date'],
  ['fulfilment_type'],         ['seller_sku'],              ['quantity'],
  ['product_sub_category'],    ['additional_info'],         ['return_type'],
  ['shopsy_order'],            ['item_return_status'],      ['invoice_id'],
  ['invoice_date'],            ['marketplace'],
];

// Known normalized prefixes for Orders sheet columns (used to detect new/unknown columns)
const ORDERS_KNOWN_PREFIXES = [
  'neftid','nefttype','paymentdate','banksettlementvalue','inputgsttcs','incometaxcredits',
  'orderid','orderitemid','saleamountrs','totalofferamountrs','mysharers',
  'customeraddonsamountrs','marketplacefee','taxesrs','offeradjustmentsrs',
  'protectionfundrs','refundrs','tier','commissionrate','commissionrs',
  'fixedfeers','collectionfeers','pickandpackfeers','shippingfeers','reverseshippingfeers',
  'nocostemi','installationfeers','techvisitfee','uninstallation',
  'customeraddonsamountrecovery','franchisefeers','shopsymarketing','productcancellation',
  'tcsrs','tdsrs','gstonmpfees','offeramountsettled','itemgstrate',
  'discountinmpfees','gstondiscount','totaldiscountinmpfee','offeradjustmentrs',
  'deadweight','lengthbreadth','volumetricweight','chargeableweightsource',
  'chargeableweighttype','chargeablewtslab','shippingzone','orderdate','dispatchdate',
  'fulfilmenttype','sellersku','quantity','productsubcategory','additionalinformation',
  'returntype','shopsyorder','itemreturnstatus','invoiceid','invoicedate',
  // summary columns at end (ignore these)
  'saleamount','totalofferamount','myshare',
];

// ── Insert Orders sheet (bulk insert for performance with 30K rows) ───────────
async function insertOrders(pool, ws, marketplace, onProgress) {
  const { colIdx, data } = buildColIdx(ws, 1);

  // Detect unknown columns and report them
  const unknownCols = findUnknownCols(colIdx, ORDERS_KNOWN_PREFIXES);
  const newDeductions = unknownCols.map(k => {
    const origEntry = Object.entries(colIdx).find(([key]) => key === k);
    return k;
  });

  if (!data.length) return { inserted: 0, skipped: 0, newColumns: newDeductions };

  // Parse before deleting prior rows. A malformed replacement file must never
  // erase a previously reconciled settlement batch.
  const g = (row, pfx) => gv(row, colIdx, pfx);
  const dateFormats = await getSheetDateFormats(data, g, ['paymentdate', 'orderdate', 'dispatchdate', 'invoicedate']);

  // Parse all rows into records — yield every 500 rows so other requests aren't blocked
  let skipped = 0;
  const records = [];
  const invalidNeftIds = new Set();
  for (let _i = 0; _i < data.length; _i++) {
    if (_i % 500 === 0) await yieldToEventLoop();
    const row = data[_i];
    const neftId = str(g(row, 'neftid'));
    const orderId = str(g(row, 'orderid'));
    const orderItemId = str(g(row, 'orderitemid'));
    const paymentRaw = g(row, 'paymentdate');
    const paymentDate = dt(paymentRaw, dateFormats.paymentdate);
    const bankRaw = g(row, 'banksettlementvalue');
    const bankSettlement = num(bankRaw);
    const saleRaw = g(row, 'saleamountrs');
    const saleAmount = num(saleRaw);
    if (!neftId || !orderId || !orderItemId || !paymentDate || isInvalidNumber(bankRaw, bankSettlement) || isInvalidNumber(saleRaw, saleAmount)) {
      if (neftId) invalidNeftIds.add(neftId);
      skipped++;
      continue;
    }
    try {
      records.push([
        neftId,
        str(g(row, 'nefttype')),
        paymentDate,
        bankSettlement,
        num(g(row, 'inputgsttcs')),
        num(g(row, 'incometaxcredits')),
        orderId,
        orderItemId,
        saleAmount,
        num(g(row, 'totalofferamountrs')),
        num(g(row, 'mysharers')),
        num(g(row, 'customeraddonsamountrs')),
        num(g(row, 'marketplacefee')),
        num(g(row, 'taxesrs')),
        num(g(row, 'offeradjustmentsrs')),
        num(g(row, 'protectionfundrs')),
        num(g(row, 'refundrs')),
        str(g(row, 'tier')),
        num(g(row, 'commissionrate')),
        num(g(row, 'commissionrs')),
        num(g(row, 'fixedfeers')),
        num(g(row, 'collectionfeers')),
        num(g(row, 'pickandpackfeers')),
        num(g(row, 'shippingfeers')),
        num(g(row, 'reverseshippingfeers')),
        num(g(row, 'nocostemi')),
        num(g(row, 'installationfeers')),
        num(g(row, 'techvisitfee')),
        num(g(row, 'uninstallation')),
        num(g(row, 'customeraddonsamountrecovery')),
        num(g(row, 'franchisefeers')),
        num(g(row, 'shopsymarketing')),
        num(g(row, 'productcancellation')),
        num(g(row, 'tcsrs')),
        num(g(row, 'tdsrs')),
        num(g(row, 'gstonmpfees')),
        num(g(row, 'offeramountsettled')),
        num(g(row, 'itemgstrate')),
        num(g(row, 'discountinmpfees')),
        num(g(row, 'gstondiscount')),
        num(g(row, 'totaldiscountinmpfee')),
        num(g(row, 'offeradjustmentrs')),
        num(g(row, 'deadweight')),
        str(g(row, 'lengthbreadth')),
        num(g(row, 'volumetricweight')),
        str(g(row, 'chargeableweightsource')),
        str(g(row, 'chargeableweighttype')),
        str(g(row, 'chargeablewtslab')),
        str(g(row, 'shippingzone')),
        dt(g(row, 'orderdate'), dateFormats.orderdate),
        dt(g(row, 'dispatchdate'), dateFormats.dispatchdate),
        str(g(row, 'fulfilmenttype')),
        str(g(row, 'sellersku')),
        int(g(row, 'quantity')),
        str(g(row, 'productsubcategory')),
        str(g(row, 'additionalinformation')),
        str(g(row, 'returntype')),
        str(g(row, 'shopsyorder')),
        str(g(row, 'itemreturnstatus')),
        str(g(row, 'invoiceid')),
        dt(g(row, 'invoicedate'), dateFormats.invoicedate),
        marketplace,
      ]);
    } catch { skipped++; }
  }

  // An upload is an atomic replacement at NEFT level: one malformed line means
  // we retain the old NEFT batch rather than replacing it with partial data.
  const safeRecords = records.filter(record => !invalidNeftIds.has(record[0]));
  skipped += records.length - safeRecords.length;
  const neftIds = [...new Set(safeRecords.map(record => record[0]).filter(Boolean))];
  if (!safeRecords.length) throw new Error('No valid Orders rows were found; existing settlement data was left unchanged.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Re-uploading a NEFT is an all-or-nothing replacement. The compact
    // dashboard totals are refreshed in the same transaction, so no tab can
    // observe a mixture of old rows and a new read model.
    await deleteByNeftIds(client, 'fk_settlement_orders', neftIds);
    const inserted = await batchSimpleInsert(client, 'fk_settlement_orders', ORDER_COLS, safeRecords);
    await refreshOrderSettlementTotals(client);
    await client.query('COMMIT');
    if (onProgress) onProgress(inserted, safeRecords.length);
    console.log(`[FK] Orders: ${inserted} rows inserted, ${skipped} skipped`);
    return { inserted, skipped, newColumns: newDeductions, dateFormats: summarizeDateFormats(dateFormats) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ── Insert Non_Order_SPF sheet ─────────────────────────────────────────────────
const SPF_COLS = [
  ['neft_id'], ['payment_date'], ['settlement_value'], ['claim_id'],
  ['order_item_id'], ['status'],
  ['protection_reason'], ['seller_sku'], ['fsn'], ['selling_price'],
  ['warehouse_id'], ['marketplace'],
];

// Flipkart reuses the same claim_id across multiple NEFT cycles (deduction + credit for same claim).
// Auto-migrate: replace single-column UNIQUE(claim_id) with composite UNIQUE(claim_id, neft_id).
let _spfConstraintFixed = false;
async function ensureSpfConstraint(pool) {
  if (_spfConstraintFixed) return;
  _spfConstraintFixed = true;
  try {
    await pool.query(`ALTER TABLE fk_spf_claims DROP CONSTRAINT IF EXISTS "UQ_fk_spf_claim"`);
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'UQ_fk_spf_claim_neft' AND conrelid = 'fk_spf_claims'::regclass`
    );
    if (!rows.length) {
      await pool.query(`ALTER TABLE fk_spf_claims ADD CONSTRAINT "UQ_fk_spf_claim_neft" UNIQUE (claim_id, neft_id)`);
    }
    console.log('[DB] fk_spf_claims constraint: unique on (claim_id, neft_id)');
  } catch (e) {
    _spfConstraintFixed = false;
    throw e;
  }
}

async function insertSpfClaims(pool, ws, marketplace) {
  await ensureSpfConstraint(pool);
  const { colIdx, data } = buildColIdx(ws, 1);
  if (!data.length) return { inserted: 0, skipped: 0 };
  const g = (row, pfx) => gv(row, colIdx, pfx);
  const dateFormats = await getSheetDateFormats(data, g, ['paymentdate']);

  let skipped = 0;
  const records = [];
  for (let i = 0; i < data.length; i++) {
    if (i % 500 === 0) await yieldToEventLoop();
    const row = data[i];
    const claimId = str(g(row, 'claimid'));
    if (!claimId) { skipped++; continue; }
    const orderItemId = str(g(row, 'orderitemid')) || str(g(row, 'orderitem'));
    const claimStatus = str(g(row, 'status')) || str(g(row, 'claimstatus'));
    records.push([str(g(row,'neftid')), dt(g(row,'paymentdate'),dateFormats.paymentdate),
      num(g(row,'settlementvalue')), claimId, orderItemId, claimStatus, str(g(row,'protectionreason')),
      str(g(row,'sellersku')), str(g(row,'fsn')), num(g(row,'sellingprice')),
      str(g(row,'warehouseid')), marketplace]);
  }
  const neftIds = [...new Set(records.map(record => record[0]).filter(Boolean))];
  if (!records.length) throw new Error('No valid SPF claim rows were found; existing claim data was left unchanged.');
  await deleteByNeftIds(pool, 'fk_spf_claims', neftIds);
  const inserted = await batchSimpleInsert(pool, 'fk_spf_claims', SPF_COLS, records);
  return { inserted, skipped, dateFormats: summarizeDateFormats(dateFormats) };
}

// ── Insert Storage_Recall sheet ────────────────────────────────────────────────
const SR_COLS = [
  ['neft_id'], ['payment_date'], ['settlement_value'], ['service_name'],
  ['listing_id'], ['recall_id'], ['warehouse_state'], ['fsn'],
  ['marketplace_fees'], ['gst_fees'], ['removal_fee_units'], ['removal_fee'],
  ['storage_fee_units'], ['storage_fee'], ['sellable_regular_units'], ['sellable_regular'],
  ['unsellable_regular_units'], ['unsellable_regular'], ['product_sub_category'],
  ['dead_weight'], ['volumetric_weight'], ['chargeable_weight_slab'], ['marketplace'],
];
async function insertStorageRecall(pool, ws, marketplace) {
  const { colIdx, data } = buildColIdx(ws, 1);
  if (!data.length) return { inserted: 0, skipped: 0 };
  const g = (row, pfx) => gv(row, colIdx, pfx);
  const dateFormats = await getSheetDateFormats(data, g, ['paymentdate']);

  let skipped = 0;
  const records = [];
  for (let i = 0; i < data.length; i++) {
    if (i % 500 === 0) await yieldToEventLoop();
    const row = data[i];
    const neftId = str(g(row, 'neftid'));
    if (!neftId) { skipped++; continue; }
    records.push([neftId, dt(g(row,'paymentdate'),dateFormats.paymentdate),
      num(g(row,'settlementvalue')), str(g(row,'servicename')), str(g(row,'listingid')),
      str(g(row,'recallid')), str(g(row,'warehousestate')), str(g(row,'fsn')),
      num(g(row,'marketplacefees')), num(g(row,'gstonstorage')),
      num(g(row,'removalfeeunits')), num(g(row,'removalfee')),
      num(g(row,'storagefeeunits')), num(g(row,'storagefee')),
      num(g(row,'sellableregularstorageu')), num(g(row,'sellableregularstorage')),
      num(g(row,'unsellableregularstorageu')), num(g(row,'unsellableregularstorage')),
      str(g(row,'productsubcategory')), num(g(row,'deadweight')),
      num(g(row,'volumetricweight')), str(g(row,'chargeablewt')), marketplace]);
  }
  const neftIds = [...new Set(records.map(record => record[0]).filter(Boolean))];
  if (!records.length) throw new Error('No valid Storage & Recall rows were found; existing data was left unchanged.');
  await deleteByNeftIds(pool, 'fk_storage_recall', neftIds);
  const inserted = await batchSimpleInsert(pool, 'fk_storage_recall', SR_COLS, records);
  return { inserted, skipped, dateFormats: summarizeDateFormats(dateFormats) };
}

// ── Insert Ads sheet ───────────────────────────────────────────────────────────
const ADS_COLS = [
  ['neft_id'], ['payment_date'], ['settlement_value'], ['transaction_type'],
  ['campaign_id'], ['wallet_redeem'], ['wallet_redeem_reversal'], ['wallet_topup'],
  ['wallet_refund'], ['gst_on_ads'], ['marketplace'],
];
async function insertAds(pool, ws, marketplace) {
  const { colIdx, data } = buildColIdx(ws, 1);
  if (!data.length) return { inserted: 0, skipped: 0 };
  const g = (row, pfx) => gv(row, colIdx, pfx);
  const dateFormats = await getSheetDateFormats(data, g, ['paymentdate']);

  let skipped = 0;
  const records = [];
  for (let i = 0; i < data.length; i++) {
    if (i % 500 === 0) await yieldToEventLoop();
    const row = data[i];
    const neftId = str(g(row, 'neftid'));
    if (!neftId) { skipped++; continue; }
    records.push([neftId, dt(g(row,'paymentdate'),dateFormats.paymentdate),
      num(g(row,'settlementvalue')), str(g(row,'type')), str(g(row,'campaign')),
      num(g(row,'walletredeem')), num(g(row,'walletredeemreversal')),
      num(g(row,'wallettopup')), num(g(row,'walletrefund')),
      num(g(row,'gstonads')), marketplace]);
  }
  const neftIds = [...new Set(records.map(record => record[0]).filter(Boolean))];
  if (!records.length) throw new Error('No valid Ads rows were found; existing data was left unchanged.');
  await deleteByNeftIds(pool, 'fk_ads', neftIds);
  const inserted = await batchSimpleInsert(pool, 'fk_ads', ADS_COLS, records);
  return { inserted, skipped, dateFormats: summarizeDateFormats(dateFormats) };
}

// ── Insert Google Ads Services sheet ──────────────────────────────────────────
const GA_COLS = [
  ['neft_id'], ['payment_date'], ['settlement_value'], ['service_name'],
  ['service_details'], ['service_order_id'], ['purchase_date'], ['total_amount'],
  ['service_amount'], ['gst_on_service'], ['marketplace'],
];
async function insertGoogleAds(pool, ws, marketplace) {
  const { colIdx, data } = buildColIdx(ws, 1);
  if (!data.length) return { inserted: 0, skipped: 0 };
  const g = (row, pfx) => gv(row, colIdx, pfx);
  const dateFormats = await getSheetDateFormats(data, g, ['paymentdate', 'purchasedate']);

  let skipped = 0;
  const records = [];
  for (let i = 0; i < data.length; i++) {
    if (i % 500 === 0) await yieldToEventLoop();
    const row = data[i];
    const neftId = str(g(row, 'neftid'));
    if (!neftId) { skipped++; continue; }
    records.push([neftId, dt(g(row,'paymentdate'),dateFormats.paymentdate),
      num(g(row,'settlementvalue')), str(g(row,'servicename')), str(g(row,'servicedetails')),
      str(g(row,'serviceorderid')), dt(g(row,'purchasedate'),dateFormats.purchasedate),
      num(g(row,'totalamount')), num(g(row,'serviceamount')),
      num(g(row,'gstonservice')), marketplace]);
  }
  const neftIds = [...new Set(records.map(record => record[0]).filter(Boolean))];
  if (!records.length) throw new Error('No valid Google Ads rows were found; existing data was left unchanged.');
  await deleteByNeftIds(pool, 'fk_google_ads', neftIds);
  const inserted = await batchSimpleInsert(pool, 'fk_google_ads', GA_COLS, records);
  return { inserted, skipped, dateFormats: summarizeDateFormats(dateFormats) };
}

// ── Main endpoint ──────────────────────────────────────────────────────────────
// POST /api/upload/flipkart-settlement
// ── In-process job store (survives across requests, cleared after 5 min) ─────
const jobs = new Map();

// sheetKey: 'orders'|'spf'|'storage'|'ads'|'google_ads'|'' (empty = all)
async function processAllSheets(jobId, pool, wb, marketplace, filename, sheetKey = '') {
  const job = jobs.get(jobId);
  const results = {};
  const newColumnsFound = [];
  let mainLogId = null;
  const only = sheetKey || 'all';

  try {
    if ((only === 'all' || only === 'orders') && wb.Sheets['Orders']) {
      job.sheet = 'Orders (all deductions)'; job.sheetDone = 0; job.sheetTotal = 0;
      const r = await insertOrders(pool, wb.Sheets['Orders'], marketplace, (done, total) => {
        job.sheetDone = done; job.sheetTotal = total;
      });
      results.orders = r;
      if (r.newColumns?.length) newColumnsFound.push(...r.newColumns.map(c => `Orders/${c}`));
      mainLogId = await logUpload(pool, 'fk_settlement_orders', filename, marketplace, r.inserted, 0, r.skipped, 'ok');
    }

    if ((only === 'all' || only === 'spf') && wb.Sheets['Non_Order_SPF']) {
      job.sheet = 'Non-Order SPF claims'; job.sheetDone = 0; job.sheetTotal = 0;
      const r = await insertSpfClaims(pool, wb.Sheets['Non_Order_SPF'], marketplace);
      results.spf_claims = r;
      if (r.inserted) await logUpload(pool, 'fk_spf_claims', filename, marketplace, r.inserted, 0, r.skipped, 'ok');
    }

    if ((only === 'all' || only === 'storage') && wb.Sheets['Storage_Recall']) {
      job.sheet = 'Storage & Recall fees'; job.sheetDone = 0; job.sheetTotal = 0;
      const r = await insertStorageRecall(pool, wb.Sheets['Storage_Recall'], marketplace);
      results.storage_recall = r;
      if (r.inserted) await logUpload(pool, 'fk_storage_recall', filename, marketplace, r.inserted, 0, r.skipped, 'ok');
    }

    if ((only === 'all' || only === 'ads') && wb.Sheets['Ads']) {
      job.sheet = 'Flipkart Ads wallet'; job.sheetDone = 0; job.sheetTotal = 0;
      const r = await insertAds(pool, wb.Sheets['Ads'], marketplace);
      results.ads = r;
      if (r.inserted) await logUpload(pool, 'fk_ads', filename, marketplace, r.inserted, 0, r.skipped, 'ok');
    }

    if ((only === 'all' || only === 'google_ads') && wb.Sheets['Google Ads Services']) {
      job.sheet = 'Google Ads billing'; job.sheetDone = 0; job.sheetTotal = 0;
      const r = await insertGoogleAds(pool, wb.Sheets['Google Ads Services'], marketplace);
      results.google_ads = r;
      if (r.inserted) await logUpload(pool, 'fk_google_ads', filename, marketplace, r.inserted, 0, r.skipped, 'ok');
    }

    const skippedSheets = ['MP Fee Rebate','Value Added Services','TCS_Recovery','TDS','GST_Details','Report Help','Summary of report']
      .filter(s => wb.SheetNames.includes(s));
    results.skipped_sheets = skippedSheets;

    const totalInserted = Object.values(results)
      .filter(r => typeof r === 'object' && r?.inserted !== undefined)
      .reduce((s, r) => s + (r.inserted || 0), 0);

    // The next Payment Check visit must see the newly imported settlement, not
    // the five-minute reporting cache used to reduce repeated PostgreSQL reads.
    if (results.orders?.inserted) {
      clearSkuSettlementBenchmarkCache('flipkart');
      void notifySkuSettlementBenchmarkAfterImport(pool, 'flipkart')
        .catch(error => console.warn('[sku settlement notification]', error.message));
    }

    Object.assign(job, {
      status: 'done', ok: true,
      filename, results, totalInserted,
      sheetsProcessed: Object.keys(results).filter(k => k !== 'skipped_sheets'),
      newColumnsFound: newColumnsFound.length ? newColumnsFound : undefined,
      logId: mainLogId,
    });

  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    try {
      await logUpload(getPool(), 'fk_settlement', filename, marketplace, 0, 0, 0, 'error', e.message);
    } catch {}
  }
  // Auto-expire job entry after 5 minutes
  setTimeout(() => jobs.delete(jobId), 300_000);
}

// ── POST / — respond instantly, do ALL work in background ────────────────────
router.post('/', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const marketplace = req.body.marketplace || 'flipkart';
  const filename    = req.file.originalname;
  const buffer      = req.file.buffer; // hold ref before multer GC

  const jobId = `fk_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  jobs.set(jobId, { status: 'processing', sheet: 'Parsing file…', sheetDone: 0, sheetTotal: 0 });

  // ← Response sent here, BEFORE any parsing or DB work
  res.json({ jobId, status: 'started' });

  // Everything below runs after the response is already delivered
  setImmediate(async () => {
    const job = jobs.get(jobId);
    try {
      const pool = getPool();
      const sheetKey = req.body.sheetKey || ''; // 'orders'|'spf'|'storage'|'ads'|'google_ads'|'' = all
      job.sheet = 'Reading workbook…';
      await yieldToEventLoop(); // let any queued requests through first
      const wb = XLSX.read(buffer, { type: 'buffer', raw: false });
      await processAllSheets(jobId, pool, wb, marketplace, filename, sheetKey);
    } catch (e) {
      if (job) { job.status = 'error'; job.error = e.message; }
      try {
        await logUpload(getPool(), 'fk_settlement', filename, marketplace, 0, 0, 0, 'error', e.message);
      } catch {}
    }
  });
});

// ── GET /progress/:jobId — frontend polls this every 2s ──────────────────────
router.get('/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json(job);
});

export default router;
