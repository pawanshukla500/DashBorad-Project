import { describe, expect, it } from 'vitest';
import { parseCatalogCogsInput, parseSkuMasterInput } from '../routes/upload.js';

describe('SKU and catalog COGS validation', () => {
  it('keeps valid spreadsheet currencies and weights in a canonical form', () => {
    expect(parseSkuMasterInput({
      listing_sku: 'TEE-BLK-M', marketplace: 'Flipkart', cogs: '₹1,250.50',
      launch_date: '24/08/2026', weight_slab: '0.5 - 1 kg', brand_name: 'Recon Central',
    })).toMatchObject({
      listingSku: 'TEE-BLK-M', marketplace: 'flipkart', cogs: 1250.5,
      launchDate: '2026-08-24', weightSlab: 1, brandName: 'Recon Central',
    });

    expect(parseCatalogCogsInput({
      catalog_id: 'B012345678', marketplace: 'amazon', cogs: '99.25',
    })).toMatchObject({ catalogId: 'B012345678', marketplace: 'amazon', cogs: 99.25 });
  });

  it('rejects malformed or negative profitability inputs instead of coercing them to zero', () => {
    expect(() => parseSkuMasterInput({ listing_sku: 'TEE-BLK-M', cogs: '12oops' }))
      .toThrow('COGS must be a non-negative amount');
    expect(() => parseSkuMasterInput({ listing_sku: 'TEE-BLK-M', cogs: '-1' }))
      .toThrow('COGS must be a non-negative amount');
    expect(() => parseSkuMasterInput({ listing_sku: 'TEE-BLK-M', weight_slab: '1oops' }))
      .toThrow('Weight slab must be a positive number');
    expect(() => parseCatalogCogsInput({ catalog_id: 'B012345678', marketplace: 'Amazon India', cogs: 1 }))
      .toThrow('Marketplace may contain only lowercase letters');
  });
});
