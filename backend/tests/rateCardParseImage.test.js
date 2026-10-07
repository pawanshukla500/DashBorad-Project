import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

const state = vi.hoisted(() => ({ statements: [], aiSlabs: [], aiCalls: [] }));

vi.mock('../db/index.js', () => {
  const run = async (text, params) => {
    state.statements.push({ sql: String(text).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
  return {
    isDbConfigured: async () => true,
    getPool: () => ({ query: run, connect: async () => ({ query: run, release: () => {} }) }),
  };
});

// Never call the real Gemini API: the "model" returns the test's slabs.
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return {
        generateContent: async parts => {
          state.aiCalls.push(parts);
          return { response: { text: () => JSON.stringify({ slabs: state.aiSlabs }) } };
        },
      };
    }
  },
}));

const { default: rateCardRouter, MAX_PARSE_IMAGE_BASE64_CHARS } = await import('../routes/rateCard.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(24)]).toString('base64');

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
  state.aiSlabs = [];
  state.aiCalls = [];
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/rate-card', rateCardRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise(resolve => server.close(resolve)));

async function post(path, body) {
  const res = await fetch(`${baseUrl}/api/rate-card${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('rate-card screenshot parser input', () => {
  it('accepts PNG, JPEG and WebP screenshots whose bytes match the declared type', async () => {
    for (const [mimeType, imageBase64] of [['image/png', PNG], ['image/jpeg', JPEG], ['image/webp', WEBP], ['IMAGE/PNG', PNG]]) {
      const { status } = await post('/parse-image', { imageBase64, mimeType, type: 'commission' });
      expect(status, mimeType).toBe(200);
    }
    expect(state.aiCalls).toHaveLength(4);
    expect(state.aiCalls[3][1].inlineData.mimeType).toBe('image/png');
  });

  it('rejects other types, mismatched bytes, non-base64 data, and oversized images before calling the model', async () => {
    const cases = [
      [{ imageBase64: PNG, mimeType: 'image/gif' }, 400, 'PNG, JPEG, or WebP'],
      [{ imageBase64: PNG, mimeType: 'application/pdf' }, 400, 'PNG, JPEG, or WebP'],
      [{ imageBase64: PNG, mimeType: 'image/svg+xml' }, 400, 'PNG, JPEG, or WebP'],
      [{ imageBase64: JPEG, mimeType: 'image/png' }, 400, 'not a PNG file'],
      [{ imageBase64: Buffer.from('%PDF-1.7 not an image').toString('base64'), mimeType: 'image/jpeg' }, 400, 'not a JPEG file'],
      [{ imageBase64: `${PNG}<script>`, mimeType: 'image/png' }, 400, 'base64'],
      [{ imageBase64: 'A'.repeat(MAX_PARSE_IMAGE_BASE64_CHARS + 4), mimeType: 'image/png' }, 413, 'too large'],
      [{ mimeType: 'image/png' }, 400, 'No image provided'],
      [{ imageBase64: PNG }, 400, 'MIME type is required'],
    ];
    for (const [body, status, message] of cases) {
      const res = await post('/parse-image', { type: 'commission', ...body });
      expect(res.status, message).toBe(status);
      expect(res.body.error).toContain(message);
    }
    expect(state.aiCalls).toHaveLength(0);
  });

  it('returns a range check for every parsed slab, in slab order', async () => {
    state.aiSlabs = [
      { brand_name: null, price_min: 0, price_max: 300, rate: 0.14 },
      { brand_name: null, price_min: 300, price_max: null, rate: 14 },
      { brand_name: null, price_min: -5, price_max: 100, rate: 0.1 },
    ];
    const { status, body } = await post('/parse-image', { imageBase64: PNG, mimeType: 'image/png', type: 'commission' });

    expect(status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.slabs[1]).toMatchObject({ price_min: 300, price_max: null, rate: 14 });
    expect(body.checks).toHaveLength(3);
    expect(body.checks[0]).toEqual({ errors: [], warnings: [] });
    expect(body.checks[1].errors).toEqual([]);
    expect(body.checks[1].warnings[0]).toContain('enter 0.14 if you meant 14%');
    expect(body.checks[2].errors).toEqual(['price_min must be 0 or more']);
  });

  it('asks the model for franchise fees in rupees, matching how they are stored and charged', async () => {
    await post('/parse-image', { imageBase64: PNG, mimeType: 'image/png', type: 'franchise_fee' });
    const prompt = state.aiCalls[0][0].text;
    expect(prompt).toContain('rate (flat rupee amount per order');
    expect(prompt).not.toContain('0.02 = 2%');
  });
});

describe('rate-card save-period range checks', () => {
  const period = { marketplace: 'flipkart', seller_account: 'default', category: 'kurta', start_date: '2026-10-01', end_date: null };
  const inserts = () => state.statements.filter(s => s.sql.startsWith('INSERT'));

  it('saves an implausible but storable row and returns its warning', async () => {
    const { status, body } = await post('/config/commission/save-period', {
      ...period,
      replaceIds: ['17'],
      rows: [{ brand_name: '', price_min: 0, price_max: 500, rate: 0.12 }, { brand_name: '', price_min: 501, price_max: 999999, rate: 14 }],
    });

    expect(status).toBe(200);
    expect(body.inserted).toBe(2);
    expect(body.rowWarnings).toHaveLength(1);
    expect(body.rowWarnings[0].row).toBe(2);
    expect(body.rowWarnings[0].warnings[0]).toContain('above 1');
    expect(state.statements.at(-1).sql).toBe('COMMIT');
  });

  it('stores an open-ended (null) price_max as 999999 instead of NULL', async () => {
    const { status } = await post('/config/commission/save-period', {
      ...period,
      rows: [{ brand_name: '', price_min: 500, price_max: null, rate: 0.1 }],
    });

    expect(status).toBe(200);
    // category, start_date, end_date, marketplace, seller_account, brand_name, price_min, price_max, rate
    expect(inserts()[0].params).toEqual(['kurta', '2026-10-01', null, 'flipkart', 'default', '', 500, 999999, 0.1]);
  });

  it('stores collection types in lower case and rejects unknown types without writing', async () => {
    const ok = await post('/config/collection_fee/save-period', {
      ...period,
      rows: [{ fulfilment_type: 'All', price_min: 0, price_max: 500, prepaid: 0.01, prepaid_type: 'PCT', postpaid: 15, postpaid_type: 'FLAT' }],
    });
    expect(ok.status).toBe(200);
    expect(inserts()[0].params.slice(-2)).toEqual(['pct', 'flat']);

    state.statements = [];
    const refused = await post('/config/collection_fee/save-period', {
      ...period,
      rows: [{ fulfilment_type: 'All', prepaid: 2, prepaid_type: 'percent', postpaid: 0, postpaid_type: 'pct' }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('Row 1: prepaid_type must be "pct" or "flat"');
    expect(state.statements).toHaveLength(0);
  });

  it('rejects a negative price bound', async () => {
    const { status, body } = await post('/config/fixed_fee/save-period', {
      ...period,
      rows: [{ fulfilment_type: 'Silver', price_min: -1, price_max: 500, rate: 6 }],
    });
    expect(status).toBe(400);
    expect(body.error).toBe('Row 1: price_min must be 0 or more');
    expect(state.statements).toHaveLength(0);
  });
});
