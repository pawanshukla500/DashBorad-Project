import express  from 'express';
import multer   from 'multer';
import { createRequire } from 'module';
import { getPool, isDbConfigured, isDbOffline } from '../db/index.js';
import { buildDateFormatMap, normalizeSqlDate, summarizeDateFormats } from '../utils/dateNormalizer.js';
import { normalizeDeliveryState } from '../utils/geoNormalization.js';
import { forEachDbBatch } from '../utils/dbBatch.js';
import { optionalQueryText, pagination } from '../utils/requestParams.js';
import { optionalNumber as num, optionalString as str } from '../utils/valueParsers.js';
import { getUploadHistory, logUpload, saveSkippedRows } from '../services/uploadLog.js';
import { writeAudit } from '../services/auditLog.js';
import {
  getReturnsReceivedSummary,
  getReturnsTracker,
  getSpfSummary,
  getSpfTracking,
  markSpfReceived,
} from '../services/returnReports.js';
import { refreshAmazonSettlementReportingRollups } from '../services/amazonSettlementReportingRollups.js';
import { ORDER_SETTLEMENT_TOTALS_TABLE, refreshOrderSettlementTotals } from '../services/orderSettlementTotals.js';
import { spreadsheetFileFilter } from '../utils/uploadSecurity.js';
import { syncVbExportCatalog } from '../scripts/sync-vb-export-catalog.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, parts: 20 },
  fileFilter: spreadsheetFileFilter,
});
const req2   = createRequire(import.meta.url);
const XLSX   = req2('xlsx');

export const REQUIRED_FIELDS = {
  orders: [
    'Order ID','Order Item ID','FSN','SKU','Selling Channel','Category','Brand','HSN Code',
    'Order Type','Fulfilment Type','Order Date','QTY','Amount',
    "Customer's Delivery State","Customer's Delivery Pincode",'Warehouse ID',
    'Warehouse City',
  ],
  returns: [
    'return_id','order_item_id','fulfilment_type','return_requested_date','return_approval_date',
    'return_status','return_reason','return_sub_reason','return_type',
    'return_result','return_expectation','reverse_logistics_tracking_id',
    'sku','fsn','product_title','quantity','return_completion_type','primary_pv_output',
    'detailed_pv_output','final_condition_of_returned_product','tech_visit_sla',
    'tech_visit_by_date','tech_visit_completion_datetime','tech_visit_completion_breach',
    'return_completion_sla','return_complete_by_date','return_completion_date',
    'return_completion_breach','return_cancellation_date','return_cancellation_reason',
  ],
  settlements: [
    'NEFT ID','NEFT Type','Payment Date','Bank Settlement','Input GST TCS',
    'Income Tax Credits','Order ID','Order Item ID','Sale Amount','Total Offer Amount',
    'My Share','Customer Addons','Marketplace Fee','Taxes','Offer Adjustments',
    'Protection Fund','Refund','Tier','Commission Rate','Commission','Fixed Fee',
    'Collection Fee','Pick Pack Fee','Shipping Fee','Reverse Shipping',
    'Customer Addon Recovery','Franchise Fee','TCS','TDS','GST on MP Fees',
    'Shipping Zone','Order Date','Dispatch Date',
  ],
  // ── Amazon multi-source pipeline (template columns) ───────────────────────
  // Used only by GET /api/upload/template/:type to generate downloadable
  // .xlsx templates. Real ingestion lives in backend/routes/amazonUpload.js.
  // Header strings match Seller Central exports verbatim.
  'amazon-sale-orders': [
    'Customer Shipment Date','Merchant SKU','FNSKU','ASIN','FC','Quantity',
    'Amazon Order Id','Currency','Product Amount','Shipping Amount','Gift Amount',
    'Shipment To City','Shipment To State','Shipment To Postal Code',
  ],
  'amazon-fba-returns': [
    'return-date','order-id','sku','asin','fnsku','product-name','quantity',
    'fulfillment-center-id','detailed-disposition','reason',
    'license-plate-number','customer-comments',
  ],
  'amazon-flex-returns': [
    // NOTE: file's "SKU" col = FNSKU; "mSKU" col = seller SKU (backend handles swap)
    'Return Type','Customer Order ID','Shipment ID','SKU','mSKU','ASIN','Units',
    'Forward Leg Tracking ID','Reverse Leg Tracking ID','RMA ID','Return Status',
    'Carrier','Pick -up date','Last Updated On','Returned with OTP',
    'Days In-transit','Days Since Return Complete','Return Reason',
  ],
  'amazon-settlement': [
    'settlement-id','settlement-start-date','settlement-end-date','deposit-date',
    'total-amount','currency','transaction-type','order-id','merchant-order-id',
    'adjustment-id','shipment-id','marketplace-name','amount-type','amount-description',
    'amount','fulfillment-id','posted-date','posted-date-time','order-item-code',
    'merchant-order-item-id','sku','quantity-purchased','promotion-id',
  ],
  'sku-master': [
    'Marketplace SKU', "VB EXPORT SKU's", 'VB Export Product Category', 'Weight Slab (kg)', 'COGS (₹)', 'Marketplace'
  ],
  'vb-export-catalog': [
    'Marketplace SKU', "VB EXPORT SKU's", 'VB Export Product Category', 'Weight Slab (kg)', 'COGS (₹)', 'Marketplace'
  ],
};

/** Sample rows for template downloads — 2–3 realistic examples per type */
const TEMPLATE_SAMPLES = {
  orders: [
    ['OD12345678901','123456789012345678','FSNABC0001','SKU-TEE-BLK-M','Flipkart','Apparel','Youthnic','61091000','Customer','FBF','2026-04-05','1','899',"Maharashtra",'400001','WH-MUM-01','Mumbai'],
    ['OD12345678902','123456789012345679','FSNABC0002','SKU-TEE-WHT-L','Flipkart','Apparel','Youthnic','61091000','Customer','FBF','2026-04-06','2','1598',"Karnataka",'560001','WH-BLR-02','Bengaluru'],
    ['OD12345678903','123456789012345680','FSNABC0003','SKU-HOOD-NVY-XL','Flipkart','Apparel','Youthnic','61099000','Customer','Non-FBF','2026-04-07','1','1499',"Delhi",'110001','WH-DEL-01','New Delhi'],
  ],
  returns: [
    ['RET001','123456789012345678','FBF','2026-04-10','2026-04-11','Completed','Size issue','Too large','customer_return','Approved','Refund','RL123456','SKU-TEE-BLK-M','FSNABC0001','Black Tee M','1','Completed','PASS','No damage','Good','','','','','','2026-04-18','','',''],
    ['RET002','123456789012345679','FBF','2026-04-12','2026-04-13','Completed','DAMAGED PRODUCT','Torn','customer_return','Approved','Refund','RL123457','SKU-TEE-WHT-L','FSNABC0002','White Tee L','1','Completed','FAIL','Fabric tear','Damaged','','','','','','2026-04-20','','',''],
    ['RET003','123456789012345680','Non-FBF','2026-04-08','2026-04-09','Completed','RTO','Customer unavailable','courier_return','Approved','Refund','RL123458','SKU-HOOD-NVY-XL','FSNABC0003','Navy Hood XL','1','Completed','','','','','','','','','2026-04-15','','',''],
  ],
  settlements: [
    ['NEFT240401001','Settlement','2026-04-15','650.00','12.50','5.00','OD12345678901','123456789012345678','899.00','50.00','650.00','0','180.00','32.40','0','0','0','Tier1','0.12','107.88','20.00','15.00','10.00','25.00','0','0','5.00','12.50','5.00','32.40','Local','2026-04-05','2026-04-06'],
    ['NEFT240401002','Settlement','2026-04-15','1180.00','22.00','8.00','OD12345678902','123456789012345679','1598.00','100.00','1180.00','0','320.00','57.60','0','0','0','Tier1','0.12','191.76','30.00','25.00','18.00','40.00','0','0','8.00','22.00','8.00','57.60','Zonal','2026-04-06','2026-04-07'],
  ],
  'amazon-sale-orders': [
    ['2026-04-30T23:47:50+05:30','SKU-TEE-BLK-M','X001FNSKU','B0EXAMPLE01','BOM5',1,'405-3118393-5670756','INR',799,38.1,0,'PUNE','MAHARASHTRA','411001'],
    ['2026-04-30T22:42:46+05:30','SKU-TEE-WHT-L','X002FNSKU','B0EXAMPLE02','DEL4',1,'405-7984469-3781915','INR',999,0,0,'NEW DELHI','DELHI','110045'],
  ],
  'amazon-fba-returns': [
    ['2026-04-12','402-1234567-8901234','SKU-TEE-BLK-M','B0EXAMPLE01','X001FNSKU','Black Tee M','1','BOM3','SELLABLE','APPAREL_TOO_LARGE','LPN000111','Size too big'],
    ['2026-04-14','402-1234567-8901235','SKU-TEE-WHT-L','B0EXAMPLE02','X002FNSKU','White Tee L','1','BLR7','DAMAGED','APPAREL_STYLE','LPN000222','Torn seam'],
  ],
  'amazon-flex-returns': [
    ['Customer Return','402-1111222-3333444','FBA15ABC','X003FNSKU','SKU-HOOD-NVY-XL','B0EXAMPLE03','1','TRKfwd001','TRKrev001','RMA-10001','Completed','ATS','2026-04-10','2026-04-18','Yes','3','2','Wrong size'],
    ['Customer Return','402-5555666-7777888','FBA15DEF','X004FNSKU','SKU-TEE-BLK-M','B0EXAMPLE01','1','TRKfwd002','TRKrev002','RMA-10002','Completed','ATS','2026-04-11','2026-04-19','Yes','4','1','Damaged'],
  ],
  'amazon-settlement': [
    ['12345678901','2026-04-01','2026-04-15','2026-04-16','12500.00','INR','Order','402-1234567-8901234','','','','Amazon.in','ItemPrice','Principal','899.00','AFN','2026-04-06','2026-04-06T10:00:00+00:00','999888777','','SKU-TEE-BLK-M','1',''],
    ['12345678901','2026-04-01','2026-04-15','2026-04-16','12500.00','INR','Order','402-1234567-8901234','','','','Amazon.in','ItemFees','FBAPerUnitFulfillmentFee','-45.00','AFN','2026-04-06','2026-04-06T10:00:00+00:00','999888777','','SKU-TEE-BLK-M','1',''],
  ],
  'sku-master': [
    ['EJ1201-16001_FK', 'EJ1201-16001', 'Kurta Set', 0.5, 450, 'flipkart'],
    ['EJ1201-16001_M',  'EJ1201-16001', 'Kurta Set', 0.5, 450, 'myntra_ej'],
    ['7Y-UQCI-Y51D',     'EJ1201-16001', 'Kurta Set', 0.5, 450, 'amazon'],
  ],
  'vb-export-catalog': [
    ['EJ1201-16001_FK', 'EJ1201-16001', 'Kurta Set', 0.5, 450, 'flipkart'],
    ['EJ1201-16001_M',  'EJ1201-16001', 'Kurta Set', 0.5, 450, 'myntra_ej'],
    ['7Y-UQCI-Y51D',     'EJ1201-16001', 'Kurta Set', 0.5, 450, 'amazon'],
  ],
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function parseFile(buffer, preferredSheets = []) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = preferredSheets.find(n => wb.SheetNames.includes(n)) || wb.SheetNames[0];
  const ws   = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (rows.length < 2) return { headers: [], data: [] };
  const headers = rows[0].map(h => (h + '').trim());
  const data    = rows.slice(1).filter(r => r.some(c => c !== ''));
  return { headers, data };
}

function rowMapper(headers) {
  return (row) => {
    const m = {};
    headers.forEach((h, i) => { m[h] = (row[i] ?? '').toString().trim(); });
    return m;
  };
}

function getField(rawRow, fieldName, colMap) {
  const csvCol = colMap[fieldName];
  if (!csvCol) return '';
  return (rawRow[csvCol] ?? '').toString().trim();
}

function dt(v, hint) { return normalizeSqlDate(v, hint); }

class InputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function parseColumnMap(value) {
  if (value == null || value === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InputError('Column mapping is invalid. Please reselect the file and try again.');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new InputError('Column mapping must be an object. Please reselect the file and try again.');
  }
  return parsed;
}

function requireUploadRows(data) {
  if (!data.length) throw new InputError('The workbook has headers but no data rows. No data was saved.');
}

function requireMappedFields(type, colMap, headers) {
  const alternatives = {
    orders: [['Order Item ID'], ['Order ID'], ['Order Date'], ['QTY', 'Qty'], ['Amount', 'Final Invoice Amount']],
    returns: [['return_id', 'order_item_id']],
    settlements: [['Order Item ID'], ['Payment Date']],
  }[type] || [];
  const headerSet = new Set(headers);
  const missing = alternatives
    .filter(fields => !fields.some(field => colMap[field] && headerSet.has(colMap[field])))
    .map(fields => fields.join(' or '));
  if (missing.length) {
    throw new InputError(`This file cannot be safely imported as ${type}. Missing mapped column(s): ${missing.join(', ')}.`);
  }
}

function genericMarketplace(value) {
  const marketplace = String(value || 'flipkart').trim().toLowerCase();
  if (marketplace !== 'flipkart' && marketplace !== 'meesho') {
    throw new InputError('Use the dedicated Amazon or Myntra import flow for that marketplace. Generic imports are limited to Flipkart and Meesho data.');
  }
  return marketplace;
}

function rowData(rawRow) {
  return Object.fromEntries(Object.entries(rawRow).filter(([, value]) => value !== ''));
}

function hasInvalidNumber(raw, parsed) {
  return raw !== '' && parsed == null;
}

// Weight slab: accept a positive number (0.5) or a clear range ("0-0.5 kg").
// The upper bound is stored. Never strip arbitrary characters: "1oops" must not
// silently become a 1 kg slab in profitability calculations.
function parseWeightSlab(v, label = 'Weight slab') {
  const text = str(v);
  if (text == null) return null;
  const normalized = text.toLowerCase()
    .replace(/\s+/g, '')
    .replace(/kgs?$/i, '')
    .replace(/[–—]/g, '-');
  const range = normalized.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  const value = range ? Number(range[2]) : num(normalized);
  if (value == null || !Number.isFinite(value) || value <= 0 || value > 100 || (range && Number(range[1]) >= value)) {
    throw new InputError(`${label} must be a positive number or a valid range up to 100 kg.`);
  }
  return value;
}

function textInput(value, label, { required = false, max = 250 } = {}) {
  const text = str(value);
  if (required && !text) throw new InputError(`${label} is required.`);
  if (text && text.length > max) throw new InputError(`${label} must be ${max} characters or fewer.`);
  return text;
}

function catalogMarketplace(value) {
  const marketplace = (textInput(value, 'Marketplace', { max: 50 }) || 'all').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(marketplace)) {
    throw new InputError('Marketplace may contain only lowercase letters, numbers, hyphens, and underscores.');
  }
  return marketplace;
}

function nonNegativeMoney(value, label, { defaultValue = 0 } = {}) {
  const text = str(value);
  if (text == null) return defaultValue;
  const parsed = num(text);
  if (parsed == null || parsed < 0 || parsed > 1000000000) {
    throw new InputError(`${label} must be a non-negative amount up to 1,000,000,000.`);
  }
  return parsed;
}

function optionalCatalogDate(value, label = 'Launch date') {
  const text = str(value);
  if (text == null) return null;
  const parsed = dt(text);
  if (!parsed) throw new InputError(`${label} must be a valid date.`);
  return parsed;
}

function positiveRowId(value) {
  const id = num(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new InputError('Row id must be a positive whole number.');
  return id;
}

export function parseSkuMasterInput(input = {}) {
  const listingSku = textInput(input.listing_sku, 'Listing SKU', { required: true });
  const masterSku = textInput(input.master_sku, 'Master SKU') || listingSku;
  return {
    masterSku,
    marketplace: catalogMarketplace(input.marketplace),
    listingSku,
    cogs: nonNegativeMoney(input.cogs, 'COGS'),
    launchDate: optionalCatalogDate(input.launch_date),
    productName: textInput(input.product_name, 'Product name', { max: 500 }),
    weightSlab: parseWeightSlab(input.weight_slab),
    brandName: textInput(input.brand_name, 'Brand name', { max: 120 }),
    category: textInput(input.category, 'Category', { max: 250 }),
  };
}

export function parseCatalogCogsInput(input = {}) {
  return {
    marketplace: catalogMarketplace(input.marketplace),
    catalogId: textInput(input.catalog_id, 'Catalog ID / FSN / ASIN', { required: true }),
    category: textInput(input.category, 'Category', { max: 250 }),
    cogs: nonNegativeMoney(input.cogs, 'COGS'),
    productName: textInput(input.product_name, 'Product name', { max: 500 }),
    brandName: textInput(input.brand_name, 'Brand name', { max: 120 }),
  };
}

function normalizedUploadHeader(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function firstUploadValue(row, ...keys) {
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim() !== '') return value;
  }
  return null;
}

function returnReceiptFlag(value, label) {
  const text = str(value);
  if (text == null) return null;
  const normalized = text.toLowerCase().replace(/[\s_-]+/g, '');
  if (['yes', 'true', '1', 'received'].includes(normalized)) return true;
  if (['no', 'false', '0', 'notreceived', 'pending'].includes(normalized)) return false;
  throw new InputError(`${label} must be Yes or No.`);
}

function returnCondition(value) {
  const text = str(value);
  if (text == null) return null;
  const normalized = text.toLowerCase().replace(/[\s_-]+/g, '');
  if (['good', 'sellable', 'ok', 'false', 'no', '0'].includes(normalized)) return false;
  if (['bad', 'damaged', 'rejected', 'true', 'yes', '1'].includes(normalized)) return true;
  throw new InputError('Condition must be Good or Bad.');
}

export function parseReturnsReceivedRow(row = {}) {
  const orderItemId = textInput(firstUploadValue(row, 'order_item_id', 'orderitemid'), 'Order item id', { required: true, max: 250 });
  const receivedRaw = firstUploadValue(row, 'return_received_yes_no', 'return_received', 'received');
  const conditionRaw = firstUploadValue(row, 'condition_good_bad', 'condition', 'is_bad_return', 'isbadreturn', 'bad');
  const dateRaw = firstUploadValue(row, 'received_date', 'receiveddate', 'date');
  const received = returnReceiptFlag(receivedRaw, 'Return Received?');
  const isBad = returnCondition(conditionRaw);
  const dateText = str(dateRaw);
  const receivedDate = dateText == null ? null : dt(dateText);
  if (dateText != null && !receivedDate) throw new InputError('Received Date must be a valid date.');

  // Legacy files without the explicit Yes/No column remain supported only when
  // they contain the required receipt facts; blank rows can never become "good".
  const effectiveReceived = received == null && (isBad != null || receivedDate != null) ? true : received;
  if (effectiveReceived == null) throw new InputError('Return Received? is required.');
  if (!effectiveReceived) {
    if (isBad != null || receivedDate != null) throw new InputError('Condition and Received Date must be blank when Return Received? is No.');
    return { orderItemId, received: false, isBad: null, receivedDate: null, notes: textInput(firstUploadValue(row, 'notes', 'remark', 'comment'), 'Notes', { max: 4000 }) };
  }
  if (isBad == null) throw new InputError('Condition is required when Return Received? is Yes.');
  if (!receivedDate) throw new InputError('Received Date is required when Return Received? is Yes.');
  return {
    orderItemId,
    received: true,
    isBad,
    receivedDate,
    notes: textInput(firstUploadValue(row, 'notes', 'remark', 'comment'), 'Notes', { max: 4000 }),
  };
}

function upsertSkuMasterRows(pool, records) {
  let inserted = 0;
  let updated = 0;
  return forEachDbBatch(records, 9, async batch => {
    const values = [];
    const groups = batch.map((record) => {
      const start = values.length;
      values.push(record.masterSku, record.marketplace, record.listingSku, record.cogs, record.launchDate, record.productName, record.weightSlab, record.brandName, record.category || null);
      return `(${Array.from({ length: 9 }, (_, index) => `$${start + index + 1}`).join(', ')})`;
    });
    const result = await pool.query(`
      INSERT INTO sku_master (master_sku, marketplace, listing_sku, cogs, launch_date, product_name, weight_slab, brand_name, category)
      VALUES ${groups.join(', ')}
      ON CONFLICT (marketplace, listing_sku) DO UPDATE
        SET master_sku   = EXCLUDED.master_sku,
            cogs         = EXCLUDED.cogs,
            launch_date  = COALESCE(EXCLUDED.launch_date, sku_master.launch_date),
            product_name = COALESCE(NULLIF(EXCLUDED.product_name,''), sku_master.product_name),
            weight_slab  = COALESCE(EXCLUDED.weight_slab, sku_master.weight_slab),
            brand_name   = COALESCE(NULLIF(EXCLUDED.brand_name,''), sku_master.brand_name),
            category     = COALESCE(NULLIF(EXCLUDED.category,''), sku_master.category)
      RETURNING (xmax = 0) AS inserted
    `, values);
    for (const row of result.rows) {
      if (row.inserted) inserted++;
      else updated++;
    }

    // Sync into vb_sku_master
    const vbRows = batch.map(r => [r.masterSku, r.category || null, r.cogs || 0, r.weightSlab || null, r.productName || null]);
    await forEachDbBatch(vbRows, 5, async vbBatch => {
      const vVals = [];
      const vGroups = vbBatch.map(r => {
        const s = vVals.length;
        vVals.push(...r);
        return `($${s+1}, $${s+2}, $${s+3}, $${s+4}, $${s+5})`;
      });
      await pool.query(`
        INSERT INTO vb_sku_master (vb_export_sku, category, cogs, weight_slab, product_name)
        VALUES ${vGroups.join(', ')}
        ON CONFLICT (vb_export_sku) DO UPDATE
        SET category = COALESCE(EXCLUDED.category, vb_sku_master.category),
            cogs = CASE WHEN EXCLUDED.cogs > 0 THEN EXCLUDED.cogs ELSE vb_sku_master.cogs END,
            weight_slab = COALESCE(EXCLUDED.weight_slab, vb_sku_master.weight_slab),
            product_name = COALESCE(NULLIF(EXCLUDED.product_name,''), vb_sku_master.product_name),
            updated_at = NOW();
      `, vVals);
    });
  }).then(async () => {
    await pool.query(`
      UPDATE orders o
      SET vb_export_sku = sm.master_sku,
          vb_export_category = sm.category
      FROM sku_master sm
      WHERE o.sku = sm.listing_sku
        AND (
          o.vb_export_sku IS DISTINCT FROM sm.master_sku
          OR o.vb_export_category IS DISTINCT FROM sm.category
        );
    `).catch(e => console.warn('[sku_master] backfill orders:', e.message));

    return { inserted, updated };
  });
}

function upsertCatalogCogsRows(pool, records) {
  let inserted = 0;
  let updated = 0;
  return forEachDbBatch(records, 6, async batch => {
    const values = [];
    const groups = batch.map((record) => {
      const start = values.length;
      values.push(record.marketplace, record.catalogId, record.category, record.cogs, record.productName, record.brandName);
      return `(${Array.from({ length: 6 }, (_, index) => `$${start + index + 1}`).join(', ')})`;
    });
    const result = await pool.query(`
      INSERT INTO catalog_cogs (marketplace, catalog_id, category, cogs, product_name, brand_name)
      VALUES ${groups.join(', ')}
      ON CONFLICT (marketplace, catalog_id) DO UPDATE
        SET category     = COALESCE(NULLIF(EXCLUDED.category,''), catalog_cogs.category),
            cogs         = EXCLUDED.cogs,
            product_name = COALESCE(NULLIF(EXCLUDED.product_name,''), catalog_cogs.product_name),
            brand_name   = COALESCE(NULLIF(EXCLUDED.brand_name,''), catalog_cogs.brand_name),
            updated_at   = NOW()
      RETURNING (xmax = 0) AS inserted
    `, values);
    for (const row of result.rows) {
      if (row.inserted) inserted++;
      else updated++;
    }
  }).then(() => ({ inserted, updated }));
}

// ── Batch UPSERT (INSERT ON CONFLICT) ─────────────────────────────────────────
async function batchUpsert(pool, table, keyCol, fields, rows, marketplace, conflictCondition = '', sellerAccount = 'default') {
  let inserted = 0;
  let updated = 0;
  const colList  = [...fields.map(([c]) => c), 'marketplace', 'seller_account'].join(', ');
  let updateSet = fields.filter(([c]) => c !== keyCol)
    .map(([c]) => `${c} = EXCLUDED.${c}`).join(', ') + ', marketplace = EXCLUDED.marketplace, seller_account = EXCLUDED.seller_account, uploaded_at = NOW()';
  
  if (conflictCondition) {
    updateSet += ` WHERE ${conflictCondition}`;
  }

  const keyIdx = fields.findIndex(([c]) => c === keyCol);
  
  // Deduplicate by keyCol — keep last occurrence, but if it's returns, prefer active over cancelled if same key
  const seen = new Map();
  for (const row of rows) {
    const key = row[keyIdx];
    if (table === 'returns' && seen.has(key)) {
      const existing = seen.get(key);
      const statusIdx = fields.findIndex(([c]) => c === 'return_status');
      const dateIdx = fields.findIndex(([c]) => c === 'return_requested_date');
      const exDate = new Date(existing[dateIdx]);
      const newDate = new Date(row[dateIdx]);
      
      if (newDate > exDate || (newDate.getTime() === exDate.getTime() && row[statusIdx] !== 'cancelled')) {
        seen.set(key, row);
      }
    } else {
      seen.set(key, row);
    }
  }
  const deduped = [...seen.values()];

  await forEachDbBatch(deduped, fields.length + 2, async batch => {
    const values = [];
    const groups = batch.map((row) => {
      const start = values.length;
      values.push(...row, marketplace, sellerAccount);
      return `(${[...row, marketplace, sellerAccount].map((_, ci) => `$${start + ci + 1}`).join(', ')})`;
    });
    try {
      const { rows: outcomeRows } = await pool.query(
        `INSERT INTO ${table} (${colList}) VALUES ${groups.join(', ')}
         ON CONFLICT (marketplace, seller_account, ${keyCol}) DO UPDATE SET ${updateSet}
         RETURNING (xmax = 0) AS inserted`,
        values
      );
      for (const outcome of outcomeRows) {
        if (outcome.inserted) inserted++;
        else updated++;
      }
    } catch (e) {
      if (e.message.includes('no unique or exclusion constraint')) {
        throw new Error(`Database setup incomplete: no UNIQUE constraint on "${keyCol}" in table "${table}". Please run the database migration and restart the server.`);
      }
    }
  });

  if (table === 'orders' && (inserted || updated)) {
    try {
      await pool.query(`
        UPDATE orders o
        SET vb_export_sku = sm.master_sku,
            vb_export_category = sm.category
        FROM sku_master sm
        WHERE o.sku = sm.listing_sku
          AND (o.vb_export_sku IS NULL OR o.vb_export_category IS NULL);
      `);
    } catch (e) {
      console.warn('[batchUpsert orders] vb_export_sku backfill skipped:', e.message);
    }
  }

  // Repeated keys within a workbook and rows rejected by a conditional update
  // are counted as skipped so upload history never claims they were inserted.
  return { inserted, updated, skipped: rows.length - inserted - updated };
}

// ── Batch INSERT (for settlements — no unique key conflict) ───────────────────
async function batchInsert(pool, table, fields, rows, marketplace) {
  let affected = 0;
  const colList = fields.map(([c]) => c).join(', ');

  await forEachDbBatch(rows, fields.length + 1, async batch => {
    const values = [];
    const groups = batch.map((row) => {
      const start = values.length;
      values.push(...row, marketplace);
      return `(${[...row, marketplace].map((_, ci) => `$${start + ci + 1}`).join(', ')})`;
    });
    const { rowCount } = await pool.query(
      `INSERT INTO ${table} (${colList}, marketplace) VALUES ${groups.join(', ')}`,
      values
    );
    affected += rowCount;
  });
  return affected;
}

// ── Field definitions — [colName, getter(g)] ──────────────────────────────────
const ORDER_FIELDS = [
  ['order_id',               g => str(g('Order ID'))],
  ['order_item_id',          g => { const v = str(g('Order Item ID')); return v ? v.replace(/^OI:/i, '') || null : null; }],
  ['fsn',                    g => str(g('FSN'))],
  ['sku',                    g => str(g('SKU'))],
  ['brand',                  g => str(g('Brand'))],
  ['selling_channel',        g => str(g('Selling Channel'))],
  ['category',               g => str(g('Category'))],
  ['hsn_code',               g => str(g('HSN Code'))],
  ['order_type',             g => str(g('Order Type'))],
  ['fulfilment_type',        g => str(g('Fulfilment Type'))],
  ['order_date',             g => dt(g('Order Date'), g.dateFormat('Order Date'))],
  ['qty',                    g => num(g('QTY') || g('Qty'))],
  ['final_invoice_amount',   g => num(g('Amount') || g('Final Invoice Amount'))],
  ['total_share_amount',     g => num(g('Total Offer Amount'))],
  ['my_share',               g => num(g('My Share'))],
  ['delivery_state',         g => normalizeDeliveryState(g("Customer's Delivery State") || g('Delivery State'))],
  ['delivery_city',          g => str(g('Delivery City'))],
  ['warehouse_id',           g => str(g('Warehouse ID'))],
  ['warehouse_city',         g => str(g('Warehouse City'))],
  ['delivery_pincode',       g => str(g("Customer's Delivery Pincode") || g('Delivery Pincode'))],
  ['orders_status',          g => str(g('Orders Status'))],
  ['return_type',            g => str(g('Return Type'))],
  ['weight_slab',            g => str(g('Weight Slab'))],
  ['shipping_zone',          g => str(g('Shipping Zone'))],
  ['commission',             g => num(g('Commission'))],
  ['fixed_fee',              g => num(g('Fixed Fee'))],
  ['collection_fee',         g => num(g('Collection Fee'))],
  ['pick_pack_fee',          g => num(g('Pick Pack Fee'))],
  ['shipping_fee',           g => num(g('Shipping Fee'))],
  ['reverse_shipping',       g => num(g('Reverse Shipping'))],
  ['franchise',              g => num(g('Franchise'))],
  ['customer_addon_recovery',g => num(g('Customer Addon Recovery'))],
  ['tcs',                    g => num(g('TCS'))],
  ['tds',                    g => num(g('TDS'))],
  ['gst_on_mp',              g => num(g('GST on MP'))],
  ['settlement_amount',      g => num(g('Settlement Amount'))],
  ['return_received_amount', g => num(g('Return Received Amount'))],
  ['spf_amount',             g => num(g('SPF Amount'))],
  ['brand_name',             g => str(g('Brand'))],
];

const RETURN_FIELDS = [
  ['return_id',                     g => { const v = str(g('return_id')); return v ? v.replace(/^RI:/i, '') || null : null; }],
  ['order_item_id',                 g => { const v = str(g('order_item_id')); return v ? v.replace(/^OI:/i, '') || null : null; }],
  ['fulfilment_type',               g => str(g('fulfilment_type'))],
  ['return_requested_date',         g => dt(g('return_requested_date'), g.dateFormat('return_requested_date'))],
  ['return_approval_date',          g => dt(g('return_approval_date'), g.dateFormat('return_approval_date'))],
  ['return_status',                 g => {
      const status = str(g('return_status'));
      const cancelDate = str(g('return_cancellation_date'));
      return cancelDate ? 'cancelled' : status;
    }],
  ['return_reason',                 g => str(g('return_reason'))],
  ['return_sub_reason',             g => str(g('return_sub_reason'))],
  ['return_type',                   g => str(g('return_type'))],
  ['return_result',                 g => str(g('return_result'))],
  ['return_expectation',            g => str(g('return_expectation'))],
  ['reverse_logistics_tracking_id', g => { const v = str(g('reverse_logistics_tracking_id')); return v ? v.replace(/^RTr:/i, '') : null; }],
  ['sku',                           g => { const v = str(g('sku')); return v ? v.replace(/^SKU:/i, '') : null; }],
  ['fsn',                           g => str(g('fsn'))],
  ['product_title',                 g => str(g('product_title'))],
  ['quantity',                      g => num(g('quantity'))],
  ['return_completion_type',        g => str(g('return_completion_type'))],
  ['primary_pv_output',             g => str(g('primary_pv_output'))],
  ['detailed_pv_output',            g => str(g('detailed_pv_output'))],
  ['final_condition',               g => str(g('final_condition_of_returned_product') || g('final_condition'))],
  ['return_cancellation_reason',    g => str(g('return_cancellation_reason'))],
  ['tech_visit_sla',                g => str(g('tech_visit_sla'))],
  ['tech_visit_by_date',            g => dt(g('tech_visit_by_date'), g.dateFormat('tech_visit_by_date'))],
  ['tech_visit_completion_datetime',g => str(g('tech_visit_completion_datetime'))],
  ['tech_visit_completion_breach',  g => str(g('tech_visit_completion_breach'))],
  ['return_completion_sla',         g => str(g('return_completion_sla'))],
  ['return_complete_by_date',       g => dt(g('return_complete_by_date'), g.dateFormat('return_complete_by_date'))],
  ['return_completion_date',        g => dt(g('return_completion_date'), g.dateFormat('return_completion_date'))],
  ['return_completion_breach',      g => str(g('return_completion_breach'))],
  ['return_cancellation_date',      g => dt(g('return_cancellation_date'), g.dateFormat('return_cancellation_date'))],
  ['return_date',                   g => dt(g('return_date') || g('Return Date'), g.dateFormat('return_date') || g.dateFormat('Return Date'))],
];

const SETTLEMENT_FIELDS = [
  ['neft_id',                g => str(g('NEFT ID'))],
  ['neft_type',              g => str(g('NEFT Type'))],
  ['payment_date',           g => dt(g('Payment Date'), g.dateFormat('Payment Date'))],
  ['bank_settlement',        g => num(g('Bank Settlement'))],
  ['input_gst_tcs',          g => num(g('Input GST TCS'))],
  ['income_tax_credits',     g => num(g('Income Tax Credits'))],
  ['order_id',               g => str(g('Order ID'))],
  ['order_item_id',          g => str(g('Order Item ID'))],
  ['sale_amount',            g => num(g('Sale Amount'))],
  ['total_offer_amount',     g => num(g('Total Offer Amount'))],
  ['my_share',               g => num(g('My Share'))],
  ['customer_addons',        g => num(g('Customer Addons'))],
  ['marketplace_fee',        g => num(g('Marketplace Fee'))],
  ['taxes',                  g => num(g('Taxes'))],
  ['offer_adjustments',      g => num(g('Offer Adjustments'))],
  ['protection_fund',        g => num(g('Protection Fund'))],
  ['refund',                 g => num(g('Refund'))],
  ['tier',                   g => str(g('Tier'))],
  ['commission_rate',        g => num(g('Commission Rate'))],
  ['commission',             g => num(g('Commission'))],
  ['fixed_fee',              g => num(g('Fixed Fee'))],
  ['collection_fee',         g => num(g('Collection Fee'))],
  ['pick_pack_fee',          g => num(g('Pick Pack Fee'))],
  ['shipping_fee',           g => num(g('Shipping Fee'))],
  ['reverse_shipping',       g => num(g('Reverse Shipping'))],
  ['customer_addon_recovery',g => num(g('Customer Addon Recovery'))],
  ['franchise_fee',          g => num(g('Franchise Fee'))],
  ['tcs',                    g => num(g('TCS'))],
  ['tds',                    g => num(g('TDS'))],
  ['gst_on_mp_fees',         g => num(g('GST on MP Fees'))],
  ['shipping_zone',          g => str(g('Shipping Zone'))],
  ['order_date',             g => dt(g('Order Date'), g.dateFormat('Order Date'))],
  ['dispatch_date',          g => dt(g('Dispatch Date'), g.dateFormat('Dispatch Date'))],
];

const ORDER_DATE_FIELDS      = ['Order Date'];
const RETURN_DATE_FIELDS     = ['return_approval_date', 'return_requested_date', 'return_date', 'Return Date', 'tech_visit_by_date', 'return_complete_by_date', 'return_completion_date', 'return_cancellation_date'];
const SETTLEMENT_DATE_FIELDS = ['Payment Date', 'Order Date', 'Dispatch Date'];

const FIELD_ALIASES = {
  'Order ID':            ['order number','order no','orderid','amazon-order-id','amazonorderid','merchant-order-id','sub_order_num','sub order num'],
  'Order Item ID':       ['order item','order line id','sub order id','orderitemid','order-item-id','amazon-order-item-id','orderitemcode','order-item-code','sub_order_num','sub order num'],
  'Amount': ['invoice amount','selling price','gross amount','item total','item-price','itemprice','item price','total_invoice_value','total invoice value'],
    'Final Invoice Amount':['invoice amount','selling price','gross amount','item total','item-price','itemprice','item price','total_invoice_value','total invoice value'],
  'Total Offer Amount':  ['offer amount','discount amount'],
  'My Share':            ['seller share','your share','net seller amount'],
  'Order Date':          ['ordered date','purchase date','created date','purchase-date','purchasedate'],
  'Qty':                 ['quantity','quantity-purchased','qtypurchased','units'],
  'FSN':                 ['asin','amazon asin','item asin'],
  'Delivery State':      ['ship-state','shipstate','ship state','shipping state'],
  'Delivery City':       ['ship-city','shipcity','ship city','shipping city'],
  'Delivery Pincode':    ['ship-postal-code','shippostalcode','ship postal code','postal code','pincode'],
  'Fulfilment Type':     ['fulfillment-channel','fulfillmentchannel','fulfillment channel','fulfilment channel'],
  'Orders Status':       ['order-status','orderstatus','order status','item-status','itemstatus','item status'],
  'Selling Channel':     ['sales-channel','saleschannel','sales channel'],
  'Category':            ['product-group','productgroup','gl','browse-node','browsecategory'],
  'Shipping Fee':        ['shipping-price','shippingprice','shipping price','shipping charge'],
  'GST on MP':           ['item-tax','itemtax','item tax'],
  'Return Requested Date': ['return date','requested date','cancel_return_date','cancel return date'],
  'Return Approval Date':  ['approval date','approved date','return-date','returndate'],
  'Payment Date':        ['settlement date','paid date','neft date'],
  'Bank Settlement':     ['bank settlement value','settlement value','bank amount'],
  'Dispatch Date':       ['shipped date','shipment date'],
  'SKU':                 ['seller sku','sku id','merchant sku','merchant-sku','merchantsku'],
  'return_reason':       ['reason','return reason','customer reason'],
  'return_status':       ['status','return status','return-status'],
  'return_result':       ['detailed disposition','detailed-disposition','disposition'],
  'return_type':         ['return type','return-type'],
  'product_title':       ['title','product name','product-name','productname','item title'],
  'quantity':            ['qty','quantity','quantity-purchased','units returned'],
  'return_date':         ['return date','return-date','returndate'],
  'Brand':               ['brand name','brand_name','manufacturer','seller brand'],
};

function normalize(s) { return (s + '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function autoMap(fields, headers) {
  const norm = headers.map(h => ({ orig: h, norm: normalize(h) }));
  const map = {};
  for (const f of fields) {
    const fn = normalize(f);
    const hit = norm.find(h => h.norm === fn)
             || norm.find(h => h.norm.startsWith(fn))
             || norm.find(h => fn.startsWith(h.norm) && h.norm.length > 4)
             || norm.find(h => h.norm.includes(fn) && fn.length > 5);
    if (hit) map[f] = hit.orig;
    if (!map[f]) {
      const candidates = [f, ...(FIELD_ALIASES[f] || [])].map(normalize).filter(Boolean);
      const aliasHit = norm.find(h => candidates.some(c => h.norm === c || h.norm.startsWith(c) || h.norm.includes(c)));
      if (aliasHit) map[f] = aliasHit.orig;
    }
  }
  return map;
}

async function resolveColumnMap(colMap, requiredFields, headers) {
  if (Object.keys(colMap).length === 0) {
    const basicMap = autoMap(requiredFields, headers);
    Object.assign(colMap, basicMap);
  }
}

async function getDateFormats(rawRows, dateFields, colMap) {
  return buildDateFormatMap({
    rows: rawRows,
    dateFields,
    valueFor: (rawRow, field) => getField(rawRow, field, colMap),
  });
}

// ── GET /api/upload/fields/:type ───────────────────────────────────────────────
router.get('/fields/:type', (req, res) => {
  const fields = REQUIRED_FIELDS[req.params.type];
  if (!fields) return res.status(404).json({ error: 'Unknown type' });
  res.json({ fields });
});

// ── GET /api/upload/template/:type ────────────────────────────────────────────
router.get('/template/:type', (req, res) => {
  const type   = req.params.type;
  const fields = REQUIRED_FIELDS[type];
  if (!fields) return res.status(404).json({ error: 'Unknown template type' });
  const samples = TEMPLATE_SAMPLES[type] || [];
  // Pad / trim sample rows to match header length so Excel columns stay aligned
  const sampleRows = samples.map(row =>
    fields.map((_, i) => (row[i] != null ? row[i] : ''))
  );
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([fields, ...sampleRows]);
  ws['!cols'] = fields.map(f => ({ wch: Math.max(String(f).length + 4, 18) }));
  XLSX.utils.book_append_sheet(wb, ws, type === 'amazon-sale-orders' ? 'Sale Orders' : type.slice(0, 31));
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = type === 'amazon-sale-orders'
    ? 'Amazon_Sale_Order_Template.xlsx'
    : `template_${type}_sample.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(buf);
});

// ── GET /api/upload/template/vb-export-prefilled ──────────────────────────────
// Download Excel template prefilled with user's actual VB Export SKUs from vb_sku_master
// Falls back to extracting unique vb_export_sku from orders table if master catalog is empty
router.get('/template/vb-export-prefilled', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    
    // Fetch all VB Export SKUs from the master catalog
    const { rows: vbSkus } = await pool.query(`
      SELECT
        vb_export_sku,
        category,
        cogs,
        weight_slab,
        COALESCE(product_name, '') as product_name
      FROM vb_sku_master
      ORDER BY vb_export_sku ASC
    `);
    
    // Fetch all marketplace listing SKUs mapped to each VB Export SKU from sku_master
    const { rows: listings } = await pool.query(`
      SELECT
        master_sku,
        listing_sku,
        marketplace,
        COALESCE(category, '') as category,
        cogs,
        weight_slab,
        COALESCE(product_name, '') as product_name
      FROM sku_master
      ORDER BY master_sku, marketplace, listing_sku
    `);

    // If master catalog is empty, extract unique VB Export SKUs from orders table
    // This gives users a template with their actual SKUs even before first catalog upload
    let orderSkus = [];
    if (vbSkus.length === 0) {
      const { rows } = await pool.query(`
        SELECT DISTINCT
          vb_export_sku,
          vb_export_category as category,
          weight_slab,
          cogs
        FROM orders
        WHERE vb_export_sku IS NOT NULL AND vb_export_sku != ''
        ORDER BY vb_export_sku ASC
      `);
      orderSkus = rows;
    }
    
    // Fields for the template
    const fields = ['Marketplace SKU', "VB EXPORT SKU's", 'VB Export Product Category', 'Weight Slab (kg)', 'COGS (₹)', 'Marketplace'];

    // Build rows from vb_sku_master (master catalog entries)
    const masterRows = vbSkus.map(r => {
      // For master catalog, we don't have a specific marketplace listing SKU
      // We'll create a row for the master VB SKU itself
      return [
        r.vb_export_sku,           // Marketplace SKU - use VB SKU as reference
        r.vb_export_sku,           // VB EXPORT SKU's
        r.category || '',          // VB Export Product Category
        r.weight_slab != null ? r.weight_slab : '',  // Weight Slab (kg)
        r.cogs != null ? r.cogs : '',                 // COGS (₹)
        'all'                       // Marketplace - master catalog applies to all
      ];
    });

    // Build rows from sku_master (marketplace-specific listing mappings)
    const listingRows = listings.map(r => [
      r.listing_sku,               // Marketplace SKU - actual listing SKU
      r.master_sku,                // VB EXPORT SKU's
      r.category || '',            // VB Export Product Category (from sku_master)
      r.weight_slab != null ? r.weight_slab : '',     // Weight Slab (kg)
      r.cogs != null ? r.cogs : '',                    // COGS (₹)
      r.marketplace || 'all'      // Marketplace
    ]);

    // Build rows from orders (fallback when master catalog is empty)
    const orderRows = orderSkus.map(r => [
      r.vb_export_sku,             // Marketplace SKU - use VB SKU as reference
      r.vb_export_sku,             // VB EXPORT SKU's
      r.category || '',            // VB Export Product Category
      r.weight_slab != null ? r.weight_slab : '',  // Weight Slab (kg)
      r.cogs != null ? r.cogs : '',               // COGS (₹)
      'all'                         // Marketplace - applies to all
    ]);

    // Combine: master catalog rows first, then sku_master listings, then orders fallback
    const allRows = [...masterRows, ...listingRows, ...orderRows];

    // If still no data, add a sample row for reference
    const finalRows = allRows.length > 0 ? allRows : [
      ['EJ1201-16001_FK', 'EJ1201-16001', 'Kurta Set', 0.5, 450, 'flipkart'],
      ['EJ1201-16001_M',  'EJ1201-16001', 'Kurta Set', 0.5, 450, 'myntra_ej'],
      ['7Y-UQCI-Y51D',     'EJ1201-16001', 'Kurta Set', 0.5, 450, 'amazon'],
    ];

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([fields, ...finalRows]);
    ws['!cols'] = fields.map(f => ({ wch: Math.max(String(f).length + 4, 22) }));
    XLSX.utils.book_append_sheet(wb, ws, 'VB Export Catalog');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', `attachment; filename="VB_Export_Product_Catalog_Prefilled.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(buf);
  } catch (e) {
    console.error('[template/vb-export-prefilled]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/upload/status ─────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false, logs: [], counts: {} });
  try {
    const pool = getPool();
    const [logs, counts, lastUploads, fkPeriod, dataCoverage] = await Promise.all([
      pool.query(`SELECT * FROM upload_log WHERE data_cleared_at IS NULL ORDER BY uploaded_at DESC LIMIT 50`),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM orders)                  AS orders,
          (SELECT COUNT(*) FROM returns)                 AS returns,
          (SELECT COUNT(*) FROM settlements)             AS settlements,
          (SELECT COUNT(*) FROM fk_settlement_orders)    AS fk_settlement_orders,
          (SELECT COUNT(*) FROM fk_spf_claims)           AS fk_spf_claims,
          (SELECT COUNT(*) FROM fk_storage_recall)       AS fk_storage_recall,
          (SELECT COUNT(*) FROM fk_ads)                  AS fk_ads,
          (SELECT COUNT(*) FROM amazon_settlement_items) AS amazon_settlement_items,
          -- Amazon multi-source pipeline counts
          (SELECT COUNT(*) FROM amazon_settlements)                                AS amazon_settlements,
          (SELECT COUNT(*) FROM amazon_settlement_lines)                           AS amazon_settlement_lines,
          (SELECT COUNT(*) FROM orders WHERE marketplace = 'amazon')               AS amazon_orders,
          (SELECT COUNT(*) FROM returns WHERE marketplace = 'amazon'
             AND fulfilment_type = 'FBA')                                          AS amazon_fba_returns,
          (SELECT COUNT(*) FROM returns WHERE marketplace = 'amazon'
             AND fulfilment_type = 'Flex')                                         AS amazon_flex_returns
          ,(SELECT COUNT(*) FROM mp_invoices WHERE marketplace = 'myntra'
             AND seller_account = 'myntra_ej')                                     AS myntra_ej_invoices
          ,(SELECT COUNT(*) FROM mp_invoices WHERE marketplace = 'myntra'
             AND seller_account = 'myntra_vb')                                     AS myntra_vb_invoices
          ,(SELECT COUNT(*) FROM orders WHERE marketplace = 'myntra'
             AND seller_account = 'myntra_ej')                                     AS myntra_ej_orders
          ,(SELECT COUNT(*) FROM returns WHERE marketplace = 'myntra'
             AND seller_account = 'myntra_ej')                                     AS myntra_ej_returns
          ,(SELECT COUNT(*) FROM orders WHERE marketplace = 'myntra'
             AND seller_account = 'myntra_vb')                                     AS myntra_vb_orders
          ,(SELECT COUNT(*) FROM returns WHERE marketplace = 'myntra'
             AND seller_account = 'myntra_vb')                                     AS myntra_vb_returns
      `),
      pool.query(`
        SELECT data_type, MAX(uploaded_at) AS last_uploaded
        FROM upload_log WHERE status = 'ok' AND data_cleared_at IS NULL
        GROUP BY data_type
      `),
      pool.query(`
        SELECT
          MIN(payment_date) AS period_start,
          MAX(payment_date) AS period_end,
          COUNT(DISTINCT neft_id) AS neft_count
        FROM fk_settlement_orders
      `),
      // This reports the currently stored business-data range, not just when
      // a file was uploaded. It lets operators see exactly which date each
      // marketplace feed is up to after re-uploads and corrections.
      pool.query(`
        SELECT data_type, MIN(data_date) AS period_start, MAX(data_date) AS period_end
        FROM (
          SELECT 'orders' AS data_type, order_date AS data_date
          FROM orders WHERE marketplace = 'flipkart'
          UNION ALL
          SELECT 'returns', return_requested_date
          FROM returns WHERE marketplace = 'flipkart'
          UNION ALL
          SELECT 'fk_settlement_orders', payment_date
          FROM fk_settlement_orders
          UNION ALL
          SELECT 'amazon_sale_orders', order_date
          FROM orders WHERE marketplace = 'amazon'
          UNION ALL
          SELECT 'amazon_fba_returns', return_approval_date
          FROM returns WHERE marketplace = 'amazon' AND fulfilment_type = 'FBA'
          UNION ALL
          SELECT 'amazon_flex_returns', return_approval_date
          FROM returns WHERE marketplace = 'amazon' AND fulfilment_type = 'Flex'
          UNION ALL
          SELECT 'amazon_settlement', posted_date
          FROM amazon_settlement_lines
          UNION ALL
          SELECT 'myntra_ej_orders', order_date
          FROM orders WHERE marketplace = 'myntra' AND seller_account = 'myntra_ej'
          UNION ALL
          SELECT 'myntra_ej_returns', return_requested_date
          FROM returns WHERE marketplace = 'myntra' AND seller_account = 'myntra_ej'
          UNION ALL
          SELECT 'myntra_ej_invoices', COALESCE(payment_date, invoice_date)
          FROM mp_invoices WHERE marketplace = 'myntra' AND seller_account = 'myntra_ej'
          UNION ALL
          SELECT 'myntra_vb_orders', order_date
          FROM orders WHERE marketplace = 'myntra' AND seller_account = 'myntra_vb'
          UNION ALL
          SELECT 'myntra_vb_returns', return_requested_date
          FROM returns WHERE marketplace = 'myntra' AND seller_account = 'myntra_vb'
          UNION ALL
          SELECT 'myntra_vb_invoices', COALESCE(payment_date, invoice_date)
          FROM mp_invoices WHERE marketplace = 'myntra' AND seller_account = 'myntra_vb'
        ) coverage
        WHERE data_date IS NOT NULL
        GROUP BY data_type
      `),
    ]);

    const lastMap = {};
    lastUploads.rows.forEach(r => { lastMap[r.data_type] = r.last_uploaded; });
    const coverageMap = {};
    dataCoverage.rows.forEach(r => {
      coverageMap[r.data_type] = { periodStart: r.period_start, periodEnd: r.period_end };
    });

    res.json({
      configured: true,
      dbConnected: !isDbOffline(),
      counts: counts.rows[0] || {},
      logs: logs.rows || [],
      lastUploads: lastMap,
      fkSettlementPeriod: fkPeriod.rows[0],
      dataCoverage: coverageMap,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/upload/log/:id/remark ───────────────────────────────────────────
// Full, filterable history. This is separate from /status, whose latest-50
// payload stays intentionally small for the dashboard health cards.
router.get('/history', async (req, res) => {
  if (!(await isDbConfigured())) {
    return res.json({
      configured: false,
      rows: [],
      pagination: { page: 1, pageSize: 25, total: 0 },
    });
  }
  try {
    const history = await getUploadHistory(getPool(), req.query);
    res.json({ configured: true, ...history });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/log/:id/remark', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  const logId = req.params.id;
  if (!/^\d+$/.test(logId) || logId === '0') {
    return res.status(400).json({ error: 'A valid upload history ID is required.' });
  }

  try {
    const pool = getPool();
    const remark = String(req.body?.remark ?? '').trim().slice(0, 500);
    const { rows } = await pool.query(
      `UPDATE upload_log
       SET remark = $1
       WHERE id = $2
       RETURNING id, remark`,
      [remark, logId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Upload history entry was not found.' });
    res.json({ ok: true, id: rows[0].id, remark: rows[0].remark });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/upload/clear/:type ────────────────────────────────────────────
// Removes imported data but retains the corresponding upload_log rows as audit
// evidence. Optional ?marketplace=flipkart|amazon scopes order/return clears.
router.delete('/clear/:type', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });

  const FK_TABLES   = ['fk_settlement_orders','fk_spf_claims','fk_storage_recall','fk_ads','fk_google_ads'];
  const FK_LOGTYPES = ['fk_settlement','fk_settlement_orders','fk_spf_claims','fk_storage_recall','fk_ads','fk_google_ads'];
  const marketplace = (req.query.marketplace || req.body?.marketplace || '').toLowerCase();

  const CONFIGS = {
    orders:               { tables: ['orders'],                     logTypes: ['orders'], scopeMp: true },
    returns:              { tables: ['returns'],                    logTypes: ['returns'], scopeMp: true },
    settlements:          { tables: ['settlements'],               logTypes: ['settlements'], scopeMp: false },
    amazon_settlement:    { tables: ['amazon_settlement_items','amazon_settlement_lines','amazon_settlements'], logTypes: ['amazon_settlement'], scopeMp: false },
    amazon_sale_orders:   { tables: ['orders'], logTypes: ['amazon_sale_orders'], scopeMp: true, forceMp: 'amazon' },
    amazon_order_summary: { tables: ['orders'], logTypes: ['amazon_order_summary'], scopeMp: true, forceMp: 'amazon' },
    amazon_order_reports: { tables: ['orders'], logTypes: ['amazon_order_reports'], scopeMp: true, forceMp: 'amazon' },
    amazon_fba_returns:   { tables: ['returns'], logTypes: ['amazon_fba_returns'], scopeMp: true, forceMp: 'amazon' },
    amazon_flex_returns:  { tables: ['returns'], logTypes: ['amazon_flex_returns'], scopeMp: true, forceMp: 'amazon' },
    // Each Myntra account has a separate log type and a scoped clear action;
    // clearing EJ can therefore never delete VB's payment/invoice data.
    myntra_ej_invoices:  { tables: ['mp_invoices'], logTypes: ['myntra_ej_invoices'], scopeMp: false, forceMp: 'myntra', forceSellerAccount: 'myntra_ej' },
    myntra_vb_invoices:  { tables: ['mp_invoices'], logTypes: ['myntra_vb_invoices'], scopeMp: false, forceMp: 'myntra', forceSellerAccount: 'myntra_vb' },
    myntra_ej_orders:    { tables: ['myntra_order_details', 'orders'], logTypes: ['myntra_ej_orders'], scopeMp: false, forceMp: 'myntra', forceSellerAccount: 'myntra_ej' },
    myntra_ej_returns:   { tables: ['myntra_return_details', 'returns'], logTypes: ['myntra_ej_returns'], scopeMp: false, forceMp: 'myntra', forceSellerAccount: 'myntra_ej' },
    myntra_vb_orders:    { tables: ['myntra_order_details', 'orders'], logTypes: ['myntra_vb_orders'], scopeMp: false, forceMp: 'myntra', forceSellerAccount: 'myntra_vb' },
    myntra_vb_returns:   { tables: ['myntra_return_details', 'returns'], logTypes: ['myntra_vb_returns'], scopeMp: false, forceMp: 'myntra', forceSellerAccount: 'myntra_vb' },
    fk_settlement:        { tables: FK_TABLES,     logTypes: FK_LOGTYPES, scopeMp: false },
    fk_settlement_orders: { tables: FK_TABLES,     logTypes: FK_LOGTYPES, scopeMp: false },
    fk_spf_claims:        { tables: FK_TABLES,     logTypes: FK_LOGTYPES, scopeMp: false },
    fk_storage_recall:    { tables: FK_TABLES,     logTypes: FK_LOGTYPES, scopeMp: false },
    fk_ads:               { tables: FK_TABLES,     logTypes: FK_LOGTYPES, scopeMp: false },
    fk_google_ads:        { tables: FK_TABLES,     logTypes: FK_LOGTYPES, scopeMp: false },
    all: { tables: ['orders','returns','settlements', ...FK_TABLES], logTypes: null, scopeMp: !!marketplace },
  };

  const cfg = CONFIGS[req.params.type];
  if (!cfg) return res.status(400).json({ error: `Unknown type: ${req.params.type}` });
  const clearReason = String(req.body?.reason ?? '').trim().slice(0, 500);
  if (!clearReason) {
    return res.status(400).json({ error: 'A clear reason is required so this removal can be audited.' });
  }

  let client;
  try {
    const pool = getPool();
    client = await pool.connect();
    await client.query('BEGIN');
    const deleted = {};
    const mp = cfg.forceMp || marketplace;
    for (const table of cfg.tables) {
      let result;
      if (cfg.forceSellerAccount && ['mp_invoices', 'myntra_order_details', 'myntra_return_details', 'orders', 'returns'].includes(table)) {
        result = await client.query(
          `DELETE FROM ${table} WHERE marketplace = $1 AND seller_account = $2`,
          [mp, cfg.forceSellerAccount],
        );
      } else if (cfg.scopeMp && mp && (table === 'orders' || table === 'returns')) {
        result = await client.query(`DELETE FROM ${table} WHERE COALESCE(marketplace,'flipkart') = $1`, [mp]);
      } else {
        result = await client.query(`DELETE FROM ${table}`);
      }
      deleted[table] = result.rowCount;
    }

    // These compact models are part of the same business-data transaction.
    // A clear must never leave a page showing settlement totals whose source
    // ledger has just been removed.
    if (cfg.tables.includes('amazon_settlement_lines')) {
      await refreshAmazonSettlementReportingRollups(client);
    }
    const refreshSettlementTotals = cfg.tables.includes('fk_settlement_orders')
      || cfg.tables.includes('amazon_settlement_lines')
      || (cfg.tables.includes('orders') && (!mp || mp === 'amazon'));
    if (refreshSettlementTotals) await refreshOrderSettlementTotals(client);

    // Reuse the exact log scope from the clear configuration, but mark records
    // as cleared instead of deleting them. The original filename, upload time,
    // counts, skipped rows, and operator remark therefore remain searchable.
    const logScopeValues = [];
    const addLogScopeValue = (value) => {
      logScopeValues.push(value);
      return `$${4 + logScopeValues.length}`;
    };
    let logScopeSql;
    if (cfg.logTypes === null) {
      if (mp) {
        logScopeSql = `COALESCE(marketplace,'flipkart') = ${addLogScopeValue(mp)}`;
      } else {
        logScopeSql = 'TRUE';
      }
    } else {
      const logTypes = cfg.logTypes.map(type => addLogScopeValue(type)).join(', ');
      if (mp && cfg.scopeMp) {
        logScopeSql = `data_type IN (${logTypes}) AND COALESCE(marketplace,'flipkart') = ${addLogScopeValue(mp)}`;
      } else {
        logScopeSql = `data_type IN (${logTypes})`;
      }
    }

    const clearedLogs = await client.query(
      `UPDATE upload_log
       SET data_cleared_at = NOW(),
           cleared_by = $3,
           cleared_by_email = $4,
           clear_reason = $2,
           cleared_row_counts = $1::jsonb
       WHERE data_cleared_at IS NULL AND ${logScopeSql}
       RETURNING id, data_type, filename, remark, data_cleared_at`,
      [
        JSON.stringify(deleted),
        clearReason,
        req.user?.firebase_uid || req.user?.id || null,
        req.user?.email || null,
        ...logScopeValues,
      ],
    );
    deleted.upload_log = clearedLogs.rowCount;
    await client.query('COMMIT');

    const retainedLogs = clearedLogs.rows.map(log => ({
      id: log.id,
      dataType: log.data_type,
      filename: log.filename,
      remark: log.remark,
      clearedAt: log.data_cleared_at,
    }));
    await writeAudit(req, {
      action: 'upload_data_cleared',
      entityType: 'upload_batch',
      entityId: req.params.type,
      details: {
        marketplace: mp || null,
        reason: clearReason,
        deletedRows: deleted,
        retainedUploadLogs: retainedLogs,
      },
    });
    res.json({
      ok: true,
      deleted,
      marketplace: mp || null,
      clearReason,
      retainedUploadLogs: retainedLogs,
    });
  } catch (e) {
    await client?.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client?.release();
  }
});

// ── POST /api/upload/orders ────────────────────────────────────────────────────
router.post('/orders', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  let inserted = 0, updated = 0, skipped = 0;
  let marketplace = 'flipkart';

  try {
    const colMap = parseColumnMap(req.body.columnMap);
    marketplace = genericMarketplace(req.body.marketplace);
    const pool = getPool();
    const { headers, data } = parseFile(req.file.buffer);
    await resolveColumnMap(colMap, REQUIRED_FIELDS.orders, headers);
    requireUploadRows(data);
    requireMappedFields('orders', colMap, headers);
    const toRow   = rowMapper(headers);
    const rawRows = data.map(toRow);
    const dateFormats = await getDateFormats(rawRows, ORDER_DATE_FIELDS, colMap);

    const parsedRows = [];
    const skippedRows = [];
    rawRows.forEach((rawRow, idx) => {
      const g = (f) => getField(rawRow, f, colMap);
      g.dateFormat = (f) => dateFormats[f];
      const vals = ORDER_FIELDS.map(([, get]) => get(g));
      const rawQty = g('QTY') || g('Qty');
      const rawAmount = g('Amount') || g('Final Invoice Amount');
      let reason = null;
      if (!vals[0]) reason = 'order_id is empty';
      else if (!vals[1]) reason = 'order_item_id is empty';
      else if (!vals[10]) reason = 'order_date is empty or invalid';
      else if (hasInvalidNumber(rawQty, vals[11]) || !Number.isInteger(vals[11]) || vals[11] < 1) reason = 'QTY must be a positive whole number';
      else if (hasInvalidNumber(rawAmount, vals[12]) || vals[12] == null) reason = 'Amount is empty or invalid';
      if (reason) {
        skipped++;
        skippedRows.push({ rowNum: idx + 2, reason, data: rowData(rawRow) });
        return;
      }
      parsedRows.push(vals);
    });

    const outcome = await batchUpsert(pool, 'orders', 'order_item_id', ORDER_FIELDS, parsedRows, marketplace);
    inserted = outcome.inserted;
    updated = outcome.updated;
    skipped += outcome.skipped;
    if (marketplace === 'amazon' && (inserted || updated)) await refreshOrderSettlementTotals(pool);

    const logId = await logUpload(pool, 'orders', req.file.originalname, marketplace, inserted, updated, skipped, 'ok');
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}
    res.json({ ok: true, inserted, updated, skipped, total: data.length, dateFormats: summarizeDateFormats(dateFormats), logId });
  } catch (e) {
    try { await logUpload(getPool(), 'orders', req.file.originalname, marketplace, inserted, updated, skipped, 'error', e.message); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── POST /api/upload/returns ───────────────────────────────────────────────────
router.post('/returns', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  let inserted = 0, updated = 0, skipped = 0;
  let marketplace = 'flipkart';

  try {
    const colMap = parseColumnMap(req.body.columnMap);
    marketplace = genericMarketplace(req.body.marketplace);
    const pool = getPool();
    const { headers, data } = parseFile(req.file.buffer, ['Return Data', 'Returns']);
    await resolveColumnMap(colMap, REQUIRED_FIELDS.returns, headers);
    requireUploadRows(data);
    requireMappedFields('returns', colMap, headers);
    const toRow   = rowMapper(headers);
    const rawRows = data.map(toRow);
    const dateFormats = await getDateFormats(rawRows, RETURN_DATE_FIELDS, colMap);

    const parsedRows = [];
    const skippedRows = [];
    rawRows.forEach((rawRow, idx) => {
      const g = (f) => getField(rawRow, f, colMap);
      g.dateFormat = (f) => dateFormats[f];
      const vals = RETURN_FIELDS.map(([, get]) => get(g));
      const rawQuantity = g('quantity');
      if (hasInvalidNumber(rawQuantity, vals[15]) || (vals[15] != null && (!Number.isInteger(vals[15]) || vals[15] < 1))) {
        skipped++;
        skippedRows.push({ rowNum: idx + 2, reason: 'quantity must be a positive whole number', data: rowData(rawRow) });
        return;
      }
      // Fallback: if order_item_id missing but return_id present, use synthetic key
      if (!vals[1]) {
        if (vals[0]) {
          vals[1] = `RET_${vals[0]}`;
        } else if (marketplace === 'amazon') {
          // Amazon returns: synthesise from order_id + sku (vals[12]=sku, order_id via g)
          const ordId = str(g('Order ID') || g('order_id')) || '';
          const sku   = vals[12] || '';
          if (ordId) {
            vals[1] = `AMZR-${ordId}${sku ? `-${sku.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,30)}` : `-${idx}`}`;
            if (!vals[0]) vals[0] = vals[1]; // use as return_id too
          } else {
            skipped++;
            skippedRows.push({ rowNum: idx + 2, reason: 'order_item_id and order_id both empty', data: rowData(rawRow) });
            return;
          }
        } else {
          skipped++;
          skippedRows.push({ rowNum: idx + 2, reason: 'order_item_id and return_id both empty', data: rowData(rawRow) });
          return;
        }
      }
      parsedRows.push(vals);
    });

    const outcome = await batchUpsert(pool, 'returns', 'order_item_id', RETURN_FIELDS, parsedRows, marketplace,
      `EXCLUDED.return_requested_date > returns.return_requested_date OR (EXCLUDED.return_requested_date = returns.return_requested_date AND EXCLUDED.return_status != 'cancelled')`
    );
    inserted = outcome.inserted;
    updated = outcome.updated;
    skipped += outcome.skipped;

    const logId = await logUpload(pool, 'returns', req.file.originalname, marketplace, inserted, updated, skipped, 'ok');
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}
    res.json({ ok: true, inserted, updated, skipped, total: data.length, dateFormats: summarizeDateFormats(dateFormats), logId });
  } catch (e) {
    try { await logUpload(getPool(), 'returns', req.file.originalname, marketplace, inserted, updated, skipped, 'error', e.message); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── POST /api/upload/settlements ───────────────────────────────────────────────
router.post('/settlements', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  let inserted = 0, skipped = 0;
  let marketplace = 'flipkart';

  try {
    const colMap = parseColumnMap(req.body.columnMap);
    marketplace = genericMarketplace(req.body.marketplace);
    const pool = getPool();
    const { headers, data } = parseFile(req.file.buffer);
    await resolveColumnMap(colMap, REQUIRED_FIELDS.settlements, headers);
    requireUploadRows(data);
    requireMappedFields('settlements', colMap, headers);
    const toRow   = rowMapper(headers);
    const rawRows = data.map(toRow);
    const dateFormats = await getDateFormats(rawRows, SETTLEMENT_DATE_FIELDS, colMap);

    const parsedRows = [];
    const skippedRows = [];
    rawRows.forEach((rawRow, idx) => {
      const g = (f) => getField(rawRow, f, colMap);
      g.dateFormat = (f) => dateFormats[f];
      const vals = SETTLEMENT_FIELDS.map(([, get]) => get(g));
      const rawBankSettlement = g('Bank Settlement');
      let reason = null;
      if (!vals[7]) reason = 'order_item_id is empty';
      else if (!vals[2]) reason = 'payment_date is empty or invalid';
      else if (hasInvalidNumber(rawBankSettlement, vals[3]) || vals[3] == null) reason = 'Bank Settlement is empty or invalid';
      if (reason) {
        skipped++;
        skippedRows.push({ rowNum: idx + 2, reason, data: rowData(rawRow) });
        return;
      }
      parsedRows.push(vals);
    });

    inserted = await batchInsert(pool, 'settlements', SETTLEMENT_FIELDS, parsedRows, marketplace);
    skipped += (parsedRows.length - inserted);

    const logId = await logUpload(pool, 'settlements', req.file.originalname, marketplace, inserted, 0, skipped, 'ok');
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}
    res.json({ ok: true, inserted, skipped, total: data.length, dateFormats: summarizeDateFormats(dateFormats), logId });
  } catch (e) {
    try { await logUpload(getPool(), 'settlements', req.file.originalname, marketplace, inserted, 0, skipped, 'error', e.message); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── GET /api/upload/log/:id/skipped ───────────────────────────────────────────
router.get('/log/:id/skipped', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool  = getPool();
    const logId = req.params.id;
    if (!/^\d+$/.test(logId) || logId === '0') {
      return res.status(400).json({ error: 'A valid upload history ID is required.' });
    }
    const { page, offset } = pagination(req.query, { defaultPageSize: 100, maxPageSize: 100 });
    const pageSize = 100;

    const [cnt, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM upload_skipped_rows WHERE upload_log_id = $1`, [logId]),
      pool.query(
        `SELECT row_num, skip_reason, raw_json FROM upload_skipped_rows
         WHERE upload_log_id = $1 ORDER BY row_num LIMIT $2 OFFSET $3`,
        [logId, pageSize, offset]
      ),
    ]);

    res.json({
      total: +cnt.rows[0].total,
      page,
      pageSize,
      rows: rows.rows.map(r => ({ rowNum: r.row_num, reason: r.skip_reason, data: r.raw_json })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/upload/amazon-settlement ───────────────────────────────────────
// Amazon settlement ingestion and reporting live in amazonUpload.js.
// Keeping one implementation prevents route shadowing and schema drift.

router.post('/sku-master', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const pool = getPool();
  let inserted = 0, updated = 0, skipped = 0;
  const skippedRows = [];

  try {
    const { headers, data } = parseFile(req.file.buffer);

    // Auto-detect VB EXPORT Product Category format
    const isVbExport = headers.some(h => /vb\s*export\s*sku/i.test(h)) ||
                       (headers.some(h => /marketplace\s*sku/i.test(h)) && headers.some(h => /vb/i.test(h)));
    if (isVbExport) {
      const syncRes = await syncVbExportCatalog({ pool, buffer: req.file.buffer });
      const logId = await logUpload(pool, 'sku_master', req.file.originalname, 'all', syncRes.uniqueVbSkus, syncRes.uniqueListings, 0, 'ok');
      return res.json({
        ok: true,
        isVbExportCatalog: true,
        uniqueVbSkus: syncRes.uniqueVbSkus,
        uniqueListings: syncRes.uniqueListings,
        ordersBackfilled: syncRes.ordersBackfilled,
        logId
      });
    }

    // Flexible column name matching
    function findCol(...variants) {
      const clean = s => (s || '').toLowerCase().replace(/[\s_()₹.,/\\-]/g, '');
      for (const v of variants) {
        const norm = clean(v);
        const found = headers.find(h => {
          const hn = clean(h);
          return hn === norm || hn.startsWith(norm);
        });
        if (found) return found;
      }
      return null;
    }

    const COL_MASTER   = findCol('master sku', 'mastersku', 'master', "vb export sku's", 'vb export sku', 'vb_export_sku');
    const COL_LISTING  = findCol('marketplace sku', 'marketplace_sku', 'listing sku', 'listingsku', 'listing', 'sku');
    const COL_MP       = findCol('marketplace', 'channel', 'platform');
    const COL_CATEGORY = findCol('vb export product category', 'product category', 'vb_export_category', 'category');
    const COL_COGS     = findCol('cogs', 'cost', 'cost of goods', 'cost of goods sold', 'purchase price', 'buying price');
    const COL_LAUNCH   = findCol('launch date', 'launchdate', 'launch', 'launch_date');
    const COL_PRODUCT  = findCol('product name', 'productname', 'product', 'title', 'description');
    const COL_WEIGHT   = findCol('weight slab', 'weightslab', 'weight', 'wt slab', 'wt_slab', 'weight_slab');
    const COL_BRAND    = findCol('brand', 'brand name', 'brand_name', 'brandname', 'seller brand');

    // Detect positional mode: if no Listing SKU column found by name, fall back to col B (index 1)
    const usePositional = !COL_LISTING;
    const toMap = rowMapper(headers);
    requireUploadRows(data);
    const records = [];
    const seen = new Set();

    for (let i = 0; i < data.length; i++) {
      try {
        const raw = usePositional
          ? {
              listing_sku: data[i][1], master_sku: data[i][1], marketplace: 'all',
              cogs: data[i][2], weight_slab: data[i][3],
            }
          : {
              listing_sku: COL_LISTING ? toMap(data[i])[COL_LISTING] : null,
              master_sku: COL_MASTER ? toMap(data[i])[COL_MASTER] : null,
              marketplace: COL_MP ? toMap(data[i])[COL_MP] : 'all',
              category: COL_CATEGORY ? toMap(data[i])[COL_CATEGORY] : null,
              cogs: COL_COGS ? toMap(data[i])[COL_COGS] : null,
              launch_date: COL_LAUNCH ? toMap(data[i])[COL_LAUNCH] : null,
              product_name: COL_PRODUCT ? toMap(data[i])[COL_PRODUCT] : null,
              weight_slab: COL_WEIGHT ? toMap(data[i])[COL_WEIGHT] : null,
              brand_name: COL_BRAND ? toMap(data[i])[COL_BRAND] : null,
            };
        const record = parseSkuMasterInput(raw);
        if (/^(listing\s*sku|sku|header)$/i.test(record.listingSku)) {
          throw new InputError('Header-looking row');
        }
        const key = `${record.marketplace}\u001f${record.listingSku}`;
        if (seen.has(key)) throw new InputError('Duplicate Marketplace + Listing SKU in this file');
        seen.add(key);
        records.push(record);
      } catch (error) {
        skipped++;
        skippedRows.push({ rowNum: i + 2, reason: error.message, data: data[i] });
      }
    }

    if (!records.length) throw new InputError('No valid SKU master rows were found. Review the skipped-row details and upload a corrected file.');
    ({ inserted, updated } = await upsertSkuMasterRows(pool, records));

    // ── Auto-backfill orders.brand_name from sku_master ──────────────────────
    // Any order whose SKU matches a sku_master row with brand_name gets updated.
    // Only overwrites NULL / empty brand_name — preserves values already set from order upload.
    let brandsFilled = 0;
    try {
      const bf = await pool.query(`
        UPDATE orders o
        SET    brand_name = sm.brand_name
        FROM   sku_master sm
        WHERE  o.sku = sm.listing_sku
          AND  sm.brand_name IS NOT NULL AND sm.brand_name <> ''
          AND  (o.brand_name IS NULL OR o.brand_name = '')
      `);
      brandsFilled = bf.rowCount || 0;
    } catch (e) { console.warn('[sku-master] brand backfill skipped:', e.message); }

    const logId = await logUpload(pool, 'sku_master', req.file.originalname, 'all', inserted, updated, skipped, 'ok');
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}

    res.json({ ok: true, inserted, updated, skipped, total: data.length, logId, brandsFilled });
  } catch (e) {
    try { await logUpload(getPool(), 'sku_master', req.file?.originalname, 'all', inserted, updated, skipped, 'error', e.message); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── POST /api/upload/sku-master/row — add or update a single row inline ───────
router.post('/sku-master/row', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const record = parseSkuMasterInput(req.body);
    const { rows } = await pool.query(`
      INSERT INTO sku_master (master_sku, marketplace, listing_sku, cogs, launch_date, product_name, weight_slab, brand_name, category)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (marketplace, listing_sku) DO UPDATE
        SET master_sku   = EXCLUDED.master_sku,
            cogs         = EXCLUDED.cogs,
            launch_date  = COALESCE(EXCLUDED.launch_date, sku_master.launch_date),
            product_name = COALESCE(NULLIF(EXCLUDED.product_name,''), sku_master.product_name),
            weight_slab  = COALESCE(EXCLUDED.weight_slab, sku_master.weight_slab),
            brand_name   = COALESCE(NULLIF(EXCLUDED.brand_name,''), sku_master.brand_name),
            category     = COALESCE(NULLIF(EXCLUDED.category,''), sku_master.category)
      RETURNING *
    `, [record.masterSku, record.marketplace, record.listingSku, record.cogs, record.launchDate, record.productName, record.weightSlab, record.brandName, record.category || null]);

    // Keep vb_sku_master and orders synced
    await pool.query(`
      INSERT INTO vb_sku_master (vb_export_sku, category, cogs, weight_slab, product_name)
      VALUES ($1, $2, COALESCE($3, 0), $4, $5)
      ON CONFLICT (vb_export_sku) DO UPDATE
      SET category = COALESCE(EXCLUDED.category, vb_sku_master.category),
          cogs = CASE WHEN EXCLUDED.cogs > 0 THEN EXCLUDED.cogs ELSE vb_sku_master.cogs END,
          weight_slab = COALESCE(EXCLUDED.weight_slab, vb_sku_master.weight_slab),
          product_name = COALESCE(NULLIF(EXCLUDED.product_name, ''), vb_sku_master.product_name),
          updated_at = NOW();
    `, [record.masterSku, record.category || null, record.cogs || 0, record.weightSlab || null, record.productName || null]).catch(() => {});

    await pool.query(`
      UPDATE orders
      SET vb_export_sku = $1,
          vb_export_category = COALESCE($2, vb_export_category)
      WHERE sku = $3;
    `, [record.masterSku, record.category || null, record.listingSku]).catch(() => {});

    res.json({ ok: true, row: rows[0] });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── PUT /api/upload/sku-master/:id — update a single row ─────────────────────
router.put('/sku-master/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { master_sku, cogs, launch_date, product_name, weight_slab, brand_name, category } = req.body;
    const id = positiveRowId(req.params.id);
    const masterSku = master_sku == null ? null : textInput(master_sku, 'Master SKU');
    const cogsValue = cogs == null ? null : nonNegativeMoney(cogs, 'COGS');
    const launchDate = launch_date == null ? null : optionalCatalogDate(launch_date);
    const productName = product_name == null ? null : textInput(product_name, 'Product name', { max: 500 });
    const weightSlab = weight_slab == null ? null : parseWeightSlab(weight_slab);
    const brandName = brand_name == null ? null : textInput(brand_name, 'Brand name', { max: 120 });
    const catVal = category == null ? null : textInput(category, 'Category', { max: 250 });

    const { rows } = await pool.query(`
      UPDATE sku_master
      SET master_sku   = COALESCE($1, master_sku),
          cogs         = COALESCE($2, cogs),
          launch_date  = COALESCE($3::date, launch_date),
          product_name = COALESCE(NULLIF($4,''), product_name),
          weight_slab  = COALESCE($5, weight_slab),
          brand_name   = COALESCE(NULLIF($7,''), brand_name),
          category     = COALESCE(NULLIF($8,''), category)
      WHERE id = $6
      RETURNING *
    `, [masterSku, cogsValue, launchDate, productName, weightSlab, id, brandName, catVal]);
    if (!rows.length) return res.status(404).json({ error: 'Row not found' });

    const updatedRow = rows[0];
    if (updatedRow.master_sku) {
      await pool.query(`
        UPDATE orders
        SET vb_export_sku = $1,
            vb_export_category = COALESCE($2, vb_export_category)
        WHERE sku = $3;
      `, [updatedRow.master_sku, updatedRow.category, updatedRow.listing_sku]).catch(() => {});
    }

    res.json({ ok: true, row: updatedRow });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── POST /api/upload/sku-master/merge-single ──────────────────────────────────
// Merges a single listing SKU into a VB EXPORT SKU, updating sku_master,
// vb_sku_master, and backfilling all matching orders.
router.post('/sku-master/merge-single', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const {
      listing_sku,
      master_sku,
      category,
      marketplace = 'all',
      cogs = null,
      weight_slab = null,
      product_name = null
    } = req.body;

    if (!listing_sku || !String(listing_sku).trim()) {
      return res.status(400).json({ error: 'Listing SKU is required' });
    }
    if (!master_sku || !String(master_sku).trim()) {
      return res.status(400).json({ error: 'Master / VB EXPORT SKU is required' });
    }

    const cleanListing = String(listing_sku).trim();
    const cleanMaster = String(master_sku).trim();
    const cleanCategory = category ? String(category).trim() : null;
    const cleanMp = marketplace ? String(marketplace).trim().toLowerCase() : 'all';
    const cogsVal = cogs != null && !isNaN(cogs) && Number(cogs) >= 0 ? Number(cogs) : null;
    const weightVal = weight_slab != null && !isNaN(weight_slab) && Number(weight_slab) > 0 ? Number(weight_slab) : null;
    const prodVal = product_name ? String(product_name).trim() : null;

    // 1. Upsert into vb_sku_master
    await pool.query(`
      INSERT INTO vb_sku_master (vb_export_sku, category, cogs, weight_slab, product_name)
      VALUES ($1, $2, COALESCE($3, 0), $4, $5)
      ON CONFLICT (vb_export_sku) DO UPDATE
      SET category = COALESCE(EXCLUDED.category, vb_sku_master.category),
          cogs = CASE WHEN EXCLUDED.cogs > 0 THEN EXCLUDED.cogs ELSE vb_sku_master.cogs END,
          weight_slab = COALESCE(EXCLUDED.weight_slab, vb_sku_master.weight_slab),
          product_name = COALESCE(NULLIF(EXCLUDED.product_name, ''), vb_sku_master.product_name),
          updated_at = NOW();
    `, [cleanMaster, cleanCategory, cogsVal, weightVal, prodVal]);

    // 2. Upsert into sku_master
    const skuRes = await pool.query(`
      INSERT INTO sku_master (master_sku, marketplace, listing_sku, category, cogs, weight_slab, product_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (marketplace, listing_sku) DO UPDATE
      SET master_sku = EXCLUDED.master_sku,
          category = COALESCE(EXCLUDED.category, sku_master.category),
          cogs = COALESCE(EXCLUDED.cogs, sku_master.cogs),
          weight_slab = COALESCE(EXCLUDED.weight_slab, sku_master.weight_slab),
          product_name = COALESCE(NULLIF(EXCLUDED.product_name, ''), sku_master.product_name)
      RETURNING *;
    `, [cleanMaster, cleanMp, cleanListing, cleanCategory, cogsVal, weightVal, prodVal]);

    // 3. Update orders
    const orderRes = await pool.query(`
      UPDATE orders
      SET vb_export_sku = $1,
          vb_export_category = COALESCE($2, vb_export_category)
      WHERE sku = $3
      RETURNING order_item_id;
    `, [cleanMaster, cleanCategory, cleanListing]);

    res.json({
      ok: true,
      skuMaster: skuRes.rows[0],
      ordersUpdated: orderRes.rowCount || 0,
      message: `Successfully merged "${cleanListing}" to "${cleanMaster}" (${orderRes.rowCount || 0} orders updated)`
    });
  } catch (e) {
    console.error('[merge-single]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/upload/vb-export-sku/:sku ────────────────────────────────────────
// Updates COGS, weight slab, category, or product name for a VB EXPORT SKU
// Cascades COGS and weight_slab to sku_master and category to orders
router.put('/vb-export-sku/:sku', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const vbSku = decodeURIComponent(req.params.sku);
    const { cogs, weight_slab, category, product_name } = req.body;

    const cogsVal = cogs != null && !isNaN(cogs) && Number(cogs) >= 0 ? Number(cogs) : null;
    const weightVal = weight_slab != null && !isNaN(weight_slab) && Number(weight_slab) > 0 ? Number(weight_slab) : null;
    const catVal = category != null ? String(category).trim() : null;
    const prodVal = product_name != null ? String(product_name).trim() : null;

    let { rows } = await pool.query(`
      UPDATE vb_sku_master
      SET cogs = COALESCE($1, cogs),
          weight_slab = COALESCE($2, weight_slab),
          category = COALESCE($3, category),
          product_name = COALESCE(NULLIF($4, ''), product_name),
          updated_at = NOW()
      WHERE vb_export_sku = $5
      RETURNING *;
    `, [cogsVal, weightVal, catVal, prodVal, vbSku]);

    if (!rows.length) {
      const insRes = await pool.query(`
        INSERT INTO vb_sku_master (vb_export_sku, cogs, weight_slab, category, product_name)
        VALUES ($1, COALESCE($2, 0), $3, $4, $5)
        ON CONFLICT (vb_export_sku) DO UPDATE
        SET cogs = COALESCE(EXCLUDED.cogs, vb_sku_master.cogs),
            weight_slab = COALESCE(EXCLUDED.weight_slab, vb_sku_master.weight_slab),
            category = COALESCE(EXCLUDED.category, vb_sku_master.category),
            product_name = COALESCE(NULLIF(EXCLUDED.product_name, ''), vb_sku_master.product_name),
            updated_at = NOW()
        RETURNING *;
      `, [vbSku, cogsVal, weightVal, catVal, prodVal]);
      rows = insRes.rows;
    }

    // Cascade to sku_master where master_sku = vbSku
    if (cogsVal !== null || weightVal !== null || catVal !== null || prodVal !== null) {
      await pool.query(`
        UPDATE sku_master
        SET cogs = COALESCE($1, cogs),
            weight_slab = COALESCE($2, weight_slab),
            category = COALESCE($3, category),
            product_name = COALESCE(NULLIF($4, ''), product_name)
        WHERE master_sku = $5;
      `, [cogsVal, weightVal, catVal, prodVal, vbSku]).catch(e => console.warn('[cascade sku_master]:', e.message));
    }

    // Cascade category to orders
    if (catVal !== null) {
      await pool.query(`
        UPDATE orders
        SET vb_export_category = $1
        WHERE vb_export_sku = $2;
      `, [catVal, vbSku]).catch(e => console.warn('[cascade orders category]:', e.message));
    }

    res.json({ ok: true, row: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/upload/vb-export-skus ───────────────────────────────────────────
// List and filter VB EXPORT SKUs with their COGS, weight slabs, category, and listing count
router.get('/vb-export-skus', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const search = optionalQueryText(req.query.search, 'Search', { maxLength: 120 });
    const category = req.query.category || null;
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 100, maxPageSize: 500 });

    const conds = [];
    const vals = [];
    if (category && category !== 'all') conds.push(`vsm.category = $${vals.push(category)}`);
    if (search) {
      const p = `$${vals.push('%' + search + '%')}`;
      conds.push(`(vsm.vb_export_sku ILIKE ${p} OR vsm.product_name ILIKE ${p})`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const countVals = [...vals];
    const listVals = [...vals, pageSize, offset];

    const [listResult, countResult] = await Promise.all([
      pool.query(`
        SELECT
          vsm.vb_export_sku,
          vsm.category,
          vsm.cogs,
          vsm.weight_slab,
          vsm.product_name,
          vsm.created_at,
          vsm.updated_at,
          (SELECT COUNT(*) FROM sku_master sm WHERE sm.master_sku = vsm.vb_export_sku) AS listings_count
        FROM vb_sku_master vsm
        ${where}
        ORDER BY vsm.vb_export_sku ASC
        LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}
      `, listVals),
      pool.query(`SELECT COUNT(*) AS total FROM vb_sku_master vsm ${where}`, countVals)
    ]);

    res.json({
      total: +countResult.rows[0].total,
      page,
      pageSize,
      data: listResult.rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/upload/backfill-brands — propagate sku_master.brand_name → orders ──
// Useful for existing orders uploaded before brand_name was introduced.
// Also overwrites if force=true in body.
router.post('/backfill-brands', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool  = getPool();
    const force = req.body?.force === true;

    // Step 1: backfill orders.brand_name from sku_master
    const orderRes = await pool.query(`
      UPDATE orders o
      SET    brand_name = sm.brand_name
      FROM   sku_master sm
      WHERE  o.sku = sm.listing_sku
        AND  sm.brand_name IS NOT NULL AND sm.brand_name <> ''
        ${force ? '' : "AND (o.brand_name IS NULL OR o.brand_name = '')"}
    `);

    // Step 2: count how many brands are now populated
    const countRes = await pool.query(`
      SELECT COUNT(DISTINCT brand_name) AS brand_count,
             COUNT(*) FILTER (WHERE brand_name IS NOT NULL AND brand_name <> '') AS orders_with_brand,
             COUNT(*) AS total_orders
      FROM orders
    `);

    res.json({
      ok: true,
      ordersUpdated: orderRes.rowCount || 0,
      brandCount:    +(countRes.rows[0]?.brand_count  || 0),
      ordersWithBrand: +(countRes.rows[0]?.orders_with_brand || 0),
      totalOrders:     +(countRes.rows[0]?.total_orders || 0),
    });
  } catch (e) {
    console.error('[backfill-brands]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/upload/sku-master/unmapped — SKUs in orders not in sku_master ────
router.get('/sku-master/unmapped', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT
        o.sku,
        o.marketplace,
        o.category,
        COUNT(o.order_item_id)           AS order_count,
        COALESCE(SUM(o.final_invoice_amount), 0) AS total_revenue,
        MAX(o.order_date::text)          AS last_order_date,
        MIN(o.order_date::text)          AS first_order_date
      FROM orders o
      WHERE o.sku IS NOT NULL AND o.sku <> ''
        AND (
          o.vb_export_sku IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM sku_master sm
            WHERE sm.listing_sku = o.sku
              AND (sm.marketplace = o.marketplace OR sm.marketplace = 'all')
          )
        )
      GROUP BY o.sku, o.marketplace, o.category
      ORDER BY order_count DESC
      LIMIT 300
    `);
    res.json({ unmapped: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/upload/sku-master ────────────────────────────────────────────────
// List all SKU master mappings
router.get('/sku-master', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const marketplace = req.query.marketplace || null;
    const search      = optionalQueryText(req.query.search, 'Search', { maxLength: 120 });
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 100, maxPageSize: 500 });

    const conds = [];
    const vals  = [];
    if (marketplace && marketplace !== 'all') conds.push(`marketplace = $${vals.push(marketplace)}`);
    if (search) conds.push(`(master_sku ILIKE $${vals.push('%'+search+'%')} OR listing_sku ILIKE $${vals.length})`);
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const countVals = [...vals];
    const listVals = [...vals, pageSize, offset];
    const [rows, cnt] = await Promise.all([
      pool.query(`SELECT id, master_sku, marketplace, listing_sku, category, cogs, launch_date, product_name, weight_slab, created_at FROM sku_master ${where} ORDER BY marketplace, master_sku, listing_sku LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`, listVals),
      pool.query(`SELECT COUNT(*) AS total FROM sku_master ${where}`, countVals),
    ]);

    res.json({ total: +cnt.rows[0].total, page, pageSize, data: rows.rows });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── DELETE /api/upload/sku-master/:id ─────────────────────────────────────────
router.delete('/sku-master/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { rowCount } = await pool.query(`DELETE FROM sku_master WHERE id = $1`, [positiveRowId(req.params.id)]);
    if (!rowCount) return res.status(404).json({ error: 'Row not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── DELETE /api/upload/sku-master (clear all for a marketplace) ───────────────
router.delete('/sku-master', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    if (req.query.marketplace == null) throw new InputError('Marketplace is required. Use marketplace=all to intentionally clear every SKU mapping.');
    const marketplace = catalogMarketplace(req.query.marketplace);
    if (marketplace !== 'all') {
      await pool.query(`DELETE FROM sku_master WHERE marketplace = $1`, [marketplace]);
    } else {
      await pool.query(`TRUNCATE sku_master`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Catalog COGS (FSN/ASIN/catalog-level fallback) ───────────────────────────
router.post('/catalog-cogs', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const pool = getPool();
  let inserted = 0, updated = 0, skipped = 0;
  const skippedRows = [];

  try {
    const { headers, data } = parseFile(req.file.buffer);
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]/g, '');
    const findCol = (...variants) => {
      const wanted = variants.map(norm);
      return headers.find(h => wanted.includes(norm(h))) || null;
    };

    const COL_CATALOG = findCol('catalog id', 'catalog_id', 'catalog', 'fsn', 'asin', 'listing id', 'style id');
    const COL_MP      = findCol('marketplace', 'channel', 'platform');
    const COL_CAT     = findCol('category', 'vertical', 'product category');
    const COL_COGS    = findCol('cogs', 'cost', 'cost of goods', 'cost of goods sold', 'purchase price', 'buying price');
    const COL_PRODUCT = findCol('product name', 'productname', 'product', 'title', 'description');
    const COL_BRAND   = findCol('brand', 'brand name', 'brand_name', 'brandname', 'seller brand');
    const toMap = rowMapper(headers);
    const usePositional = !COL_CATALOG;
    requireUploadRows(data);
    const records = [];
    const seen = new Set();

    for (let i = 0; i < data.length; i++) {
      try {
        const mapped = usePositional ? null : toMap(data[i]);
        const record = parseCatalogCogsInput(usePositional
          ? {
              catalog_id: data[i][0], marketplace: data[i][1], category: data[i][2],
              cogs: data[i][3], product_name: data[i][4], brand_name: data[i][5],
            }
          : {
              catalog_id: COL_CATALOG ? mapped[COL_CATALOG] : null,
              marketplace: COL_MP ? mapped[COL_MP] : 'all',
              category: COL_CAT ? mapped[COL_CAT] : null,
              cogs: COL_COGS ? mapped[COL_COGS] : null,
              product_name: COL_PRODUCT ? mapped[COL_PRODUCT] : null,
              brand_name: COL_BRAND ? mapped[COL_BRAND] : null,
            });
        if (/^(catalog\s*id|fsn|asin|header)$/i.test(record.catalogId)) {
          throw new InputError('Header-looking row');
        }
        const key = `${record.marketplace}\u001f${record.catalogId}`;
        if (seen.has(key)) throw new InputError('Duplicate Marketplace + Catalog ID in this file');
        seen.add(key);
        records.push(record);
      } catch (error) {
        skipped++;
        skippedRows.push({ rowNum: i + 2, reason: error.message, data: data[i] });
      }
    }

    if (!records.length) throw new InputError('No valid catalog COGS rows were found. Review the skipped-row details and upload a corrected file.');
    ({ inserted, updated } = await upsertCatalogCogsRows(pool, records));

    const logId = await logUpload(pool, 'catalog_cogs', req.file.originalname, 'all', inserted, updated, skipped, 'ok');
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}
    res.json({ ok: true, inserted, updated, skipped, total: data.length, logId });
  } catch (e) {
    try { await logUpload(getPool(), 'catalog_cogs', req.file?.originalname, 'all', inserted, updated, skipped, 'error', e.message); } catch {}
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/catalog-cogs/unmapped', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const marketplace = req.query.marketplace && req.query.marketplace !== 'all' ? req.query.marketplace : null;
    const params = marketplace ? [marketplace] : [];
    const mpWhere = marketplace ? 'AND o.marketplace = $1' : '';
    const { rows } = await pool.query(`
      SELECT
        o.fsn AS catalog_id,
        COALESCE(o.marketplace, 'all') AS marketplace,
        COALESCE(o.category, 'Uncategorized') AS category,
        COUNT(*) AS order_count,
        COUNT(*) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM sku_master sm
            WHERE sm.listing_sku = o.sku
              AND (sm.marketplace = o.marketplace OR sm.marketplace = 'all')
          )
        ) AS profit_gap_orders,
        COALESCE(SUM(o.final_invoice_amount), 0) AS total_revenue,
        MIN(o.order_date::text) AS first_order_date,
        MAX(o.order_date::text) AS last_order_date
      FROM orders o
      WHERE o.fsn IS NOT NULL AND o.fsn <> ''
        ${mpWhere}
        AND NOT EXISTS (
          SELECT 1 FROM catalog_cogs cc
          WHERE cc.catalog_id = o.fsn
            AND (cc.marketplace = o.marketplace OR cc.marketplace = 'all')
        )
      GROUP BY o.fsn, COALESCE(o.marketplace, 'all'), COALESCE(o.category, 'Uncategorized')
      ORDER BY profit_gap_orders DESC, order_count DESC
      LIMIT 300
    `, params);
    res.json({ unmapped: rows, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/catalog-cogs', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const marketplace = req.query.marketplace || null;
    const search = optionalQueryText(req.query.search, 'Search', { maxLength: 120 });
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 100, maxPageSize: 500 });

    const conds = [];
    const vals = [];
    if (marketplace && marketplace !== 'all') conds.push(`marketplace = $${vals.push(marketplace)}`);
    if (search) {
      vals.push(`%${search}%`);
      conds.push(`(catalog_id ILIKE $${vals.length} OR category ILIKE $${vals.length} OR product_name ILIKE $${vals.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const listVals = [...vals, pageSize, offset];
    const [rows, cnt] = await Promise.all([
      pool.query(`
        SELECT id, marketplace, catalog_id, category, cogs, product_name, brand_name, updated_at, created_at
        FROM catalog_cogs ${where}
        ORDER BY marketplace, catalog_id
        LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}
      `, listVals),
      pool.query(`SELECT COUNT(*) AS total FROM catalog_cogs ${where}`, vals),
    ]);
    res.json({ total: +cnt.rows[0].total, page, pageSize, data: rows.rows });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/catalog-cogs/row', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const record = parseCatalogCogsInput(req.body);
    const { rows } = await pool.query(`
      INSERT INTO catalog_cogs (marketplace, catalog_id, category, cogs, product_name, brand_name)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (marketplace, catalog_id) DO UPDATE
        SET category     = COALESCE(NULLIF(EXCLUDED.category,''), catalog_cogs.category),
            cogs         = EXCLUDED.cogs,
            product_name = COALESCE(NULLIF(EXCLUDED.product_name,''), catalog_cogs.product_name),
            brand_name   = COALESCE(NULLIF(EXCLUDED.brand_name,''), catalog_cogs.brand_name),
            updated_at   = NOW()
      RETURNING *
    `, [record.marketplace, record.catalogId, record.category, record.cogs, record.productName, record.brandName]);
    res.json({ ok: true, row: rows[0] });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.put('/catalog-cogs/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { category, cogs, product_name, brand_name } = req.body;
    const id = positiveRowId(req.params.id);
    const categoryValue = category == null ? null : textInput(category, 'Category', { max: 250 });
    const cogsValue = cogs == null ? null : nonNegativeMoney(cogs, 'COGS');
    const productName = product_name == null ? null : textInput(product_name, 'Product name', { max: 500 });
    const brandName = brand_name == null ? null : textInput(brand_name, 'Brand name', { max: 120 });
    const { rows } = await pool.query(`
      UPDATE catalog_cogs
      SET category = COALESCE($1, category),
          cogs = COALESCE($2, cogs),
          product_name = COALESCE(NULLIF($3,''), product_name),
          brand_name = COALESCE(NULLIF($4,''), brand_name),
          updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [categoryValue, cogsValue, productName, brandName, id]);
    if (!rows.length) return res.status(404).json({ error: 'Row not found' });
    res.json({ ok: true, row: rows[0] });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/catalog-cogs/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    const { rowCount } = await pool.query(`DELETE FROM catalog_cogs WHERE id = $1`, [positiveRowId(req.params.id)]);
    if (!rowCount) return res.status(404).json({ error: 'Row not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/catalog-cogs', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
  try {
    const pool = getPool();
    if (req.query.marketplace == null) throw new InputError('Marketplace is required. Use marketplace=all to intentionally clear every catalog COGS mapping.');
    const marketplace = catalogMarketplace(req.query.marketplace);
    if (marketplace !== 'all') await pool.query(`DELETE FROM catalog_cogs WHERE marketplace = $1`, [marketplace]);
    else await pool.query(`TRUNCATE catalog_cogs`);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/upload/returns-received
router.post('/returns-received', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let inserted = 0, updated = 0, skipped = 0;
  const skippedRows = [];
  try {
    const pool = getPool();
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const headerRow = (rows[0] || []).map((header, index) => normalizedUploadHeader(header) || `col_${index}`);
    const data = rows.slice(1).filter(r => r.some(c => c !== ''));
    requireUploadRows(data);
    const receivedRecords = [];
    const notReceivedRecords = [];
    const seen = new Set();
    for (let i = 0; i < data.length; i++) {
      try {
        const mapped = {};
        headerRow.forEach((header, column) => { mapped[header] = data[i][column]; });
        const record = { ...parseReturnsReceivedRow(mapped), rowNum: i + 2, raw: data[i] };
        if (seen.has(record.orderItemId)) throw new InputError('Duplicate order_item_id in this file');
        seen.add(record.orderItemId);
        (record.received ? receivedRecords : notReceivedRecords).push(record);
      } catch (error) {
        skipped++;
        skippedRows.push({ rowNum: i + 2, reason: error.message, data: data[i] });
      }
    }

    const validIds = [...receivedRecords, ...notReceivedRecords].map(record => record.orderItemId);
    if (!validIds.length) throw new InputError('No valid return-receipt rows were found. Review the skipped-row details and upload a corrected file.');
    const known = await pool.query(`SELECT DISTINCT order_item_id FROM returns WHERE order_item_id = ANY($1::text[])`, [validIds]);
    const knownIds = new Set(known.rows.map(row => row.order_item_id));
    const keepKnown = records => records.filter(record => {
      if (knownIds.has(record.orderItemId)) return true;
      skipped++;
      skippedRows.push({ rowNum: record.rowNum, reason: 'No matching return found for order_item_id', data: record.raw });
      return false;
    });
    const knownReceived = keepKnown(receivedRecords);
    const knownNotReceived = keepKnown(notReceivedRecords);

    await forEachDbBatch(knownReceived, 4, async batch => {
      const values = [];
      const groups = batch.map(record => {
        const start = values.length;
        values.push(record.orderItemId, record.receivedDate, record.isBad, record.notes);
        return `($${start + 1}, $${start + 2}::date, $${start + 3}, $${start + 4})`;
      });
      const result = await pool.query(`
        INSERT INTO returns_received (order_item_id, received_date, is_bad_return, notes)
        VALUES ${groups.join(', ')}
        ON CONFLICT (order_item_id) DO UPDATE
          SET received_date = EXCLUDED.received_date, is_bad_return = EXCLUDED.is_bad_return,
              notes = EXCLUDED.notes, uploaded_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, values);
      for (const row of result.rows) {
        if (row.inserted) inserted++;
        else updated++;
      }
      await pool.query(`
        UPDATE returns SET is_received = TRUE, received_date = rr.received_date
        FROM returns_received rr
        WHERE returns.order_item_id = rr.order_item_id AND returns.order_item_id = ANY($1::text[])
      `, [batch.map(record => record.orderItemId)]);
    });

    await forEachDbBatch(knownNotReceived, 1, async batch => {
      const ids = batch.map(record => record.orderItemId);
      await pool.query(`DELETE FROM returns_received WHERE order_item_id = ANY($1::text[])`, [ids]);
      const reset = await pool.query(`UPDATE returns SET is_received = FALSE, received_date = NULL WHERE order_item_id = ANY($1::text[])`, [ids]);
      updated += reset.rowCount || 0;
    });

    const logId = await logUpload(pool, 'returns_received', req.file.originalname, 'flipkart', inserted, updated, skipped, 'ok');
    try { await saveSkippedRows(pool, logId, skippedRows); } catch {}
    res.json({ ok: true, inserted, updated, skipped, total: data.length, logId });
  } catch (err) {
    try { await logUpload(getPool(), 'returns_received', req.file?.originalname, 'flipkart', inserted, updated, skipped, 'error', err.message); } catch {}
    console.error('[upload/returns-received]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/upload/returns-received/summary
router.get('/returns-received/summary', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    res.json(await getReturnsReceivedSummary(getPool()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/upload/returns-received/mismatches
router.get('/returns-received/mismatches', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const pool = getPool();
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 100 });
    const [rows, cnt] = await Promise.all([
      pool.query(`
        SELECT r.order_item_id, r.return_date, r.return_reason, r.return_type, r.return_status, r.final_condition
        FROM returns r LEFT JOIN returns_received rr ON rr.order_item_id = r.order_item_id
        WHERE rr.order_item_id IS NULL
        ORDER BY r.return_requested_date DESC NULLS LAST LIMIT $1 OFFSET $2
      `, [pageSize, offset]),
      pool.query('SELECT COUNT(*) AS cnt FROM returns r LEFT JOIN returns_received rr ON rr.order_item_id = r.order_item_id WHERE rr.order_item_id IS NULL'),
    ]);
    res.json({ data: rows.rows, total: +(cnt.rows[0].cnt || 0), page, pageSize });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/upload/spf-summary
router.get('/spf-summary', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    res.json(await getSpfSummary(getPool()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/upload/spf-tracking
router.get('/spf-tracking', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const paging = pagination(req.query, { defaultPageSize: 50, maxPageSize: 100 });
    res.json(await getSpfTracking(getPool(), paging));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/upload/spf-mark-received
export function parseSpfReceiptInput(input = {}) {
  if (!Array.isArray(input.orderItemIds) || !input.orderItemIds.length || input.orderItemIds.length > 1000) {
    throw new InputError('orderItemIds must be a non-empty array with at most 1000 entries');
  }
  const orderItemIds = [...new Set(input.orderItemIds.map((value, index) => {
    const id = textInput(value, `orderItemIds[${index}]`, { required: true, max: 250 });
    return id;
  }))];
  const rawDate = input.receivedDate;
  const receivedDate = rawDate == null || rawDate === '' ? null : dt(rawDate);
  if (rawDate != null && rawDate !== '' && !receivedDate) throw new InputError('receivedDate must be a valid date');
  const rawAmount = input.receivedAmount;
  const receivedAmount = rawAmount == null || rawAmount === '' ? 0 : num(rawAmount);
  if (receivedAmount == null || receivedAmount < 0) throw new InputError('receivedAmount must be a non-negative number');
  return {
    orderItemIds,
    receivedDate,
    receivedAmount,
    neftId: textInput(input.neftId, 'neftId', { max: 120 }) || '',
    claimId: textInput(input.claimId, 'claimId', { max: 120 }) || '',
  };
}

router.post('/spf-mark-received', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const parsed = parseSpfReceiptInput(req.body);
    const updated = await markSpfReceived(getPool(), parsed);
    res.json({ ok: true, updated });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ── GET /api/upload/returns/template ─────────────────────────────────────────
// Download a pre-filled Excel template for marking return received + condition
router.get('/returns/template', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT
        r.order_item_id,
        o.order_id,
        o.fsn,
        o.sku,
        o.category,
        COALESCE(o.marketplace, r.marketplace, 'flipkart') AS marketplace,
        r.return_type,
        r.return_reason,
        r.return_sub_reason,
        TO_CHAR(r.return_requested_date, 'YYYY-MM-DD') AS return_requested_date,
        r.return_status,
        r.final_condition                AS system_condition,
        COALESCE(r.quantity, 1)          AS quantity,
        COALESCE(o.final_invoice_amount, 0) AS invoice_amount,
        COALESCE(SUM(fko.protection_fund), 0) AS protection_fund_in_sett,
        rr.received_date,
        rr.is_bad_return,
        rr.notes
      FROM returns r
      LEFT JOIN orders o ON o.order_item_id = r.order_item_id
      LEFT JOIN returns_received rr ON rr.order_item_id = r.order_item_id
      LEFT JOIN fk_settlement_orders fko ON fko.order_item_id = r.order_item_id
      WHERE r.order_item_id IS NOT NULL
      GROUP BY r.order_item_id, o.order_id, o.fsn, o.sku, o.category, o.marketplace, r.marketplace,
               r.return_type, r.return_reason, r.return_sub_reason, r.return_requested_date,
               r.return_status, r.final_condition, r.quantity, o.final_invoice_amount,
               rr.received_date, rr.is_bad_return, rr.notes
      ORDER BY r.return_requested_date DESC NULLS LAST
    `);

    const headers = [
      'order_item_id', 'Order ID', 'FSN', 'SKU', 'Category', 'Marketplace',
      'Return Type', 'Return Reason', 'Sub Reason', 'Return Requested Date',
      'Return Status', 'System Condition', 'Qty', 'Invoice Amount (Rs)',
      'Return Received? (Yes/No)',   // ← user fills col O
      'Condition (Good/Bad)',        // ← user fills col P
      'Received Date (YYYY-MM-DD)', // ← user fills col Q
      'Notes',                       // ← user fills col R
    ];

    const dataRows = rows.map(r => [
      r.order_item_id,
      r.order_id   || '',
      r.fsn        || '',
      r.sku        || '',
      r.category   || '',
      r.marketplace || '',
      r.return_type || '',
      r.return_reason || '',
      r.return_sub_reason || '',
      r.return_requested_date || '',
      r.return_status || '',
      r.system_condition || '',
      r.quantity || 1,
      +r.invoice_amount || 0,
      // Pre-fill if already uploaded
      (r.received_date || r.is_bad_return !== null) ? (r.is_bad_return === false ? 'Yes' : r.received_date ? 'Yes' : '') : '',
      (r.received_date || r.is_bad_return !== null) ? (r.is_bad_return ? 'Bad' : r.received_date ? 'Good' : '') : '',
      r.received_date ? String(r.received_date).slice(0, 10) : '',
      r.notes || '',
    ]);

    const wb = XLSX.utils.book_new();

    // Main return tracker sheet
    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    ws['!cols'] = [
      {wch:24},{wch:18},{wch:16},{wch:18},{wch:22},{wch:12},
      {wch:18},{wch:32},{wch:26},{wch:20},{wch:18},{wch:16},
      {wch:5},{wch:18},{wch:24},{wch:20},{wch:22},{wch:30},
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Return Tracker');

    // Instructions sheet
    const instrData = [
      ['COLUMN', 'HEADER', 'VALID VALUES', 'INSTRUCTIONS'],
      ['O', 'Return Received? (Yes/No)', 'Yes  OR  No',
        'Yes = you physically received the item back. No = item not received yet.'],
      ['P', 'Condition (Good/Bad)', 'Good  OR  Bad',
        'Good = item sellable/relistable. Bad = item damaged, tampered, or unusable.'],
      ['Q', 'Received Date', 'YYYY-MM-DD (e.g. 2026-03-15)',
        'Date you received the item back at your warehouse.'],
      ['R', 'Notes', 'Free text',
        'Any remarks — courier tracking issues, photos taken, escalation ref number etc.'],
      ['', '', '', ''],
      ['IMPORTANT', '', '', 'Do NOT modify columns A to N (pre-filled data). Only fill cols O, P, Q, R.'],
      ['', '', '', 'For Bad returns: we will automatically check if Flipkart SPF was received.'],
      ['', '', '', 'Upload this file back using the "Upload Return Status" button in the dashboard.'],
    ];
    const instrWs = XLSX.utils.aoa_to_sheet(instrData);
    instrWs['!cols'] = [{wch:12},{wch:28},{wch:20},{wch:70}];
    XLSX.utils.book_append_sheet(wb, instrWs, 'Instructions');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="returns-tracker-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error('[returns/template]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/upload/returns/tracker ──────────────────────────────────────────
// Full return tracker list: condition, received status, SPF status, unsettled flag
router.get('/returns/tracker', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const paging = pagination(req.query, { defaultPageSize: 100, maxPageSize: 500 });
    const marketplace = req.query.marketplace && req.query.marketplace !== 'all'
      ? req.query.marketplace
      : null;
    res.json(await getReturnsTracker(getPool(), {
      filter: req.query.filter || 'all',
      marketplace,
      ...paging,
    }));
  } catch (err) {
    console.error('[returns/tracker]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/upload/unsettled-orders ─────────────────────────────────────────
// Orders with no positive settlement — unsettled (no entry) + returned unpaid
router.get('/unsettled-orders', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const pool = getPool();
    const mp       = (req.query.marketplace && req.query.marketplace !== 'all') ? String(req.query.marketplace).trim().toLowerCase() : null;
    let mpWhere = '';
    const mpVals = [];
    if (mp === 'myntra_vb') {
      mpWhere = "AND o.marketplace = 'myntra' AND COALESCE(o.seller_account, 'myntra_vb') = 'myntra_vb'";
    } else if (mp === 'myntra_ej') {
      mpWhere = "AND o.marketplace = 'myntra' AND o.seller_account = 'myntra_ej'";
    } else if (mp === 'myntra') {
      mpWhere = "AND o.marketplace = 'myntra'";
    } else if (mp) {
      mpVals.push(mp);
      mpWhere = `AND o.marketplace = $${mpVals.length}`;
    }

    const { rows } = await pool.query(`
      SELECT
        o.order_item_id,
        o.order_id,
        o.fsn,
        o.sku,
        o.category,
        CASE
          WHEN o.marketplace = 'myntra' THEN COALESCE(o.seller_account, 'myntra_vb')
          ELSE COALESCE(o.marketplace, 'flipkart')
        END                                   AS marketplace,
        TO_CHAR(o.order_date, 'YYYY-MM-DD')   AS order_date,
        o.final_invoice_amount                 AS invoice_amount,
        o.orders_status,
        o.fulfilment_type,
        COALESCE(CURRENT_DATE - o.order_date::date, 0)  AS days_pending,
        (r.order_item_id IS NOT NULL)          AS has_return,
        r.return_type,
        r.return_status,
        CASE
          WHEN s.order_item_id IS NULL                   THEN 'No Settlement'
          WHEN COALESCE(s.net_bank,0) < 0               THEN 'Clawback'
          WHEN COALESCE(s.net_bank,0) = 0
               AND COALESCE(s.refund_count,0) > 0       THEN 'Fully Returned'
          ELSE 'Zero Settlement'
        END                                    AS settlement_status,
        COALESCE(s.net_bank, 0)               AS net_bank,
        COALESCE(s.negative_bank_amount, 0)   AS refund_debited,
        TO_CHAR(s.payment_date,'YYYY-MM-DD')  AS first_payment_date
      FROM orders o
      LEFT JOIN ${ORDER_SETTLEMENT_TOTALS_TABLE} s ON s.order_item_id = o.order_item_id
      LEFT JOIN order_returns r ON r.order_item_id = o.order_item_id
      WHERE (s.order_item_id IS NULL OR COALESCE(s.net_bank, 0) <= 0) ${mpWhere}
      ORDER BY
        CASE WHEN s.order_item_id IS NULL THEN 0
             WHEN COALESCE(s.net_bank,0) < 0 THEN 1 ELSE 2 END,
        o.order_date ASC NULLS LAST
    `, mpVals);

    res.json({
      data: rows,
      total: rows.length,
      totalValue: rows.reduce((s, r) => s + (+r.invoice_amount || 0), 0),
    });
  } catch (err) {
    console.error('[unsettled-orders]', err);
    res.status(500).json({ error: err.message });
  }
});

export { autoMap, normalize, FIELD_ALIASES };
export default router;
