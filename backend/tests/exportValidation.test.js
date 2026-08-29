import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { buildMonthlyDetailedSql, parseMonthlyDetailedQuery } from '../routes/export.js';

const exportRouteSource = fs.readFileSync(new URL('../routes/export.js', import.meta.url), 'utf8');

describe('monthly detailed export query validation', () => {
  it('normalizes a valid period into index-friendly date bounds', () => {
    expect(parseMonthlyDetailedQuery({ month: '2026-02', marketplace: 'Amazon' })).toEqual({
      month: '2026-02',
      marketplace: 'amazon',
      startDate: '2026-02-01',
      endDate: '2026-03-01',
    });
  });

  it('accepts the all-marketplaces view without treating all as a database value', () => {
    expect(parseMonthlyDetailedQuery({ month: '2026-12', marketplace: 'all' }).marketplace).toBeNull();
  });

  it('uses indexed order-date bounds and scopes the settlement aggregation to those orders', () => {
    const sql = buildMonthlyDetailedSql(parseMonthlyDetailedQuery({ month: '2026-06', marketplace: 'flipkart' }));
    expect(sql.text).toContain('o.order_date >= $2::date');
    expect(sql.text).toContain('o.order_date < $3::date');
    expect(sql.text).toContain('JOIN scoped_orders o ON o.order_item_id = s.order_item_id');
    expect(sql.text).toContain('ORDER BY o.order_date DESC, o.order_item_id');
    expect(sql.text).not.toContain("TO_CHAR(o.order_date, 'YYYY-MM')");
    expect(sql.values).toEqual(['flipkart', '2026-06-01', '2026-07-01']);
  });

  it('rejects malformed periods and marketplace identifiers', () => {
    expect(() => parseMonthlyDetailedQuery({ month: '2026-19' })).toThrow('Month must be YYYY-MM');
    expect(() => parseMonthlyDetailedQuery({ month: '2026-06', marketplace: 'flipkart; drop table orders' }))
      .toThrow('Marketplace filter is invalid');
  });

  it('requires an operator role before sending an external benchmark notification', () => {
    expect(exportRouteSource).toContain("router.post('/sku-settlement/notify', requireRole('operator', 'admin')");
  });
});
