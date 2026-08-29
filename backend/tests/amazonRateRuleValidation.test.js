import { describe, expect, it } from 'vitest';
import { parseAmazonRulePayload } from '../routes/amazonUpload.js';

describe('Amazon rate-rule validation', () => {
  it('normalizes valid strict rule values before they affect expected fees', () => {
    expect(parseAmazonRulePayload({
      feeCode: 'fba_pick_pack', program: 'fba', calculationBasis: 'per_unit',
      rate: '₹12.50', taxRate: '0.18', priceMin: '0', priceMax: '999',
      startDate: '01/08/2026', endDate: '31/08/2026', priority: '2', isActive: 'true',
    })).toEqual([
      'default', 'fba_pick_pack', 'FBA', 'ALL', 'Ethnic Juction', null,
      '2026-08-01', '2026-08-31', 0, 999, 'per_unit', 12.5, 0.18, 2, true, null,
    ]);
  });

  it('rejects silent-number coercions, invalid dates, and ambiguous booleans', () => {
    expect(() => parseAmazonRulePayload({ feeCode: 'fba_pick_pack', rate: '12oops' }))
      .toThrow('Rate must be a number');
    expect(() => parseAmazonRulePayload({ feeCode: 'fba_pick_pack', rate: 12, startDate: '31/02/2026' }))
      .toThrow('Start date must be a valid date');
    expect(() => parseAmazonRulePayload({ feeCode: 'fba_pick_pack', rate: 12, isActive: 'maybe' }))
      .toThrow('is_active must be true or false');
  });
});
