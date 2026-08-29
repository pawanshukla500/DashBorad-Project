import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const uploadRoutes = fs.readFileSync(new URL('../routes/upload.js', import.meta.url), 'utf8');
const dataCenter = fs.readFileSync(new URL('../../frontend/src/pages/UploadPage.jsx', import.meta.url), 'utf8');

describe('current data coverage', () => {
  it('returns current business-date ranges for each active marketplace feed', () => {
    expect(uploadRoutes).toContain("SELECT 'amazon_sale_orders', order_date");
    expect(uploadRoutes).toContain("SELECT 'amazon_settlement', posted_date");
    expect(uploadRoutes).toContain("SELECT 'myntra_ej_invoices', COALESCE(payment_date, invoice_date)");
    expect(uploadRoutes).toContain('dataCoverage: coverageMap');
  });

  it('shows upload time separately from the latest business-data date', () => {
    expect(dataCenter).toContain('Current data coverage');
    expect(dataCenter).toContain('Updated through {through}');
    expect(dataCenter).toContain('>Uploaded at</th>');
    expect(dataCenter).toContain('↻ Refresh dates');
  });
});
