import crypto from 'crypto';
import express from 'express';
import multer from 'multer';
// The package entry point (pdf-parse/index.js) only re-exports this file,
// plus a debug branch that reads a test PDF when it has no parent module.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getPool, isDbConfigured } from '../db/index.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { optionalNumber, optionalString } from '../utils/valueParsers.js';
import { forEachDbBatch } from '../utils/dbBatch.js';
import { logUpload } from '../services/uploadLog.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10, parts: 20 },
});

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite-preview-06-17', 'gemini-1.5-pro'];
const GEMINI_TIMEOUT_MS = 60_000;
// A real settlement statement carries a few KB of table text. Less means a
// scanned PDF with no text layer — the model would then invent figures (e.g.
// echo the prompt's example) that replace a month's statement. Far more is
// not a statement at all and would only burn tokens.
const MIN_STATEMENT_TEXT_CHARS = 200;
const MAX_STATEMENT_TEXT_CHARS = 200_000;

// A parsed statement waits here, unwritten, until the uploader reviews it and
// commits it. The API runs as a single container, so process memory is shared
// by every request; a restart drops pending previews and the PDF is uploaded
// again. Previews are single-use and bound to the user who uploaded them.
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_PREVIEWS = 50;
const pendingPreviews = new Map();

const STATEMENT_COLUMNS = ['month', 'period', 'description', 'credits', 'debits', 'net', 'amount', 'pct', 'category'];

class StatementInputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

async function parseWithAI(text) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const genAI = new GoogleGenerativeAI(apiKey);

  const prompt = `You are a financial data extraction assistant. Extract ALL line items from this Flipkart settlement statement.

The statement has a settled balance table with columns:
Description | Credits (Rs.) | Debits (Rs.) | Net Settled Amount (Rs.)

Return ONLY valid JSON:
{
  "period": "2026-01-01 to 2026-01-31",
  "month": "2026-01",
  "items": [
    { "description": "Sale Amount", "credits": 15305872.00, "debits": 0, "net": 15305872.00 }
  ],
  "totalSettled": 6556764.46
}

Rules:
1. Remove commas from Indian number formats.
2. Blank credit/debit cells are 0.
3. net equals credits minus debits exactly as shown in the statement.
4. Include every line item from the settled balance table.
5. month must be YYYY-MM from the statement period start date.
6. period must be the exact date range normalized as YYYY-MM-DD to YYYY-MM-DD.

Statement PDF text:
${text}`;

  let lastErr;
  for (const modelName of GEMINI_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName }, { timeout: GEMINI_TIMEOUT_MS });
      const result = await model.generateContent(prompt);
      const raw = result.response.text().trim();
      const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(jsonStr.startsWith('{') ? jsonStr : (jsonStr.match(/\{[\s\S]*\}/)?.[0] ?? '{}'));
      if (!parsed.items?.length) throw new Error('AI could not extract statement items; check that the PDF text is readable');
      console.log(`[statement] parsed with model: ${modelName}`);
      return parsed;
    } catch (err) {
      const is404 = err.message?.includes('404') || err.message?.includes('not found') || err.message?.includes('no longer available');
      if (is404) {
        console.warn(`[statement] model ${modelName} unavailable, trying next...`);
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`All Gemini models unavailable. Last error: ${lastErr?.message}`);
}

function categorize(desc) {
  const d = (desc || '').toLowerCase();
  if (d.includes('sale amount')) return 'Revenue';
  if (d.includes('refund') || d.includes('recall') || d.includes('reverse shipping')) return 'Return Cost';
  if (d.includes('commission') || d.includes('collection fee') || d.includes('pick') ||
      d.includes('franchise') || d.includes('storage') || d.includes('google ads') ||
      d.includes('wallet') || d.includes('fixed fee')) return 'Flipkart Fee';
  if (d.includes('tcs') || d.includes('tds') || d.includes('sgst') || d.includes('utgst') ||
      d.includes('cgst') || d.includes('igst')) return 'Tax';
  if (d.includes('offer') || d.includes('spf') || d.includes('sdd') || d.includes('ndd') ||
      d.includes('customer add') || d.includes('addon')) return 'Adjustment';
  if (d.includes('total')) return 'Total';
  return 'Other';
}

function statementNumber(value, label, { min = -1000000000, max = 1000000000 } = {}) {
  const number = optionalNumber(value);
  if (number == null || number < min || number > max) {
    throw new StatementInputError(`${label} must be a number from ${min} to ${max}.`);
  }
  return number;
}

function statementPeriod(value) {
  const match = String(value || '').trim().match(/^(\d{4}-\d{1,2}-\d{1,2})\s+to\s+(\d{4}-\d{1,2}-\d{1,2})$/i);
  if (!match) throw new StatementInputError('Statement period must be formatted as YYYY-MM-DD to YYYY-MM-DD.');
  const start = normalizeSqlDate(match[1]);
  const end = normalizeSqlDate(match[2]);
  if (!start || !end || end < start) throw new StatementInputError('Statement period contains an invalid date range.');
  return { start, end, period: `${start} to ${end}` };
}

export function parseStatementPayload(payload = {}) {
  const { start, period } = statementPeriod(payload.period);
  const month = optionalString(payload.month);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') || month !== start.slice(0, 7)) {
    throw new StatementInputError('Statement month must match the period start month (YYYY-MM).');
  }
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 500) {
    throw new StatementInputError('Statement must contain between 1 and 500 line items.');
  }
  const items = payload.items.map((item, index) => {
    const description = optionalString(item?.description);
    if (!description || description.length > 500) throw new StatementInputError(`Line ${index + 1} needs a description of 500 characters or fewer.`);
    const credits = statementNumber(item.credits, `Line ${index + 1} credits`, { min: 0 });
    const debits = statementNumber(item.debits, `Line ${index + 1} debits`, { min: 0 });
    const net = statementNumber(item.net, `Line ${index + 1} net`);
    if (Math.abs(net - (credits - debits)) > 0.05) {
      throw new StatementInputError(`Line ${index + 1} net must equal credits minus debits.`);
    }
    return { description, credits, debits, net };
  });
  const totalSettled = statementNumber(payload.totalSettled, 'Total settled');
  const saleItem = items.find(item => item.description.toLowerCase().includes('sale amount'));
  if (!saleItem || saleItem.net <= 0) throw new StatementInputError('Statement needs a positive Sale Amount line to calculate financial percentages.');
  return { month, period, items, totalSettled, saleAmount: saleItem.net };
}

// The model reads the PDF text and returns figures; nothing stops it from
// inventing, rounding, or "correcting" one. Every amount it returns must
// appear in the comma-stripped PDF text and every description in the text
// itself, or the row is flagged for the reviewer. Descriptions are compared
// without case, whitespace, or commas, which pdf-parse reflows inside table
// cells. Zero needs no proof: blank cells are 0.
function amountInText(amount, amountText) {
  if (amount === 0) return true;
  // String(1000) is a prefix of "1000.00" and String(1234.5) of "1234.50",
  // so the shortest form matches every rendering of the same figure.
  return amountText.includes(String(Math.abs(amount)));
}

function squashText(value) {
  return String(value ?? '').toLowerCase().replace(/[\s,]+/g, '');
}

export function checkStatementProvenance(parsed, pdfText) {
  const amountText = String(pdfText ?? '').replace(/,/g, '');
  const descriptionText = squashText(pdfText);
  const items = parsed.items.map(item => {
    const issues = [];
    if (!descriptionText.includes(squashText(item.description))) {
      issues.push('Description is not in the PDF text');
    }
    for (const [field, label] of [['credits', 'Credits'], ['debits', 'Debits'], ['net', 'Net']]) {
      if (!amountInText(item[field], amountText)) issues.push(`${label} ${item[field]} is not in the PDF text`);
    }
    return issues;
  });
  const totalSettled = amountInText(parsed.totalSettled, amountText)
    ? []
    : [`Total settled ${parsed.totalSettled} is not in the PDF text`];
  return { items, totalSettled };
}

function buildStatementRows(parsed) {
  // parseStatementPayload guarantees a positive Sale Amount.
  const pctOfSales = value => +((value / parsed.saleAmount) * 100).toFixed(2);
  const base = { month: parsed.month, period: parsed.period };
  const rows = parsed.items.map(item => ({
    ...base,
    description: item.description,
    credits: item.credits,
    debits: item.debits,
    net: item.net,
    pct: pctOfSales(item.net),
    category: categorize(item.description),
  }));
  rows.push({
    ...base,
    description: 'TOTAL SETTLED',
    credits: 0,
    debits: 0,
    net: parsed.totalSettled,
    pct: pctOfSales(parsed.totalSettled),
    category: 'Total',
  });
  return rows;
}

function previewOwner(req) {
  return req.user?.id || null;
}

function storePreview(preview) {
  const now = Date.now();
  for (const [id, entry] of pendingPreviews) {
    if (entry.expiresAt <= now) pendingPreviews.delete(id);
  }
  // A Map iterates in insertion order, so the first key is the oldest preview.
  while (pendingPreviews.size >= MAX_PENDING_PREVIEWS) {
    pendingPreviews.delete(pendingPreviews.keys().next().value);
  }
  const entry = { ...preview, id: crypto.randomUUID(), expiresAt: now + PREVIEW_TTL_MS };
  pendingPreviews.set(entry.id, entry);
  return entry;
}

function findPreview(id, owner) {
  const entry = pendingPreviews.get(String(id ?? ''));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    pendingPreviews.delete(entry.id);
    return null;
  }
  return entry.owner === owner ? entry : null;
}

async function countMonthRows(db, month) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM statements WHERE month = $1', [month]);
  return Number(rows[0]?.count) || 0;
}

// A month that already has rows is replaced only when the caller asks for it.
// The advisory lock keeps two commits for the same month from interleaving
// their DELETE and INSERTs.
async function writeStatementMonth(month, rows, { replace }) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`statements:${month}`]);
    const existingRows = await countMonthRows(client, month);
    if (existingRows > 0 && !replace) {
      await client.query('ROLLBACK');
      return { conflict: true, existingRows };
    }
    if (existingRows > 0) await client.query('DELETE FROM statements WHERE month = $1', [month]);
    await forEachDbBatch(rows, STATEMENT_COLUMNS.length, async batch => {
      const params = [];
      const tuples = batch.map(row => {
        const values = [row.month, row.period, row.description, row.credits, row.debits, row.net, row.net, row.pct, row.category];
        return `(${values.map(value => `$${params.push(value)}`).join(',')})`;
      });
      await client.query(`INSERT INTO statements (${STATEMENT_COLUMNS.join(',')}) VALUES ${tuples.join(',')}`, params);
    });
    await client.query('COMMIT');
    return { conflict: false, replacedRows: existingRows };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Step 1 of 2: parse the PDF and return what would be written, without writing
// anything. The reviewer commits the returned previewId with POST /commit.
router.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      return res.status(400).json({ error: 'GEMINI_API_KEY not configured in backend/.env' });
    }

    const pdfData = await pdfParse(req.file.buffer);
    const statementText = String(pdfData.text || '').trim();
    if (statementText.length < MIN_STATEMENT_TEXT_CHARS) {
      throw new StatementInputError('This PDF has no readable text (it may be a scanned image). Upload the statement PDF downloaded from the seller portal.');
    }
    if (statementText.length > MAX_STATEMENT_TEXT_CHARS) {
      throw new StatementInputError('This PDF is much larger than a settlement statement. Upload the monthly statement PDF only.');
    }
    const parsed = parseStatementPayload(await parseWithAI(statementText));
    const rows = buildStatementRows(parsed);
    const provenance = checkStatementProvenance(parsed, statementText);
    // One issue list per row; TOTAL SETTLED is the last row.
    const issues = [...provenance.items, provenance.totalSettled];
    const flaggedRows = issues.filter(list => list.length).length;
    const existingRows = await countMonthRows(getPool(), parsed.month);

    const preview = storePreview({
      owner: previewOwner(req),
      filename: req.file.originalname,
      month: parsed.month,
      period: parsed.period,
      rows,
      flaggedRows,
    });

    res.json({
      previewId: preview.id,
      expiresAt: new Date(preview.expiresAt).toISOString(),
      month: parsed.month,
      period: parsed.period,
      totalSettled: parsed.totalSettled,
      saleAmount: parsed.saleAmount,
      existingRows,
      monthExists: existingRows > 0,
      flaggedRows,
      items: rows.map((r, index) => ({
        description: r.description,
        credits: r.credits,
        debits: r.debits,
        net: r.net,
        pct: r.pct,
        category: r.category,
        issues: issues[index],
      })),
    });
  } catch (err) {
    try { await logUpload(getPool(), 'statement_pdf', req.file?.originalname, 'flipkart', 0, 0, 0, 'error', err.message); } catch {}
    console.error('[statement/upload]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Step 2 of 2: write a reviewed preview. Replacing a month that already has a
// statement needs replace=true, and saving rows that failed the provenance
// check needs acceptUnverified=true; both are explicit choices in the review UI.
router.post('/commit', async (req, res) => {
  const body = req.body || {};
  const preview = findPreview(body.previewId, previewOwner(req));
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
    if (!preview) {
      return res.status(404).json({ error: 'This statement preview has expired or was already saved. Upload the PDF again.' });
    }
    if (preview.committing) return res.status(409).json({ error: 'This statement is already being saved.' });
    if (preview.flaggedRows > 0 && body.acceptUnverified !== true) {
      return res.status(422).json({
        error: `${preview.flaggedRows} row${preview.flaggedRows === 1 ? '' : 's'} could not be matched to the PDF text. Check them against the PDF, then confirm to save anyway.`,
        flaggedRows: preview.flaggedRows,
      });
    }

    preview.committing = true;
    let result;
    try {
      result = await writeStatementMonth(preview.month, preview.rows, { replace: body.replace === true });
    } finally {
      preview.committing = false;
    }
    if (result.conflict) {
      return res.status(409).json({
        error: `A statement for ${preview.month} is already saved (${result.existingRows} rows). Confirm to replace it.`,
        month: preview.month,
        monthExists: true,
        existingRows: result.existingRows,
      });
    }
    pendingPreviews.delete(preview.id);
    const logId = await logUpload(getPool(), 'statement_pdf', preview.filename, 'flipkart', preview.rows.length, 0, 0, 'ok');

    res.json({
      success: true,
      month: preview.month,
      period: preview.period,
      rowsWritten: preview.rows.length,
      replacedRows: result.replacedRows,
      logId,
    });
  } catch (err) {
    try { await logUpload(getPool(), 'statement_pdf', preview?.filename, 'flipkart', 0, 0, 0, 'error', err.message); } catch {}
    console.error('[statement/commit]', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/data', async (req, res) => {
  try {
    if (!(await isDbConfigured())) return res.json({ months: [], data: [] });
    const pool = getPool();
    const result = await pool.query(`
      SELECT month, period, description, credits, debits, COALESCE(net, amount) AS net, pct, category
      FROM statements
      ORDER BY month, id
    `);

    const data = result.rows.map(r => ({
      month: r.month || '',
      period: r.period || '',
      description: r.description || '',
      credits: Number(r.credits) || 0,
      debits: Number(r.debits) || 0,
      net: Number(r.net) || 0,
      pct: Number(r.pct) || 0,
      category: r.category || 'Other',
    })).filter(r => r.month);

    const months = [...new Set(data.map(d => d.month))].sort();
    res.json({ months, data });
  } catch (err) {
    console.error('[statement/data]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
