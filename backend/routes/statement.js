import express from 'express';
import multer from 'multer';
import { createRequire } from 'module';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getPool, isDbConfigured } from '../db/index.js';
import { normalizeSqlDate } from '../utils/dateNormalizer.js';
import { optionalNumber, optionalString } from '../utils/valueParsers.js';
import { logUpload } from '../services/uploadLog.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10, parts: 20 },
});

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite-preview-06-17', 'gemini-1.5-pro'];

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
      const model = genAI.getGenerativeModel({ model: modelName });
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

async function replaceMonthData(month, rows) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM statements WHERE month = $1', [month]);
    for (const row of rows) {
      await client.query(
        `INSERT INTO statements (month,period,description,credits,debits,net,amount,pct,category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [row.month, row.period, row.description, row.credits, row.debits, row.net, row.net, row.pct, row.category]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

router.post('/upload', upload.single('pdf'), async (req, res) => {
  let logId = null;
  try {
    if (!(await isDbConfigured())) return res.status(503).json({ error: 'Database not configured' });
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      return res.status(400).json({ error: 'GEMINI_API_KEY not configured in backend/.env' });
    }

    const pdfData = await pdfParse(req.file.buffer);
    const parsed = parseStatementPayload(await parseWithAI(pdfData.text));
    const saleAmt = parsed.saleAmount;

    const rows = parsed.items.map(item => {
      const net = item.net;
      const pct = saleAmt !== 0 ? +((net / saleAmt) * 100).toFixed(2) : 0;
      return {
        month: parsed.month,
        period: parsed.period,
        description: item.description,
        credits: item.credits,
        debits: item.debits,
        net,
        pct,
        category: categorize(item.description),
      };
    });

    const totalSettled = parsed.totalSettled;
    const totalPct = saleAmt !== 0 ? +((totalSettled / saleAmt) * 100).toFixed(2) : 0;
    rows.push({
      month: parsed.month,
      period: parsed.period,
      description: 'TOTAL SETTLED',
      credits: 0,
      debits: 0,
      net: totalSettled,
      pct: totalPct,
      category: 'Total',
    });

    await replaceMonthData(parsed.month, rows);
    logId = await logUpload(getPool(), 'statement_pdf', req.file.originalname, 'flipkart', rows.length, 0, 0, 'ok');

    res.json({
      success: true,
      month: parsed.month,
      period: parsed.period,
      rowsWritten: rows.length,
      totalSettled,
      saleAmount: saleAmt,
      logId,
      items: rows.map(r => ({
        description: r.description,
        credits: r.credits,
        debits: r.debits,
        net: r.net,
        pct: r.pct,
        category: r.category,
      })),
    });
  } catch (err) {
    try { await logUpload(getPool(), 'statement_pdf', req.file?.originalname, 'flipkart', 0, 0, 0, 'error', err.message); } catch {}
    console.error('[statement/upload]', err);
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
