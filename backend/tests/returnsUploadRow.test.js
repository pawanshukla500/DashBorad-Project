import { describe, expect, it } from 'vitest';
import { RETURN_FIELD_INDEX, fieldIndex, parseReturnUploadRow } from '../routes/upload.js';

function reader(row) {
  const g = (field) => row[field] ?? '';
  g.dateFormat = () => null;
  return g;
}

const flipkartReturn = {
  return_id: 'RI:12345',
  order_item_id: 'OI:4400123',
  order_id: 'OD:998877',
  return_requested_date: '2026-09-01',
  return_status: 'approved',
  return_reason: 'SIZE_ISSUE',
  sku: 'SKU:EJ1201-16001',
  product_title: 'Women Printed Kurta Set',
  quantity: '1',
};

const parse = (row, marketplace = 'flipkart', rowIndex = 0) =>
  parseReturnUploadRow(reader(row), { marketplace, rowIndex });
const at = (vals, name) => vals[RETURN_FIELD_INDEX[name]];

describe('generic returns upload row parsing', () => {
  it('accepts a normal titled Flipkart return (regression: quantity was read from product_title)', () => {
    const { vals, reason } = parse(flipkartReturn);

    expect(reason).toBeUndefined();
    expect(at(vals, 'return_id')).toBe('12345');
    expect(at(vals, 'order_item_id')).toBe('4400123');
    expect(at(vals, 'order_id')).toBe('998877');
    expect(at(vals, 'sku')).toBe('EJ1201-16001');
    expect(at(vals, 'product_title')).toBe('Women Printed Kurta Set');
    expect(at(vals, 'quantity')).toBe(1);
  });

  it('rejects zero, fractional and non-numeric quantities', () => {
    for (const quantity of ['0', '1.5', 'two']) {
      expect(parse({ ...flipkartReturn, quantity }).reason).toBe('quantity must be a positive whole number');
    }
  });

  it('allows a blank quantity', () => {
    expect(parse({ ...flipkartReturn, quantity: '' }).reason).toBeUndefined();
  });

  it('keys a return without an order item on its return id, or skips it', () => {
    expect(at(parse({ ...flipkartReturn, order_item_id: '' }).vals, 'order_item_id')).toBe('RET_12345');
    expect(parse({ ...flipkartReturn, order_item_id: '', return_id: '' }).reason)
      .toBe('order_item_id and return_id both empty');
  });

  it('synthesises an Amazon key from the order id and the sku column', () => {
    const { vals } = parse(
      { ...flipkartReturn, order_item_id: '', return_id: '', order_id: '171-1234567-1234567', sku: 'AB/12' },
      'amazon',
      4,
    );
    expect(at(vals, 'order_item_id')).toBe('AMZR-171-1234567-1234567-AB_12');
    expect(at(vals, 'return_id')).toBe('AMZR-171-1234567-1234567-AB_12');
  });

  it('maps field names to positions', () => {
    expect(fieldIndex([['a'], ['b'], ['c']])).toEqual({ a: 0, b: 1, c: 2 });
  });
});
