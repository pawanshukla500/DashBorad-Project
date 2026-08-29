import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dataCenter = fs.readFileSync(
  new URL('../../frontend/src/pages/UploadPage.jsx', import.meta.url),
  'utf8',
);
const invoiceRoutes = fs.readFileSync(new URL('../routes/mpSettlement.js', import.meta.url), 'utf8');
const uploadRoutes = fs.readFileSync(new URL('../routes/upload.js', import.meta.url), 'utf8');
const myntraRoutes = fs.readFileSync(new URL('../routes/myntraUpload.js', import.meta.url), 'utf8');

describe('Myntra Data Center accounts', () => {
  it('shows separate EJ and VB upload selections', () => {
    expect(dataCenter).toContain("sellerAccount: 'myntra_ej'");
    expect(dataCenter).toContain("sellerAccount: 'myntra_vb'");
    expect(dataCenter).toContain("label: 'Myntra (EJ)'");
    expect(dataCenter).toContain("label: 'Myntra (VB)'");
  });

  it('sends the selected account through the validated invoice importer', () => {
    expect(dataCenter).toContain("uploadMpInvoices('myntra', uploadFd, uploadContext.sellerAccount)");
    expect(invoiceRoutes).toContain("resolveSellerAccount(pool, mp, req.query.seller_account");
    expect(invoiceRoutes).toContain("const logType = mp === 'myntra' ? `${sellerAccount}_invoices`");
  });

  it('offers the same dedicated Order and Return layouts for each account', () => {
    expect(dataCenter).toContain("key: 'myntra-orders'");
    expect(dataCenter).toContain("key: 'myntra-returns'");
    expect(dataCenter).toContain("uploadMyntraData(");
    expect(myntraRoutes).toContain("['orders', 'returns'].includes(type)");
    expect(myntraRoutes).toContain("resolveMyntraAccount(pool, req.query.seller_account");
    expect(myntraRoutes).toContain('validateSellerIds(rows, type, sellerAccount)');
    expect(myntraRoutes).toContain("['marketplace', 'seller_account', 'order_item_id']");
  });

  it('keeps clear operations scoped to the chosen Myntra account', () => {
    expect(uploadRoutes).toContain("forceSellerAccount: 'myntra_ej'");
    expect(uploadRoutes).toContain("forceSellerAccount: 'myntra_vb'");
    expect(uploadRoutes).toContain('DELETE FROM ${table} WHERE marketplace = $1 AND seller_account = $2');
    expect(uploadRoutes).toContain("myntra_ej_orders:");
    expect(uploadRoutes).toContain("myntra_vb_returns:");
  });

  it('keeps existing generic order and return uploads compatible with account-scoped keys', () => {
    expect(uploadRoutes).toContain('ON CONFLICT (marketplace, seller_account, ${keyCol})');
    expect(uploadRoutes).toContain("seller_account = EXCLUDED.seller_account");
  });

  it('stores and constrains the known seller IDs at the database boundary', () => {
    const schema = fs.readFileSync(new URL('../db/initDb.js', import.meta.url), 'utf8');
    expect(schema).toContain("seller_account = 'myntra_ej' AND seller_id = '45833'");
    expect(schema).toContain("seller_account = 'myntra_vb' AND seller_id = '10708'");
  });
});
