import { describe, it, expect, vi } from 'vitest';
import { buildBrandRateCardSet, getRealTimeBrandFsnSamples } from '../services/brandRateCardService.js';
import { generateBrandwiseRateCardExcel } from '../services/brandwiseExcelExport.js';
import path from 'path';
import fs from 'fs/promises';

const samples = [
  { marketplace: 'flipkart', category: 'kurta', brand: 'Youthnic', seller_account: 'default', sample_fsn: 'ABCDEFGHIJKLMNOP', sample_sku: 'SKU-DEFAULT', order_count: 6 },
  { marketplace: 'flipkart', category: 'kurta', brand: 'Youthnic', seller_account: 'seller_ej', sample_fsn: 'QRSTUVWXYZ123456', sample_sku: 'SKU-EJ', order_count: 3 },
  { marketplace: 'flipkart', category: 'Shopsy Kurta', brand: 'Youthnic', seller_account: 'default', sample_fsn: 'ABCDEF0123456789', sample_sku: 'SKU-SHOPSY', order_count: 4 },
];

function fixturePool() {
  const tables = {
    rc_commission: [
      { marketplace: 'flipkart', seller_account: 'default', category: 'kurta', brand_name: 'Youthnic', price_min: 0, price_max: 500, rate: '0.15' },
      { marketplace: 'flipkart', seller_account: 'seller_ej', category: 'kurta', brand_name: 'Youthnic', price_min: 0, price_max: 500, rate: '0.17' },
      { marketplace: 'shopsy', seller_account: 'default', category: 'shopsy_kurta', brand_name: 'Youthnic', price_min: 0, price_max: 999999, rate: '0.00' },
      { marketplace: 'flipkart', seller_account: 'default', category: 'no_fsn_category', brand_name: 'Youthnic', price_min: 0, price_max: 500, rate: '0.99' },
    ],
    rc_fixed_fee: [
      { marketplace: 'flipkart', seller_account: 'default', category: 'kurta', fulfilment_type: 'NON_FBF', price_min: 0, price_max: 500, rate: '10' },
    ],
    rc_collection_fee: [], rc_pick_pack: [], rc_reverse_shipping: [], rc_franchise_fee: [],
  };
  const query = vi.fn(async sql => {
    const text = String(sql);
    if (text.includes('FROM orders')) return { rows: samples };
    const table = Object.keys(tables).find(name => text.includes(`FROM ${name}`));
    if (table) return { rows: tables[table] };
    throw new Error(`Unexpected SQL: ${text}`);
  });
  return { query };
}

describe('Read-only brand/category rate-card catalog', () => {
  it('requires valid real FSNs and ranks samples separately by seller account', async () => {
    const pool = fixturePool();
    const catalog = await getRealTimeBrandFsnSamples(pool);
    const [query, params] = pool.query.mock.calls[0];
    expect(catalog).toEqual(samples);
    expect(query).toContain("UPPER(TRIM(fsn)) ~ '^[A-Z0-9]{16}$'");
    expect(query).toContain('COALESCE(NULLIF(TRIM(brand_name), \'\'), NULLIF(TRIM(brand), \'\'), \'General\')');
    expect(query).toContain("PARTITION BY marketplace, category,");
    expect(query).toContain("COALESCE(NULLIF(TRIM(seller_account), ''), 'default')");
    expect(params).toEqual([]);
  });

  it('scopes FSN reads to the requested marketplace and seller account', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await getRealTimeBrandFsnSamples(pool, { marketplace: 'flipkart', sellerAccount: 'seller_ej' });
    const [query, params] = pool.query.mock.calls[0];
    expect(query).toContain('LOWER(TRIM(marketplace)) = $1');
    expect(query).toContain("COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2");
    expect(params).toEqual(['flipkart', 'seller_ej']);
  });

  it('reads published rates only, keeps accounts and Shopsy separate, and skips profiles without an order FSN', async () => {
    const pool = fixturePool();
    const cards = await buildBrandRateCardSet(pool, 'all');
    expect(cards).toHaveLength(4);
    expect(cards.map(card => [card.marketplace, card.seller_account, card.category]).sort()).toEqual([
      ['flipkart', 'default', 'kurta'],
      ['flipkart', 'default', 'kurta'],
      ['flipkart', 'seller_ej', 'kurta'],
      ['shopsy', 'default', 'shopsy_kurta'],
    ]);
    const defaultFlipkart = cards.find(card => card.marketplace === 'flipkart' && card.seller_account === 'default');
    expect(defaultFlipkart).toMatchObject({ source: 'published_database', sample_fsn: 'ABCDEFGHIJKLMNOP' });
    expect(defaultFlipkart.commissions[0].rate).toBe(0.15);
    expect(cards.find(card => card.marketplace === 'flipkart' && card.fixedFees.length).fixedFees[0].rate).toBe(10);
    expect(cards.find(card => card.marketplace === 'shopsy').commissions[0].rate).toBe(0);
    expect(cards.some(card => card.category === 'no_fsn_category')).toBe(false);
    expect(pool.query.mock.calls.filter(([sql]) => !String(sql).includes('FROM orders')).every(([sql]) =>
      String(sql).includes('start_date <= $1::date') && String(sql).includes('end_date >= $1::date'))).toBe(true);
  });

  it('exports published database rows without generating guessed fee slabs', async () => {
    const outputPath = path.join(process.cwd(), 'test_brandwise_ratecard.xlsx');
    try {
      const result = await generateBrandwiseRateCardExcel(outputPath, fixturePool());
      expect(result.sheetsCount).toBe(6);
      expect(result.sheets).toContain('Flipkart_Rates');
      expect(result.sheets).toContain('Shopsy_Rates');
      expect(result.sheets).toContain('Sample_FSN_Catalog');
      expect((await fs.stat(outputPath)).size).toBeGreaterThan(1000);
    } finally {
      await fs.unlink(outputPath).catch(() => null);
    }
  });
});
