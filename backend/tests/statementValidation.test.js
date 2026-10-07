import { describe, expect, it } from 'vitest';
import { checkStatementProvenance, parseStatementPayload } from '../routes/statement.js';

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

describe('statement PDF provenance check', () => {
  const pdfText = 'Sale\nAmount 1,53,05,872.00  Commission Fee (50.00)  Shipping Fee 1,234.5  Total Settled 1,53,04,587.50';
  const parsed = items => ({ items, totalSettled: 15304587.5 });

  it('matches amounts in the comma-stripped text and descriptions across reflowed whitespace and case', () => {
    expect(checkStatementProvenance(parsed([
      { description: 'Sale Amount', credits: 15305872, debits: 0, net: 15305872 },
      { description: 'COMMISSION FEE', credits: 0, debits: 50, net: -50 },
      { description: 'Shipping Fee', credits: 0, debits: 1234.5, net: -1234.5 },
    ]), pdfText)).toEqual({ items: [[], [], []], totalSettled: [] });
  });

  it('flags figures and descriptions the model did not read from the PDF', () => {
    const result = checkStatementProvenance({
      items: [
        { description: 'Sale Amount', credits: 15305827, debits: 0, net: 15305827 },
        { description: 'Promotional Rebate', credits: 0, debits: 0, net: 0 },
      ],
      totalSettled: 99,
    }, pdfText);
    expect(result.items[0]).toEqual([
      'Credits 15305827 is not in the PDF text',
      'Net 15305827 is not in the PDF text',
    ]);
    expect(result.items[1]).toEqual(['Description is not in the PDF text']);
    expect(result.totalSettled).toEqual(['Total settled 99 is not in the PDF text']);
  });
});

describe('statement provenance review fixes', () => {
  it('needs a whole number, not a digit substring, so a dropped or partial figure is flagged', () => {
    const text = 'Sale Amount 1,53,05,872.00 1,53,05,872.00';
    const flagged = amount => checkStatementProvenance({
      items: [{ description: 'Sale Amount', credits: amount, debits: 0, net: amount }], totalSettled: 0,
    }, text).items[0];
    expect(flagged(15305872)).toEqual([]);
    expect(flagged(1530587)).toEqual(['Credits 1530587 is not in the PDF text', 'Net 1530587 is not in the PDF text']);
    expect(flagged(5305)).toHaveLength(2);
  });

  it('still finds amounts in cells pdf-parse joined without spaces', () => {
    const text = 'Commission Fee12,450.50-12,450.50Collection Fee3,210.00-3,210.00';
    expect(checkStatementProvenance({
      items: [
        { description: 'Commission Fee', credits: 0, debits: 12450.5, net: -12450.5 },
        { description: 'Collection Fee', credits: 0, debits: 3210, net: -3210 },
      ],
      totalSettled: 0,
    }, text)).toEqual({ items: [[], []], totalSettled: [] });
  });

  it('rejects a Sale Amount so small the percentages could not be stored', () => {
    expect(() => parseStatementPayload({
      ...validStatement,
      items: [
        { description: 'Sale Amount', credits: 0.5, debits: 0, net: 0.5 },
        { description: 'Commission Fee', credits: 0, debits: 50, net: -50 },
      ],
    })).toThrow('Line 2 is more than 100 times the Sale Amount');
  });
});
