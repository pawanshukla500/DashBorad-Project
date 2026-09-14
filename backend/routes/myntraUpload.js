/**
 * Myntra order and return imports.
 *
 * These exports are intentionally not sent through the generic marketplace
 * mapper: their real keys are Order Release ID / Order Line ID and the two
 * Myntra accounts must never share an import boundary.
 */
import express from 'express';
import multer from 'multer';
import { createRequire } from 'module';
import { getPool, isDbConfigured } from '../db/index.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { normalizeDeliveryState } from '../utils/geoNormalization.js';
import { forEachDbBatch } from '../utils/dbBatch.js';
import { logUpload, saveSkippedRows } from '../services/uploadLog.js';
import { backfillOrdersFromMyntraPayment } from '../services/myntraSettlementReportingRollups.js';
import { refreshOrderSettlementTotals } from '../services/orderSettlementTotals.js';
import { spreadsheetFileFilter } from '../utils/uploadSecurity.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, parts: 20 },
  fileFilter: spreadsheetFileFilter,
});
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const MYNTRA_SELLER_IDS = Object.freeze({
  myntra_vb: '10708',
  myntra_ej: '45833',
});

const ORDER_HEADERS = [
  'seller id', 'warehouse id', 'po_type', 'store order id', 'order release id', 'order line id',
  'seller order id', 'order id fk', 'created on', 'style id', 'seller sku code', 'sku id',
  'myntra sku code', 'size', 'vendor article number', 'brand', 'style name', 'article type',
  'order status', 'packet id', 'seller packe id', 'courier code', 'order tracking number',
  'seller warehouse id', 'cancellation reason id fk', 'cancellation reason', 'packed on',
  'fmpu date', 'inscanned on', 'shipped on', 'delivered on', 'cancelled on', 'rto creation date',
  'lost date', 'return creation date', 'final amount', 'total mrp', 'discount', 'coupon discount',
  'shipping charge', 'gift charge', 'tax recovery', 'city', 'state', 'zipcode', 'seller price',
];

const RETURN_HEADERS = [
  'seller_id', 'warehouse_id', 'partner_warehouse_code', 'model', 'myntra_sku_code', 'seller_sku_code', 'style_id', 'sku_id',
  'brand', 'order_created_date', 'inscanned_on', 'fmpu_date', 'order_delivered_date',
  'return_created_date', 'refunded_date', 'order_rto_date', 'is_refunded', 'exchange_id', 'order_id',
  'order_group_id', 'order_line_id', 'seller_order_id', 'type', 'status', 'store_packet_id',
  'seller_packet_id_fk', 'quantity', 'return_id', 'return_mode', 'return_reason', 'return_status',
  'forward_tracking_number', 'return_tracking_number', 'master_bag_id', 'lmdo_status',
  'lmdo_last_modified_on', 'gatepass_id', 'gatepass_status', 'gatepass_type', 'gatepass_lastmodified',
];

function clean(value) {
  return (value ?? '').toString().trim();
}

function headerKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function value(row, ...names) {
  for (const name of names) {
    const key = headerKey(name);
    const matchingKey = Object.keys(row).find(column => headerKey(column) === key);
    if (matchingKey && clean(row[matchingKey])) return clean(row[matchingKey]);
  }
  return '';
}

export function parseMoney(value) {
  const raw = clean(value);
  if (!raw) return null;
  const normalized = raw
    .replace(/[₹$\s,]/g, '')
    .replace(/^INR/i, '')
    .replace(/^Rs\.?/i, '')
    .replace(/^\((.+)\)$/, '-$1');
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function money(value) {
  return parseMoney(value) ?? 0;
}

function positiveInteger(value) {
  const text = clean(value);
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function integer(value, fallback = 1) {
  return positiveInteger(value) ?? fallback;
}

function bool(value) {
  return ['1', 'true', 'yes', 'y'].includes(clean(value).toLowerCase());
}

function date(value) {
  if (!value) return null;
  const s = String(value).trim();
  // Attempt strictly as MDY first, fallback to standard parsing if it contains text or fails
  let d = normalizeSqlDate(s, { format: 'MDY' });
  if (d) return d;
  return normalizeSqlDate(s);
}

function fulfillment(model) {
  // Myntra's PPMP rows are its non-FBM flow. All other PO models represent
  // the seller-fulfilled / FBM flow in the reporting model.
  return clean(model).toUpperCase() === 'PPMP' ? 'Non-FBM' : 'FBM';
}

function orderLifecycle(row) {
  if (!value(row, 'order tracking number')) return 'Cancelled';
  if (value(row, 'cancelled on')) return 'Cancelled';
  if (value(row, 'rto creation date')) return 'RTO';
  if (value(row, 'return creation date')) return 'Return Initiated';
  if (value(row, 'delivered on')) return 'Delivered';
  return value(row, 'order status');
}

function orderReturnType(row) {
  if (!value(row, 'order tracking number')) return 'Courier Return';
  if (value(row, 'rto creation date')) return 'RTO';
  return value(row, 'return creation date') ? 'Customer Return' : null;
}

function parseSheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  const headers = (matrix[0] || []).map(clean);
  const rows = matrix.slice(1)
    .filter(row => row.some(cell => clean(cell)))
    .map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        if (header) {
          obj[header] = clean(row[index]);
        }
      });
      return obj;
    });
  return { headers, rows };
}

function validateLayout(headers, type) {
  const required = type === 'orders'
    ? ['order release id', 'order line id', 'po_type', 'created on']
    : ['order_id', 'order_line_id', 'type', 'return_created_date'];
  const found = new Set(headers.map(headerKey));
  const missing = required.filter(column => !found.has(headerKey(column)));
  if (missing.length) {
    throw new InputError(`This is not a Myntra ${type === 'orders' ? 'Order' : 'Return'} Layout file. Missing column(s): ${missing.join(', ')}.`);
  }
}

class InputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

async function resolveMyntraAccount(pool, requestedAccount) {
  const account = clean(requestedAccount).toLowerCase();
  if (!account) throw new InputError('Select Myntra (EJ) or Myntra (VB) before uploading.');
  const { rowCount } = await pool.query(
    `SELECT 1 FROM marketplace_accounts
     WHERE marketplace = 'myntra' AND account_id = $1 AND is_active = TRUE`,
    [account],
  );
  if (!rowCount) throw new InputError('The selected Myntra account is not active. Choose Myntra (EJ) or Myntra (VB).');
  if (!MYNTRA_SELLER_IDS[account]) throw new InputError('Only Myntra (EJ) and Myntra (VB) can use this dedicated Order / Return uploader.');
  return account;
}

function isRepeatedMyntraHeader(row, type) {
  if (!row || typeof row !== 'object') return false;
  const sellerId = value(row, 'seller_id', 'seller id');
  if (sellerId && (sellerId.toLowerCase().replace(/[\s_-]+/g, '') === 'sellerid' || sellerId.toLowerCase().replace(/[\s_-]+/g, '') === 'seller')) return true;
  const lineId = value(row, 'order_line_id', 'order line id');
  if (lineId && lineId.toLowerCase().replace(/[\s_-]+/g, '') === 'orderlineid') return true;
  const parentId = value(row, 'order_id', 'order release id');
  if (parentId && (parentId.toLowerCase().replace(/[\s_-]+/g, '') === 'orderid' || parentId.toLowerCase().replace(/[\s_-]+/g, '') === 'orderreleaseid')) return true;
  return false;
}

function validateSellerIds(rows, type, sellerAccount) {
  const expectedSellerId = MYNTRA_SELLER_IDS[sellerAccount];
  const sellerColumn = type === 'orders' ? 'seller id' : 'seller_id';
  const mismatches = rows
    .filter(row => !isRepeatedMyntraHeader(row, type))
    .map((row, index) => ({ row, rowNum: index + 2, sellerId: value(row, sellerColumn) }))
    .filter(entry => entry.sellerId && entry.sellerId !== expectedSellerId && entry.sellerId.toLowerCase().replace(/[\s_-]+/g, '') !== 'sellerid');
  if (!mismatches.length) return;

  const foundIds = [...new Set(mismatches.map(entry => entry.sellerId || '(blank)'))].slice(0, 4);
  const selectedName = sellerAccount === 'myntra_ej' ? 'Myntra (EJ)' : 'Myntra (VB)';
  const correctName = sellerAccount === 'myntra_ej' ? 'Myntra (VB)' : 'Myntra (EJ)';
  const expectedOther = sellerAccount === 'myntra_ej' ? MYNTRA_SELLER_IDS.myntra_vb : MYNTRA_SELLER_IDS.myntra_ej;
  const hint = foundIds.includes(expectedOther)
    ? ` This appears to be the ${correctName} file.`
    : '';
  throw new InputError(
    `Wrong Myntra account selected. ${selectedName} accepts seller ID ${expectedSellerId}, but ${mismatches.length} row(s) contain ${foundIds.join(', ')}.${hint} No data was saved.`,
  );
}

const ORDER_DATE_COLUMNS = ['created on', 'packed on', 'fmpu date', 'inscanned on', 'shipped on', 'delivered on', 'cancelled on', 'rto creation date', 'lost date', 'return creation date'];
const RETURN_DATE_COLUMNS = ['order_created_date', 'inscanned_on', 'fmpu_date', 'order_delivered_date', 'return_created_date', 'refunded_date', 'order_rto_date', 'lmdo_last_modified_on', 'gatepass_lastmodified'];
const ORDER_MONEY_COLUMNS = ['final amount', 'total mrp', 'discount', 'coupon discount', 'shipping charge', 'gift charge', 'tax recovery', 'seller price'];

function resolveReturnCreatedDate(row) {
  const rawType = clean(value(row, 'type', 'return_type')).toUpperCase();
  const rawRetDate = value(row, 'return_created_date');
  const rawRtoDate = value(row, 'order_rto_date');
  const parsedRetDate = date(rawRetDate);
  const parsedRtoDate = date(rawRtoDate);

  // If parsed return date is placeholder 1-Jan-1970 / epoch 0 or missing
  const isInvalidOrEpochRetDate = !parsedRetDate || parsedRetDate <= '1970-01-05';
  const isRto = rawType === 'RTO' || rawType.includes('RTO');

  // If RTO order or return_created_date is 1970 / empty, consider order_rto_date as return created date
  if ((isRto || isInvalidOrEpochRetDate) && parsedRtoDate && parsedRtoDate > '1970-01-05') {
    return parsedRtoDate;
  }
  if (parsedRetDate && !isInvalidOrEpochRetDate) {
    return parsedRetDate;
  }
  if (parsedRtoDate && parsedRtoDate > '1970-01-05') {
    return parsedRtoDate;
  }
  return parsedRetDate;
}

// Reject malformed values instead of silently turning them into zero/defaults.
// A zero amount is valid (for example, a cancelled order); a value such as
// "N/A" in a populated money cell is not and must remain visible in the audit.
export function validateMyntraRow(row, type) {
  const dateColumns = type === 'orders' ? ORDER_DATE_COLUMNS : RETURN_DATE_COLUMNS;
  for (const column of dateColumns) {
    const raw = value(row, column);
    if (raw && !date(raw)) return `invalid ${column} date: ${raw}`;
  }

  if (type === 'orders') {
    if (!value(row, 'created on')) return 'created on is empty';
    if (!value(row, 'final amount')) return 'final amount is empty';
    for (const column of ORDER_MONEY_COLUMNS) {
      const raw = value(row, column);
      if (raw && parseMoney(raw) == null) return `invalid ${column} amount: ${raw}`;
    }
  } else {
    if (!resolveReturnCreatedDate(row)) return 'return_created_date / order_rto_date is empty';
    const rawQuantity = value(row, 'quantity');
    if (rawQuantity && positiveInteger(rawQuantity) == null) return `invalid quantity: ${rawQuantity}`;
    const rawRefunded = value(row, 'is_refunded');
    if (rawRefunded && !['1', '0', 'true', 'false', 'yes', 'no', 'y', 'n'].includes(rawRefunded.toLowerCase())) {
      return `invalid is_refunded value: ${rawRefunded}`;
    }
  }

  return null;
}

function orderDetail(row, sellerAccount, batch) {
  return [
    'myntra', sellerAccount, value(row, 'seller id'), value(row, 'order line id'), value(row, 'order release id'),
    value(row, 'store order id').replace(/^'/, ''), value(row, 'seller order id'), value(row, 'order id fk'),
    value(row, 'po_type'), date(value(row, 'created on')), value(row, 'style id'), value(row, 'seller sku code'),
    value(row, 'myntra sku code'), value(row, 'size'), value(row, 'vendor article number'), value(row, 'brand'),
    value(row, 'style name'), value(row, 'article type'), value(row, 'order status'), value(row, 'packet id'),
    value(row, 'seller packe id', 'seller packet id'), value(row, 'courier code'), value(row, 'order tracking number'),
    value(row, 'seller warehouse id', 'warehouse id'), date(value(row, 'packed on')), date(value(row, 'fmpu date')),
    date(value(row, 'inscanned on')), date(value(row, 'shipped on')), date(value(row, 'delivered on')),
    date(value(row, 'cancelled on')), date(value(row, 'rto creation date')), date(value(row, 'lost date')),
    date(value(row, 'return creation date')), money(value(row, 'final amount')), money(value(row, 'total mrp')),
    money(value(row, 'discount')), money(value(row, 'coupon discount')), money(value(row, 'shipping charge')),
    money(value(row, 'gift charge')), money(value(row, 'tax recovery')), money(value(row, 'seller price')),
    value(row, 'city'), normalizeDeliveryState(value(row, 'state')), value(row, 'zipcode'), JSON.stringify(row), batch,
  ];
}

function normalizedOrder(row, sellerAccount) {
  const sellerPrice = money(value(row, 'seller price')) || money(value(row, 'final amount'));
  return [
    'myntra', value(row, 'order release id'), value(row, 'order line id'), value(row, 'myntra sku code'), value(row, 'seller sku code'),
    value(row, 'brand'), 'Myntra', value(row, 'article type'), null, value(row, 'po_type'), fulfillment(value(row, 'po_type')),
    date(value(row, 'created on')), 1, sellerPrice, sellerPrice,
    sellerPrice, normalizeDeliveryState(value(row, 'state')), value(row, 'city'), value(row, 'seller warehouse id', 'warehouse id'),
    null, value(row, 'zipcode'), orderLifecycle(row), orderReturnType(row), sellerAccount, value(row, 'brand'),
  ];
}

function returnDetail(row, sellerAccount, batch) {
  const returnCreatedDate = resolveReturnCreatedDate(row);
  return [
    'myntra', sellerAccount, value(row, 'seller_id'), value(row, 'order_line_id'), value(row, 'order_id'), value(row, 'order_group_id'),
    value(row, 'return_id'), value(row, 'model'), value(row, 'seller_sku_code'), value(row, 'myntra_sku_code'),
    value(row, 'style_id'), value(row, 'sku_id'), value(row, 'brand'), date(value(row, 'order_created_date')),
    date(value(row, 'order_delivered_date')), returnCreatedDate, date(value(row, 'refunded_date')),
    date(value(row, 'order_rto_date')), bool(value(row, 'is_refunded')), value(row, 'exchange_id'), value(row, 'seller_order_id'),
    value(row, 'type'), value(row, 'status'), value(row, 'return_status'), value(row, 'store_packet_id'),
    value(row, 'seller_packet_id_fk'), integer(value(row, 'quantity')), value(row, 'return_mode'), value(row, 'return_reason'),
    value(row, 'forward_tracking_number'), value(row, 'return_tracking_number'), value(row, 'master_bag_id'), value(row, 'lmdo_status'),
    date(value(row, 'lmdo_last_modified_on')),
    value(row, 'gatepass_id'), value(row, 'gatepass_status'), value(row, 'gatepass_type'),
    date(value(row, 'gatepass_lastmodified')),
    value(row, 'warehouse_id', 'seller_warehouse_id') || null,
    value(row, 'partner_warehouse_code') || null,
    JSON.stringify(row), batch,
  ];
}

function normalizedReturn(row, sellerAccount) {
  const returnDate = resolveReturnCreatedDate(row);
  const returnType = clean(value(row, 'type')).toUpperCase() === 'RTO' ? 'RTO' : (value(row, 'type') || 'Customer Return');
  return [
    'myntra', value(row, 'return_id'), value(row, 'order_line_id'), fulfillment(value(row, 'model')), returnDate,
    date(value(row, 'refunded_date')), value(row, 'status'), value(row, 'return_reason'), value(row, 'return_status'),
    returnType, value(row, 'return_status'), bool(value(row, 'is_refunded')) ? 'Refunded' : '',
    value(row, 'return_tracking_number'), value(row, 'seller_sku_code'), value(row, 'myntra_sku_code'), null,
    integer(value(row, 'quantity')), value(row, 'return_mode'), null, null, value(row, 'return_status'), null,
    null, null, null, null, null, null, date(value(row, 'refunded_date')), null, null, returnDate,
    value(row, 'order_id'), sellerAccount,
  ];
}

function synthesizedBlankTrackingReturn(row, sellerAccount) {
  const lineId = value(row, 'order line id');
  const parentId = value(row, 'order release id');
  const returnDate = date(value(row, 'cancelled on')) || date(value(row, 'created on'));
  return [
    'myntra',
    `RTO-${lineId}`,
    lineId,
    fulfillment(value(row, 'po_type')),
    returnDate,
    returnDate,
    'Cancelled',
    'Cancel Before Dispached',
    value(row, 'cancellation reason') || 'Cancel Before Dispached',
    'Courier Return',
    'Cancelled',
    null,
    null,
    value(row, 'seller sku code'),
    value(row, 'myntra sku code'),
    value(row, 'style name') || null,
    1,
    null, null, null, null,
    value(row, 'cancellation reason') || null,
    null, null, null, null, null, null,
    returnDate,
    null, null,
    returnDate,
    parentId,
    sellerAccount,
  ];
}

const ORDER_DETAIL_COLUMNS = [
  'marketplace', 'seller_account', 'seller_id', 'order_line_id', 'order_release_id', 'store_order_id', 'seller_order_id', 'order_id_fk',
  'po_type', 'order_created_on', 'style_id', 'seller_sku_code', 'myntra_sku_code', 'size', 'vendor_article_number', 'brand',
  'style_name', 'article_type', 'order_status', 'packet_id', 'seller_packet_id', 'courier_code', 'tracking_number', 'warehouse_id',
  'packed_on', 'fmpu_date', 'inscanned_on', 'shipped_on', 'delivered_on', 'cancelled_on', 'rto_creation_date', 'lost_date',
  'return_creation_date', 'final_amount', 'total_mrp', 'discount', 'coupon_discount', 'shipping_charge', 'gift_charge',
  'tax_recovery', 'seller_price', 'city', 'state', 'zipcode', 'source_data', 'upload_batch',
];
const NORMALIZED_ORDER_COLUMNS = [
  'marketplace', 'order_id', 'order_item_id', 'fsn', 'sku', 'brand', 'selling_channel', 'category', 'hsn_code', 'order_type',
  'fulfilment_type', 'order_date', 'qty', 'final_invoice_amount', 'total_share_amount', 'my_share', 'delivery_state',
  'delivery_city', 'warehouse_id', 'warehouse_city', 'delivery_pincode', 'orders_status', 'return_type', 'seller_account', 'brand_name',
];
const RETURN_DETAIL_COLUMNS = [
  'marketplace', 'seller_account', 'seller_id', 'order_line_id', 'order_release_id', 'order_group_id', 'return_id', 'model', 'seller_sku_code',
  'myntra_sku_code', 'style_id', 'sku_id', 'brand', 'order_created_date', 'order_delivered_date', 'return_created_date',
  'refunded_date', 'order_rto_date', 'is_refunded', 'exchange_id', 'seller_order_id', 'return_type', 'return_status', 'return_state',
  'store_packet_id', 'seller_packet_id', 'quantity', 'return_mode', 'return_reason', 'forward_tracking_number',
  'return_tracking_number', 'master_bag_id', 'lmdo_status', 'lmdo_last_modified_on',
  'gatepass_id', 'gatepass_status', 'gatepass_type', 'gatepass_lastmodified',
  'warehouse_id', 'partner_warehouse_code',
  'source_data', 'upload_batch',
];
const NORMALIZED_RETURN_COLUMNS = [
  'marketplace', 'return_id', 'order_item_id', 'fulfilment_type', 'return_requested_date', 'return_approval_date', 'return_status',
  'return_reason', 'return_sub_reason', 'return_type', 'return_result', 'return_expectation', 'reverse_logistics_tracking_id',
  'sku', 'fsn', 'product_title', 'quantity', 'return_completion_type', 'primary_pv_output', 'detailed_pv_output',
  'final_condition', 'return_cancellation_reason', 'tech_visit_sla', 'tech_visit_by_date', 'tech_visit_completion_datetime',
  'tech_visit_completion_breach', 'return_completion_sla', 'return_complete_by_date', 'return_completion_date',
  'return_completion_breach', 'return_cancellation_date', 'return_date', 'order_id', 'seller_account',
];

async function upsertRows(pool, table, columns, rows, conflictColumns, timestampColumn = 'updated_at') {
  if (!rows.length) return 0;
  const columnSql = columns.join(', ');
  const updateSql = columns
    .filter(column => !conflictColumns.includes(column) && column !== 'created_at')
    .map(column => `${column} = EXCLUDED.${column}`)
    .concat(`${timestampColumn} = NOW()`)
    .join(', ');
  let affected = 0;
  await forEachDbBatch(rows, columns.length, async batch => {
    const values = [];
    const groups = batch.map(row => {
      const start = values.length;
      values.push(...row);
      return `(${row.map((_, index) => `$${start + index + 1}`).join(', ')})`;
    });
    const result = await pool.query(
      `INSERT INTO ${table} (${columnSql}) VALUES ${groups.join(', ')}
       ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${updateSql}`,
      values,
    );
    affected += result.rowCount;
  });
  return affected;
}

const BATCH_CHUNK_SIZE = 1000;

async function importRows({ pool, rows, sellerAccount, type, batch }) {
  const skippedRows = [];
  const seenLineIds = new Set();
  const validRows = rows.filter((row, index) => {
    if (isRepeatedMyntraHeader(row, type)) {
      skippedRows.push({
        rowNum: index + 2,
        reason: 'repeated header row',
        data: row,
      });
      return false;
    }
    const lineId = type === 'orders' ? value(row, 'order line id') : value(row, 'order_line_id');
    const parentId = type === 'orders' ? value(row, 'order release id') : value(row, 'order_id');
    if (!lineId || !parentId) {
      skippedRows.push({
        rowNum: index + 2,
        reason: `${type === 'orders' ? 'order line id / order release id' : 'order_line_id / order_id'} is empty`,
        data: row,
      });
      return false;
    }
    const validationError = validateMyntraRow(row, type);
    if (validationError) {
      skippedRows.push({ rowNum: index + 2, reason: validationError, data: row });
      return false;
    }
    if (seenLineIds.has(lineId)) {
      skippedRows.push({ rowNum: index + 2, reason: 'duplicate order line ID within this file', data: row });
      return false;
    }
    seenLineIds.add(lineId);
    return true;
  });

  if (type === 'orders') {
    const dCols = ORDER_DETAIL_COLUMNS;
    const dConflict = ['marketplace', 'seller_account', 'order_line_id'];
    const dColumnSql = dCols.join(', ');
    const dUpdateSql = dCols
      .filter(column => !dConflict.includes(column) && column !== 'created_at')
      .map(column => `${column} = EXCLUDED.${column}`)
      .concat('updated_at = NOW()')
      .join(', ');

    const oCols = NORMALIZED_ORDER_COLUMNS;
    const oConflict = ['marketplace', 'seller_account', 'order_item_id'];
    const oColumnSql = oCols.join(', ');
    const oUpdateSql = oCols
      .filter(column => !oConflict.includes(column) && column !== 'created_at')
      .map(column => `${column} = EXCLUDED.${column}`)
      .concat('uploaded_at = NOW()')
      .join(', ');

    for (let i = 0; i < validRows.length; i += BATCH_CHUNK_SIZE) {
      const chunk = validRows.slice(i, i + BATCH_CHUNK_SIZE);
      const detailRows = chunk.map(row => orderDetail(row, sellerAccount, batch));
      const orderRows = chunk.map(row => normalizedOrder(row, sellerAccount));

      const dVals = [];
      const dGroups = detailRows.map(row => {
        const start = dVals.length;
        dVals.push(...row);
        return `(${row.map((_, idx) => `$${start + idx + 1}`).join(', ')})`;
      });

      const oVals = [];
      const oGroups = orderRows.map(row => {
        const start = oVals.length;
        oVals.push(...row);
        return `(${row.map((_, idx) => `$${start + idx + 1}`).join(', ')})`;
      });

      const blankTrackingRows = chunk.filter(row => !value(row, 'order tracking number'));
      const synthesizedReturnRows = blankTrackingRows.map(row => synthesizedBlankTrackingReturn(row, sellerAccount));

      const batchPromises = [
        pool.query(
          `INSERT INTO myntra_order_details (${dColumnSql}) VALUES ${dGroups.join(', ')}
           ON CONFLICT (${dConflict.join(', ')}) DO UPDATE SET ${dUpdateSql}`,
          dVals,
        ),
        pool.query(
          `INSERT INTO orders (${oColumnSql}) VALUES ${oGroups.join(', ')}
           ON CONFLICT (${oConflict.join(', ')}) DO UPDATE SET ${oUpdateSql}`,
          oVals,
        ),
      ];

      if (synthesizedReturnRows.length > 0) {
        const retCols = NORMALIZED_RETURN_COLUMNS;
        const retConflict = ['marketplace', 'seller_account', 'order_item_id'];
        const retColumnSql = retCols.join(', ');
        const retUpdateSql = retCols
          .filter(column => !retConflict.includes(column) && column !== 'created_at')
          .map(column => `${column} = EXCLUDED.${column}`)
          .concat('uploaded_at = NOW()')
          .join(', ');

        const rVals = [];
        const rGroups = synthesizedReturnRows.map(row => {
          const start = rVals.length;
          rVals.push(...row);
          return `(${row.map((_, idx) => `$${start + idx + 1}`).join(', ')})`;
        });

        batchPromises.push(
          pool.query(
            `INSERT INTO returns (${retColumnSql}) VALUES ${rGroups.join(', ')}
             ON CONFLICT (${retConflict.join(', ')}) DO UPDATE SET ${retUpdateSql}`,
            rVals,
          )
        );
      }

      await Promise.all(batchPromises);

      if (i + BATCH_CHUNK_SIZE < validRows.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    try {
      await backfillOrdersFromMyntraPayment(pool, sellerAccount);
      await refreshOrderSettlementTotals(pool);
      await pool.query(`
        UPDATE orders o
        SET vb_export_sku = sm.master_sku,
            vb_export_category = sm.category
        FROM sku_master sm
        WHERE o.sku = sm.listing_sku
          AND (o.vb_export_sku IS NULL OR o.vb_export_category IS NULL);
      `);
    } catch (e) {
      console.warn('[Myntra Upload] Warning: post-order backfill failed:', e.message);
    }
  } else {
    const rCols = RETURN_DETAIL_COLUMNS;
    const rConflict = ['marketplace', 'seller_account', 'order_line_id'];
    const rColumnSql = rCols.join(', ');
    const rUpdateSql = rCols
      .filter(column => !rConflict.includes(column) && column !== 'created_at')
      .map(column => `${column} = EXCLUDED.${column}`)
      .concat('updated_at = NOW()')
      .join(', ');

    const nCols = NORMALIZED_RETURN_COLUMNS;
    const nConflict = ['marketplace', 'seller_account', 'order_item_id'];
    const nColumnSql = nCols.join(', ');
    const nUpdateSql = nCols
      .filter(column => !nConflict.includes(column) && column !== 'created_at')
      .map(column => `${column} = EXCLUDED.${column}`)
      .concat('uploaded_at = NOW()')
      .join(', ');

    for (let i = 0; i < validRows.length; i += BATCH_CHUNK_SIZE) {
      const chunk = validRows.slice(i, i + BATCH_CHUNK_SIZE);
      const detailRows = chunk.map(row => returnDetail(row, sellerAccount, batch));
      const returnRows = chunk.map(row => normalizedReturn(row, sellerAccount));

      const rVals = [];
      const rGroups = detailRows.map(row => {
        const start = rVals.length;
        rVals.push(...row);
        return `(${row.map((_, idx) => `$${start + idx + 1}`).join(', ')})`;
      });

      const nVals = [];
      const nGroups = returnRows.map(row => {
        const start = nVals.length;
        nVals.push(...row);
        return `(${row.map((_, idx) => `$${start + idx + 1}`).join(', ')})`;
      });

      await Promise.all([
        pool.query(
          `INSERT INTO myntra_return_details (${rColumnSql}) VALUES ${rGroups.join(', ')}
           ON CONFLICT (${rConflict.join(', ')}) DO UPDATE SET ${rUpdateSql}`,
          rVals,
        ),
        pool.query(
          `INSERT INTO returns (${nColumnSql}) VALUES ${nGroups.join(', ')}
           ON CONFLICT (${nConflict.join(', ')}) DO UPDATE SET ${nUpdateSql}`,
          nVals,
        ),
      ]);

      if (i + BATCH_CHUNK_SIZE < validRows.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Ensure the return/exchange type correctly maps back to the main order ledger
    await pool.query(`
      UPDATE orders o
      SET 
        return_type = r.return_type,
        orders_status = CASE 
          WHEN r.return_reason IN ('Cancel before ship', 'Cancel Before Dispached') THEN 'Cancelled'
          WHEN r.return_type = 'RTO' THEN 'RTO'
          WHEN r.return_type = 'Courier Return' THEN 'Cancelled'
          WHEN o.orders_status IS NULL OR o.orders_status IN ('Delivered', 'Shipped', 'Complete', '') 
            THEN 'Return Orders' 
          ELSE o.orders_status 
        END
      FROM returns r
      WHERE o.order_item_id = r.order_item_id
        AND r.marketplace = 'myntra'
        AND r.seller_account = $1
    `, [sellerAccount]);
  }
  return { saved: validRows.length, skippedRows };
}

router.post('/:type', upload.single('file'), async (req, res) => {
  const type = clean(req.params.type).toLowerCase();
  if (!['orders', 'returns'].includes(type)) return res.status(404).json({ error: 'Unknown Myntra data type.' });
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured.' });
  if (!req.file) return res.status(400).json({ error: 'No file provided.' });

  let pool;
  let sellerAccount = '';
  let parsedRows = [];
  let saved = 0;
  let skippedRows = [];
  try {
    pool = getPool();
    sellerAccount = await resolveMyntraAccount(pool, req.query.seller_account || req.body.seller_account);
    const { headers, rows } = parseSheet(req.file.buffer);
    parsedRows = rows;
    if (!rows.length) throw new InputError('The workbook has headers but no data rows. No data was saved.');
    validateLayout(headers, type);
    validateSellerIds(rows, type, sellerAccount);
    const batch = new Date().toISOString().replace(/[:.]/g, '-');
    ({ saved, skippedRows } = await importRows({ pool, rows, sellerAccount, type, batch }));
    if (!saved) throw new InputError('No valid rows were found. Review the skipped-row reasons and correct the file before retrying.');
    const logType = `${sellerAccount}_${type}`;
    const logId = await logUpload(pool, logType, req.file.originalname, 'myntra', saved, 0, skippedRows.length, 'ok');
    await saveSkippedRows(pool, logId, skippedRows);
    res.json({
      ok: true, marketplace: 'myntra', seller_account: sellerAccount,
      inserted: saved, updated: 0, skipped: skippedRows.length, total: parsedRows.length, batch, logId,
    });
  } catch (error) {
    if (pool) {
      const logType = sellerAccount ? `${sellerAccount}_${type}` : `myntra_${type}`;
      const logId = await logUpload(pool, logType, req.file?.originalname, 'myntra', saved, 0, skippedRows.length, 'error', error.message);
      await saveSkippedRows(pool, logId, skippedRows).catch(() => {});
    }
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/template/:type', (req, res) => {
  const type = clean(req.params.type).toLowerCase();
  const headers = type === 'orders' ? ORDER_HEADERS : type === 'returns' ? RETURN_HEADERS : null;
  if (!headers) return res.status(404).json({ error: 'Unknown Myntra template type.' });
  const samples = type === 'orders'
    ? [[
      '10708', '14417', 'PPMP', '132711270516523865901', '100019530457', '11074259318',
      '000c9a08-9b48-404e-b8ca-58cd77255471', '5834298391', '2026-04-03', '31188717',
      'B96-Himani-Bottle Green_M_KL', '100518147', 'KALNKRTA100518147', 'M',
      'B96-Himani-Bottle Green_M_KL', 'KALINI', 'Sample Kurta', 'Kurtas', 'C', '100019530457',
      '', 'flipkartlogistics', 'MYSP1383140980', '14417', '', '', '2026-04-04', '2026-04-07',
      '2026-04-06', '2026-04-06', '2026-04-07', '', '', '', '', 475, 2796, 2321, 0, 0, 0, 0,
      'Bareilly', 'UP', '243005', 416,
    ]]
    : [[
      '10708', '14417', '14417', 'PPMP', 'SNGRKASS113289524', 'BT165-Nishi-Peach_XL_SA_Kurtaset', '35324487',
      '113289524', 'Sangria', '2026-04-13', '2026-04-15', '', '2026-04-22', '2026-04-24',
      '2026-04-25', '', 1, '', '100039181524', '5845830880', '11093910482',
      'f69f1745-f152-4ab1-a8ff-ccf9e8323e1f', 'Return', 'Ret Delivered', '100039181524', '', 1,
      '100155000000', 'OPEN_BOX_PICKUP', 'I did not like the fit', 'DLS', 'MYEC1098205736',
      'MYSR1208758327', '', '', '2026-05-07', '', '', '', '',
    ]];
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...samples]);
  sheet['!cols'] = headers.map(header => ({ wch: Math.min(Math.max(header.length + 3, 14), 28) }));
  XLSX.utils.book_append_sheet(workbook, sheet, type === 'orders' ? 'Myntra Orders' : 'Myntra Returns');
  const file = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Myntra_${type === 'orders' ? 'Order' : 'Return'}_Template.xlsx"`);
  res.send(file);
});

export {
  ORDER_HEADERS,
  RETURN_HEADERS,
  fulfillment,
  MYNTRA_SELLER_IDS,
  orderLifecycle,
  orderReturnType,
  resolveReturnCreatedDate,
  parseSheet,
  validateLayout,
  validateSellerIds,
  orderDetail,
  normalizedOrder,
  returnDetail,
  normalizedReturn,
  ORDER_DETAIL_COLUMNS,
  NORMALIZED_ORDER_COLUMNS,
  RETURN_DETAIL_COLUMNS,
  NORMALIZED_RETURN_COLUMNS,
  synthesizedBlankTrackingReturn,
  importRows,
  isRepeatedMyntraHeader,
};
export default router;
