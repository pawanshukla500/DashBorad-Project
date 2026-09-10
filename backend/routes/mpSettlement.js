/**
 * Multi-marketplace settlement routes
 *
 * order-based  (FK/Shopsy/Amazon) → handled by existing data.js / upload.js
 * invoice-based (Myntra SOR, Cocoblue) → /mp-settlement/invoices
 * ledger-based  (Zepto)                → /mp-settlement/ledger
 *
 * All routes scoped to /api/mp-settlement
 */
import express from 'express';
import multer  from 'multer';
import { createRequire } from 'module';
import { createHash } from 'node:crypto';
import { getPool, isDbConfigured } from '../db/index.js';
import { clearSkuSettlementBenchmarkCache } from '../services/skuSettlementBenchmark.js';
import { notifySkuSettlementBenchmarkAfterImport } from '../services/skuSettlementNotifications.js';
import { logUpload, saveSkippedRows } from '../services/uploadLog.js';
import { getRateCard } from '../services/rateCard.js';
import { forEachDbBatch } from '../utils/dbBatch.js';
import { refreshOrderSettlementTotals } from '../services/orderSettlementTotals.js';
import { backfillOrdersFromMyntraPayment } from '../services/myntraSettlementReportingRollups.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { pagination } from '../utils/requestParams.js';
import { optionalNumber, optionalString } from '../utils/valueParsers.js';
import { MYNTRA_SELLER_IDS } from './myntraUpload.js';
import { classifyMyntraNod } from '../services/myntraNodClassification.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 10, parts: 20 },
});
const req2   = createRequire(import.meta.url);
const XLSX   = req2('xlsx');

// ── helpers ───────────────────────────────────────────────────────────────────
function num(v) { return optionalNumber(v) ?? 0; }
function str(v) { return (v ?? '').toString().trim(); }

function hasValue(value) {
  return value != null && String(value).trim() !== '';
}

function strictDate(value) {
  return hasValue(value) ? normalizeSqlDate(value) : null;
}

// Myntra payment exports write dates as M/D/YY (e.g. "4/2/26" is 2 April 2026).
// A plain DMY read silently swaps day and month for every day above 12, so the
// Myntra importer tries MDY first and falls back to standard inference.
function myntraDate(value) {
  if (!hasValue(value)) return null;
  // cellDates:true gives real Date objects; only text cells need MDY parsing.
  if (value instanceof Date) return normalizeSqlDate(value);
  const s = String(value).trim();
  const mdy = normalizeSqlDate(s, { format: 'MDY' });
  if (mdy) return mdy;
  return normalizeSqlDate(s);
}

// Excel text cells often keep a leading apostrophe ("'132509375680735653501").
// Strip it so the stored identity matches the Order file's plain ID.
function stripIdApostrophe(value) {
  return String(value ?? '').trim().replace(/^'/, '');
}

function strictPositiveInteger(value) {
  if (!hasValue(value)) return 1;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function invoiceAlias(row, ...keys) {
  for (const key of keys) {
    const found = Object.keys(row).find(column =>
      column.toLowerCase().replace(/[\s_-]+/g, '') === key.toLowerCase().replace(/[\s_-]+/g, ''),
    );
    if (found && row[found] !== '') return row[found];
  }
  return '';
}

function invalidNumberLabel(label, raw, { required = false } = {}) {
  if (!hasValue(raw)) return required ? { error: `${label} is empty` } : { value: 0 };
  const value = optionalNumber(raw);
  return value == null ? { error: `invalid ${label}: ${raw}` } : { value };
}

const INVOICE_STATUS_BY_KEY = new Map([
  ['pending', 'Pending'],
  ['partial', 'Partial'],
  ['paid', 'Paid'],
  ['disputed', 'Disputed'],
]);

function calculatedInvoiceStatus(amountReceived, netPayable) {
  // Reverse/refund rows carry negative receivable and payment amounts. A
  // negative payment is valid only when it covers a negative payable amount.
  if (netPayable < 0) {
    if (amountReceived >= -0.01) return 'Pending';
    return amountReceived <= netPayable + 0.01 ? 'Paid' : 'Partial';
  }
  if (amountReceived <= 0) return 'Pending';
  return amountReceived >= netPayable - 0.01 ? 'Paid' : 'Partial';
}

function canonicalInvoiceStatus(value) {
  if (!hasValue(value)) return null;
  return INVOICE_STATUS_BY_KEY.get(str(value).toLowerCase()) || null;
}

export function invoiceSourceFingerprint({
  marketplace,
  sellerAccount,
  invoiceNumber,
  invoiceDate,
  sku,
  paymentReference,
  orderType,
  orderLineId,
  returnId,
}) {
  const canonical = [marketplace, sellerAccount, invoiceNumber, invoiceDate, sku, paymentReference, orderType]
    .map(value => String(value ?? '').trim());
  // Myntra settles one order multiple times: separate order lines of the same
  // release, Forward plus Reverse pairs, and second payouts under a new NEFT.
  // The order line and return identities keep each settlement row unique.
  // Files without those columns keep their previous fingerprint unchanged.
  if (orderLineId) canonical.push(String(orderLineId).trim());
  if (returnId) canonical.push(String(returnId).trim());
  return createHash('md5').update(canonical.join('\u001f')).digest('hex');
}

// Parse one invoice row before any write. This keeps a malformed finance cell
// from becoming 0 and then being treated as a valid, paid/partially-paid row.
export function parseInvoiceUploadRow(row, { marketplace, sellerAccount, batch }) {
  // Myntra payment rows identify the settled order by Order Release ID — the
  // same ID the Order upload stores as orders.order_id — with Store Order ID
  // only as a fallback for layouts without the release column.
  const orderReleaseId = stripIdApostrophe(invoiceAlias(row, 'order_release_id'));
  const orderLineId = stripIdApostrophe(invoiceAlias(row, 'order_line_id'));
  const returnId = stripIdApostrophe(invoiceAlias(row, 'return_id'));
  const rawInvoiceNumber = stripIdApostrophe(
    invoiceAlias(row, 'invoice_number', 'invoice no', 'invoiceno', 'invoice#', 'order_release_id', 'store_order_id'),
  );
  const invoiceNumber = orderReleaseId || rawInvoiceNumber || stripIdApostrophe(row['NOD_Comment']) || '';
  const parseDate = marketplace === 'myntra' ? myntraDate : strictDate;
  const rawInvoiceDate = invoiceAlias(row, 'invoice_date', 'invoicedate', 'date', 'dispatch_date', 'dispatchdate', 'payment_date');
  const invoiceDate = parseDate(rawInvoiceDate);
  if (!invoiceNumber) return { error: 'invoice number is empty' };
  if (!invoiceDate) return { error: `invoice date is empty or invalid${hasValue(rawInvoiceDate) ? `: ${rawInvoiceDate}` : ''}` };

  const invoiceAmountRaw = marketplace === 'myntra'
    ? invoiceAlias(row, 'customer_paid_amt', 'sale_total_customer_paid', 'invoice_amount', 'sale_amount', 'amount', 'taxable_amount', 'settled_amount')
    : invoiceAlias(row, 'invoice_amount', 'invoiceamount', 'sale_amount', 'saleamount', 'amount', 'taxable_amount', 'customer_paid_amt', 'settled_amount');

  const moneyFields = [
    ['invoice amount', invoiceAmountRaw, true],
    ['commission %', invoiceAlias(row, 'commission_pct', 'commission%', 'commissionpct', 'commissionrate'), false],
    ['commission amount', invoiceAlias(row, 'commission_amount', 'commissionamount', 'commission'), false],
    ['TDS %', invoiceAlias(row, 'tds_pct', 'tds%', 'tdspct', 'tdsrate'), false],
    ['TDS amount', invoiceAlias(row, 'tds_amount', 'tdsamount', 'tds'), false],
    ['other deductions', invoiceAlias(row, 'other_deductions', 'otherdeductions', 'deductions', 'other', 'fixed_fee', 'shipping_fee', 'logistics_commission'), false],
    ['net payable', invoiceAlias(row, 'net_payable', 'netpayable', 'net', 'settled_amount'), false],
    ['amount received', invoiceAlias(row, 'amount_received', 'amountreceived', 'received', 'paid', 'settled_amount'), false],
    ['MRP', invoiceAlias(row, 'mrp'), false],
    // Myntra payment exports have no selling-price column; commission there is
    // computed on the taxable amount, so use it as the rate-card price base.
    ['selling price', invoiceAlias(row, 'selling_price', 'sellingprice', 'sp', 'taxable_amount'), false],
  ];
  const parsed = {};
  for (const [label, raw, required] of moneyFields) {
    const result = invalidNumberLabel(label, raw, { required });
    if (result.error) return result;
    parsed[label] = result.value;
  }

  if (parsed['invoice amount'] <= 0 && invoiceNumber) {
    // Reverse/Return rows in Myntra payment files can have positive or zero invoice amounts
    // but negative net payables
  }
  for (const label of ['TDS %', 'MRP', 'selling price']) {
    if (parsed[label] < 0) return { error: `${label} cannot be negative` };
  }
  
  // Floating point precision fixes for things like -3.33066907387546e-16
  for (const label of ['commission amount', 'other deductions', 'net payable', 'invoice amount', 'amount received']) {
    if (Math.abs(parsed[label]) < 0.01) {
      parsed[label] = 0;
    }
  }

  for (const label of ['commission %', 'TDS %']) {
    if (parsed[label] > 100) return { error: `${label} cannot exceed 100` };
  }

  const rawQuantity = invoiceAlias(row, 'quantity', 'qty');
  const quantity = strictPositiveInteger(rawQuantity);
  if (quantity == null) return { error: `invalid quantity: ${rawQuantity}` };

  const rawDispatchDate = invoiceAlias(row, 'dispatch_date', 'dispatchdate');
  const dispatchDate = parseDate(rawDispatchDate);
  if (hasValue(rawDispatchDate) && !dispatchDate) return { error: `invalid dispatch date: ${rawDispatchDate}` };
  const rawPaymentDate = invoiceAlias(row, 'payment_date', 'paymentdate');
  const paymentDate = parseDate(rawPaymentDate);
  if (hasValue(rawPaymentDate) && !paymentDate) return { error: `invalid payment date: ${rawPaymentDate}` };

  const sku = str(invoiceAlias(row, 'sku', 'fsn', 'article_no', 'articleno', 'packet_id'));
  const paymentReference = str(invoiceAlias(row, 'payment_reference', 'paymentreference', 'neft_id', 'utr', 'reference', 'neft_ref'));
  let invoiceAmount = parsed['invoice amount'];
  let commissionAmount = hasValue(moneyFields[2][1])
    ? parsed['commission amount']
    : invoiceAmount * parsed['commission %'] / 100;
  let tdsAmount = hasValue(moneyFields[4][1])
    ? parsed['TDS amount']
    : invoiceAmount * parsed['TDS %'] / 100;
  let otherDeductions = parsed['other deductions'];

  const nodComment = str(invoiceAlias(row, 'nod_comment', 'nodcomment') || row['NOD_Comment']);
  let orderType = str(invoiceAlias(row, 'order_type', 'ordertype')).toLowerCase();
  if (!orderType && nodComment) {
    orderType = 'nod';
  }
  // Reverse refunds and NOD (non-order deduction) rows legitimately settle with
  // negative amounts. Any other negative receipt is treated as corrupt input.
  const myntraNegativeSettlement = orderType === 'reverse' || orderType === 'nod';
  if (parsed['amount received'] < 0 && !(marketplace === 'myntra' && myntraNegativeSettlement)) {
    return { error: 'amount received cannot be negative' };
  }
  if (marketplace === 'myntra' && orderType === 'reverse') {
    // Reverse amounts represent refunds/credits to us, while the invoice is a refund to the customer.
    invoiceAmount = -Math.abs(invoiceAmount);
    commissionAmount = -Math.abs(commissionAmount);
    tdsAmount = -Math.abs(tdsAmount);
  }

  let netPayable = hasValue(moneyFields[6][1])
    ? parsed['net payable']
    : invoiceAmount - commissionAmount - tdsAmount - otherDeductions;

  if (marketplace === 'myntra' && hasValue(moneyFields[6][1])) {
    // Roll up fragmented fee columns (shipping, fixed, gateway, pick_and_pack, etc)
    // into a single other_deductions figure by mathematically bridging the gap.
    otherDeductions = invoiceAmount - netPayable - commissionAmount - tdsAmount;
    otherDeductions = Math.round(otherDeductions * 100) / 100;
  }

  // Myntra payment layouts itemize every fee, but GST-inclusive:
  //   Commission 283.919  = 240.609 ex-GST + 43.31 GST (rate = ex / taxable)
  //   Logistics_Commission 53.1 = fixed_fee 45 + 8.1 GST
  // The payout math is customer_paid − commission(incl GST) − TCS − TDS −
  // logistics(incl GST) = settled. Store the components separately and
  // GST-free so fee reports and the rate audit are apples-to-apples with
  // Flipkart/Amazon. Reverse rows refund commission/TCS/TDS (negative) while
  // reverse shipping and its GST stay charges (positive).
  let tcsAmount = null;
  let fixedFeeAmount = null;
  let shippingFeeAmount = null;
  let pickPackFeeAmount = null;
  let gatewayFeeAmount = null;
  let gstOnMpFees = null;
  const myntraFeeLayout = marketplace === 'myntra' && (
    hasValue(invoiceAlias(row, 'logistics_commission'))
    || hasValue(invoiceAlias(row, 'igst_tcs'))
    || hasValue(invoiceAlias(row, 'order_type'))
  );
  if (myntraFeeLayout) {
    const sign = orderType === 'reverse' ? -1 : 1;
    const commissionIncl = Math.abs(num(invoiceAlias(row, 'commission', 'commission_amount')));
    const round2v = v => Math.round(v * 100) / 100;
    const commissionEx = round2v(commissionIncl / 1.18);
    const commissionGst = round2v(commissionIncl - commissionEx);
    const tcsRaw = Math.abs(
      num(invoiceAlias(row, 'igst_tcs')) + num(invoiceAlias(row, 'cgst_tcs')) + num(invoiceAlias(row, 'sgst_tcs')),
    );
    const fixedRaw = Math.abs(num(invoiceAlias(row, 'fixed_fee')));
    const shippingRaw = Math.abs(num(invoiceAlias(row, 'shipping_fee')));
    const pickPackRaw = Math.abs(num(invoiceAlias(row, 'pick_and_pack_fee')));
    const gatewayRaw = Math.abs(num(invoiceAlias(row, 'payment_gateway_fee')));
    // Logistics_Commission is the GST-inclusive total of the fee columns.
    const logisticsIncl = Math.abs(num(invoiceAlias(row, 'logistics_commission')));
    const feeEx = round2v(fixedRaw + shippingRaw + pickPackRaw + gatewayRaw);
    const feeGst = Math.max(0, round2v(logisticsIncl - feeEx));

    commissionAmount = sign * commissionEx;
    tdsAmount = sign * Math.abs(tdsAmount);
    tcsAmount = sign * tcsRaw;
    gstOnMpFees = sign * commissionGst + feeGst;
    fixedFeeAmount = fixedRaw;
    shippingFeeAmount = shippingRaw;
    pickPackFeeAmount = pickPackRaw;
    gatewayFeeAmount = gatewayRaw;
    // What the payout actually deducted besides commission/TDS: TCS plus the
    // GST-inclusive fee total (for Reverse, TCS comes back as a credit).
    otherDeductions = round2v(sign * tcsRaw + logisticsIncl);
  }

  let amountReceived = parsed['amount received'];
  // Return net payables are natively negative
  const rawStatus = invoiceAlias(row, 'status', 'payment_status', 'paymentstatus');
  const requestedStatus = canonicalInvoiceStatus(rawStatus);
  if (hasValue(rawStatus) && !requestedStatus) {
    return { error: `invalid payment status: ${rawStatus}` };
  }
  const calculatedStatus = calculatedInvoiceStatus(amountReceived, netPayable);
  if (requestedStatus && requestedStatus !== 'Disputed' && requestedStatus !== calculatedStatus) {
    return { error: `payment status ${requestedStatus} does not match amount received` };
  }
  const status = requestedStatus || calculatedStatus;
  
  // Myntra payment files include both Forward and Reverse rows for the same Store_Order_id + SKU + Payment Ref.
  // We must differentiate them to avoid duplicate constraint failures.

  return {
    fingerprint: invoiceSourceFingerprint({
      marketplace,
      sellerAccount,
      invoiceNumber,
      invoiceDate,
      sku,
      paymentReference,
      orderType,
      orderLineId,
      returnId,
    }),
    values: [
      marketplace, sellerAccount, invoiceNumber, invoiceDate, dispatchDate, sku,
      str(invoiceAlias(row, 'product_title', 'product', 'product_name', 'productname', 'title', 'description')),
      quantity, parsed.MRP, parsed['selling price'], invoiceAmount, parsed['commission %'], commissionAmount,
      parsed['TDS %'], tdsAmount, otherDeductions, netPayable, amountReceived,
      paymentDate, paymentReference, status, str(invoiceAlias(row, 'notes', 'remarks', 'remark', 'nod_comment') || row['NOD_Comment']), batch,
      orderReleaseId || null, orderLineId || null, returnId || null, orderType || null,
      tcsAmount, fixedFeeAmount, shippingFeeAmount, pickPackFeeAmount, gatewayFeeAmount, gstOnMpFees,
    ],
  };
}

const INVOICE_STORAGE_COLUMNS = [
  'marketplace', 'seller_account', 'invoice_number', 'invoice_date', 'dispatch_date', 'sku', 'product_title',
  'quantity', 'mrp', 'selling_price', 'invoice_amount', 'commission_pct', 'commission_amount',
  'tds_pct', 'tds_amount', 'other_deductions', 'net_payable', 'amount_received',
  'payment_date', 'payment_reference', 'status', 'notes', 'upload_batch',
  'order_release_id', 'order_line_id', 'return_id', 'order_type',
  'tcs_amount', 'fixed_fee_amount', 'shipping_fee_amount', 'pick_pack_fee_amount', 'gateway_fee_amount', 'gst_on_mp_fees',
  'source_fingerprint',
];

const INVOICE_UPSERT_UPDATE_SET = INVOICE_STORAGE_COLUMNS
  .filter(column => !['marketplace', 'seller_account', 'source_fingerprint'].includes(column))
  .map(column => `${column} = EXCLUDED.${column}`)
  .concat('updated_at = NOW()')
  .join(', ');

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// A Myntra payment file must be imported under the account that owns its rows,
// exactly like the Order and Return importers. Seller_Id is present on every
// Myntra payment export (VB is 10708, EJ is 45833).
export function validateMyntraInvoiceSellerIds(rows, sellerAccount) {
  const expectedSellerId = MYNTRA_SELLER_IDS[sellerAccount];
  if (!expectedSellerId) return;
  const mismatches = rows
    .map((row, index) => ({
      rowNum: index + 2,
      sellerId: stripIdApostrophe(invoiceAlias(row, 'seller_id', 'sellerid')),
    }))
    .filter(entry => entry.sellerId && entry.sellerId !== expectedSellerId);
  if (!mismatches.length) return;

  const foundIds = [...new Set(mismatches.map(entry => entry.sellerId))].slice(0, 4);
  const selectedName = sellerAccount === 'myntra_ej' ? 'Myntra (EJ)' : 'Myntra (VB)';
  const correctName = sellerAccount === 'myntra_ej' ? 'Myntra (VB)' : 'Myntra (EJ)';
  const expectedOther = sellerAccount === 'myntra_ej' ? MYNTRA_SELLER_IDS.myntra_vb : MYNTRA_SELLER_IDS.myntra_ej;
  const hint = foundIds.includes(expectedOther)
    ? ` This appears to be the ${correctName} file.`
    : '';
  throw inputError(
    `Wrong Myntra account selected. ${selectedName} accepts seller ID ${expectedSellerId}, but ${mismatches.length} row(s) contain ${foundIds.join(', ')}.${hint} No data was saved.`,
  );
}

const MP_RECO_TYPES = new Set(['order', 'invoice', 'ledger', 'setup']);
const MP_COLORS = new Set(['slate', 'indigo', 'amber', 'pink', 'blue', 'emerald', 'rose', 'violet', 'cyan', 'teal']);

function marketplaceToken(value) {
  const token = optionalString(value)?.toLowerCase();
  if (!token || !/^[a-z0-9][a-z0-9_-]{0,49}$/.test(token)) {
    throw inputError('marketplace must contain lowercase letters, numbers, hyphens, or underscores');
  }
  return token;
}

function configText(value, label, { required = false, max = 500 } = {}) {
  const text = optionalString(value);
  if (required && !text) throw inputError(`${label} is required`);
  if (text && text.length > max) throw inputError(`${label} must be ${max} characters or fewer`);
  return text;
}

function configRecoType(value) {
  const type = (configText(value, 'reco_type', { max: 20 }) || 'order').toLowerCase();
  if (!MP_RECO_TYPES.has(type)) throw inputError('reco_type must be order, invoice, ledger, or setup');
  return type;
}

function configColor(value) {
  const color = (configText(value, 'color', { max: 20 }) || 'slate').toLowerCase();
  if (!MP_COLORS.has(color)) throw inputError('color is not supported');
  return color;
}

function configActive(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && ['true', 'false'].includes(value.trim().toLowerCase())) return value.trim().toLowerCase() === 'true';
  throw inputError('is_active must be true or false');
}

export function parseMpConfigInput(input = {}, { partial = false } = {}) {
  if (partial) {
    const values = {};
    if (Object.prototype.hasOwnProperty.call(input, 'is_active') || Object.prototype.hasOwnProperty.call(input, 'isActive')) values.isActive = configActive(input.is_active ?? input.isActive);
    if (Object.prototype.hasOwnProperty.call(input, 'notes')) values.notes = configText(input.notes, 'notes', { max: 1000 });
    if (Object.prototype.hasOwnProperty.call(input, 'display_name') || Object.prototype.hasOwnProperty.call(input, 'displayName')) values.displayName = configText(input.display_name ?? input.displayName, 'display_name', { required: true, max: 100 });
    if (Object.prototype.hasOwnProperty.call(input, 'reco_type') || Object.prototype.hasOwnProperty.call(input, 'recoType')) values.recoType = configRecoType(input.reco_type ?? input.recoType);
    if (!Object.keys(values).length) throw inputError('Nothing to update');
    return values;
  }
  return {
    marketplace: marketplaceToken(input.marketplace),
    displayName: configText(input.display_name ?? input.displayName, 'display_name', { required: true, max: 100 }),
    recoType: configRecoType(input.reco_type ?? input.recoType),
    color: configColor(input.color),
    notes: configText(input.notes, 'notes', { max: 1000 }),
  };
}

const LEDGER_ENTRY_TYPES = new Map([
  ['sale', 'Sale'], ['sales', 'Sale'], ['order', 'Sale'],
  ['return', 'Return'], ['rto', 'Return'], ['refund', 'Return'],
  ['commission', 'Commission'], ['fee', 'Commission'], ['fees', 'Commission'],
  ['payment', 'Payment'], ['receipt', 'Payment'], ['neft', 'Payment'], ['credit note', 'Payment'],
  ['penalty', 'Penalty'], ['fine', 'Penalty'],
  ['adjustment', 'Adjustment'], ['adj', 'Adjustment'],
  ['other', 'Other'],
]);

function ledgerAlias(row, ...keys) {
  for (const key of keys) {
    const found = Object.keys(row).find(column =>
      column.toLowerCase().replace(/[\s_-]+/g, '') === key.toLowerCase().replace(/[\s_-]+/g, ''),
    );
    if (found && row[found] !== '') return row[found];
  }
  return '';
}

function canonicalLedgerEntryType(value) {
  if (!hasValue(value)) return 'Other';
  const normalized = str(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (LEDGER_ENTRY_TYPES.has(normalized)) return LEDGER_ENTRY_TYPES.get(normalized);
  for (const [key, canonical] of LEDGER_ENTRY_TYPES) {
    if (normalized.includes(key)) return canonical;
  }
  return null;
}

function parseLedgerMoney(label, value, { allowNegative = false } = {}) {
  if (!hasValue(value)) return { value: null };
  const parsed = optionalNumber(value);
  if (parsed == null) return { error: `invalid ${label}: ${value}` };
  if (!allowNegative && parsed < 0) return { error: `${label} cannot be negative` };
  return { value: parsed };
}

function ledgerEntryTypeFromRow(row) {
  const raw = ledgerAlias(row, 'entry_type', 'entrytype', 'type', 'category', 'transaction_type', 'transactiontype');
  const entryType = canonicalLedgerEntryType(raw);
  return entryType ? { value: entryType, raw } : { error: `invalid entry type: ${raw}` };
}

function moneyFingerprintValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : '0.00';
}

export function ledgerSourceFingerprint({
  marketplace,
  entryDate,
  referenceNumber,
  orderId,
  entryType,
  debit,
  credit,
  description,
}) {
  const canonical = [
    marketplace, entryDate, referenceNumber, orderId, entryType,
    moneyFingerprintValue(debit), moneyFingerprintValue(credit), description,
  ].map(value => String(value ?? '').trim()).join('\u001f');
  return createHash('md5').update(canonical).digest('hex');
}

export function parseLedgerUploadRow(row, { marketplace, batch }) {
  const rawEntryDate = ledgerAlias(row, 'date', 'entry_date', 'entrydate', 'transaction_date', 'transactiondate');
  const entryDate = strictDate(rawEntryDate);
  if (!entryDate) return { error: `entry date is empty or invalid${hasValue(rawEntryDate) ? `: ${rawEntryDate}` : ''}` };

  const typeResult = ledgerEntryTypeFromRow(row);
  if (typeResult.error) return typeResult;
  const entryType = typeResult.value;
  const rawDebit = ledgerAlias(row, 'debit', 'debits', 'debit_amount', 'debitamount');
  const rawCredit = ledgerAlias(row, 'credit', 'credits', 'credit_amount', 'creditamount');
  const rawAmount = ledgerAlias(row, 'amount', 'transaction_amount', 'transactionamount');
  const debitResult = parseLedgerMoney('debit', rawDebit);
  const creditResult = parseLedgerMoney('credit', rawCredit);
  const amountResult = parseLedgerMoney('amount', rawAmount, { allowNegative: true });
  if (debitResult.error || creditResult.error || amountResult.error) {
    return debitResult.error ? debitResult : (creditResult.error ? creditResult : amountResult);
  }

  const debitProvided = debitResult.value != null;
  const creditProvided = creditResult.value != null;
  const amountProvided = amountResult.value != null;
  if ((debitProvided || creditProvided) && amountProvided) {
    return { error: 'use either Amount or Debit/Credit columns, not both' };
  }

  let debit = debitResult.value || 0;
  let credit = creditResult.value || 0;
  if (!debitProvided && !creditProvided) {
    if (!amountProvided || amountResult.value === 0) return { error: 'a non-zero debit, credit, or amount is required' };
    if (entryType === 'Other') return { error: 'entry type is required when using a single Amount column' };
    const amount = amountResult.value;
    const creditType = entryType === 'Sale' || entryType === 'Payment';
    if (amount < 0 || !creditType) debit = Math.abs(amount);
    else credit = amount;
  }
  if (debit > 0 && credit > 0) return { error: 'a row cannot contain both debit and credit values' };
  if (debit === 0 && credit === 0) return { error: 'a non-zero debit, credit, or amount is required' };

  const rawRunningBalance = ledgerAlias(row, 'running_balance', 'runningbalance', 'balance', 'closing_balance', 'closingbalance');
  const runningBalanceResult = parseLedgerMoney('running balance', rawRunningBalance, { allowNegative: true });
  if (runningBalanceResult.error) return runningBalanceResult;

  const referenceNumber = str(ledgerAlias(row, 'reference_number', 'referencenumber', 'reference', 'ref', 'neft_id', 'utr', 'voucher'));
  const orderId = str(ledgerAlias(row, 'order_id', 'orderid', 'order_no', 'orderno'));
  const description = str(ledgerAlias(row, 'description', 'narration', 'particulars', 'remarks', 'remark', 'note'));
  const fingerprint = ledgerSourceFingerprint({
    marketplace, entryDate, referenceNumber, orderId, entryType, debit, credit, description,
  });

  return {
    fingerprint,
    values: [
      marketplace, entryDate, referenceNumber, orderId, description, entryType, debit, credit,
      runningBalanceResult.value, batch,
    ],
  };
}

const LEDGER_STORAGE_COLUMNS = [
  'marketplace', 'entry_date', 'reference_number', 'order_id', 'description',
  'entry_type', 'debit', 'credit', 'running_balance', 'upload_batch', 'source_fingerprint',
];

const LEDGER_UPSERT_UPDATE_SET = LEDGER_STORAGE_COLUMNS
  .filter(column => !['marketplace', 'source_fingerprint'].includes(column))
  .map(column => `${column} = EXCLUDED.${column}`)
  .concat('updated_at = NOW()')
  .join(', ');

// Account choice is an import boundary, not an Excel-column convention. It
// prevents a single file from accidentally mixing the two Myntra businesses.
async function resolveSellerAccount(pool, marketplace, requestedAccount, { required = false } = {}) {
  const account = str(requestedAccount);
  // Account validation is currently enforced only for the two-account Myntra
  // workflow. Other invoice-based marketplaces retain their existing default
  // account behaviour until their own account configuration is introduced.
  if (marketplace !== 'myntra') return account || 'default';
  if (!account) {
    if (required || marketplace === 'myntra') {
      throw inputError('Select Myntra (VB) or Myntra (EJ) before importing.');
    }
    return 'default';
  }

  const { rows } = await pool.query(
    `SELECT account_id
       FROM marketplace_accounts
      WHERE marketplace = $1 AND account_id = $2 AND is_active = TRUE`,
    [marketplace, account]
  );
  if (!rows.length) throw inputError(`The selected account is not active for ${marketplace}.`);
  return account;
}

// ── GET /config ───────────────────────────────────────────────────────────────
router.get('/config', async (_req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const { rows } = await getPool().query(
      `SELECT marketplace, display_name, reco_type, is_active, color, notes FROM mp_config ORDER BY marketplace`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /config/:marketplace — toggle active or update notes ────────────────
router.patch('/config/:marketplace', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const marketplace = marketplaceToken(req.params.marketplace);
    const parsed = parseMpConfigInput(req.body, { partial: true });
    const sets = [], vals = [];
    if (Object.prototype.hasOwnProperty.call(parsed, 'isActive')) sets.push(`is_active = $${vals.push(parsed.isActive)}`);
    if (Object.prototype.hasOwnProperty.call(parsed, 'notes')) sets.push(`notes = $${vals.push(parsed.notes)}`);
    if (Object.prototype.hasOwnProperty.call(parsed, 'displayName')) sets.push(`display_name = $${vals.push(parsed.displayName)}`);
    if (Object.prototype.hasOwnProperty.call(parsed, 'recoType')) sets.push(`reco_type = $${vals.push(parsed.recoType)}`);
    vals.push(marketplace);
    const result = await getPool().query(
      `UPDATE mp_config SET ${sets.join(', ')} WHERE marketplace = $${vals.length}`, vals
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Marketplace configuration not found' });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── POST /config — add a new marketplace ─────────────────────────────────────
router.post('/config', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const { marketplace, displayName, recoType, color, notes } = parseMpConfigInput(req.body);
    await getPool().query(
      `INSERT INTO mp_config (marketplace, display_name, reco_type, color, notes) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (marketplace) DO UPDATE SET display_name=EXCLUDED.display_name, reco_type=EXCLUDED.reco_type, is_active=TRUE`,
      [marketplace, displayName, recoType, color, notes]
    );
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// INVOICE-BASED RECONCILIATION  (Myntra SOR, Cocoblue, etc.)
// ══════════════════════════════════════════════════════════════════════════════

export function auditInvoiceRow(row, rc) {
  const invoiceAmount = num(row.invoice_amount);
  const storedQuantity = optionalNumber(row.quantity);
  const qty = Number.isSafeInteger(storedQuantity) && storedQuantity > 0 ? storedQuantity : 1;
  const storedSellingPrice = optionalNumber(row.selling_price);
  const unitPrice = storedSellingPrice != null ? storedSellingPrice : invoiceAmount / qty;
  const invoiceDate = row.invoice_date ? String(row.invoice_date).slice(0, 10) : null;
  const actualCommPct = num(row.commission_pct);
  const storedCommissionAmount = optionalNumber(row.commission_amount);
  const actualCommAmt = storedCommissionAmount != null
    ? storedCommissionAmount
    : invoiceAmount * actualCommPct / 100;

  if (!rc || !rc.commission || !rc.commission.length) {
    return {
      expected_commission_pct: null,
      expected_commission_amount: null,
      commission_variance: 0,
      rate_card_status: 'not_configured',
      rate_card_notes: 'No rate card rules configured for this account',
    };
  }

  // Find matching commission row (scoped by date and unit price range)
  const match = rc.commission.find(r => {
    if (invoiceDate) {
      if (r.startDate && invoiceDate < r.startDate) return false;
      if (r.endDate   && invoiceDate > r.endDate)   return false;
    }
    const pMin = r.priceMin ?? 0;
    const pMax = r.priceMax ?? 999999;
    if (unitPrice < pMin || unitPrice > pMax) return false;
    return true;
  });

  if (!match) {
    return {
      expected_commission_pct: null,
      expected_commission_amount: null,
      commission_variance: 0,
      rate_card_status: 'not_configured',
      rate_card_notes: 'No matching rate rule found for this invoice price slab',
    };
  }

  const expPct = match.rate <= 1 ? +(match.rate * 100).toFixed(2) : +match.rate.toFixed(2);
  const expRate = match.rate <= 1 ? match.rate : match.rate / 100;
  const expAmt = +(invoiceAmount * expRate).toFixed(2);
  const variance = +(actualCommAmt - expAmt).toFixed(2);

  let status = 'matched';
  if (variance > 2) status = 'overcharged';
  else if (variance < -2) status = 'undercharged';

  return {
    expected_commission_pct: expPct,
    expected_commission_amount: expAmt,
    commission_variance: variance,
    rate_card_status: status,
    rate_card_notes: status === 'overcharged'
      ? `Charged ${actualCommPct}% vs configured ${expPct}% (₹${variance} overcharge)`
      : (status === 'matched' ? 'Matches configured rate card' : `Charged ${actualCommPct}% vs configured ${expPct}%`),
  };
}

// GET /invoices?marketplace=myntra&status=Pending&page=1&pageSize=50
router.get('/invoices', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const pool = getPool();
    const mp = req.query.marketplace;
    const status = req.query.status || '';
    const account = str(req.query.seller_account);
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 500 });

    const where = []; const vals = [];
    if (mp)      { where.push(`marketplace = $${vals.push(mp)}`); }
    if (account) { where.push(`seller_account = $${vals.push(account)}`); }
    if (status)  { where.push(`status = $${vals.push(status)}`);  }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const whereVals = [...vals];

    const [rows, cnt, agg, rc] = await Promise.all([
      pool.query(`SELECT * FROM mp_invoices ${wh} ORDER BY invoice_date DESC NULLS LAST, id DESC LIMIT $${whereVals.length + 1} OFFSET $${whereVals.length + 2}`, [...whereVals, pageSize, offset]),
      pool.query(`SELECT COUNT(*) AS cnt FROM mp_invoices ${wh}`, whereVals),
      pool.query(`
        SELECT
          marketplace,
          COUNT(*)                                  AS invoice_count,
          SUM(invoice_amount)                       AS total_invoiced,
          SUM(commission_amount + tds_amount + other_deductions) AS total_deductions,
          SUM(net_payable)                          AS total_net_payable,
          SUM(amount_received)                      AS total_received,
          SUM(net_payable - amount_received)        AS total_pending,
          SUM(CASE WHEN status = 'Pending'  THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN status = 'Partial'  THEN 1 ELSE 0 END) AS partial_count,
          SUM(CASE WHEN status = 'Paid'     THEN 1 ELSE 0 END) AS paid_count,
          SUM(CASE WHEN status = 'Disputed' THEN 1 ELSE 0 END) AS disputed_count
        FROM mp_invoices ${wh}
        GROUP BY marketplace
      `, whereVals),
      mp ? getRateCard(mp, account || 'default').catch(() => null) : Promise.resolve(null),
    ]);

    const enrichedRows = rows.rows.map(row => ({
      ...row,
      ...auditInvoiceRow(row, rc),
    }));

    res.json({
      data: enrichedRows,
      total: +(cnt.rows[0].cnt || 0),
      summary: agg.rows,
      page, pageSize,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /invoices/rate-audit?marketplace=myntra&seller_account=myntra_vb
router.get('/invoices/rate-audit', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const pool    = getPool();
    const mp      = req.query.marketplace || 'myntra';
    const account = str(req.query.seller_account);

    const where = [`marketplace = $1`];
    const vals = [mp];
    if (account) {
      where.push(`seller_account = $${vals.push(account)}`);
    }
    const wh = `WHERE ${where.join(' AND ')}`;

    const [rc, invRes] = await Promise.all([
      getRateCard(mp, account || 'default').catch(() => null),
      pool.query(`SELECT * FROM mp_invoices ${wh} ORDER BY invoice_date DESC NULLS LAST, id DESC LIMIT 500`, vals),
    ]);

    const rows = invRes.rows.map(row => ({
      ...row,
      ...auditInvoiceRow(row, rc),
    }));

    const configured = Boolean(rc && rc.commission && rc.commission.length > 0);
    const matchedCount = rows.filter(r => r.rate_card_status === 'matched').length;
    const overchargedCount = rows.filter(r => r.rate_card_status === 'overcharged').length;
    const underchargedCount = rows.filter(r => r.rate_card_status === 'undercharged').length;
    const notConfiguredCount = rows.filter(r => r.rate_card_status === 'not_configured').length;

    const totalOvercharge = rows
      .filter(r => r.rate_card_status === 'overcharged')
      .reduce((s, r) => s + (r.commission_variance || 0), 0);

    const totalUndercharge = rows
      .filter(r => r.rate_card_status === 'undercharged')
      .reduce((s, r) => s + Math.abs(r.commission_variance || 0), 0);

    res.json({
      marketplace: mp,
      seller_account: account || 'all',
      rate_card_configured: configured,
      rules_count: rc?.commission?.length || 0,
      total_invoices: rows.length,
      matched_count: matchedCount,
      overcharged_count: overchargedCount,
      undercharged_count: underchargedCount,
      not_configured_count: notConfiguredCount,
      total_overcharge_amount: +totalOvercharge.toFixed(2),
      total_undercharge_amount: +totalUndercharge.toFixed(2),
      discrepancy_rows: rows.filter(r => r.rate_card_status === 'overcharged' || r.rate_card_status === 'undercharged'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /invoices/summary — aggregate across all/one marketplace(s)
router.get('/invoices/summary', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const mp      = req.query.marketplace;
    const account = str(req.query.seller_account);
    const where = []; const vals = [];
    if (mp)      where.push(`marketplace = $${vals.push(mp)}`);
    if (account) where.push(`seller_account = $${vals.push(account)}`);
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await getPool().query(`
      SELECT
        marketplace,
        COUNT(*)                                           AS invoice_count,
        COALESCE(SUM(invoice_amount),    0)               AS total_invoiced,
        COALESCE(SUM(commission_amount), 0)               AS commission,
        COALESCE(SUM(tds_amount),        0)               AS tds,
        COALESCE(SUM(other_deductions),  0)               AS other_deductions,
        COALESCE(SUM(net_payable),       0)               AS total_net_payable,
        COALESCE(SUM(amount_received),   0)               AS total_received,
        COALESCE(SUM(net_payable - amount_received), 0)   AS total_pending,
        SUM(CASE WHEN status='Pending'  THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status='Partial'  THEN 1 ELSE 0 END) AS partial_count,
        SUM(CASE WHEN status='Paid'     THEN 1 ELSE 0 END) AS paid_count,
        SUM(CASE WHEN status='Disputed' THEN 1 ELSE 0 END) AS disputed_count
      FROM mp_invoices ${wh}
      GROUP BY marketplace ORDER BY marketplace
    `, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /invoices — add single invoice row
router.post('/invoices', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const b = req.body;
    const marketplace = str(b.marketplace).toLowerCase();
    if (!marketplace) return res.status(400).json({ error: 'marketplace is required' });
    const pool = getPool();
    const sellerAccount = await resolveSellerAccount(pool, marketplace, b.seller_account);
    const parsed = parseInvoiceUploadRow(b, {
      marketplace,
      sellerAccount,
      batch: `manual-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    });
    if (parsed.error) throw inputError(parsed.error);
    const values = [...parsed.values, parsed.fingerprint];
    const placeholders = INVOICE_STORAGE_COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
    const { rows } = await pool.query(`
      INSERT INTO mp_invoices (${INVOICE_STORAGE_COLUMNS.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (source_fingerprint) WHERE source_fingerprint IS NOT NULL DO UPDATE
        SET ${INVOICE_UPSERT_UPDATE_SET}
      RETURNING id, (xmax = 0) AS inserted
    `, values);
    clearSkuSettlementBenchmarkCache(marketplace);
    res.json({ ok: true, id: rows[0].id, created: rows[0].inserted });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// PUT /invoices/:id — update (including mark as paid)
router.put('/invoices/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const b = req.body;
    const id = req.params.id;
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid invoice ID' });
    if (b.marketplace !== undefined || b.seller_account !== undefined) {
      throw inputError('Marketplace and seller account cannot be changed on an existing invoice. Create a new invoice instead.');
    }
    const pool = getPool();
    const existing = await pool.query(`SELECT * FROM mp_invoices WHERE id = $1`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    const current = existing.rows[0];
    const suppliedFields = Object.keys(b).filter(key => key !== 'marketplace' && key !== 'seller_account');
    if (!suppliedFields.length) return res.status(400).json({ error: 'Nothing to update' });

    const parsed = parseInvoiceUploadRow({ ...current, ...b }, {
      marketplace: current.marketplace,
      sellerAccount: current.seller_account,
      batch: current.upload_batch || `manual-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    });
    if (parsed.error) throw inputError(parsed.error);
    const record = [...parsed.values, parsed.fingerprint];
    const editableColumns = INVOICE_STORAGE_COLUMNS
      .filter(column => !['marketplace', 'seller_account'].includes(column));
    const values = editableColumns.map(column => record[INVOICE_STORAGE_COLUMNS.indexOf(column)]);
    const sets = editableColumns
      .map((column, index) => `${column} = $${index + 1}`)
      .concat('updated_at = NOW()');
    values.push(id);
    const result = await pool.query(
      `UPDATE mp_invoices SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING marketplace`,
      values,
    );
    clearSkuSettlementBenchmarkCache(result.rows[0].marketplace);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// DELETE /invoices/:id
router.delete('/invoices/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid invoice ID' });
    const { rows } = await getPool().query(`DELETE FROM mp_invoices WHERE id = $1 RETURNING marketplace`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Invoice not found' });
    if (rows[0]?.marketplace) clearSkuSettlementBenchmarkCache(rows[0].marketplace);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /invoices?marketplace=myntra&seller_account=myntra_vb — clear a scoped import
router.delete('/invoices', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  const mp = req.query.marketplace;
  if (!mp) return res.status(400).json({ error: 'marketplace required' });
  try {
    const account = str(req.query.seller_account);
    const { rowCount } = await getPool().query(
      `DELETE FROM mp_invoices WHERE marketplace = $1${account ? ' AND seller_account = $2' : ''}`,
      account ? [mp, account] : [mp]
    );
    clearSkuSettlementBenchmarkCache(mp);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /invoices/backfill-myntra — backfill orders table with Myntra settlement totals
router.post('/invoices/backfill-myntra', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const pool = getPool();
    const account = str(req.query.seller_account || req.body?.seller_account);
    const { ordersUpdated } = await backfillOrdersFromMyntraPayment(pool, account);
    await refreshOrderSettlementTotals(pool);
    res.json({ ok: true, ordersUpdated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /monthly-summary or /invoices/monthly-summary — Myntra month-wise settlement summary
const handleMonthlySummary = async (req, res) => {
  if (!(await isDbConfigured())) return res.json({ configured: false, data: [] });
  try {
    const pool = getPool();
    const marketplace = str(req.query.marketplace) || 'myntra';
    const sellerAcc = str(req.query.seller_account || req.query.sellerAccount) || 'all';

    const accountWhere = (sellerAcc && sellerAcc !== 'all') ? `AND seller_account = '${sellerAcc}'` : '';

    const [ordRes, nodRes, unsettleRes] = await Promise.all([
      pool.query(`
        SELECT
          TO_CHAR(payment_date, 'YYYY-MM') AS month,
          seller_account,
          COUNT(DISTINCT order_line_id) AS order_count,
          ROUND(SUM(CASE WHEN COALESCE(order_type, '') <> 'reverse' THEN invoice_amount ELSE 0 END)::numeric, 2) AS gross_sales,
          ROUND(SUM(CASE WHEN COALESCE(order_type, '') = 'reverse' THEN ABS(invoice_amount) ELSE 0 END)::numeric, 2) AS returns_amount,
          ROUND(SUM(CASE WHEN COALESCE(order_type, '') <> 'reverse' THEN invoice_amount ELSE -ABS(invoice_amount) END)::numeric, 2) AS net_sales,
          ROUND(SUM(COALESCE(commission_amount, 0))::numeric, 2) AS commission,
          ROUND(SUM(COALESCE(fixed_fee_amount, 0))::numeric, 2) AS fixed_fee,
          ROUND(SUM(CASE WHEN COALESCE(order_type, '') = 'reverse' THEN COALESCE(shipping_fee_amount, 0) ELSE 0 END)::numeric, 2) AS reverse_shipping,
          ROUND(SUM(COALESCE(pick_pack_fee_amount, 0))::numeric, 2) AS pick_pack_fee,
          ROUND(SUM(COALESCE(gateway_fee_amount, 0))::numeric, 2) AS gateway_fee,
          ROUND(SUM(COALESCE(tcs_amount, 0))::numeric, 2) AS tcs,
          ROUND(SUM(COALESCE(tds_amount, 0))::numeric, 2) AS tds,
          ROUND(SUM(COALESCE(gst_on_mp_fees, 0))::numeric, 2) AS gst_on_mp_fees,
          ROUND(SUM(amount_received)::numeric, 2) AS order_bank_received,
          COUNT(DISTINCT CASE WHEN COALESCE(order_type, '') <> 'reverse' THEN order_line_id END) AS forward_count,
          COUNT(DISTINCT CASE WHEN COALESCE(order_type, '') = 'reverse' THEN order_line_id END) AS return_count
        FROM mp_invoices
        WHERE marketplace = $1
          AND order_line_id IS NOT NULL
          AND COALESCE(order_type, '') <> 'nod'
          ${accountWhere}
        GROUP BY TO_CHAR(payment_date, 'YYYY-MM'), seller_account
        ORDER BY month DESC, seller_account
      `, [marketplace]),

      pool.query(`
        SELECT
          TO_CHAR(payment_date, 'YYYY-MM') AS month,
          seller_account,
          invoice_number,
          notes,
          amount_received
        FROM mp_invoices
        WHERE marketplace = $1
          AND payment_date IS NOT NULL
          AND (order_type = 'nod' OR notes ILIKE '%nod%' OR invoice_number ILIKE '%nod%')
          ${accountWhere}
        ORDER BY payment_date DESC
      `, [marketplace]),

      pool.query(`
        SELECT
          TO_CHAR(order_date, 'YYYY-MM') AS month,
          seller_account,
          COUNT(*) AS unsettled_count,
          ROUND(SUM(COALESCE(final_invoice_amount, 0))::numeric, 2) AS unsettled_amount
        FROM orders o
        WHERE marketplace = $1
          ${accountWhere}
          AND NOT EXISTS (
            SELECT 1 FROM mp_invoices i
            WHERE i.marketplace = o.marketplace
              AND i.seller_account = o.seller_account
              AND i.order_line_id = o.order_item_id
          )
        GROUP BY TO_CHAR(order_date, 'YYYY-MM'), seller_account
      `, [marketplace]),
    ]);

    const nodByMonth = {};
    for (const r of nodRes.rows) {
      const key = `${r.month}|${r.seller_account}`;
      if (!nodByMonth[key]) {
        nodByMonth[key] = {
          marketingMfb: 0,
          splitNod: 0,
          spf: 0,
          creditNotes: 0,
          other: 0,
          netNod: 0,
        };
      }
      const val = Number(r.amount_received || 0);
      const c = classifyMyntraNod(r.invoice_number, r.notes, val);
      nodByMonth[key].netNod += val;

      if (c.category === 'marketing' || c.category === 'mfb' || c.category === 'service_tax_invoice') {
        nodByMonth[key].marketingMfb += val;
      } else if (c.category === 'split_nod') {
        nodByMonth[key].splitNod += val;
      } else if (c.category === 'spf' || c.category === 'logistics_reimb') {
        nodByMonth[key].spf += val;
      } else if (c.category === 'credit_note') {
        nodByMonth[key].creditNotes += val;
      } else {
        nodByMonth[key].other += val;
      }
    }

    const unsettleByMonth = {};
    for (const u of unsettleRes.rows) {
      const key = `${u.month}|${u.seller_account}`;
      unsettleByMonth[key] = {
        count: Number(u.unsettled_count || 0),
        amount: Number(u.unsettled_amount || 0),
      };
    }

    const data = ordRes.rows.map(r => {
      const key = `${r.month}|${r.seller_account}`;
      const nod = nodByMonth[key] || { marketingMfb: 0, splitNod: 0, spf: 0, creditNotes: 0, other: 0, netNod: 0 };
      const unsettle = unsettleByMonth[key] || { count: 0, amount: 0 };

      const grossSales = Number(r.gross_sales || 0);
      const returns = Number(r.returns_amount || 0);
      const netSales = Number(r.net_sales || 0);
      const commission = Number(r.commission || 0);
      const fixedFee = Number(r.fixed_fee || 0);
      const reverseShipping = Number(r.reverse_shipping || 0);
      const pickPack = Number(r.pick_pack_fee || 0);
      const gateway = Number(r.gateway_fee || 0);
      const tcs = Number(r.tcs || 0);
      const tds = Number(r.tds || 0);
      const gst = Number(r.gst_on_mp_fees || 0);
      const totalOrderFees = Math.round((commission + fixedFee + reverseShipping + pickPack + gateway + tcs + tds + gst) * 100) / 100;

      const orderNetBank = Number(r.order_bank_received || 0);
      const netNod = Math.round(nod.netNod * 100) / 100;
      const totalBankSettled = Math.round((orderNetBank + netNod) * 100) / 100;

      return {
        month: r.month,
        seller_account: r.seller_account,
        seller_account_label: r.seller_account === 'myntra_ej' ? 'Myntra (EJ)' : 'Myntra (VB)',
        order_count: Number(r.order_count || 0),
        forward_count: Number(r.forward_count || 0),
        return_count: Number(r.return_count || 0),
        gross_sales: grossSales,
        returns_amount: returns,
        net_sales: netSales,
        commission,
        fixed_fee: fixedFee,
        reverse_shipping: reverseShipping,
        pick_pack_fee: pickPack,
        gateway_fee: gateway,
        tcs,
        tds,
        gst_on_mp_fees: gst,
        total_order_fees: totalOrderFees,
        order_bank_received: orderNetBank,
        marketing_mfb_deductions: Math.round(nod.marketingMfb * 100) / 100,
        split_nod_deductions: Math.round(nod.splitNod * 100) / 100,
        spf_reimbursements: Math.round(nod.spf * 100) / 100,
        credit_notes: Math.round(nod.creditNotes * 100) / 100,
        net_nod: netNod,
        total_bank_settled: totalBankSettled,
        unsettled_count: unsettle.count,
        unsettled_amount: unsettle.amount,
      };
    });

    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

router.get('/monthly-summary', handleMonthlySummary);
router.get('/invoices/monthly-summary', handleMonthlySummary);

// POST /invoices/upload?marketplace=myntra — Excel bulk upload
router.post('/invoices/upload', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mp = str(req.query.marketplace || req.body.marketplace).toLowerCase();
  if (!mp) return res.status(400).json({ error: 'marketplace query param required' });
  let pool;
  let sellerAccount = 'default';
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let skippedRows = [];
  try {
    pool = getPool();
    sellerAccount = await resolveSellerAccount(pool, mp, req.query.seller_account || req.body.seller_account, { required: mp === 'myntra' });
    const wb    = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws    = wb.Sheets[wb.SheetNames[0]];
    const raw   = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const batch = new Date().toISOString().replace(/[:.]/g, '-');
    if (!raw.length) throw inputError('The workbook has headers but no data rows. No data was saved.');
    if (mp === 'myntra') validateMyntraInvoiceSellerIds(raw, sellerAccount);

    const recordsByFingerprint = new Map();
    for (let index = 0; index < raw.length; index++) {
      const parsed = parseInvoiceUploadRow(raw[index], { marketplace: mp, sellerAccount, batch });
      if (parsed.error) {
        skipped++;
        skippedRows.push({ rowNum: index + 2, reason: parsed.error, data: raw[index] });
        continue;
      }
      if (recordsByFingerprint.has(parsed.fingerprint)) {
        skipped++;
        skippedRows.push({ rowNum: index + 2, reason: 'duplicate invoice line within this file', data: raw[index] });
        continue;
      }
      recordsByFingerprint.set(parsed.fingerprint, parsed.values);
    }

    const records = [...recordsByFingerprint.entries()].map(([fingerprint, values]) => [...values, fingerprint]);
    if (!records.length) throw inputError('No valid invoice rows were found. Review the skipped-row reasons and correct the file before retrying.');

    await forEachDbBatch(records, INVOICE_STORAGE_COLUMNS.length, async batchRows => {
      const values = [];
      const groups = batchRows.map(record => {
        const start = values.length;
        values.push(...record);
        return `(${record.map((_, column) => `$${start + column + 1}`).join(', ')})`;
      });
      const result = await pool.query(`
        INSERT INTO mp_invoices (${INVOICE_STORAGE_COLUMNS.join(', ')}) VALUES ${groups.join(', ')}
        ON CONFLICT (source_fingerprint) WHERE source_fingerprint IS NOT NULL DO UPDATE
          SET ${INVOICE_UPSERT_UPDATE_SET}
        RETURNING (xmax = 0) AS inserted
      `, values);
      for (const row of result.rows) {
        if (row.inserted) inserted++;
        else updated++;
      }
    });

    if (inserted || updated) {
      clearSkuSettlementBenchmarkCache(mp);
      void notifySkuSettlementBenchmarkAfterImport(pool, mp)
        .catch(error => console.warn('[sku settlement notification]', error.message));
    }
    // Myntra payments feed the unified_settlements view, so the per-order
    // settlement read model must be rebuilt exactly like Flipkart/Amazon do
    // after their settlement imports.
    if (mp === 'myntra' && (inserted || updated)) {
      const affectedOrderIds = raw.map(r => stripIdApostrophe(invoiceAlias(r, 'order_release_id', 'order_id', 'release_id'))).filter(Boolean);
      await backfillOrdersFromMyntraPayment(pool, sellerAccount, affectedOrderIds);
      await refreshOrderSettlementTotals(pool);
    }
    // Keep the Data Center history separate for Myntra EJ and VB even though
    // they share the same validated importer and database table.
    const logType = mp === 'myntra' ? `${sellerAccount}_invoices` : `${mp}_invoices`;
    const logId = await logUpload(
      pool, logType, req.file.originalname, mp, inserted, updated, skipped, 'ok',
    );
    await saveSkippedRows(pool, logId, skippedRows);
    res.json({
      ok: true, marketplace: mp, seller_account: sellerAccount,
      inserted, updated, skipped, total: raw.length, batch, logId,
    });
  } catch (e) {
    if (pool) {
      const logType = mp === 'myntra' ? `${sellerAccount}_invoices` : `${mp}_invoices`;
      const logId = await logUpload(pool, logType, req.file.originalname, mp, inserted, updated, skipped, 'error', e.message);
      await saveSkippedRows(pool, logId, skippedRows).catch(() => {});
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /invoices/template?marketplace=myntra — Excel download template
router.get('/invoices/template', async (req, res) => {
  const mp   = req.query.marketplace || 'marketplace';
  const hdrs = [
    'Invoice Number', 'Invoice Date', 'Dispatch Date', 'SKU', 'Product Title',
    'Quantity', 'MRP', 'Selling Price', 'Invoice Amount',
    'Commission %', 'Commission Amount', 'TDS %', 'TDS Amount', 'Other Deductions',
    'Net Payable', 'Amount Received', 'Payment Date', 'Payment Reference', 'Status', 'Notes',
  ];
  const sample = [
    'INV-2026-001', '2026-03-15', '2026-03-14', 'SKU123', 'Sample Product',
    1, 999, 799, 799,
    12, 95.88, 1, 7.99, 0,
    696.13, 696.13, '2026-04-05', 'NEFT123', 'Paid', '',
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([hdrs, sample]);
  ws['!cols'] = hdrs.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Invoice Upload');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${mp}-invoice-template.xlsx"`);
  res.send(buf);
});

// ══════════════════════════════════════════════════════════════════════════════
// LEDGER-BASED RECONCILIATION  (Zepto, etc.)
// ══════════════════════════════════════════════════════════════════════════════

// GET /ledger?marketplace=zepto&page=1
router.get('/ledger', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const pool = getPool();
    const mp = req.query.marketplace;
    const type = req.query.entry_type || '';
    const { page, pageSize, offset } = pagination(req.query, { defaultPageSize: 50, maxPageSize: 500 });

    const where = []; const vals = [];
    if (mp)   { where.push(`marketplace = $${vals.push(mp)}`); }
    if (type) { where.push(`entry_type  = $${vals.push(type)}`); }
    const wh = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows, cnt] = await Promise.all([
      pool.query(
        `SELECT * FROM mp_ledger_entries ${wh} ORDER BY entry_date DESC, id DESC LIMIT $${vals.push(pageSize)} OFFSET $${vals.push(offset)}`,
        vals
      ),
      pool.query(`SELECT COUNT(*) AS cnt FROM mp_ledger_entries ${wh}`, vals.slice(0, where.length)),
    ]);
    res.json({ data: rows.rows, total: +(cnt.rows[0].cnt || 0), page, pageSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /ledger/summary?marketplace=zepto
router.get('/ledger/summary', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    const mp  = req.query.marketplace;
    const wh  = mp ? `WHERE marketplace = $1` : '';
    const val = mp ? [mp] : [];
    const { rows } = await getPool().query(`
      SELECT
        marketplace,
        COUNT(*)                                             AS entry_count,
        COALESCE(SUM(credit), 0)                            AS total_credits,
        COALESCE(SUM(debit),  0)                            AS total_debits,
        COALESCE(SUM(credit) - SUM(debit), 0)              AS net_balance,
        MIN(entry_date)                                     AS from_date,
        MAX(entry_date)                                     AS to_date,
        COALESCE(SUM(CASE WHEN entry_type='Sale'       THEN credit  ELSE 0 END), 0) AS sale_credits,
        COALESCE(SUM(CASE WHEN entry_type='Return'     THEN debit   ELSE 0 END), 0) AS return_debits,
        COALESCE(SUM(CASE WHEN entry_type='Commission' THEN debit   ELSE 0 END), 0) AS commission_debits,
        COALESCE(SUM(CASE WHEN entry_type='Payment'    THEN credit  ELSE 0 END), 0) AS payment_credits,
        COALESCE(SUM(CASE WHEN entry_type='Penalty'    THEN debit   ELSE 0 END), 0) AS penalty_debits,
        SUM(CASE WHEN is_reconciled THEN 1 ELSE 0 END)     AS reconciled_count,
        SUM(CASE WHEN NOT is_reconciled THEN 1 ELSE 0 END) AS unreconciled_count
      FROM mp_ledger_entries ${wh}
      GROUP BY marketplace ORDER BY marketplace
    `, val);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ledger/upload?marketplace=zepto — Excel bulk upload
router.post('/ledger/upload', upload.single('file'), async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mp = str(req.query.marketplace || req.body.marketplace).toLowerCase();
  if (!mp) return res.status(400).json({ error: 'marketplace query param required' });
  let pool;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let skippedRows = [];
  try {
    pool = getPool();
    const wb    = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws    = wb.Sheets[wb.SheetNames[0]];
    const raw   = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const batch = new Date().toISOString().replace(/[:.]/g, '-');
    if (!raw.length) throw inputError('The workbook has headers but no data rows. No data was saved.');

    const recordsByFingerprint = new Map();
    for (let index = 0; index < raw.length; index++) {
      const parsed = parseLedgerUploadRow(raw[index], { marketplace: mp, batch });
      if (parsed.error) {
        skipped++;
        skippedRows.push({ rowNum: index + 2, reason: parsed.error, data: raw[index] });
        continue;
      }
      if (recordsByFingerprint.has(parsed.fingerprint)) {
        skipped++;
        skippedRows.push({ rowNum: index + 2, reason: 'duplicate ledger entry within this file', data: raw[index] });
        continue;
      }
      recordsByFingerprint.set(parsed.fingerprint, parsed.values);
    }
    const records = [...recordsByFingerprint.entries()].map(([fingerprint, values]) => [...values, fingerprint]);
    if (!records.length) throw inputError('No valid ledger rows were found. Review the skipped-row reasons and correct the file before retrying.');

    await forEachDbBatch(records, LEDGER_STORAGE_COLUMNS.length, async batchRows => {
      const values = [];
      const groups = batchRows.map(record => {
        const start = values.length;
        values.push(...record);
        return `(${record.map((_, column) => `$${start + column + 1}`).join(', ')})`;
      });
      const result = await pool.query(`
        INSERT INTO mp_ledger_entries (${LEDGER_STORAGE_COLUMNS.join(', ')}) VALUES ${groups.join(', ')}
        ON CONFLICT (source_fingerprint) WHERE source_fingerprint IS NOT NULL DO UPDATE
          SET ${LEDGER_UPSERT_UPDATE_SET}
        RETURNING (xmax = 0) AS inserted
      `, values);
      for (const row of result.rows) {
        if (row.inserted) inserted++;
        else updated++;
      }
    });
    const logId = await logUpload(pool, `${mp}_ledger`, req.file.originalname, mp, inserted, updated, skipped, 'ok');
    await saveSkippedRows(pool, logId, skippedRows);
    res.json({ ok: true, marketplace: mp, inserted, updated, skipped, total: raw.length, batch, logId });
  } catch (e) {
    if (pool) {
      const logId = await logUpload(pool, `${mp}_ledger`, req.file.originalname, mp, inserted, updated, skipped, 'error', e.message);
      await saveSkippedRows(pool, logId, skippedRows).catch(() => {});
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

// DELETE /ledger?marketplace=zepto — clear all ledger entries for a marketplace
router.delete('/ledger', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  const mp = req.query.marketplace;
  if (!mp) return res.status(400).json({ error: 'marketplace required' });
  try {
    const { rowCount } = await getPool().query(`DELETE FROM mp_ledger_entries WHERE marketplace = $1`, [mp]);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /ledger/template?marketplace=zepto — Excel download template
router.get('/ledger/template', async (req, res) => {
  const mp   = req.query.marketplace || 'marketplace';
  const hdrs = ['Date','Reference Number','Order ID','Description','Entry Type','Debit','Credit','Running Balance'];
  const types = [['Sale','Return','Commission','Payment','Penalty','Adjustment','Other']];
  const sample = [
    ['2026-03-01','REF001','ORD123','Sale of product','Sale',0,850,850],
    ['2026-03-01','REF002','ORD123','Commission deducted','Commission',85,0,765],
    ['2026-03-10','NEFT001','','Payment received','Payment',0,765,0],
  ];
  const wb  = XLSX.utils.book_new();
  const ws  = XLSX.utils.aoa_to_sheet([hdrs, ...sample]);
  ws['!cols'] = hdrs.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger Upload');
  const wsT = XLSX.utils.aoa_to_sheet([['Valid Entry Types'], ...types[0].map(t => [t])]);
  XLSX.utils.book_append_sheet(wb, wsT, 'Valid Values');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${mp}-ledger-template.xlsx"`);
  res.send(buf);
});

// PATCH /ledger/:id — mark reconciled / update notes
router.patch('/ledger/:id', async (req, res) => {
  if (!(await isDbConfigured())) return res.status(503).json({ error: 'DB not configured' });
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid ledger entry ID' });
    const { is_reconciled, notes, entry_type } = req.body;
    const sets = [], vals = [];
    if (is_reconciled !== undefined) {
      if (typeof is_reconciled !== 'boolean') throw inputError('is_reconciled must be true or false');
      sets.push(`is_reconciled = $${vals.push(is_reconciled)}`);
    }
    if (notes !== undefined) {
      if (typeof notes !== 'string' || notes.length > 4000) throw inputError('notes must be text up to 4000 characters');
      sets.push(`notes = $${vals.push(notes.trim())}`);
    }
    if (entry_type !== undefined) {
      const entryType = canonicalLedgerEntryType(entry_type);
      if (!entryType) throw inputError(`invalid entry type: ${entry_type}`);
      sets.push(`entry_type = $${vals.push(entryType)}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const result = await getPool().query(
      `UPDATE mp_ledger_entries SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING id`,
      vals,
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ledger entry not found' });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

export default router;
