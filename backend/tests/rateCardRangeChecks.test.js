import { describe, expect, it } from 'vitest';
import { checkRateRow } from '../utils/rateCardRowChecks.js';

const clean = { errors: [], warnings: [] };
const issues = result => ({ errors: result.errors, warnings: result.warnings });

describe('rate-card range checks', () => {
  it('accepts typical stored values: fractional commission, flat ₹ fees, mixed collection types', () => {
    expect(issues(checkRateRow('commission', { price_min: 0, price_max: 500, rate: 0.14 }))).toEqual(clean);
    expect(issues(checkRateRow('commission', { rate: 0 }))).toEqual(clean);
    expect(issues(checkRateRow('fixed_fee', { price_min: '0', price_max: '999999.00', rate: '6' }))).toEqual(clean);
    expect(issues(checkRateRow('pick_pack', { rate: 37 }))).toEqual(clean);
    expect(issues(checkRateRow('franchise_fee', { rate: 25.5 }))).toEqual(clean);
    expect(issues(checkRateRow('collection_fee', {
      prepaid: 0.003, prepaid_type: 'pct', postpaid: 15, postpaid_type: 'flat',
    }))).toEqual(clean);
    expect(issues(checkRateRow('reverse_shipping', { local_fee: 102, zonal_fee: 122, national_fee: 162 }))).toEqual(clean);
  });

  it('warns, without rejecting, on a commission stored as a percentage (legacy rows stay editable)', () => {
    const result = checkRateRow('commission', { rate: 14 });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('above 1');
    expect(result.warnings[0]).toContain('1400%');
    expect(result.warnings[0]).toContain('enter 0.14 if you meant 14%');
  });

  it('warns on implausibly high or tiny fractional rates', () => {
    expect(checkRateRow('commission', { rate: 0.75 }).warnings[0]).toContain('unusually high');
    expect(checkRateRow('commission', { rate: 0.003 }).warnings[0]).toContain('resets rates this small to 0%');
    expect(checkRateRow('collection_fee', { prepaid: 0.2, prepaid_type: 'pct' }).warnings[0]).toContain('unusually high');
    expect(checkRateRow('collection_fee', { postpaid: 2 }).warnings[0]).toContain('above 1'); // blank type = pct
  });

  it('warns on flat fees that look like fractions or exceed the expected cap', () => {
    expect(checkRateRow('fixed_fee', { rate: 0.14 }).warnings[0]).toContain('under ₹1');
    expect(checkRateRow('franchise_fee', { rate: 0.02 }).warnings[0]).toContain('under ₹1');
    expect(checkRateRow('pick_pack', { rate: 5000 }).warnings[0]).toContain('above the ₹500 expected');
    expect(checkRateRow('reverse_shipping', { national_fee: 2500 }).warnings[0]).toContain('National fee');
    expect(checkRateRow('collection_fee', { prepaid: 0.5, prepaid_type: 'flat' }).warnings[0]).toContain('under ₹1');
  });

  it('rejects values no row can hold', () => {
    expect(checkRateRow('commission', { rate: -0.01 }).errors).toEqual(['rate must be a non-negative number']);
    expect(checkRateRow('commission', { rate: '14%' }).errors).toEqual(['rate must be a non-negative number']);
    expect(checkRateRow('commission', { rate: 100 }).errors[0]).toContain('the most its column can hold');
    expect(checkRateRow('collection_fee', { prepaid: 150, prepaid_type: 'flat' }).errors[0]).toContain('prepaid must be below 100');
    expect(checkRateRow('reverse_shipping', { local_fee: -5 }).errors).toEqual(['local_fee must be a non-negative number']);
    expect(checkRateRow('fixed_fee', { price_min: -1, rate: 5 }).errors).toEqual(['price_min must be 0 or more']);
    expect(checkRateRow('fixed_fee', { price_min: 'abc', rate: 5 }).errors).toEqual(['price_min must be a number']);
    expect(checkRateRow('fixed_fee', { price_min: 501, price_max: 500, rate: 5 }).errors).toEqual(['price_min must be ≤ price_max']);
  });

  it('applies column limits after PostgreSQL rounds to the column scale', () => {
    expect(checkRateRow('commission', { rate: 99.9999999 }).errors[0]).toContain('rate must be below 100');
    expect(checkRateRow('commission', { rate: 99.999999 }).errors).toEqual([]);
    expect(checkRateRow('fixed_fee', { rate: 99999999.996 }).errors[0]).toContain('rate must be below');
    expect(checkRateRow('fixed_fee', { price_max: 9999999999.995, rate: 5 }).errors[0]).toContain('price_max must be below');
  });

  it('only accepts pct or flat collection types, normalising their case', () => {
    expect(checkRateRow('collection_fee', { prepaid: 1, prepaid_type: 'percent' }).errors)
      .toEqual(['prepaid_type must be "pct" or "flat"']);
    const result = checkRateRow('collection_fee', { prepaid: 0.01, prepaid_type: ' PCT ', postpaid: 10, postpaid_type: 'Flat' });
    expect(issues(result)).toEqual(clean);
    expect(result.row).toMatchObject({ prepaid_type: 'pct', postpaid_type: 'flat' });
  });

  it('treats a blank or null price_max as "no upper limit", not 0', () => {
    expect(checkRateRow('commission', { price_min: 500, price_max: '', rate: 0.1 }).errors).toEqual([]);
    expect(checkRateRow('commission', { price_min: 500, price_max: null, rate: 0.1 }).errors).toEqual([]);
  });
});
