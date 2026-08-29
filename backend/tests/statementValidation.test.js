import { describe, expect, it } from 'vitest';
import { parseStatementPayload } from '../routes/statement.js';

const validStatement = {
  period: '2026-08-01 to 2026-08-31',
  month: '2026-08',
  items: [
    { description: 'Sale Amount', credits: '₹1,000.00', debits: 0, net: 1000 },
    { description: 'Commission Fee', credits: 0, debits: 50, net: -50 },
  ],
  totalSettled: 950,
};

describe('statement PDF extraction validation', () => {
  it('accepts a financially consistent extracted statement before replacing the month', () => {
    expect(parseStatementPayload(validStatement)).toMatchObject({
      month: '2026-08', period: '2026-08-01 to 2026-08-31', saleAmount: 1000, totalSettled: 950,
    });
  });

  it('rejects corrupt numeric values and period mismatches before writing any rows', () => {
    expect(() => parseStatementPayload({
      ...validStatement,
      items: [{ description: 'Sale Amount', credits: '100oops', debits: 0, net: 100 }],
    })).toThrow('Line 1 credits must be a number');
    expect(() => parseStatementPayload({ ...validStatement, month: '2026-07' }))
      .toThrow('Statement month must match');
    expect(() => parseStatementPayload({
      ...validStatement,
      items: [{ description: 'Sale Amount', credits: 100, debits: 0, net: 99 }],
    })).toThrow('Line 1 net must equal credits minus debits');
  });
});
