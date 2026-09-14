import { describe, expect, it, vi } from 'vitest';
import { upsertSkuMasterRows, parseSkuMasterInput } from '../routes/upload.js';
import fs from 'fs';
import path from 'path';

// ── Finding #1: listing uploads must inherit existing master values when blank ─
describe('upsertSkuMasterRows inherits master values for blank listing fields', () => {
  it('runs a backfill UPDATE from vb_sku_master after the listing upsert', async () => {
    const calls = [];
    const pool = {
      query: vi.fn(async (sql) => {
        calls.push(sql);
        if (sql.includes('RETURNING')) {
          return { rows: [{ inserted: true }, { inserted: false }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const records = [
      parseSkuMasterInput({
        listing_sku: 'LIST-1',
        master_sku: 'VB-1',
        marketplace: 'amazon',
        cogs: 0,
        weight_slab: null,
        category: '',
      }),
    ];

    await upsertSkuMasterRows(pool, records);

    const inheritSql = calls.find(s => s.includes('UPDATE sku_master') && s.includes('vb_sku_master'));
    expect(inheritSql).toBeDefined();
    expect(inheritSql).toContain('COALESCE(NULLIF(sm.category');
    expect(inheritSql).toContain('vsm.cogs');
    expect(inheritSql).toContain('vsm.weight_slab');
  });
});

// ── Finding #2: catalog sync must be atomic (tested in vbExportCategoryMapping) ─
// The transaction behavior (BEGIN/COMMIT/ROLLBACK + client.release) is
// verified in vbExportCategoryMapping.test.js.

// ── Finding #3: shared dashboard endpoints use canonical category joins ───────
describe('data.js uses canonical category SQL consistently', () => {
  const dataPath = path.resolve('routes/data.js');
  const source = fs.readFileSync(dataPath, 'utf-8');

  it('does not contain the old non-canonical COALESCE(o.vb_export_category, o.category) pattern', () => {
    expect(source).not.toMatch(/COALESCE\(o\.vb_export_category,\s*o\.category/);
  });

  it('uses CANONICAL_CATEGORY_SQL in the unsettled-summary route', () => {
    // The unsettled-summary route should reference CANONICAL_CATEGORY_SQL
    // rather than inline COALESCE expressions.
    expect(source).toContain('CANONICAL_CATEGORY_SQL');
  });

  it('buildDimensionWhere passes CANONICAL_CATEGORY_SQL to buildWhere', () => {
    expect(source).toMatch(/buildDimensionWhere[\s\S]*?buildWhere\(rest,\s*alias,\s*alias\s*===\s*'o'\s*\?\s*CANONICAL_CATEGORY_SQL/);
  });

  it('filters endpoint queries vb_sku_master and sku_master for categories', () => {
    expect(source).toMatch(/SELECT category FROM vb_sku_master/);
    expect(source).toMatch(/SELECT category FROM sku_master/);
  });
});

// ── Finding #4: SKU grouping must not duplicate SKUs by category ──────────────
describe('data.js SKU queries group by SKU only, not by category', () => {
  const dataPath = path.resolve('routes/data.js');
  const source = fs.readFileSync(dataPath, 'utf-8');

  it('top-SKU query uses MAX for category and groups by sku + master only', () => {
    // Extract the top-SKU query block (between "Top SKUs" comment and LIMIT 30)
    const skuBlock = source.match(/Top SKUs[\s\S]*?LIMIT 30/);
    expect(skuBlock).toBeTruthy();
    expect(skuBlock[0]).toContain('MAX(${CANONICAL_CATEGORY_SQL}) AS category');
    expect(skuBlock[0]).toContain('GROUP BY o.sku, ${MASTER_SKU_SQL}');
    expect(skuBlock[0]).not.toMatch(/GROUP BY o\.sku.*CANONICAL_CATEGORY_SQL.*\n.*ORDER BY/);
  });

  it('VB EXPORT SKU query uses MAX for category and does not group by category', () => {
    const vbBlock = source.match(/VB EXPORT SKU[\s\S]*?LIMIT 100/);
    expect(vbBlock).toBeTruthy();
    expect(vbBlock[0]).toContain('MAX(${CANONICAL_CATEGORY_SQL}) AS category');
    // GROUP BY should not include CANONICAL_CATEGORY_SQL
    const groupByMatch = vbBlock[0].match(/GROUP BY([\s\S]*?)(ORDER BY|LIMIT)/);
    expect(groupByMatch).toBeTruthy();
    expect(groupByMatch[1]).not.toContain('CANONICAL_CATEGORY_SQL');
  });

  it('unmerged-skus query uses MAX for category and groups by sku + marketplace only', () => {
    const unmergedBlock = source.match(/unmerged-skus[\s\S]*?LIMIT 200/);
    expect(unmergedBlock).toBeTruthy();
    expect(unmergedBlock[0]).toContain('MAX(${CANONICAL_CATEGORY_SQL})');
    expect(unmergedBlock[0]).toContain('GROUP BY o.sku, o.marketplace');
    expect(unmergedBlock[0]).not.toMatch(/GROUP BY o\.sku,\s*o\.marketplace,\s*\$\{CANONICAL_CATEGORY_SQL\}/);
  });
});
