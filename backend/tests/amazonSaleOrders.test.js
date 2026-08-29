import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHeaderIndex, parseAmazonSaleOrderRow } from '../routes/amazonUpload.js';

const uploadRoute = fs.readFileSync(new URL('../routes/amazonUpload.js', import.meta.url), 'utf8');
const templateRoute = fs.readFileSync(new URL('../routes/upload.js', import.meta.url), 'utf8');
const healthRoute = fs.readFileSync(new URL('../routes/uploadHealth.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../db/initDb.js', import.meta.url), 'utf8');
const uploadPage = fs.readFileSync(
  new URL('../../frontend/src/pages/UploadPage.jsx', import.meta.url),
  'utf8',
);

describe('Amazon Sale Order workflow', () => {
  it('accepts the renewed 14-column Sale Order format', () => {
    expect(uploadRoute).toContain("router.post('/amazon-sale-orders'");
    for (const header of [
      'Customer Shipment Date',
      'Merchant SKU',
      'Amazon Order Id',
      'Product Amount',
      'Shipping Amount',
      'Gift Amount',
      'Shipment To Postal Code',
    ]) {
      expect(uploadRoute).toContain(`'${header}'`);
      expect(templateRoute).toContain(`'${header}'`);
    }
  });

  it('keeps sale revenue components distinct and batches the upsert', () => {
    expect(schema).toContain("['product_amount',          'NUMERIC(14,2)']");
    expect(schema).toContain("['sale_shipping_amount',    'NUMERIC(14,2)']");
    expect(schema).toContain("['sale_gift_amount',        'NUMERIC(14,2)']");
    expect(uploadRoute).toContain('await forEachDbBatch(rows, fields.length');
  });

  it('validates each primary Sale Order financial row before calculating revenue', () => {
    const headers = [
      'Customer Shipment Date', 'Merchant SKU', 'FNSKU', 'ASIN', 'Quantity', 'Amazon Order Id',
      'Currency', 'Product Amount', 'Shipping Amount', 'Gift Amount',
    ];
    const index = buildHeaderIndex(headers);
    const valid = parseAmazonSaleOrderRow(
      ['24/08/2026', 'SKU-1', 'X001', 'B012345678', '2', '405-1001', 'INR', '₹1,000', '50', '0'],
      index,
    );
    expect(valid.error).toBeUndefined();
    expect(valid.values).toMatchObject({ orderId: '405-1001', shipmentDate: '2026-08-24', quantity: 2, productAmount: 1000 });

    expect(parseAmazonSaleOrderRow(
      ['24/08/2026', 'SKU-1', 'X001', 'B012345678', '2', '405-1001', 'INR', '12oops', '50', '0'],
      index,
    ).error).toContain('invalid Product Amount');
    expect(parseAmazonSaleOrderRow(
      ['24/08/2026', 'SKU-1', 'X001', 'B012345678', '1.5', '405-1001', 'INR', '1000', '50', '0'],
      index,
    ).error).toContain('Quantity must be a positive whole number');
  });

  it('removes Order Reports from the active Data Hub checklist', () => {
    expect(uploadPage).toContain("key: 'amazon-sale-orders'");
    expect(uploadPage).not.toContain("key: 'amazon-order-reports'");
    expect(healthRoute).toContain("key: 'amazon-sale-orders'");
    expect(healthRoute).not.toContain("key: 'amazon-order-reports'");
  });

  it('uses indexed settlement sources for Upload health instead of expanding the reporting view', () => {
    expect(healthRoute).toContain('FROM amazon_settlement_lines');
    expect(healthRoute).toContain('FROM fk_settlement_orders');
    expect(healthRoute).not.toContain('FROM unified_settlements us');
    expect(schema).toContain("CURRENT_SCHEMA_VERSION = '2026.08.connection-stability-1'");
  });
});
