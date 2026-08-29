import { describe, expect, it } from 'vitest';
import { parseRateCardRow, parseRcEntryOrdersQuery } from '../routes/rateCard.js';

describe('rate-card input validation', () => {
  it('normalizes valid rules before they can affect reconciliation', () => {
    expect(parseRateCardRow('collection_fee', {
      category: 'Kurta Set', marketplace: 'Flipkart', seller_account: 'main_account',
      startDate: '24/08/2026', priceMin: '₹100', priceMax: '₹999',
      fulfilmentType: 'Non-FBF', prepaid: '0.005', postpaid: '12.50',
      prepaid_type: 'pct', postpaid_type: 'flat',
    })).toEqual([
      'salwar_kurta_dupatta', 'flipkart', 'main_account', '2026-08-24', null,
      'NON_FBF', 100, 999, 0.005, 12.5, 'pct', 'flat',
    ]);
  });

  it('does not convert corrupt values, inverted bands, or invalid dates to zero', () => {
    expect(() => parseRateCardRow('commission', {
      category: 'Kurta', rate: '12oops', price_min: 0, price_max: 500,
    })).toThrow('Commission rate must be a number');
    expect(() => parseRateCardRow('fixed_fee', {
      category: 'Kurta', rate: 10, price_min: 501, price_max: 500,
    })).toThrow('Order-value "To" must be greater');
    expect(() => parseRateCardRow('reverse_shipping', {
      category: 'Kurta', weight_slab: '1oops', local_fee: 1, zonal_fee: 2, national_fee: 3,
    })).toThrow('Weight slab must be a positive number');
    expect(() => parseRateCardRow('pick_pack', {
      category: 'Kurta', rate: 10, start_date: '31/02/2026',
    })).toThrow('Start date must be a valid date');
  });

  it('strictly scopes rate-card entry drill-down requests', () => {
    expect(parseRcEntryOrdersQuery({
      fee_type: 'commission', rc_id: '8', marketplace: 'Amazon', seller_account: 'primary', page: '2', pageSize: '999',
    })).toEqual({
      feeType: 'commission', rcId: 8, marketplace: 'amazon', sellerAccount: 'primary', page: 2, pageSize: 200,
    });
    expect(() => parseRcEntryOrdersQuery({ rc_id: '8.5' })).toThrow('rc_id must be a positive whole number');
    expect(() => parseRcEntryOrdersQuery({ rc_id: '8', marketplace: "amazon' OR 1=1" }))
      .toThrow('Marketplace may contain only');
  });
});
