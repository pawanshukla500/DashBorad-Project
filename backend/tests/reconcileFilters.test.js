import { describe, expect, it } from 'vitest';
import { buildFilters } from '../routes/reconcile.js';

describe('unified link-up filters', () => {
  it('uses order and settlement aliases that exist in the unified link-up query', () => {
    const result = buildFilters({
      marketplace: 'flipkart',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      category: 'Apparel',
      neftId: 'NEFT-1',
      orderId: 'ORDER-1',
      suspiciousOnly: '1',
    }, {
      alias: 'o',
      dateColumn: 'order_date',
      categoryColumn: 'category',
      neftAlias: 's',
    });

    expect(result.where).toContain('o.marketplace');
    expect(result.where).toContain('o.order_date');
    expect(result.where).toContain('o.category');
    expect(result.where).toContain('s.neft_id');
    expect(result.where).not.toContain('fko.');
    expect(result.values).toEqual(['flipkart', '2026-08-01', '2026-08-31', 'Apparel', 'NEFT-1', 'ORDER-1', 'ORDER-1']);
  });
});
