import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NORMALIZED_ORDER_COLUMNS,
  NORMALIZED_RETURN_COLUMNS,
  ORDER_DETAIL_COLUMNS,
  RETURN_DETAIL_COLUMNS,
  fulfillment,
  MYNTRA_SELLER_IDS,
  normalizedOrder,
  normalizedReturn,
  orderDetail,
  orderLifecycle,
  orderReturnType,
  parseMoney,
  returnDetail,
  validateMyntraRow,
  validateSellerIds,
} from '../routes/myntraUpload.js';

describe('Myntra layout mapping', () => {
  const order = {
    'po_type': 'PPMP',
    'order release id': '100019530457',
    'order line id': '11074259318',
    'created on': '3/Apr/2026',
    'seller sku code': 'SELLER-SKU-M',
    'myntra sku code': 'MYNTRA-FSN',
    'brand': 'KALINI',
    'article type': 'Kurtas',
    'final amount': '475',
    'seller price': '416',
    'state': 'UP',
    'city': 'Bareilly',
    'seller warehouse id': '14417',
    'zipcode': '243005',
    'order tracking number': 'MYSP1383140980',
    'delivered on': '7/Apr/2026',
  };
  const returned = {
    'model': 'PPMP',
    'return_id': '100155000000',
    'order_line_id': '11093910482',
    'order_id': '100039181524',
    'return_created_date': '4/24/26',
    'refunded_date': '4/25/26',
    'status': 'Ret Delivered',
    'return_reason': 'Size too small',
    'return_status': 'DLS',
    'type': 'Return',
    'is_refunded': '1',
    'return_tracking_number': 'MYSR1208758327',
    'seller_sku_code': 'SELLER-SKU-M',
    'myntra_sku_code': 'MYNTRA-FSN',
    'quantity': '1',
  };

  it('maps PPMP to Non-FBM and keeps lifecycle information deterministic', () => {
    expect(fulfillment('PPMP')).toBe('Non-FBM');
    expect(fulfillment('SJIT')).toBe('FBM');
    expect(orderLifecycle(order)).toBe('Delivered');
    expect(orderReturnType(order)).toBeNull();
    expect(orderLifecycle({ ...order, 'order tracking number': '' })).toBe('RTO');
  });

  it('uses the order release/line relationship and parses workbook dates safely', () => {
    const mappedOrder = normalizedOrder(order, 'myntra_ej');
    const mappedReturn = normalizedReturn(returned, 'myntra_ej');
    expect(mappedOrder).toHaveLength(NORMALIZED_ORDER_COLUMNS.length);
    expect(mappedReturn).toHaveLength(NORMALIZED_RETURN_COLUMNS.length);
    expect(mappedOrder[NORMALIZED_ORDER_COLUMNS.indexOf('order_id')]).toBe('100019530457');
    expect(mappedOrder[NORMALIZED_ORDER_COLUMNS.indexOf('order_item_id')]).toBe('11074259318');
    expect(mappedOrder[NORMALIZED_ORDER_COLUMNS.indexOf('order_date')]).toBe('2026-04-03');
    expect(mappedReturn[NORMALIZED_RETURN_COLUMNS.indexOf('order_id')]).toBe('100039181524');
    expect(mappedReturn[NORMALIZED_RETURN_COLUMNS.indexOf('order_item_id')]).toBe('11093910482');
    expect(mappedReturn[NORMALIZED_RETURN_COLUMNS.indexOf('return_requested_date')]).toBe('2026-04-24');
  });

  it('retains full source rows in the account-scoped audit tables', () => {
    const detailOrder = orderDetail(order, 'myntra_vb', 'batch-1');
    const detailReturn = returnDetail(returned, 'myntra_vb', 'batch-1');
    expect(detailOrder).toHaveLength(ORDER_DETAIL_COLUMNS.length);
    expect(detailReturn).toHaveLength(RETURN_DETAIL_COLUMNS.length);
    expect(JSON.parse(detailOrder[ORDER_DETAIL_COLUMNS.indexOf('source_data')])).toEqual(order);
    expect(JSON.parse(detailReturn[RETURN_DETAIL_COLUMNS.indexOf('source_data')])).toEqual(returned);
  });

  it('rejects a VB file before it can be imported under the EJ account', () => {
    expect(MYNTRA_SELLER_IDS).toEqual({ myntra_vb: '10708', myntra_ej: '45833' });
    expect(() => validateSellerIds([{ ...order, 'seller id': '10708' }], 'orders', 'myntra_ej'))
      .toThrow('Wrong Myntra account selected');
    expect(() => validateSellerIds([{ ...returned, seller_id: '45833' }], 'returns', 'myntra_vb'))
      .toThrow('Wrong Myntra account selected');
    expect(() => validateSellerIds([{ ...order, 'seller id': '45833' }], 'orders', 'myntra_ej')).not.toThrow();
  });

  it('rejects malformed money, dates, and return quantities rather than coercing them to zero', () => {
    expect(parseMoney('₹1,234.50')).toBe(1234.5);
    expect(parseMoney('(250.00)')).toBe(-250);
    expect(parseMoney('not available')).toBeNull();

    expect(validateMyntraRow({ ...order, 'created on': '2026-02-30' }, 'orders'))
      .toContain('invalid created on date');
    expect(validateMyntraRow({ ...order, 'final amount': 'not available' }, 'orders'))
      .toContain('invalid final amount amount');
    expect(validateMyntraRow({ ...returned, quantity: '0' }, 'returns'))
      .toContain('invalid quantity');
    expect(validateMyntraRow({ ...returned, is_refunded: 'perhaps' }, 'returns'))
      .toContain('invalid is_refunded');
  });
});
