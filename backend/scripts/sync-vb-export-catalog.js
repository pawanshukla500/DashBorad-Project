import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { getPool } from '../db/index.js';
import { forEachDbBatch } from '../utils/dbBatch.js';

dotenv.config();
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

export async function syncVbExportCatalog({ pool, filePath, buffer } = {}) {
  const db = pool || getPool();
  console.log('[syncVbExportCatalog] Starting VB EXPORT SKU catalog synchronization...');

  let wb;
  if (buffer) {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } else {
    const resolvedPath = filePath || 'C:/Users/Pawan Shukla/Desktop/VB EXPORT Product Category.xlsx';
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Catalog file not found at: ${resolvedPath}`);
    }
    wb = XLSX.readFile(resolvedPath);
  }

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws);

  console.log(`[syncVbExportCatalog] Read ${rawRows.length} rows from sheet "${sheetName}".`);

  // Ensure tables and columns exist
  await db.query(`
    CREATE TABLE IF NOT EXISTS vb_sku_master (
      vb_export_sku TEXT PRIMARY KEY,
      category      TEXT,
      cogs          NUMERIC(14,2) NOT NULL DEFAULT 0,
      weight_slab   NUMERIC(6,2),
      product_name  TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE sku_master ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS vb_export_sku TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS vb_export_category TEXT;
    CREATE INDEX IF NOT EXISTS IX_orders_vb_export_sku ON orders(vb_export_sku);
    CREATE INDEX IF NOT EXISTS IX_orders_vb_export_cat ON orders(vb_export_category);
    CREATE INDEX IF NOT EXISTS IX_sku_master_category ON sku_master(category);
    CREATE INDEX IF NOT EXISTS IX_vb_sku_master_category ON vb_sku_master(category);
  `);

  // Parse and deduplicate
  const vbMasterMap = new Map(); // vb_export_sku -> { category, cogs, weightSlab }
  const listingMap = new Map();  // listing_sku -> { master_sku, category, cogs, weightSlab }

  for (const r of rawRows) {
    const listingSku = r['Marketplace SKU'] ? String(r['Marketplace SKU']).trim() : '';
    const masterSku = (r["VB EXPORT SKU's"] || r['VB Export SKU'] || r['Master SKU']) ? String(r["VB EXPORT SKU's"] || r['VB Export SKU'] || r['Master SKU']).trim() : '';
    const category = (r['VB Export Product Category'] || r['Category']) ? String(r['VB Export Product Category'] || r['Category']).trim() : '';

    const rawCogs = r['COGS (₹)'] ?? r['COGS'] ?? r['cogs'] ?? r['Cost'] ?? null;
    const cogs = rawCogs != null && !isNaN(rawCogs) && Number(rawCogs) >= 0 ? Number(rawCogs) : null;

    const rawWeight = r['Weight Slab (kg)'] ?? r['Weight Slab'] ?? r['weight_slab'] ?? r['Weight'] ?? null;
    const weightSlab = rawWeight != null && !isNaN(rawWeight) && Number(rawWeight) > 0 ? Number(rawWeight) : null;

    if (!masterSku) continue;

    if (!vbMasterMap.has(masterSku)) {
      vbMasterMap.set(masterSku, { category: category || null, cogs, weightSlab });
    } else {
      const existing = vbMasterMap.get(masterSku);
      if (category && !existing.category) existing.category = category;
      if (cogs !== null && (!existing.cogs || existing.cogs === 0)) existing.cogs = cogs;
      if (weightSlab !== null && !existing.weightSlab) existing.weightSlab = weightSlab;
    }

    if (listingSku) {
      listingMap.set(listingSku, { masterSku, category: category || null, cogs, weightSlab });
    }
  }

  console.log(`[syncVbExportCatalog] Parsed ${vbMasterMap.size} unique VB EXPORT SKUs and ${listingMap.size} unique Marketplace listing mappings.`);

  // 1. Upsert into vb_sku_master
  const vbRows = Array.from(vbMasterMap.entries()).map(([vbSku, info]) => [
    vbSku,
    info.category,
    info.cogs || 0,
    info.weightSlab || null
  ]);
  let vbUpserted = 0;
  await forEachDbBatch(vbRows, 4, async batch => {
    const values = [];
    const groups = batch.map(row => {
      const start = values.length;
      values.push(row[0], row[1], row[2], row[3]);
      return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4})`;
    });
    const res = await db.query(`
      INSERT INTO vb_sku_master (vb_export_sku, category, cogs, weight_slab)
      VALUES ${groups.join(', ')}
      ON CONFLICT (vb_export_sku) DO UPDATE
      SET category = COALESCE(EXCLUDED.category, vb_sku_master.category),
          cogs = CASE WHEN EXCLUDED.cogs > 0 THEN EXCLUDED.cogs ELSE vb_sku_master.cogs END,
          weight_slab = COALESCE(EXCLUDED.weight_slab, vb_sku_master.weight_slab),
          updated_at = NOW()
    `, values);
    vbUpserted += res.rowCount;
  });
  console.log(`[syncVbExportCatalog] Upserted ${vbUpserted} rows into vb_sku_master.`);

  // 2. Upsert into sku_master
  const listingRows = Array.from(listingMap.entries()).map(([listingSku, info]) => [
    info.masterSku,
    'all',
    listingSku,
    info.category,
    info.cogs,
    info.weightSlab,
  ]);

  let skuMasterUpserted = 0;
  await forEachDbBatch(listingRows, 6, async batch => {
    const values = [];
    const groups = batch.map(row => {
      const start = values.length;
      values.push(row[0], row[1], row[2], row[3], row[4], row[5]);
      return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4}, $${start + 5}, $${start + 6})`;
    });
    const res = await db.query(`
      INSERT INTO sku_master (master_sku, marketplace, listing_sku, category, cogs, weight_slab)
      VALUES ${groups.join(', ')}
      ON CONFLICT (marketplace, listing_sku) DO UPDATE
      SET master_sku = EXCLUDED.master_sku,
          category = COALESCE(EXCLUDED.category, sku_master.category),
          cogs = CASE WHEN EXCLUDED.cogs > 0 THEN EXCLUDED.cogs ELSE sku_master.cogs END,
          weight_slab = COALESCE(EXCLUDED.weight_slab, sku_master.weight_slab)
    `, values);
    skuMasterUpserted += res.rowCount;
  });
  console.log(`[syncVbExportCatalog] Upserted ${skuMasterUpserted} rows into sku_master.`);

  // 3. Backfill orders with vb_export_sku and vb_export_category
  console.log('[syncVbExportCatalog] Backfilling orders.vb_export_sku and orders.vb_export_category...');
  const backfillRes = await db.query(`
    UPDATE orders o
    SET vb_export_sku = sm.master_sku,
        vb_export_category = sm.category
    FROM sku_master sm
    WHERE o.sku = sm.listing_sku
      AND (
        o.vb_export_sku IS DISTINCT FROM sm.master_sku
        OR o.vb_export_category IS DISTINCT FROM sm.category
      );
  `);
  console.log(`[syncVbExportCatalog] Backfilled ${backfillRes.rowCount} orders with VB EXPORT SKU.`);

  // Check how many orders have vb_export_sku populated vs null
  const coverageRes = await db.query(`
    SELECT
      COUNT(*) AS total_orders,
      COUNT(vb_export_sku) AS mapped_orders,
      COUNT(*) - COUNT(vb_export_sku) AS unmerged_orders
    FROM orders;
  `);

  console.log('[syncVbExportCatalog] Final Coverage:', coverageRes.rows[0]);

  return {
    uniqueVbSkus: vbMasterMap.size,
    uniqueListings: listingMap.size,
    vbUpserted,
    skuMasterUpserted,
    ordersBackfilled: backfillRes.rowCount,
    coverage: coverageRes.rows[0],
  };
}

// Allow CLI execution
if (process.argv[1] && process.argv[1].endsWith('sync-vb-export-catalog.js')) {
  syncVbExportCatalog({ filePath: process.argv[2] })
    .then(result => {
      console.log('[syncVbExportCatalog] Success:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('[syncVbExportCatalog] Failed:', err);
      process.exit(1);
    });
}
