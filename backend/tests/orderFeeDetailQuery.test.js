import { describe, expect, it } from 'vitest';
import { parseMarketplaceFilter, parseOrderFeeDetailQuery } from '../routes/data.js';

describe('order fee detail query validation', () => {
  it('validates and canonicalizes a scoped drill-down query', () => {
    expect(parseOrderFeeDetailQuery({
      fee: 'commission', month: '2026-08', marketplace: 'Flipkart', limit: '99999',
    })).toEqual({ fee: 'commission', month: '2026-08', marketplace: 'flipkart', limit: 2000 });
  });

  it('rejects malformed dynamic query components', () => {
    expect(() => parseOrderFeeDetailQuery({ fee: 'not_a_fee', month: '2026-08' })).toThrow('fee param required');
    expect(() => parseOrderFeeDetailQuery({ fee: 'commission', month: '2026-13' })).toThrow('month param required');
    expect(() => parseOrderFeeDetailQuery({ fee: 'commission', month: '2026-08', marketplace: "flipkart' OR 1=1" }))
      .toThrow('marketplace filter is invalid');
  });

  it('normalizes shared marketplace report filters', () => {
    expect(parseMarketplaceFilter(' Amazon ')).toBe('amazon');
    expect(parseMarketplaceFilter('all')).toBeNull();
    expect(() => parseMarketplaceFilter("amazon' OR 1=1")).toThrow('marketplace filter is invalid');
  });
});
