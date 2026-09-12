import { describe, expect, it } from 'vitest';
import {
  buildHeaderIndex,
  flexReturnItemKey,
  hasHeader,
  isFlexReturnDelivered,
  parseAmazonFbaReturnRow,
  parseAmazonFlexReturnRow,
} from '../routes/amazonUpload.js';

describe('Amazon Flex return receipt rule', () => {
  it('marks only the marketplace delivery status as received', () => {
    expect(isFlexReturnDelivered('Returned to Seller')).toBe(true);
    expect(isFlexReturnDelivered(' returned TO seller ')).toBe(true);
    expect(isFlexReturnDelivered('OUT_FOR_DELIVERY')).toBe(false);
    expect(isFlexReturnDelivered('Return initiated')).toBe(false);
  });

  it('does not treat the OTP flag as a delivery status', () => {
    expect(isFlexReturnDelivered('Yes')).toBe(false);
  });

  it('accepts Amazon headers whether they use spaces or hyphens', () => {
    const index = buildHeaderIndex(['RMA ID', 'Customer Order ID', 'Return Type']);
    expect(hasHeader(index, 'rma-id')).toBe(true);
    expect(hasHeader(index, 'Customer Order ID')).toBe(true);
  });

  it('uses tracking plus seller SKU when an undelivered return has no RMA', () => {
    const firstExport = flexReturnItemKey({
      rmaId: '', sellerSku: 'SKU-RED-M', reverseTrackingId: 'REV-123',
      forwardTrackingId: 'FWD-123', shipmentId: 'SHIP-1', orderId: '402-1111222-3333444', rowNumber: 2,
    });
    const reorderedExport = flexReturnItemKey({
      rmaId: '', sellerSku: 'SKU-RED-M', reverseTrackingId: 'REV-123',
      forwardTrackingId: 'FWD-123', shipmentId: 'SHIP-1', orderId: '402-1111222-3333444', rowNumber: 345,
    });

    expect(firstExport).toBe('FLEX-TRACK-REV-123-SKU-RED-M');
    expect(reorderedExport).toBe(firstExport);
  });

  it('rejects unstable or malformed FBA and Flex return rows before an upsert', () => {
    const fbaIndex = buildHeaderIndex(['return-date', 'order-id', 'sku', 'quantity', 'detailed-disposition', 'license-plate-number']);
    expect(parseAmazonFbaReturnRow(['24/08/2026', '402-1', 'SKU-1', '1', 'SELLABLE', ''], fbaIndex).error)
      .toContain('license-plate-number is empty');
    expect(parseAmazonFbaReturnRow(['31/02/2026', '402-1', 'SKU-1', '1', 'SELLABLE', 'LPN-1'], fbaIndex).error)
      .toContain('return-date is invalid');

    const flexIndex = buildHeaderIndex(['Customer Order ID', 'mSKU', 'RMA ID', 'Units', 'Returned with OTP']);
    expect(parseAmazonFlexReturnRow(['402-1', 'SKU-1', '', '1', 'Yes'], flexIndex).error)
      .toContain('stable return identity');
    expect(parseAmazonFlexReturnRow(['402-1', 'SKU-1', 'RMA-1', '1.5', 'No'], flexIndex).error)
      .toContain('Units must be a positive whole number');
  });

  it('classifies FBA returns into RTO for undelivered reasons and CUSTOMER_RETURN for customer reasons, mapping final_condition', () => {
    const fbaIndex = buildHeaderIndex([
      'return-date', 'order-id', 'sku', 'asin', 'fnsku', 'product-name',
      'quantity', 'fulfillment-center-id', 'detailed-disposition', 'reason',
      'license-plate-number', 'customer-comments'
    ]);

    // RTO row
    const rtoParsed = parseAmazonFbaReturnRow([
      '2026-07-31T17:51:42+00:00', '406-111', 'SKU-A', 'B001', 'X001', 'Product A',
      '1', 'BLR5', 'SELLABLE', 'UNDELIVERABLE_REFUSED', 'LPN001', ''
    ], fbaIndex);
    expect(rtoParsed.values.return_type).toBe('RTO');
    expect(rtoParsed.values.final_condition).toBe('SELLABLE');
    expect(rtoParsed.values.disposition).toBe('SELLABLE');

    // Customer Return row
    const custParsed = parseAmazonFbaReturnRow([
      '2026-07-31T17:51:42+00:00', '406-222', 'SKU-B', 'B002', 'X002', 'Product B',
      '1', 'BOM5', 'CUSTOMER_DAMAGED', 'QUALITY_UNACCEPTABLE', 'LPN002', 'Defect in fabric'
    ], fbaIndex);
    expect(custParsed.values.return_type).toBe('CUSTOMER_RETURN');
    expect(custParsed.values.final_condition).toBe('CUSTOMER_DAMAGED');
    expect(custParsed.values.disposition).toBe('CUSTOMER_DAMAGED');
    expect(custParsed.values.customer_comment).toBe('Defect in fabric');
  });

  it('skips rows where Return Status is Customer cancelled pick-up', () => {
    const flexIndex = buildHeaderIndex([
      'Customer Order ID', 'mSKU', 'RMA ID', 'Units', 'Return Status', 'Return Type', 'Return Request Date'
    ]);
    const row = ['402-1234567-8901234', 'SKU-RED-M', 'RMA-999', '1', 'Customer cancelled pick-up', 'CUSTOMER_RETURN', '2026-06-15'];
    const res = parseAmazonFlexReturnRow(row, flexIndex);
    expect(res.skipped).toBe(true);
    expect(res.reason).toContain('Customer cancelled pick-up');
  });

  it('maps UNDELIVERED to RTO and CUSTOMER_RETURN to CUSTOMER_RETURN with >90 transit days cleaned', () => {
    const flexIndex = buildHeaderIndex([
      'Customer Order ID', 'mSKU', 'RMA ID', 'Units', 'Return Status', 'Return Type', 'Return Request Date', 'Days In-transit', 'Days Since Return Complete'
    ]);
    const rtoRow = ['402-1234567-8901234', 'SKU-A', 'RMA-001', '1', 'Returned to Seller', 'UNDELIVERED', '2026-06-15', '>90', '>7'];
    const rtoParsed = parseAmazonFlexReturnRow(rtoRow, flexIndex);
    expect(rtoParsed.values.return_type).toBe('RTO');
    expect(rtoParsed.values.days_in_transit).toBe(90);
    expect(rtoParsed.values.days_since_return_complete).toBe(7);

    const crRow = ['402-1234567-8901234', 'SKU-B', 'RMA-002', '1', 'Returned to Seller', 'CUSTOMER_RETURN', '2026-06-15', '45', '3'];
    const crParsed = parseAmazonFlexReturnRow(crRow, flexIndex);
    expect(crParsed.values.return_type).toBe('CUSTOMER_RETURN');
    expect(crParsed.values.days_in_transit).toBe(45);
    expect(crParsed.values.days_since_return_complete).toBe(3);
  });

  it('parses formatted GMT date strings correctly', () => {
    const flexIndex = buildHeaderIndex([
      'Customer Order ID', 'mSKU', 'RMA ID', 'Units', 'Return Status', 'Return Type', 'Pick -up date', 'Last Updated On'
    ]);
    const row = ['402-1234567-8901234', 'SKU-A', 'RMA-001', '1', 'Returned to Seller', 'UNDELIVERED', 'Tue Jun 16 2026 23:59:50 GMT+0530', 'Wed Jun 24 2026 14:20:00 GMT+0530'];
    const parsed = parseAmazonFlexReturnRow(row, flexIndex);
    expect(parsed.values.return_requested_date).toBe('2026-06-16');
    expect(parsed.values.return_approval_date).toBe('2026-06-24');
  });
});
