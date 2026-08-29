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
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { pagination } from '../utils/requestParams.js';
import { optionalNumber, optionalString } from '../utils/valueParsers.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10, parts: 20 },
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
}) {
  const canonical = [marketplace, sellerAccount, invoiceNumber, invoiceDate, sku, paymentReference]
    .map(value => String(value ?? '').trim())
    .join('\u001f');
  return createHash('md5').update(canonical).digest('hex');
}

// Parse one invoice row before any write. This keeps a malformed finance cell
// from becoming 0 and then being treated as a valid, paid/partially-paid row.
export function parseInvoiceUploadRow(row, { marketplace, sellerAccount, batch }) {
  const invoiceNumber = str(invoiceAlias(row, 'invoice_number', 'invoice no', 'invoiceno', 'invoice#'));
  const rawInvoiceDate = invoiceAlias(row, 'invoice_date', 'invoicedate', 'date', 'dispatch_date', 'dispatchdate');
  const invoiceDate = strictDate(rawInvoiceDate);
  if (!invoiceNumber) return { error: 'invoice number is empty' };
  if (!invoiceDate) return { error: `invoice date is empty or invalid${hasValue(rawInvoiceDate) ? `: ${rawInvoiceDate}` : ''}` };

  const moneyFields = [
    ['invoice amount', invoiceAlias(row, 'invoice_amount', 'invoiceamount', 'sale_amount', 'saleamount', 'amount'), true],
    ['commission %', invoiceAlias(row, 'commission_pct', 'commission%', 'commissionpct', 'commissionrate'), false],
    ['commission amount', invoiceAlias(row, 'commission_amount', 'commissionamount', 'commission'), false],
    ['TDS %', invoiceAlias(row, 'tds_pct', 'tds%', 'tdspct', 'tdsrate'), false],
    ['TDS amount', invoiceAlias(row, 'tds_amount', 'tdsamount', 'tds'), false],
    ['other deductions', invoiceAlias(row, 'other_deductions', 'otherdeductions', 'deductions', 'other'), false],
    ['net payable', invoiceAlias(row, 'net_payable', 'netpayable', 'net'), false],
    ['amount received', invoiceAlias(row, 'amount_received', 'amountreceived', 'received', 'paid'), false],
    ['MRP', invoiceAlias(row, 'mrp'), false],
    ['selling price', invoiceAlias(row, 'selling_price', 'sellingprice', 'sp'), false],
  ];
  const parsed = {};
  for (const [label, raw, required] of moneyFields) {
    const result = invalidNumberLabel(label, raw, { required });
    if (result.error) return result;
    parsed[label] = result.value;
  }

  if (parsed['invoice amount'] <= 0) return { error: 'invoice amount must be greater than zero' };
  for (const label of ['commission %', 'commission amount', 'TDS %', 'TDS amount', 'other deductions', 'net payable', 'amount received', 'MRP', 'selling price']) {
    if (parsed[label] < 0) return { error: `${label} cannot be negative` };
  }
  for (const label of ['commission %', 'TDS %']) {
    if (parsed[label] > 100) return { error: `${label} cannot exceed 100` };
  }

  const rawQuantity = invoiceAlias(row, 'quantity', 'qty');
  const quantity = strictPositiveInteger(rawQuantity);
  if (quantity == null) return { error: `invalid quantity: ${rawQuantity}` };

  const rawDispatchDate = invoiceAlias(row, 'dispatch_date', 'dispatchdate');
  const dispatchDate = strictDate(rawDispatchDate);
  if (hasValue(rawDispatchDate) && !dispatchDate) return { error: `invalid dispatch date: ${rawDispatchDate}` };
  const rawPaymentDate = invoiceAlias(row, 'payment_date', 'paymentdate');
  const paymentDate = strictDate(rawPaymentDate);
  if (hasValue(rawPaymentDate) && !paymentDate) return { error: `invalid payment date: ${rawPaymentDate}` };

  const sku = str(invoiceAlias(row, 'sku', 'fsn', 'article_no', 'articleno'));
  const paymentReference = str(invoiceAlias(row, 'payment_reference', 'paymentreference', 'neft_id', 'utr', 'reference'));
  const commissionAmount = hasValue(moneyFields[2][1])
    ? parsed['commission amount']
    : parsed['invoice amount'] * parsed['commission %'] / 100;
  const tdsAmount = hasValue(moneyFields[4][1])
    ? parsed['TDS amount']
    : parsed['invoice amount'] * parsed['TDS %'] / 100;
  const netPayable = hasValue(moneyFields[6][1])
    ? parsed['net payable']
    : parsed['invoice amount'] - commissionAmount - tdsAmount - parsed['other deductions'];
  const amountReceived = parsed['amount received'];
  if (netPayable < 0) return { error: 'net payable cannot be negative' };
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

  return {
    fingerprint: invoiceSourceFingerprint({
      marketplace,
      sellerAccount,
      invoiceNumber,
      invoiceDate,
      sku,
      paymentReference,
    }),
    values: [
      marketplace, sellerAccount, invoiceNumber, invoiceDate, dispatchDate, sku,
      str(invoiceAlias(row, 'product_title', 'product', 'product_name', 'productname', 'title', 'description')),
      quantity, parsed.MRP, parsed['selling price'], parsed['invoice amount'], parsed['commission %'], commissionAmount,
      parsed['TDS %'], tdsAmount, parsed['other deductions'], netPayable, amountReceived,
      paymentDate, paymentReference, status, str(invoiceAlias(row, 'notes', 'remarks', 'remark')), batch,
    ],
  };
}

const INVOICE_STORAGE_COLUMNS = [
  'marketplace', 'seller_account', 'invoice_number', 'invoice_date', 'dispatch_date', 'sku', 'product_title',
  'quantity', 'mrp', 'selling_price', 'invoice_amount', 'commission_pct', 'commission_amount',
  'tds_pct', 'tds_amount', 'other_deductions', 'net_payable', 'amount_received',
  'payment_date', 'payment_reference', 'status', 'notes', 'upload_batch', 'source_fingerprint',
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
