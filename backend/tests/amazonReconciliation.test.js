import { describe, expect, it } from 'vitest';
import {
  AMAZON_FEE_CODE_CASE_SQL,
  buildAmazonFeeComparison,
  calculateAmazonExpectedFee,
  matchAmazonRateRule,
} from '../services/amazonReconciliation.js';

describe('Amazon payment reconciliation parameters', () => {
  const fbaPickPackRule = {
    id: 9,
    seller_account: 'default',
    fee_code: 'fba_pick_pack',
    program: 'FBA',
    category: 'ALL',
    price_min: 0,
    price_max: 999999,
    calculation_basis: 'per_unit',
    rate: 17,
    tax_rate: 0.18,
  };

  it('keeps FBA pick-and-pack, weight handling, technology, and GST distinct', () => {
    expect(AMAZON_FEE_CODE_CASE_SQL).toContain("'fba_pick_pack_tax'");
    expect(AMAZON_FEE_CODE_CASE_SQL).toContain("'fba_weight_handling_tax'");
    expect(AMAZON_FEE_CODE_CASE_SQL).toContain("'technology_fee_tax'");
    expect(AMAZON_FEE_CODE_CASE_SQL).toContain("'shipping_tax_discount'");
  });

  it('matches a verified FBA per-unit rule and compares GST-inclusive fee totals', () => {
    const row = {
      seller_account: 'default', program: 'FBA', sale_amount: 494, quantity: 1,
      fba_pick_pack_base: -17, fba_pick_pack_tax: -3.06, fba_pick_pack_credit: 0,
    };
    expect(matchAmazonRateRule([fbaPickPackRule], row, 'fba_pick_pack')?.id).toBe(9);
    expect(calculateAmazonExpectedFee(fbaPickPackRule, row)).toEqual({
      ruleId: 9, basis: 'per_unit', expectedBase: 17, expectedTax: 3.06, expectedTotal: 20.06,
    });
    const fee = buildAmazonFeeComparison(row, [fbaPickPackRule]).fba_pick_pack;
    expect(fee).toMatchObject({ actualTotal: 20.06, expectedTotal: 20.06, variance: 0, status: 'matched' });
  });

  it('does not compare a refund/fee-credit lifecycle against a full-sale rule', () => {
    const row = {
      seller_account: 'default', program: 'FBA', sale_amount: 494, quantity: 1,
      has_refund: true,
      fba_pick_pack_base: -17, fba_pick_pack_tax: -3.06, fba_pick_pack_credit: 20.06,
    };
    const fee = buildAmazonFeeComparison(row, [fbaPickPackRule]).fba_pick_pack;
    expect(fee).toMatchObject({ actualTotal: 0, expectedTotal: null, status: 'return_review' });
  });
});
