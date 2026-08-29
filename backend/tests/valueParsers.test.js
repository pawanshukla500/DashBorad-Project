import { describe, expect, it } from 'vitest';
import { optionalInteger, optionalNumber, optionalString } from '../utils/valueParsers.js';

describe('shared upload value parsers', () => {
  it('preserves zero and parses formatted currency', () => {
    expect(optionalNumber(0)).toBe(0);
    expect(optionalNumber('₹1,234.50')).toBe(1234.5);
    expect(optionalNumber('(250.00)')).toBe(-250);
    expect(optionalNumber('12oops')).toBeNull();
  });

  it('normalizes empty marketplace values', () => {
    expect(optionalString(' N/A ')).toBeNull();
    expect(optionalString(' SKU-1 ')).toBe('SKU-1');
  });

  it('truncates optional integers consistently', () => {
    expect(optionalInteger('3.9')).toBe(3);
  });
});
