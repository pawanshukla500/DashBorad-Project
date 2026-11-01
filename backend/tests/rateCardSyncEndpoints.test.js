import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

vi.mock('../db/index.js', () => ({
  isDbConfigured: async () => true,
  getPool: () => ({
    query: vi.fn(async (text) => {
      if (text.includes('rate_card_versions')) {
        return {
          rows: [{
            id: '1',
            version_name: 'test-version-1',
            status: 'published',
            effective_from: '2026-10-26',
            created_at: new Date(),
            published_at: new Date()
          }]
        };
      }
      if (text.includes('DISTINCT category')) {
        return {
          rows: [
            { category: 'ethnic_set' },
            { category: 'kurta' },
            { category: 'sari' }
          ]
        };
      }
      if (text.includes('DISTINCT ON (category)')) {
        return {
          rows: [
            { category: 'ethnic_set', fsn: 'ETH123', sku: 'SKU1' },
            { category: 'kurta', fsn: 'KTA123', sku: 'SKU2' }
          ]
        };
      }
      return { rows: [] };
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn()
    }))
  })
}));

const { default: rateCardRouter } = await import('../routes/rateCard.js');

let server;
let baseUrl;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/rate-card', rateCardRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise(resolve => server.close(resolve)));

describe('Rate Card Automation & Sync Endpoints', () => {
  it('GET /api/rate-card/sync-status returns marketplace status and latest version', async () => {
    const res = await fetch(`${baseUrl}/api/rate-card/sync-status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('marketplace', 'flipkart');
    expect(body).toHaveProperty('latestVersion');
    expect(body.latestVersion.version_name).toBe('test-version-1');
    expect(body).toHaveProperty('sessionManagedBy', 'desktop_chromium_profile');
    expect(body.hasCookies).toBeNull();
    expect(body.sessionStatusMessage).toContain('not visible to the backend');
  });

  it('GET /api/rate-card/verticals returns distinct verticals and sample FSNs', async () => {
    const res = await fetch(`${baseUrl}/api/rate-card/verticals`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('verticals');
    expect(Array.isArray(body.verticals)).toBe(true);
    expect(body.verticals).toContain('ethnic_set');
    expect(body).toHaveProperty('samples');
    expect(body.samples.length).toBeGreaterThan(0);
  });

  it('POST /api/rate-card/detect-changes validates scrapedData array', async () => {
    const res = await fetch(`${baseUrl}/api/rate-card/detect-changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('scrapedData array is required');
  });

  it('POST /api/rate-card/detect-changes rejects observations for another seller account', async () => {
    const res = await fetch(`${baseUrl}/api/rate-card/detect-changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: 'flipkart', seller_account: 'default', scrapedData: [
        { marketplace: 'flipkart', seller_account: 'seller_ej', vertical: 'kurta' },
      ] }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'SELLER_ACCOUNT_MISMATCH',
      error: expect.stringContaining('seller account does not match'),
    });
  });

  it('GET /api/rate-card/unconfigured-categories returns list of unconfigured categories', async () => {
    const res = await fetch(`${baseUrl}/api/rate-card/unconfigured-categories`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('marketplace', 'flipkart');
    expect(body).toHaveProperty('categories');
    expect(Array.isArray(body.categories)).toBe(true);
  });

  it('POST /api/rate-card/check-category validates category parameter', async () => {
    const res = await fetch(`${baseUrl}/api/rate-card/check-category`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Valid category name is required');
  });
});

