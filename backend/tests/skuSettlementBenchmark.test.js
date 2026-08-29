import { describe, expect, it, vi } from 'vitest';
import {
  getSkuSettlementBenchmark,
  getSkuSettlementMonths,
} from '../services/skuSettlementBenchmark.js';

function invoiceBenchmarkPool() {
  return {
    query: vi.fn(async (sql, params = []) => {
      if (sql.includes('SELECT DISTINCT TO_CHAR(DATE_TRUNC')) {
        return { rows: [{ month: '2026-04' }, { month: '2026-03' }] };
      }
      return {
        rows: [{
          seller_account: 'myntra_ej', sku: 'SKU-1', delivered_orders: 5, units: 5,
          representative_settlement: '430', exact_median: '430', min_settlement: '429.5', max_settlement: '430.5',
          tolerance_orders: 5, tolerance_units: 5,
          previous_representative_settlement: '427', previous_exact_median: '427',
          change_from_previous: '3', has_change_alert: true,
        }],
      };
    }),
  };
}

describe('SKU settlement benchmark invoice sources', () => {
  it('uses paid, positive, dated Myntra invoice lines and preserves the selected account', async () => {
    const pool = invoiceBenchmarkPool();

    const report = await getSkuSettlementBenchmark(pool, { marketplace: 'myntra', month: '2026-04' });

    expect(report.sourceReady).toBe(true);
    expect(report.rows[0]).toMatchObject({ seller_account: 'myntra_ej', representative_settlement: 430, has_change_alert: true });
    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toContain('FROM mp_invoices i');
    expect(sql).toContain('DATE_TRUNC(\'month\', i.invoice_date)');
    expect(sql).toContain('AND i.invoice_date >= $1::date');
    expect(sql).toContain("LOWER(TRIM(COALESCE(i.status, ''))) = 'paid'");
    expect(sql).toContain('COALESCE(i.amount_received, 0) > 0');
    expect(params).toEqual(['2026-03-01', '2026-05-01', '2026-04-01', '2026-03-01', 'myntra']);
  });

  it('gets Meesho settlement months from the same payment-backed invoice source', async () => {
    const pool = invoiceBenchmarkPool();

    await expect(getSkuSettlementMonths(pool, 'meesho')).resolves.toEqual(['2026-04', '2026-03']);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM mp_invoices');
    expect(params).toEqual(['meesho']);
  });

  it('uses order month and positive, non-returned sales for Flipkart and Amazon', async () => {
    const pool = {
      query: vi.fn(async sql => {
        if (sql.includes('SELECT DISTINCT TO_CHAR')) return { rows: [{ month: '2026-07' }] };
        return { rows: [] };
      }),
    };

    await getSkuSettlementBenchmark(pool, { marketplace: 'flipkart', month: '2026-07' });
    const [flipkartSql] = pool.query.mock.calls[1];
    expect(flipkartSql).toContain("DATE_TRUNC('month', o.order_date)::date AS order_month");
    expect(flipkartSql).toContain('COALESCE(f.bank_settlement, 0) > 0');
    expect(flipkartSql).toContain('returned_items AS MATERIALIZED');
    expect(flipkartSql).not.toContain('f.payment_date >= $1::date');

    pool.query.mockClear();
    await getSkuSettlementBenchmark(pool, { marketplace: 'amazon', month: '2026-07' });
    const [amazonSql] = pool.query.mock.calls[1];
    expect(amazonSql).toContain("DATE_TRUNC('month', o.order_date)::date AS order_month");
    expect(amazonSql).toContain('excluded_order_lines AS MATERIALIZED');
    expect(amazonSql).toContain('SUM(CASE WHEN COALESCE(a.net_settlement, 0) > 0');
    expect(amazonSql).not.toContain('a.posted_month >= $1::date');
  });
});
