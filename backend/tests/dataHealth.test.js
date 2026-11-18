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

  it('repairs Myntra orders left without any payment row and restores statuses (whole scope)', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 2 })) };
    await expect(repairMyntraPaymentColumns(pool)).resolves.toEqual({ ordersReset: 2, ordersRestored: 2 });
    const [resetSql, resetParams] = pool.query.mock.calls[0];
    expect(resetSql).toContain('NOT EXISTS');
    expect(resetParams).toEqual([]);
    // The status a removed reverse payment set is put back, as the backfill endpoint does.
    const [restoreSql, restoreParams] = pool.query.mock.calls[1];
    expect(restoreSql).toContain("o.orders_status = 'Return Initiated'");
    expect(restoreParams).toEqual([]);
  });

  it('flags stale Myntra orders on any payment column the repair clears', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    await collectDataHealth(pool);
    const stale = pool.query.mock.calls.map(([sql]) => sql).find(sql => sql.includes("o.marketplace = 'myntra'"));
    for (const column of ['settlement_amount', 'commission', 'shipping_fee', 'return_received_amount']) {
      expect(stale).toContain(`o.${column} IS NOT NULL`);
    }
  });

  it('finds pre-ledger Sale Orders by product_amount, which survives settlement re-keying', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) };
    await collectDataHealth(pool);
    const amazon = pool.query.mock.calls.map(([sql]) => sql).find(sql => sql.includes('amazon_sale_order_shipments'));
    expect(amazon).toContain('o.product_amount IS NOT NULL');
    expect(amazon).not.toContain("LIKE 'AMZ:%'");
  });

  it('runs the checks one at a time, never holding several pool connections', async () => {
    let running = 0;
    let peak = 0;
    const pool = { query: vi.fn(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running -= 1;
      return { rows: [] };
    }) };
    await collectDataHealth(pool);
    expect(pool.query).toHaveBeenCalledTimes(DATA_HEALTH_CHECK_KEYS.length);
    expect(peak).toBe(1);
  });

  it('is exposed on the Data Hub: on-demand GET, operator-guarded repair, panel on the Upload page', () => {
    const route = fs.readFileSync(path.resolve('routes/uploadHealth.js'), 'utf-8');
    expect(route).toContain("router.get('/data-health'");
    expect(route).toContain("router.post('/data-health/repair/myntra-payment-columns'");
    expect(route).toContain('await refreshOrderSettlementTotals(pool);');
    expect(route).toContain('res.json({ ok: true, ordersReset, ordersRestored });');
    expect(fs.readFileSync(path.resolve('routes/index.js'), 'utf-8')).toContain("protectMutations(app, '/api/upload');");
    const page = fs.readFileSync(path.resolve('../frontend/src/pages/UploadPage.jsx'), 'utf-8');
    expect(page).toContain('<DataHealthPanel />');
  });
});
