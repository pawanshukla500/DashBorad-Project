import { describe, expect, it } from 'vitest';
import { buildFilters, marketplaceScope } from '../routes/reconcile.js';

describe('Myntra account scoping', () => {
  it('maps a Myntra account selection to marketplace + seller_account', () => {
    expect(marketplaceScope({ marketplace: 'myntra_vb' })).toEqual({ mkt: 'myntra', sellerAcc: 'myntra_vb' });
    expect(marketplaceScope({ marketplace: 'Myntra_EJ' })).toEqual({ mkt: 'myntra', sellerAcc: 'myntra_ej' });
  });

  it('accepts both seller_account spellings and ignores "all"', () => {
    expect(marketplaceScope({ marketplace: 'myntra', seller_account: 'myntra_ej' })).toEqual({ mkt: 'myntra', sellerAcc: 'myntra_ej' });
    expect(marketplaceScope({ marketplace: 'myntra', sellerAccount: 'myntra_vb' })).toEqual({ mkt: 'myntra', sellerAcc: 'myntra_vb' });
    expect(marketplaceScope({ marketplace: 'all', seller_account: 'all' })).toEqual({ mkt: null, sellerAcc: null });
  });

  it('filters settlements by account instead of comparing the account id with marketplace', () => {
    const { where, values } = buildFilters({ marketplace: 'myntra_vb', startDate: '2026-06-01' });
    expect(where).toBe(' AND fko.marketplace = $1 AND fko.seller_account = $2 AND fko.payment_date >= $3');
    expect(values).toEqual(['myntra', 'myntra_vb', '2026-06-01']);
  });
});

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
