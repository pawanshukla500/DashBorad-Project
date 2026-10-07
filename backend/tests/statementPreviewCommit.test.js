import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

// Shared state for the mocks below (vi.mock factories are hoisted).
const state = vi.hoisted(() => ({
  statements: [],
  existingRows: 0,
  pdfText: '',
  aiPayload: null,
  aiCalls: 0,
}));

vi.mock('../db/index.js', () => {
  const run = async (text, params) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    state.statements.push({ sql, params });
    if (/^SELECT COUNT/i.test(sql)) return { rows: [{ count: state.existingRows }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return {
    isDbConfigured: async () => true,
    getPool: () => ({ query: run, connect: async () => ({ query: run, release: () => {} }) }),
  };
});

vi.mock('../services/uploadLog.js', () => ({ logUpload: vi.fn(async () => 42) }));

vi.mock('pdf-parse/lib/pdf-parse.js', () => ({
  default: vi.fn(async () => ({ text: state.pdfText })),
}));

// Never call the real Gemini API: the "model" returns the test's payload.
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        generateContent: async () => {
          state.aiCalls += 1;
          return { response: { text: () => JSON.stringify(state.aiPayload) } };
        },
      };
    }
  },
}));

const { default: statementRouter } = await import('../routes/statement.js');

const PDF_TEXT = `Flipkart Seller Settlement Statement
Statement Period: 01 Aug 2026 - 31 Aug 2026
Settled Balance
Description Credits (Rs.) Debits (Rs.) Net Settled Amount (Rs.)
Sale Amount 1,53,05,872.00 1,53,05,872.00
Commission
Fee 12,450.50 -12,450.50
Collection Fee 3,210.00 -3,210.00
Total Settled 1,52,90,211.50
This is a system generated statement and does not require a signature.`;

const AI_PAYLOAD = {
  period: '2026-08-01 to 2026-08-31',
  month: '2026-08',
  items: [
    { description: 'Sale Amount', credits: 15305872, debits: 0, net: 15305872 },
    { description: 'Commission Fee', credits: 0, debits: 12450.5, net: -12450.5 },
    { description: 'Collection Fee', credits: 0, debits: 3210, net: -3210 },
  ],
  totalSettled: 15290211.5,
};

let server;
let baseUrl;
let savedKey;

beforeAll(() => {
  savedKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
});

beforeEach(async () => {
  state.statements = [];
  state.existingRows = 0;
  state.pdfText = PDF_TEXT;
  state.aiPayload = structuredClone(AI_PAYLOAD);
  state.aiCalls = 0;
  const app = express();
  app.use(express.json());
  // Stand-in for authMiddleware: the header picks the signed-in user.
  app.use((req, res, next) => {
    req.user = { id: req.get('x-test-user') || 'user-a' };
    next();
  });
  app.use('/api/statement', statementRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise(resolve => server.close(resolve)));

async function uploadPdf(user = 'user-a') {
  const form = new FormData();
  form.append('pdf', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'aug-statement.pdf');
  const res = await fetch(`${baseUrl}/api/statement/upload`, {
    method: 'POST', body: form, headers: { 'x-test-user': user },
  });
  return { status: res.status, body: await res.json() };
}

async function commit(body, user = 'user-a') {
  const res = await fetch(`${baseUrl}/api/statement/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const writes = () => state.statements.filter(s => /^(INSERT|DELETE|BEGIN|COMMIT)/i.test(s.sql));

describe('statement PDF upload: preview, then commit', () => {
  it('returns the parsed rows without writing anything', async () => {
    const { status, body } = await uploadPdf();

    expect(status).toBe(200);
    expect(state.aiCalls).toBe(1);
    expect(body).toMatchObject({
      month: '2026-08', period: '2026-08-01 to 2026-08-31',
      saleAmount: 15305872, totalSettled: 15290211.5,
      monthExists: false, existingRows: 0, flaggedRows: 0,
    });
    expect(body.previewId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.items.map(i => i.description)).toEqual(['Sale Amount', 'Commission Fee', 'Collection Fee', 'TOTAL SETTLED']);
    expect(body.items.every(i => i.issues.length === 0)).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('writes the reviewed rows in one batched insert on commit, once', async () => {
    const { body: preview } = await uploadPdf();
    state.statements = [];

    const { status, body } = await commit({ previewId: preview.previewId });

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, month: '2026-08', rowsWritten: 4, replacedRows: 0, logId: 42 });
    const sql = state.statements.map(s => s.sql);
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('pg_advisory_xact_lock');
    expect(sql.some(s => s.startsWith('DELETE'))).toBe(false);
    const inserts = state.statements.filter(s => s.sql.startsWith('INSERT INTO statements'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toHaveLength(4 * 9);
    expect(inserts[0].params.slice(0, 9)).toEqual([
      '2026-08', '2026-08-01 to 2026-08-31', 'Sale Amount', 15305872, 0, 15305872, 15305872, 100, 'Revenue',
    ]);
    expect(sql.at(-1)).toBe('COMMIT');

    // A preview is single-use.
    expect((await commit({ previewId: preview.previewId })).status).toBe(404);
  });

  it('refuses to overwrite a saved month unless replace=true is sent', async () => {
    state.existingRows = 12;
    const { body: preview } = await uploadPdf();
    expect(preview).toMatchObject({ monthExists: true, existingRows: 12 });
    state.statements = [];

    for (const replace of [undefined, false, 'true']) {
      const refused = await commit({ previewId: preview.previewId, replace });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ monthExists: true, existingRows: 12, month: '2026-08' });
    }
    expect(state.statements.some(s => /^(DELETE|INSERT)/.test(s.sql))).toBe(false);
    expect(state.statements.filter(s => s.sql === 'ROLLBACK')).toHaveLength(3);

    state.statements = [];
    const { status, body } = await commit({ previewId: preview.previewId, replace: true });
    expect(status).toBe(200);
    expect(body.replacedRows).toBe(12);
    const sql = state.statements.map(s => s.sql);
    expect(sql.indexOf('DELETE FROM statements WHERE month = $1')).toBeLessThan(sql.findIndex(s => s.startsWith('INSERT')));
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('flags rows whose figures or descriptions are not in the PDF text and needs acceptUnverified to save them', async () => {
    // The model transposed the commission digits and invented a line.
    state.aiPayload.items[1] = { description: 'Commission Fee', credits: 0, debits: 12540.5, net: -12540.5 };
    state.aiPayload.items.push({ description: 'Platform Bonus', credits: 0, debits: 0, net: 0 });
    state.aiPayload.totalSettled = 15290121.5;

    const { status, body: preview } = await uploadPdf();
    expect(status).toBe(200);
    expect(preview.flaggedRows).toBe(3);
    expect(preview.items[1].issues).toEqual([
      'Debits 12540.5 is not in the PDF text',
      'Net -12540.5 is not in the PDF text',
    ]);
    expect(preview.items[3].issues).toEqual(['Description is not in the PDF text']);
    expect(preview.items.at(-1).issues).toEqual(['Total settled 15290121.5 is not in the PDF text']);

    state.statements = [];
    const refused = await commit({ previewId: preview.previewId });
    expect(refused.status).toBe(422);
    expect(refused.body.flaggedRows).toBe(3);
    expect(writes()).toEqual([]);

    expect((await commit({ previewId: preview.previewId, acceptUnverified: true })).status).toBe(200);
  });

  it('lets only the uploader commit a preview', async () => {
    const { body: preview } = await uploadPdf('user-a');
    state.statements = [];

    expect((await commit({ previewId: preview.previewId }, 'user-b')).status).toBe(404);
    expect(writes()).toEqual([]);
    expect((await commit({ previewId: preview.previewId }, 'user-a')).status).toBe(200);
  });

  it('rejects a PDF with no text layer before calling the model', async () => {
    state.pdfText = '   ';
    const { status, body } = await uploadPdf();
    expect(status).toBe(400);
    expect(body.error).toContain('no readable text');
    expect(state.aiCalls).toBe(0);
  });
});
