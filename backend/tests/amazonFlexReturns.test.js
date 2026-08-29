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
});
