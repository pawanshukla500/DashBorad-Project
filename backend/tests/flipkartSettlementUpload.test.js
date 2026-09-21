import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', async importOriginal => ({
  ...(await importOriginal()),
  isDbConfigured: async () => true,
  getPool: () => {
    throw new Error('No database in this test');
  },
}));

const { default: router } = await import('../routes/flipkartSettlement.js');

const postUpload = router.stack
  .find(layer => layer.route?.path === '/' && layer.route.methods.post)
  .route.stack.at(-1).handle;

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function upload(sheetKey) {
  const res = fakeResponse();
  await postUpload({ body: { sheetKey }, file: { buffer: Buffer.alloc(0), originalname: 'settlement.xlsx' } }, res);
  return res;
}

describe('Flipkart settlement upload', () => {
  it.each(['bogus', 'Orders', ['orders']])('rejects sheetKey %j before starting an import', async (sheetKey) => {
    const res = await upload(sheetKey);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Unknown sheetKey/);
  });

  it.each([undefined, '', 'all', 'orders', 'spf', 'storage', 'ads', 'google_ads'])(
    'starts an import for sheetKey %j',
    async (sheetKey) => {
      const res = await upload(sheetKey);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ status: 'started' });
    },
  );
});
