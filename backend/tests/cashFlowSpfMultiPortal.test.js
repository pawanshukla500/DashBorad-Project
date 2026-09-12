import { describe, it, expect } from 'vitest';
import { buildSpfQueries } from '../routes/insights.js';

describe('Multi-Portal SPF Query Builder (Cash Flow)', () => {
  it('generates valid SQL queries for "all" marketplaces', () => {
    const { totalSql, reasonsSql, orderSummarySql, orderDetailSql } = buildSpfQueries('all');
    expect(totalSql).toContain('all_claims');
    expect(totalSql).toContain("'flipkart'");
    expect(totalSql).toContain("'amazon'");
    expect(totalSql).toContain("'myntra_vb'");
    expect(totalSql).toContain("'myntra_ej'");

    expect(reasonsSql).toContain('all_reasons');
    expect(reasonsSql).toContain('amount_description AS protection_reason');

    expect(orderSummarySql).toContain('all_order_spf');
    expect(orderSummarySql).toContain('total_orders');

    expect(orderDetailSql).toContain('all_order_details');
    expect(orderDetailSql).toContain('claim_reason');
  });

  it('generates targeted SQL for Amazon', () => {
    const { totalSql, reasonsSql, orderSummarySql, orderDetailSql } = buildSpfQueries('amazon');
    expect(totalSql).toContain("'amazon'");
    expect(totalSql).not.toContain("'flipkart'");
    expect(totalSql).not.toContain("'myntra_vb'");

    expect(orderSummarySql).toContain('amazon_settlement_lines');
    expect(orderDetailSql).toContain('amazon_settlement_lines');
  });

  it('generates targeted SQL for Myntra VB', () => {
    const { totalSql, reasonsSql, orderSummarySql, orderDetailSql } = buildSpfQueries('myntra_vb');
    expect(totalSql).toContain("'myntra_vb'");
    expect(totalSql).not.toContain("'amazon'");
    expect(totalSql).not.toContain("'flipkart'");
    expect(orderSummarySql).toContain('ForwardAutoSPF');
  });

  it('generates targeted SQL for Myntra EJ', () => {
    const { totalSql, reasonsSql, orderSummarySql, orderDetailSql } = buildSpfQueries('myntra_ej');
    expect(totalSql).toContain("'myntra_ej'");
    expect(totalSql).not.toContain("'amazon'");
    expect(totalSql).not.toContain("'myntra_vb'");
  });

  it('generates targeted SQL for Flipkart', () => {
    const { totalSql, reasonsSql, orderSummarySql, orderDetailSql } = buildSpfQueries('flipkart');
    expect(totalSql).toContain("'flipkart'");
    expect(totalSql).not.toContain("'amazon'");
    expect(totalSql).not.toContain("'myntra_vb'");
  });
});
