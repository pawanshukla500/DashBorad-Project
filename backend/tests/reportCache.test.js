import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let versionRows;
let versionError;

vi.mock('../db/index.js', () => ({
  getPool: () => ({
    query: vi.fn(async () => {
      if (versionError) throw versionError;
      return { rows: versionRows };
    }),
  }),
}));

const {
  invalidateReportCache,
  reportCacheMiddleware,
  reportCacheSize,
} = await import('../services/reportCache.js');

const cacheEverything = reportCacheMiddleware(() => true);

function fakeRequest(path, query = {}) {
  return { method: 'GET', baseUrl: '/api', path, query };
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    closeHandlers: [],
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    on(event, handler) { if (event === 'close') this.closeHandlers.push(handler); return this; },
  };
  return res;
}

// Runs the middleware; when it calls next(), the "route handler" responds.
async function request(path, query, handler) {
  const req = fakeRequest(path, query);
  const res = fakeResponse();
  let handled = false;
  await cacheEverything(req, res, async () => {
    handled = true;
    await handler(req, res);
  });
  return { res, handled };
}

async function advanceVersion(value) {
  versionRows = [{ version: value }];
  // Let the 1.5 s version memo expire.
  vi.advanceTimersByTime(2_000);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  versionRows = [{ version: '100' }];
  versionError = null;
  invalidateReportCache();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.REPORT_CACHE_TTL_MS;
});

describe('report cache', () => {
  it('serves a second identical request from cache while the data version is unchanged', async () => {
    const handler = vi.fn((req, res) => res.json({ total: 1 }));

    const first = await request('/summary', { marketplace: 'amazon' }, handler);
    const second = await request('/summary', { marketplace: 'amazon' }, handler);

    expect(first.res.headers['X-Report-Cache']).toBe('MISS');
    expect(second.handled).toBe(false);
    expect(second.res.headers['X-Report-Cache']).toBe('HIT');
    expect(second.res.body).toEqual({ total: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keys on the query string, ignoring _refresh and empty values', async () => {
    const handler = vi.fn((req, res) => res.json({ marketplace: req.query.marketplace || 'all' }));

    await request('/summary', { marketplace: 'amazon', brand: '' }, handler);
    const other = await request('/summary', { marketplace: 'flipkart' }, handler);
    const same = await request('/summary', { marketplace: 'amazon' }, handler);

    expect(other.res.body).toEqual({ marketplace: 'flipkart' });
    expect(same.res.headers['X-Report-Cache']).toBe('HIT');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('recomputes after any database write changes the version, even one this process did not make', async () => {
    let total = 1;
    const handler = vi.fn((req, res) => res.json({ total }));

    await request('/summary', {}, handler);
    total = 2;
    await advanceVersion('101');
    const after = await request('/summary', {}, handler);

    expect(after.handled).toBe(true);
    expect(after.res.body).toEqual({ total: 2 });
  });

  it('always recomputes for an explicit _refresh and replaces the cached entry', async () => {
    let total = 1;
    const handler = vi.fn((req, res) => res.json({ total }));

    await request('/summary', {}, handler);
    total = 5;
    const refreshed = await request('/summary', { _refresh: '3' }, handler);
    const next = await request('/summary', {}, handler);

    expect(refreshed.res.headers['X-Report-Cache']).toBe('REFRESHED');
    expect(refreshed.res.body).toEqual({ total: 5 });
    expect(next.res.headers['X-Report-Cache']).toBe('HIT');
    expect(next.res.body).toEqual({ total: 5 });
  });

  it('does not store a response that was computing when the cache was invalidated', async () => {
    const handler = vi.fn((req, res) => {
      invalidateReportCache(); // a write finishes while this read is running
      res.json({ total: 'stale' });
    });

    await request('/summary', {}, handler);

    expect(reportCacheSize()).toBe(0);
  });

  it('never caches error responses', async () => {
    const handler = vi.fn((req, res) => res.status(500).json({ error: 'boom' }));

    await request('/summary', {}, handler);
    const second = await request('/summary', {}, handler);

    expect(second.handled).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('expires entries after REPORT_CACHE_TTL_MS', async () => {
    process.env.REPORT_CACHE_TTL_MS = '60000';
    const handler = vi.fn((req, res) => res.json({ total: 1 }));

    await request('/summary', {}, handler);
    vi.advanceTimersByTime(61_000);
    const later = await request('/summary', {}, handler);

    expect(later.handled).toBe(true);
  });

  it('keeps serving a cached report when the version cannot be read', async () => {
    const handler = vi.fn((req, res) => res.json({ total: 1 }));

    await request('/summary', {}, handler);
    versionError = new Error('database reconnecting');
    vi.advanceTimersByTime(2_000);
    const second = await request('/summary', {}, handler);

    expect(second.res.headers['X-Report-Cache']).toBe('HIT');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('shares one computation between identical concurrent requests', async () => {
    let finish;
    const handler = vi.fn((req, res) => new Promise(resolve => {
      finish = () => { res.json({ total: 7 }); resolve(); };
    }));

    const first = request('/summary', {}, handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    const second = request('/summary', {}, handler);
    // Let the second request get past its version lookup and join the first.
    await new Promise(resolve => setImmediate(resolve));
    finish();
    const [a, b] = await Promise.all([first, second]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(a.res.body).toEqual({ total: 7 });
    expect(b.res.body).toEqual({ total: 7 });
    expect(b.res.headers['X-Report-Cache']).toBe('COALESCED');
  });

  it('passes through non-GET requests and paths the predicate rejects', async () => {
    const onlySummary = reportCacheMiddleware(req => req.path === '/summary');
    const next = vi.fn();

    await onlySummary({ method: 'POST', path: '/summary', query: {} }, fakeResponse(), next);
    await onlySummary({ method: 'GET', path: '/orders', query: {} }, fakeResponse(), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(reportCacheSize()).toBe(0);
  });
});
