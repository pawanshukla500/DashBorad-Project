import { describe, expect, it } from 'vitest';
import { buildHeaderIndex, validateLegacyAmazonOrderRow } from '../routes/amazonUpload.js';

describe('legacy Amazon order import validation', () => {
  it('rejects populated corrupt values instead of truncating or dropping them', () => {
    const headers = ['amazon-order-id', 'order-item-id', 'sku', 'purchase-date', 'quantity', 'item-price', 'is-business-order', 'currency'];
    const idx = buildHeaderIndex(headers);

    expect(validateLegacyAmazonOrderRow(
      ['171-0000000-0000000', '123', 'SKU-1', '2026-08-20', '1.5', '299', 'yes', 'INR'], idx, { report: true },
    )).toBe('quantity must be a whole number');
    expect(validateLegacyAmazonOrderRow(
      ['171-0000000-0000000', '123', 'SKU-1', '2026-08-20', '1', '299oops', 'yes', 'INR'], idx, { report: true },
    )).toContain('item-price is invalid');
    expect(validateLegacyAmazonOrderRow(
      ['171-0000000-0000000', '123', 'SKU-1', '2026-08-20', '1', '299', 'maybe', 'INR'], idx, { report: true },
    )).toContain('is-business-order must be Yes/No');
  });

  it('validates summary dates and money cells before their upsert', () => {
    const headers = ['Order ID', 'SKU', 'Order Date', 'QTY', 'Selling Price'];
    const idx = buildHeaderIndex(headers);

    expect(validateLegacyAmazonOrderRow(['171-0000000-0000000', 'SKU-1', '31/02/2026', '1', '299'], idx))
      .toContain('order date is invalid');
    expect(validateLegacyAmazonOrderRow(['171-0000000-0000000', 'SKU-1', '20/08/2026', '1', '299oops'], idx))
      .toContain('selling price is invalid');
  });
});
