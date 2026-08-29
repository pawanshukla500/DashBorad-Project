import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const dataCenter = fs.readFileSync(
  new URL('../../frontend/src/pages/UploadPage.jsx', import.meta.url),
  'utf8',
);
const uploadRoutes = fs.readFileSync(new URL('../routes/upload.js', import.meta.url), 'utf8');

describe('Data Center dataset choices', () => {
  it('keeps each marketplace limited to its supported upload flow', () => {
    expect(dataCenter).toContain("flipkart: ['orders', 'returns', 'fk-settlement']");
    expect(dataCenter).toContain("amazon: ['amazon-sale-orders', 'amazon-fba-returns', 'amazon-flex-returns', 'amazon-settlement']");
    expect(dataCenter).toContain("myntra: ['myntra-orders', 'myntra-returns', 'myntra-invoices']");
    expect(dataCenter).toContain('dataTypesForMarketplace(marketplace).map');
    expect(dataCenter).not.toContain('amazonOnly');
    expect(dataCenter).not.toContain('myntraOnly');
    expect(dataCenter).not.toContain('flipkartOnly');
    expect(dataCenter).not.toContain('hideOnAmazon');
  });

  it('only confirms an upload remark after the database row was updated', () => {
    expect(uploadRoutes).toContain('RETURNING id, remark');
    expect(uploadRoutes).toContain("Upload history entry was not found.");
    expect(dataCenter).toContain('await onSaved?.();');
    expect(dataCenter).toContain('The remark could not be saved. Please try again.');
  });
});
