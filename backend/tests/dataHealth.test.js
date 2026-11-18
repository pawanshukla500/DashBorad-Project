import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { collectDataHealth, DATA_HEALTH_CHECK_KEYS, repairMyntraPaymentColumns } from '../services/dataHealth.js';

describe('stored data health', () => {
  it('runs every check independently and reports one that fails as unavailable', async () => {
    const pool = {
      query: vi.fn(async sql => {
        if (sql.includes('amazon_sale_order_shipments')) throw new Error('relation "amazon_sale_order_shipments" does not exist');
        if (sql.includes('r.return_requested_date < o.order_date')) {
          return { rows: [{ scope: 'flipkart', count: '3', first_date: '2026-04-01', last_date: '2026-04-09' }, { scope: 'meesho', count: 0 }] };
        }
        return { rows: [] };
      }),
    };
    const report = await collectDataHealth(pool);
    expect(report.checks.map(check => check.key)).toEqual(DATA_HEALTH_CHECK_KEYS);
    expect(report.issues).toBe(1);
    const returns = report.checks.find(check => check.key === 'returns-before-order');
    expect(returns).toMatchObject({ count: 3, items: [{ scope: 'flipkart', count: 3, firstDate: '2026-04-01', lastDate: '2026-04-09' }] });
    expect(returns.action).toMatch(/Re-upload/);
    expect(report.checks.find(check => check.key === 'amazon-orders-before-shipment-ledger').unavailable).toMatch(/does not exist/);
  });

  it('only flags dropped rows whose reason is an invalid date or amount, on uncleared uploads', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    await collectDataHealth(pool);
    const dropped = pool.query.mock.calls.map(([sql]) => sql).find(sql => sql.includes('upload_skipped_rows'));
    expect(dropped).toContain("s.skip_reason ~* '(date|amount)'");
    expect(dropped).toContain('l.data_cleared_at IS NULL');
  });

  it('repairs only Myntra orders left without any payment row (whole scope)', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 2 })) };
    await expect(repairMyntraPaymentColumns(pool)).resolves.toEqual({ ordersReset: 2 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('NOT EXISTS');
    expect(params).toEqual([]);
  });

  it('is exposed on the Data Hub: on-demand GET, operator-guarded repair, panel on the Upload page', () => {
    const route = fs.readFileSync(path.resolve('routes/uploadHealth.js'), 'utf-8');
    expect(route).toContain("router.get('/data-health'");
    expect(route).toContain("router.post('/data-health/repair/myntra-payment-columns'");
    expect(route).toContain('await refreshOrderSettlementTotals(pool);');
    expect(fs.readFileSync(path.resolve('routes/index.js'), 'utf-8')).toContain("protectMutations(app, '/api/upload');");
    const page = fs.readFileSync(path.resolve('../frontend/src/pages/UploadPage.jsx'), 'utf-8');
    expect(page).toContain('<DataHealthPanel />');
  });
});
