import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NORMALIZED_ORDER_COLUMNS,
  NORMALIZED_RETURN_COLUMNS,
  ORDER_DETAIL_COLUMNS,
  RETURN_DETAIL_COLUMNS,
  RETURN_HEADERS,
  fulfillment,
  MYNTRA_SELLER_IDS,
  normalizedOrder,
  normalizedReturn,
  orderDetail,
  orderLifecycle,
  orderReturnType,
  parseMoney,
  parseSheet,
  resolveReturnCreatedDate,
  returnDetail,
  synthesizedBlankTrackingReturn,
  validateLayout,
  validateMyntraRow,
  validateSellerIds,
  isRepeatedMyntraHeader,
} from '../routes/myntraUpload.js';
import { getPool, isDbConfigured } from '../db/index.js';
import { initDb } from '../db/initDb.js';

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
    expect(orderLifecycle({ ...order, 'order tracking number': '' })).toBe('Cancelled');
    expect(orderReturnType({ ...order, 'order tracking number': '' })).toBe('Courier Return');
  });

  it('synthesizes a Courier Return for orders with blank tracking number with Cancel Before Dispached reason', () => {
    const blankTrackingOrder = {
      ...order,
      'order tracking number': '',
      'cancelled on': '10-Apr-2026',
      'cancellation reason': 'Delayed Delivery Cancellation',
    };
    expect(orderLifecycle(blankTrackingOrder)).toBe('Cancelled');
    expect(orderReturnType(blankTrackingOrder)).toBe('Courier Return');
    const synthesized = synthesizedBlankTrackingReturn(blankTrackingOrder, 'myntra_vb');
    expect(synthesized).toHaveLength(NORMALIZED_RETURN_COLUMNS.length);
    expect(synthesized[NORMALIZED_RETURN_COLUMNS.indexOf('return_id')]).toBe('RTO-11074259318');
    expect(synthesized[NORMALIZED_RETURN_COLUMNS.indexOf('order_item_id')]).toBe('11074259318');
    expect(synthesized[NORMALIZED_RETURN_COLUMNS.indexOf('return_type')]).toBe('Courier Return');
    expect(synthesized[NORMALIZED_RETURN_COLUMNS.indexOf('return_status')]).toBe('Cancelled');
    expect(synthesized[NORMALIZED_RETURN_COLUMNS.indexOf('return_reason')]).toBe('Cancel Before Dispached');
    expect(synthesized[NORMALIZED_RETURN_COLUMNS.indexOf('return_sub_reason')]).toBe('Delayed Delivery Cancellation');
    expect(synthesized[NORMALIZED_RETURN_COLUMNS.indexOf('return_requested_date')]).toBe('2026-04-10');
  });

  it('uses the order release/line relationship and parses workbook dates safely', () => {
    const mappedOrder = normalizedOrder(order, 'myntra_ej');
    const mappedReturn = normalizedReturn(returned, 'myntra_ej');
    expect(mappedOrder).toHaveLength(NORMALIZED_ORDER_COLUMNS.length);
    expect(mappedReturn).toHaveLength(NORMALIZED_RETURN_COLUMNS.length);
    expect(mappedOrder[NORMALIZED_ORDER_COLUMNS.indexOf('order_id')]).toBe('100019530457');
    expect(mappedOrder[NORMALIZED_ORDER_COLUMNS.indexOf('order_item_id')]).toBe('11074259318');
    expect(mappedOrder[NORMALIZED_ORDER_COLUMNS.indexOf('order_date')]).toBe('2026-04-03');
    expect(mappedOrder[NORMALIZED_ORDER_COLUMNS.indexOf('final_invoice_amount')]).toBe(416);
    expect(mappedOrder[NORMALIZED_ORDER_COLUMNS.indexOf('my_share')]).toBe(416);
    expect(mappedOrder[NORMALIZED_ORDER_COLUMNS.indexOf('total_share_amount')]).toBe(416);
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

  it('keeps the gatepass columns present in EJ and VB return exports', () => {
    const withGatepass = {
      ...returned,
      'gatepass_id': 'GP-1001',
      'gatepass_status': 'Closed',
      'gatepass_type': 'CUSTOMER_RETURN',
      'gatepass_lastmodified': '7-May-2026',
    };
    const detail = returnDetail(withGatepass, 'myntra_vb', 'batch-1');
    expect(detail[RETURN_DETAIL_COLUMNS.indexOf('gatepass_id')]).toBe('GP-1001');
    expect(detail[RETURN_DETAIL_COLUMNS.indexOf('gatepass_status')]).toBe('Closed');
    expect(detail[RETURN_DETAIL_COLUMNS.indexOf('gatepass_type')]).toBe('CUSTOMER_RETURN');
    expect(detail[RETURN_DETAIL_COLUMNS.indexOf('gatepass_lastmodified')]).toBe('2026-05-07');
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

  it('considers order_rto_date as return_created_date for RTO returns across both EJ and VB', () => {
    // Typical Myntra RTO row where return_created_date is 1-Jan-1970 and order_rto_date is populated
    const rtoRow1970 = {
      ...returned,
      'type': 'RTO',
      'return_created_date': '1-Jan-1970',
      'order_rto_date': '5-Apr-2026',
    };

    // RTO row where return_created_date is blank
    const rtoRowBlank = {
      ...returned,
      'type': 'RTO',
      'return_created_date': '',
      'order_rto_date': '10-Apr-2026',
    };

    // Standard Customer Return
    const customerReturnRow = {
      ...returned,
      'type': 'Return',
      'return_created_date': '4/24/26',
      'order_rto_date': '',
    };

    // Date resolution
    expect(resolveReturnCreatedDate(rtoRow1970)).toBe('2026-04-05');
    expect(resolveReturnCreatedDate(rtoRowBlank)).toBe('2026-04-10');
    expect(resolveReturnCreatedDate(customerReturnRow)).toBe('2026-04-24');

    // Validation passes for both RTO and standard returns
    expect(validateMyntraRow(rtoRow1970, 'returns')).toBeNull();
    expect(validateMyntraRow(rtoRowBlank, 'returns')).toBeNull();
    expect(validateMyntraRow(customerReturnRow, 'returns')).toBeNull();

    // Normalized return mapping maps order_rto_date into return_requested_date and return_date
    const mappedVbRto = normalizedReturn(rtoRow1970, 'myntra_vb');
    expect(mappedVbRto[NORMALIZED_RETURN_COLUMNS.indexOf('return_requested_date')]).toBe('2026-04-05');
    expect(mappedVbRto[NORMALIZED_RETURN_COLUMNS.indexOf('return_date')]).toBe('2026-04-05');
    expect(mappedVbRto[NORMALIZED_RETURN_COLUMNS.indexOf('return_type')]).toBe('RTO');

    const mappedEjRto = normalizedReturn(rtoRowBlank, 'myntra_ej');
    expect(mappedEjRto[NORMALIZED_RETURN_COLUMNS.indexOf('return_requested_date')]).toBe('2026-04-10');
    expect(mappedEjRto[NORMALIZED_RETURN_COLUMNS.indexOf('return_date')]).toBe('2026-04-10');
    expect(mappedEjRto[NORMALIZED_RETURN_COLUMNS.indexOf('return_type')]).toBe('RTO');

    // Detailed return mapping
    const detailVbRto = returnDetail(rtoRow1970, 'myntra_vb', 'batch-rto');
    expect(detailVbRto[RETURN_DETAIL_COLUMNS.indexOf('return_created_date')]).toBe('2026-04-05');
    expect(detailVbRto[RETURN_DETAIL_COLUMNS.indexOf('order_rto_date')]).toBe('2026-04-05');
  });

  it('supports partner_warehouse_code while ensuring full backward compatibility for older reports', () => {
    // 1. Check RETURN_HEADERS placement: partner_warehouse_code is right between warehouse_id and model
    const whIndex = RETURN_HEADERS.indexOf('warehouse_id');
    const partnerWhIndex = RETURN_HEADERS.indexOf('partner_warehouse_code');
    const modelIndex = RETURN_HEADERS.indexOf('model');
    expect(partnerWhIndex).toBe(whIndex + 1);
    expect(modelIndex).toBe(partnerWhIndex + 1);

    // 2. Validate layout for both old (without partner_warehouse_code) and new (with partner_warehouse_code)
    const oldHeaders = RETURN_HEADERS.filter(h => h !== 'partner_warehouse_code');
    expect(() => validateLayout(oldHeaders, 'returns')).not.toThrow();
    expect(() => validateLayout(RETURN_HEADERS, 'returns')).not.toThrow();

    // 3. Old report without partner_warehouse_code
    const oldRow = {
      ...returned,
      'seller_id': '10708',
      'warehouse_id': '14417',
    };
    const oldDetail = returnDetail(oldRow, 'myntra_vb', 'batch-old');
    expect(oldDetail).toHaveLength(RETURN_DETAIL_COLUMNS.length);
    expect(oldDetail[RETURN_DETAIL_COLUMNS.indexOf('warehouse_id')]).toBe('14417');
    expect(oldDetail[RETURN_DETAIL_COLUMNS.indexOf('partner_warehouse_code')]).toBeNull();

    // 4. New report with partner_warehouse_code
    const newRow = {
      ...returned,
      'seller_id': '10708',
      'warehouse_id': '14417',
      'partner_warehouse_code': '14417',
    };
    const newDetail = returnDetail(newRow, 'myntra_vb', 'batch-new');
    expect(newDetail).toHaveLength(RETURN_DETAIL_COLUMNS.length);
    expect(newDetail[RETURN_DETAIL_COLUMNS.indexOf('warehouse_id')]).toBe('14417');
    expect(newDetail[RETURN_DETAIL_COLUMNS.indexOf('partner_warehouse_code')]).toBe('14417');
  });

  it('applies ensureMyntraPartnerWarehouseSchema and populates columns in the database', async () => {
    if (!(await isDbConfigured())) return;

    await initDb();
    const pool = getPool();

    const cols = await pool.query(
      `SELECT column_name, data_type 
       FROM information_schema.columns 
       WHERE table_name = 'myntra_return_details' 
         AND column_name IN ('warehouse_id', 'partner_warehouse_code')
       ORDER BY column_name`
    );
    expect(cols.rows).toHaveLength(2);
    expect(cols.rows.map(r => r.column_name)).toEqual(['partner_warehouse_code', 'warehouse_id']);

    const versions = await pool.query(
      `SELECT version FROM schema_version WHERE version = '2026.09.myntra-partner-warehouse-1'`
    );
    expect(versions.rows).toHaveLength(1);

    const stats = await pool.query(
      `SELECT count(id)::int as total,
              count(warehouse_id)::int as with_wh,
              count(partner_warehouse_code)::int as with_pwh
       FROM myntra_return_details`
    );
    expect(stats.rows[0].total).toBeGreaterThanOrEqual(0);
  });

  it('parses and validates the user Myntra_VB_Return_Template.xlsx file with zero errors', () => {
    const templatePath = 'C:/Users/Pawan Shukla/Desktop/Myntra_VB_Return_Template.xlsx';
    if (!fs.existsSync(templatePath)) return;

    const buffer = fs.readFileSync(templatePath);
    const { headers, rows } = parseSheet(buffer);

    expect(headers).toContain('partner_warehouse_code');
    expect(headers.indexOf('partner_warehouse_code')).toBe(headers.indexOf('warehouse_id') + 1);
    expect(() => validateLayout(headers, 'returns')).not.toThrow();
    expect(() => validateSellerIds(rows, 'returns', 'myntra_vb')).not.toThrow();
    expect(rows.length).toBe(7568);

    // Validate all rows
    let invalidCount = 0;
    for (const r of rows) {
      if (validateMyntraRow(r, 'returns') !== null) invalidCount++;
    }
    expect(invalidCount).toBe(0);

    // Check first row detailed mapping
    const firstDetail = returnDetail(rows[0], 'myntra_vb', 'batch-template');
    expect(firstDetail[RETURN_DETAIL_COLUMNS.indexOf('warehouse_id')]).toBe('14417');
    expect(firstDetail[RETURN_DETAIL_COLUMNS.indexOf('partner_warehouse_code')]).toBe('14417');
  });

  it('detects repeated header rows and ignores them during order/return seller ID validation', () => {
    const orderRepeatedHeader = {
      'seller id': 'seller id',
      'order release id': 'order release id',
      'order line id': 'order line id',
    };
    expect(isRepeatedMyntraHeader(orderRepeatedHeader, 'orders')).toBe(true);

    const returnRepeatedHeader = {
      'seller_id': 'seller_id',
      'order_id': 'order_id',
      'order_line_id': 'order_line_id',
    };
    expect(isRepeatedMyntraHeader(returnRepeatedHeader, 'returns')).toBe(true);

    const mixedOrderRows = [
      { 'seller id': '45833', 'order release id': '100019530457', 'order line id': '11074259318' },
      { 'seller id': 'seller id', 'order release id': 'order release id', 'order line id': 'order line id' },
      { 'seller id': '45833', 'order release id': '100019530458', 'order line id': '11074259319' },
    ];
    expect(() => validateSellerIds(mixedOrderRows, 'orders', 'myntra_ej')).not.toThrow();

    const mixedReturnRows = [
      { 'seller_id': '10708', 'order_id': '100019530457', 'order_line_id': '11074259318' },
      { 'seller_id': 'seller_id', 'order_id': 'order_id', 'order_line_id': 'order_line_id' },
    ];
    expect(() => validateSellerIds(mixedReturnRows, 'returns', 'myntra_vb')).not.toThrow();
  });
});


