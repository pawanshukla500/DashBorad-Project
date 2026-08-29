import { GoogleGenerativeAI } from '@google/generative-ai';

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const DATE_FORMAT_LABELS = {
  DMY: 'DD/MM/YYYY',
  MDY: 'MM/DD/YYYY',
  YMD: 'YYYY/MM/DD',
  DMY_MON: 'DD-MMM-YYYY',
  MON_DMY: 'MMM-DD-YYYY',
  EXCEL: 'Excel date',
  ISO: 'YYYY-MM-DD',
};

function isBlank(v) {
  return v === null || v === undefined || v === '' || v === 'NA' || v === 'N/A' || v === '-';
}

function clean(v) {
  return (v ?? '')
    .toString()
    .trim()
    .replace(/\u00a0/g, ' ')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ');
}

function twoDigitYear(y) {
  const n = Number(y);
  if (n >= 100) return n;
  return n >= 70 ? 1900 + n : 2000 + n;
}

function dateFromParts(year, month, day) {
  const y = twoDigitYear(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Validate calendar (e.g. Feb 30 is invalid)
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  // Return YYYY-MM-DD string — avoids timezone shift when pg driver converts Date objects
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function excelSerialToDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  const utc = Math.round((n - 25569) * 86400000);
  const d = new Date(utc);
  if (isNaN(d)) return null;
  return dateFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function monthNumber(token) {
  return MONTHS[(token || '').toLowerCase().replace(/\./g, '')] || null;
}

function stripTime(s) {
  return s
    .replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, '')
    .replace(/T\d{2}:\d{2}:\d{2}.*$/i, '')
    .trim();
}

function parseMonthNameDate(s) {
  const value = stripTime(clean(s));
  let m = value.match(/^(\d{1,2})[-/ .]([A-Za-z]{3,9})[-/ .,]*(\d{2,4})$/);
  if (m) return dateFromParts(m[3], monthNumber(m[2]), m[1]);
  m = value.match(/^([A-Za-z]{3,9})[-/ .](\d{1,2})[-/ ,]*(\d{2,4})$/);
  if (m) return dateFromParts(m[3], monthNumber(m[1]), m[2]);
  return null;
}

function parseNumericDate(s, format) {
  const value = stripTime(clean(s));
  const m = value.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (!m) return null;

  const [, a, b, c] = m;
  if (format === 'YMD') return dateFromParts(a, b, c);
  if (format === 'MDY') return dateFromParts(c, a, b);
  return dateFromParts(c, b, a);
}

function inferLocalFormat(sample) {
  if (sample instanceof Date) return { format: 'EXCEL', confidence: 1, source: 'excel' };
  if (typeof sample === 'number' || (typeof sample === 'string' && /^\d{5}$/.test(sample.trim()))) return { format: 'EXCEL', confidence: 1, source: 'excel' };

  const s = stripTime(clean(sample));
  if (!s) return null;

  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) return { format: 'ISO', confidence: 1, source: 'local' };
  if (parseMonthNameDate(s)) {
    if (/^\d/.test(s)) return { format: 'DMY_MON', confidence: 1, source: 'local' };
    return { format: 'MON_DMY', confidence: 1, source: 'local' };
  }

  const m = s.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  if (m[1].length === 4) return { format: 'YMD', confidence: 1, source: 'local' };
  if (m[3].length !== 2 && m[3].length !== 4) return null;
  if (a > 12 && a <= 31) return { format: 'DMY', confidence: 1, source: 'local' };
  if (b > 12 && b <= 31) return { format: 'MDY', confidence: 1, source: 'local' };

  return { format: 'DMY', confidence: 0.55, source: 'default-dmy', ambiguous: true };
}

function parseJsonObject(text) {
  const cleaned = (text || '').trim().replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
  const body = cleaned.startsWith('{') ? cleaned : cleaned.match(/\{[\s\S]*\}/)?.[0];
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

async function inferWithGemini(header, sample) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') return null;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_DATE_MODEL || 'gemini-2.5-flash' });
  const prompt = `Identify the date format used by this one uploaded file column sample.

Column header: ${header}
Sample value: ${sample}

Return only JSON:
{"format":"DMY|MDY|YMD|DMY_MON|MON_DMY|ISO|UNKNOWN","confidence":0.0}

Use DMY for Indian-style day/month/year dates.`;

  const result = await model.generateContent(prompt);
  const parsed = parseJsonObject(result.response.text());
  const format = parsed?.format;
  if (!DATE_FORMAT_LABELS[format] && format !== 'UNKNOWN') return null;
  if (format === 'UNKNOWN') return null;
  return {
    format,
    confidence: Number(parsed.confidence) || 0.75,
    source: 'gemini',
  };
}

export function normalizeSqlDate(value, hint = null) {
  if (isBlank(value)) return null;
  if (value instanceof Date) {
    return isNaN(value) ? null : dateFromParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{5}$/.test(value.trim()))) return excelSerialToDate(Number(value));

  const s = clean(value);
  if (!s) return null;

  const monthName = parseMonthNameDate(s);
  if (monthName) return monthName;

  const format = hint?.format;
  if (format === 'EXCEL') return excelSerialToDate(s);
  if (format === 'ISO') {
    const m = stripTime(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? dateFromParts(m[1], m[2], m[3]) : null;
  }
  if (format === 'YMD' || format === 'MDY' || format === 'DMY') {
    return parseNumericDate(s, format);
  }

  const inferred = inferLocalFormat(s);
  if (inferred?.format === 'EXCEL') return excelSerialToDate(s);
  if (inferred?.format === 'ISO') {
    const m = stripTime(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? dateFromParts(m[1], m[2], m[3]) : null;
  }
  if (inferred?.format) return parseNumericDate(s, inferred.format);
  return null;
}

export async function buildDateFormatMap({ rows, dateFields, valueFor }) {
  const map = {};
  for (const field of dateFields) {
    const key = typeof field === 'string' ? field : field.key;
    const label = typeof field === 'string' ? field : (field.label || field.key);
    const sample = rows.map(row => valueFor(row, key)).find(v => !isBlank(v));
    if (!sample) {
      map[key] = { format: null, source: 'empty', sample: null };
      continue;
    }

    const local = inferLocalFormat(sample);
    if (local && !local.ambiguous) {
      map[key] = { ...local, sample, label };
      continue;
    }

    try {
      const gemini = await inferWithGemini(label, sample);
      map[key] = { ...(gemini || local || { format: 'DMY', confidence: 0.5, source: 'default-dmy' }), sample, label };
    } catch (e) {
      map[key] = { ...(local || { format: 'DMY', confidence: 0.5, source: 'default-dmy' }), sample, label, warning: e.message };
    }
  }
  return map;
}

export function summarizeDateFormats(formatMap) {
  return Object.fromEntries(Object.entries(formatMap || {}).map(([key, info]) => [
    key,
    {
      sample: info.sample ?? null,
      format: info.format ? (DATE_FORMAT_LABELS[info.format] || info.format) : null,
      source: info.source || 'unknown',
      confidence: info.confidence ?? null,
    },
  ]));
}
