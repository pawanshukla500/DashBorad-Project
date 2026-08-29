import { describe, expect, it } from 'vitest';
import { buildHeaderIndex, parseAmazonSettlementLine } from '../routes/amazonUpload.js';

describe('Amazon settlement line validation', () => {
  const headers = [
    'Settlement ID', 'Transaction Type', 'Amount Type', 'Amount Description', 'Amount',
    'Posted Date', 'Quantity Purchased', 'Currency', 'Order Item Code',
  ];
  const index = buildHeaderIndex(headers);

  it('keeps signed settlement money and rejects corrupted cells', () => {
    const valid = parseAmazonSettlementLine(
      ['S-101', 'ServiceFee', 'ItemRelatedFee', 'Commission', '-85.25', '2026-08-24', '1', 'INR', '12345678901234'],
      index,
    );
    expect(valid.error).toBeUndefined();
    expect(valid.values).toMatchObject({ settlement_id: 'S-101', amount: -85.25, posted_date: '2026-08-24', quantity: 1 });

    expect(parseAmazonSettlementLine(
      ['S-101', 'ServiceFee', 'ItemRelatedFee', 'Commission', '85oops', '2026-08-24', '1', 'INR', '12345678901234'],
      index,
    ).error).toContain('invalid amount');
  });

  it('does not invent a rounded order-item code from scientific notation', () => {
    const parsed = parseAmazonSettlementLine(
      ['', 'Order', 'Principal', 'Principal', '250', '2026-08-24', '1', 'INR', '1.2345678901234E+13'],
      index,
      { fallbackSettlementId: 'S-101' },
    );

    expect(parsed.scientificOrderItemCode).toBe(true);
    expect(parsed.values.order_item_code).toBeNull();
  });
});
