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

  it('skips repeated embedded header rows seamlessly', () => {
    const headerRow = parseAmazonSettlementLine(
      ['settlement-id', 'transaction-type', 'amount-type', 'amount-description', 'amount', 'posted-date', 'quantity-purchased', 'currency', 'order-item-code'],
      index,
    );
    expect(headerRow.skip).toBe(true);
    expect(headerRow.error).toBeUndefined();
  });

  it('handles SheetJS dense mode cell objects and normalizes Amazon date formats', () => {
    const denseRow = [
      { t: 'n', v: 26816726482 },
      { t: 's', v: 'Order' },
      { t: 's', v: 'ItemFees' },
      { t: 's', v: 'Commission' },
      { t: 'n', v: -135.5 },
      { t: 's', v: '31.03.2026' },
      { t: 'n', v: 1 },
      { t: 's', v: 'INR' },
      { t: 's', v: '408-1234567-8901234' },
    ];
    const parsed = parseAmazonSettlementLine(denseRow, index);
    expect(parsed.error).toBeUndefined();
    expect(parsed.values.settlement_id).toBe('26816726482');
    expect(parsed.values.amount).toBe(-135.5);
    expect(parsed.values.posted_date).toBe('2026-03-31');
    expect(parsed.values.currency).toBe('INR');
  });
});

