import { describe, it, expect } from 'vitest';
import { computeSummaryMetrics } from '../services/settlementSql.js';

describe('computeSummaryMetrics (money glossary)', () => {
  it('aliases myShare and totalSettlement to bankReceived', () => {
    const m = computeSummaryMetrics({
      totalOrders: 100,
      totalRevenue: 50000,
      bankReceived: 32000,
      totalFees: 8000,
      returnCount: 10,
      unsettledCount: 5,
    });
    expect(m.bankReceived).toBe(32000);
    expect(m.myShare).toBe(32000);
    expect(m.totalSettlement).toBe(32000);
    expect(m.myShare).toBe(m.totalSettlement);
  });

  it('computes return rate and AOV', () => {
    const m = computeSummaryMetrics({
      totalOrders: 200,
      totalRevenue: 100000,
      bankReceived: 0,
      returnCount: 40,
    });
    expect(m.returnRate).toBe(20);
    expect(m.avgOrderValue).toBe(500);
  });

  it('handles zero orders safely', () => {
    const m = computeSummaryMetrics({});
    expect(m.returnRate).toBe(0);
    expect(m.avgOrderValue).toBe(0);
  });
});
