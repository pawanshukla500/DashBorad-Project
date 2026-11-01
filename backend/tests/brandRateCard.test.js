import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  resolveBrandCommissions, 
  resolveFixedFees, 
  resolveReverseShippingSlabs,
  getRealTimeBrandFsnSamples,
  detectBrandRateChanges,
  syncBrandRateCardsToDatabase
} from '../services/brandRateCardService.js';
import { generateBrandwiseRateCardExcel } from '../services/brandwiseExcelExport.js';
import path from 'path';
import fs from 'fs/promises';

describe('Brand-Wise & FSN-Driven Rate Card System', () => {

  describe('Brand-Specific Commission Rules', () => {
    it('Ethnic Junction and Youthnic have identical standard commission', () => {
      const ejRates = resolveBrandCommissions('flipkart', 'ethnic_set', 'Ethnic Junction', 0.0);
      const ytRates = resolveBrandCommissions('flipkart', 'ethnic_set', 'Youthnic', 0.0);

      expect(ejRates).toEqual(ytRates);
      expect(ejRates).toEqual([{ price_min: 0, price_max: 999999, rate: 0.0 }]);
    });

    it('Sangria has different tiered commission structure for kurta/ethnic_set', () => {
      const sangriaRates = resolveBrandCommissions('flipkart', 'ethnic_set', 'Sangria');

      expect(sangriaRates.length).toBe(5);
      expect(sangriaRates[0]).toEqual({ price_min: 0, price_max: 500, rate: 0.0 });
      expect(sangriaRates[1]).toEqual({ price_min: 501, price_max: 800, rate: 0.02 });
      expect(sangriaRates[2]).toEqual({ price_min: 801, price_max: 1000, rate: 0.04 });
      expect(sangriaRates[3]).toEqual({ price_min: 1001, price_max: 10000, rate: 0.10 });
      expect(sangriaRates[4]).toEqual({ price_min: 10001, price_max: 999999, rate: 0.0 });
    });

    it('Sangria top/apparel_set has higher 13% slab', () => {
      const sangriaTop = resolveBrandCommissions('flipkart', 'top', 'Sangria');

      expect(sangriaTop.length).toBe(6);
      expect(sangriaTop.find(s => s.price_min === 1001 && s.price_max === 10000).rate).toBe(0.13);
    });

    it('Shopsy has 0% commission across all categories and brands', () => {
      const shopsyEj = resolveBrandCommissions('shopsy', 'ethnic_set', 'Ethnic Junction');
      const shopsyYt = resolveBrandCommissions('shopsy', 'ethnic_set', 'Youthnic');
      const shopsySa = resolveBrandCommissions('shopsy', 'ethnic_set', 'Sangria');
      const shopsyCat = resolveBrandCommissions('flipkart', 'shopsy_kurta', 'Youthnic');

      expect(shopsyEj).toEqual([{ price_min: 0, price_max: 999999, rate: 0.0 }]);
      expect(shopsyYt).toEqual([{ price_min: 0, price_max: 999999, rate: 0.0 }]);
      expect(shopsySa).toEqual([{ price_min: 0, price_max: 999999, rate: 0.0 }]);
      expect(shopsyCat).toEqual([{ price_min: 0, price_max: 999999, rate: 0.0 }]);
    });
  });

  describe('Fixed Fees & Reverse Shipping Matrix', () => {
    it('Shopsy charges tiered fixed fees (₹0 for <= 1500, ₹10 for > 1500)', () => {
      const fixed = resolveFixedFees('shopsy', 'ethnic_set');
      expect(fixed.map(f => f.fulfilment_type)).toEqual(['Bronze', 'Bronze', 'Silver', 'Silver', 'Gold', 'Gold', 'Diamond', 'Diamond']);
      const bronze0 = fixed.find(f => f.fulfilment_type === 'Bronze' && f.price_min === 0);
      const bronze1500 = fixed.find(f => f.fulfilment_type === 'Bronze' && f.price_min === 1501);
      expect(bronze0.rate).toBe(0);
      expect(bronze1500.rate).toBe(10);
    });

    it('Flipkart charges tiered fixed fees based on order value', () => {
      const fixed = resolveFixedFees('flipkart', 'ethnic_set');
      const bronze0 = fixed.find(f => f.fulfilment_type === 'Bronze' && f.price_min === 0);
      const bronze1500 = fixed.find(f => f.fulfilment_type === 'Bronze' && f.price_min === 1501);

      expect(bronze0.rate).toBe(0);
      expect(bronze1500.rate).toBe(10);
    });

    it('Reverse shipping includes local, zonal, and national fees for Shopsy and Flipkart', () => {
      const rev = resolveReverseShippingSlabs('flipkart', 'ethnic_set');
      expect(rev.length).toBeGreaterThanOrEqual(3);
      expect(rev[0]).toMatchObject({
        weight_slab: '0kg-0.5kg',
        local_fee: 122,
        zonal_fee: 142,
        national_fee: 182
      });

      const shopsyRev = resolveReverseShippingSlabs('shopsy', 'ethnic_set');
      expect(shopsyRev.length).toBe(6);
      expect(shopsyRev[0]).toMatchObject({
        weight_slab: '0kg-0.5kg',
        price_min: 0,
        price_max: 500,
        local_fee: 122,
        zonal_fee: 142,
        national_fee: 182
      });
      expect(shopsyRev[3]).toMatchObject({
        weight_slab: '0.5kg-1kg',
        price_min: 0,
        price_max: 500,
        local_fee: 152,
        zonal_fee: 177,
        national_fee: 227
      });
    });
  });

  describe('Real-Time Brand & FSN Sampling', () => {
    it('queries sample FSNs and order volumes by brand and category', async () => {
      const mockPool = {
        query: vi.fn().mockResolvedValue({
          rows: [
            { marketplace: 'flipkart', category: 'ethnic_set', brand: 'Youthnic', sample_fsn: 'ETH123', sample_sku: 'SKU1', order_count: 500 },
            { marketplace: 'flipkart', category: 'ethnic_set', brand: 'Sangria', sample_fsn: 'ETH456', sample_sku: 'SKU2', order_count: 50 },
            { marketplace: 'shopsy', category: 'shopsy_kurta', brand: 'Ethnic Junction', sample_fsn: 'KTA789', sample_sku: 'SKU3', order_count: 30 }
          ]
        })
      };

      const catalog = await getRealTimeBrandFsnSamples(mockPool);
      expect(catalog.length).toBe(3);
      expect(catalog[0].sample_fsn).toBe('ETH123');
      expect(catalog[1].brand).toBe('Sangria');
      expect(catalog[2].marketplace).toBe('shopsy');
    });

    it('scopes sample FSNs to the requested marketplace and seller account', async () => {
      const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };

      await getRealTimeBrandFsnSamples(mockPool, { marketplace: 'flipkart', sellerAccount: 'seller_ej' });

      const [query, params] = mockPool.query.mock.calls[0];
      expect(query).toContain('marketplace = $1');
      expect(query).toContain("COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2");
      expect(params).toEqual(['flipkart', 'seller_ej']);
    });
  });

  describe('Change Detection & Idempotent Database Sync', () => {
    it('detects changes when no active rates exist in DB', async () => {
      const mockPool = {
        query: vi.fn().mockResolvedValue({ rows: [] })
      };

      const testCards = [{
        marketplace: 'flipkart',
        category: 'ethnic_set',
        brand: 'Youthnic',
        sample_fsn: 'ETH123',
        commissions: [{ price_min: 0, price_max: 999999, rate: 0.0 }]
      }];

      const changes = await detectBrandRateChanges(testCards, mockPool);
      expect(changes.length).toBe(1);
      expect(changes[0].reason).toContain('New category & brand commission profile');
    });

    it('detects no changes when DB active rates match perfectly', async () => {
      const mockPool = {
        query: vi.fn().mockResolvedValue({
          rows: [{ price_min: '0.00', price_max: '999999.00', rate: '0.000000' }]
        })
      };

      const testCards = [{
        marketplace: 'flipkart',
        category: 'ethnic_set',
        brand: 'Youthnic',
        sample_fsn: 'ETH123',
        commissions: [{ price_min: 0, price_max: 999999, rate: 0.0 }]
      }];

      const changes = await detectBrandRateChanges(testCards, mockPool);
      expect(changes.length).toBe(0);
    });

    it('syncBrandRateCardsToDatabase is a no-op when no changes exist', async () => {
      const mockPool = {
        query: vi.fn().mockResolvedValue({
          rows: [{ price_min: '0.00', price_max: '999999.00', rate: '0.000000' }]
        })
      };

      const testCards = [{
        marketplace: 'flipkart',
        category: 'ethnic_set',
        brand: 'Youthnic',
        sample_fsn: 'ETH123',
        commissions: [{ price_min: 0, price_max: 999999, rate: 0.0 }]
      }];

      const res = await syncBrandRateCardsToDatabase(testCards, { forceUpdate: false }, mockPool);
      expect(res.updated).toBe(false);
      expect(res.message).toContain('No changes detected');
    });
  });

  describe('Excel Workbook Generation', () => {
    it('generates a multi-sheet Excel workbook with all 6 required sheets', async () => {
      const testExcelPath = path.join(process.cwd(), 'test_brandwise_ratecard.xlsx');

      const mockPool = {
        query: vi.fn().mockResolvedValue({
          rows: [
            { marketplace: 'flipkart', category: 'ethnic_set', brand: 'Youthnic', fsn: 'ETH123', sku: 'SKU1', sample_fsn: 'ETH123', sample_sku: 'SKU1', order_count: 100 },
            { marketplace: 'flipkart', category: 'ethnic_set', brand: 'Sangria', fsn: 'ETH456', sku: 'SKU2', sample_fsn: 'ETH456', sample_sku: 'SKU2', order_count: 20 },
            { marketplace: 'shopsy', category: 'shopsy_kurta', brand: 'Ethnic Junction', fsn: 'KTA789', sku: 'SKU3', sample_fsn: 'KTA789', sample_sku: 'SKU3', order_count: 15 }
          ]
        })
      };

      try {
        const result = await generateBrandwiseRateCardExcel(testExcelPath, mockPool);
        expect(result.sheetsCount).toBe(6);
        expect(result.sheets).toContain('Brand_Commission_Summary');
        expect(result.sheets).toContain('Flipkart_Rates');
        expect(result.sheets).toContain('Shopsy_Rates');
        expect(result.sheets).toContain('Fixed_Fees');
        expect(result.sheets).toContain('Reverse_Shipping');
        expect(result.sheets).toContain('Sample_FSN_Catalog');
        expect(result.totalRecords).toBeGreaterThan(0);

        // Verify file exists on disk
        const stat = await fs.stat(testExcelPath);
        expect(stat.size).toBeGreaterThan(1000);
      } finally {
        await fs.unlink(testExcelPath).catch(() => null);
      }
    });
  });

});
