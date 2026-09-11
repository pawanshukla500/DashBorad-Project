import { describe, expect, it, vi } from 'vitest';
import {
  amazonMonthRange,
  CATEGORY_CASE_SQL,
  fetchAmazonNonOrderReport,
  fetchAmazonSettlementSummary,
} from '../services/amazonSettlementReports.js';

describe('Amazon settlement report service', () => {
  it('builds index-friendly calendar month ranges', () => {
    expect(amazonMonthRange('2026-05')).toEqual({
      start: '2026-05-01',
      end: '2026-06-01',
    });
    expect(amazonMonthRange('2026-12')).toEqual({
      start: '2026-12-01',
      end: '2027-01-01',
    });
    expect(() => amazonMonthRange('2026-13')).toThrow(/Expected YYYY-MM/);
  });

  it('keeps unknown order-linked amounts out of non-order categories', () => {
    expect(CATEGORY_CASE_SQL).toContain("order_id IS NOT NULL AND amount >= 0 THEN 'order_other_credit'");
    expect(CATEGORY_CASE_SQL).toContain("order_id IS NOT NULL THEN 'order_other_debit'");
  });

  it('uses two scans for the paginated non-order report and no TO_CHAR date filter', async () => {
    const query = vi.fn(async sql => {
      if (sql.includes('COUNT(*) OVER')) {
        return {
          rows: [{
            id: 7,
            category: 'storage_fee',
            amount: '-25.00',
            total_count: '12',
          }],
        };
      }
      return {
        rows: [{
          category: 'storage_fee',
          count: '12',
          credit_total: '5.00',
          debit_total: '30.00',
          net_amount: '-25.00',
        }],
      };
    });

    const result = await fetchAmazonNonOrderReport({ query }, {
      month: '2026-05',
      page: '2',
      pageSize: '25',
    });

    expect(query).toHaveBeenCalledTimes(2);
    const allSql = query.mock.calls.map(([sql]) => sql).join('\n');
    expect(allSql).not.toContain('TO_CHAR');
    expect(allSql).toContain('l.posted_date >= $1::date');
    expect(query.mock.calls[0][1].slice(0, 2)).toEqual(['2026-05-01', '2026-06-01']);
    expect(result.pagination).toEqual({ page: 2, pageSize: 25, total: 12 });
    expect(result.lines[0]).not.toHaveProperty('total_count');
  });

  it('consolidates headline metrics instead of using repeated scalar scans', async () => {
    const query = vi.fn(async sql => {
      if (sql.includes('MIN(settlement_start_date)')) {
        return { rows: [{ start: '2026-05-01', settlement_count: '2', total_deposit: '900' }] };
      }
      if (sql.includes('AS gross_sales')) {
        return { rows: [{ gross_sales: '1000', total_refunds: '100' }] };
      }
      return { rows: [] };
    });

    const result = await fetchAmazonSettlementSummary({ query });
    expect(query).toHaveBeenCalledTimes(5);

    const metricsSql = query.mock.calls.map(([sql]) => sql).find(sql => sql.includes('AS gross_sales'));
    expect(metricsSql.match(/FROM amazon_settlement_lines/g)).toHaveLength(1);
    expect(metricsSql).not.toMatch(/\(SELECT\s+COALESCE/);
    expect(result.period).toMatchObject({ gross_sales: '1000', total_refunds: '100' });
  });

  it('correctly maps storage, removal, ads, and warehouse prep from Amazon settlements', () => {
    expect(CATEGORY_CASE_SQL).toContain("amount_description ILIKE 'Storage%Fee%'");
    expect(CATEGORY_CASE_SQL).toContain("amount_description ILIKE 'StorageBilling%'");
    expect(CATEGORY_CASE_SQL).toContain("amount_description ILIKE 'DisposalComplete%'");
    expect(CATEGORY_CASE_SQL).toContain("amount_description ILIKE 'WarehousePrep%'");
  });
});
