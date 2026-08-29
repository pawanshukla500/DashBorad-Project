import { describe, expect, it } from 'vitest';
import { optionalQueryText, pagination, positiveInt } from '../utils/requestParams.js';

describe('request parameter helpers', () => {
  it('clamps pagination to safe positive bounds', () => {
    expect(pagination({ page: '-3', pageSize: '10000' }, { defaultPageSize: 20, maxPageSize: 100 }))
      .toEqual({ page: 1, pageSize: 100, offset: 0 });
  });

  it('uses fallbacks for non-numeric values', () => {
    expect(positiveInt('not-a-number', 7)).toBe(7);
    expect(positiveInt('12oops', 7)).toBe(7);
    expect(positiveInt('1.5', 7)).toBe(7);
  });

  it('accepts a bounded search string but rejects ambiguous or oversized values', () => {
    expect(optionalQueryText('  order-123  ', 'Search')).toBe('order-123');
    expect(() => optionalQueryText(['order-123'], 'Search')).toThrow('Search must be text');
    expect(() => optionalQueryText('a'.repeat(101), 'Search', { maxLength: 100 }))
      .toThrow('Search must contain 100 characters or fewer');
  });
});
