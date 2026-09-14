import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { syncVbExportCatalog } from '../scripts/sync-vb-export-catalog.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

describe('VB Export category mapping', () => {
  it('uses the master category for marketplace listings and master-only rows', async () => {
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['Marketplace SKU', "VB EXPORT SKU's", 'VB Export Product Category', 'Weight Slab (kg)', 'COGS (₹)', 'Marketplace'],
      ['LIST-1', 'VB-1', 'Amazon Category', 1, 200, 'amazon'],
      ['', 'VB-1', 'Canonical Category', 0.5, 100, 'all'],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Catalog');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const calls = [];
    const pool = {
      query: vi.fn(async (sql, params = []) => {
        calls.push([sql, params]);
        if (sql.includes('COUNT(*) AS total_orders')) {
          return { rows: [{ total_orders: '1', mapped_orders: '1', unmerged_orders: '0' }] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };

    await syncVbExportCatalog({ pool, buffer });

    const vbInsert = calls.find(([sql]) => sql.includes('INSERT INTO vb_sku_master'));
    expect(vbInsert[1]).toEqual(['VB-1', 'Canonical Category', 100, 0.5]);

    const listingInsert = calls.find(([sql]) => sql.includes('INSERT INTO sku_master'));
    expect(listingInsert[1]).toEqual(['VB-1', 'all', 'LIST-1', 'Canonical Category', 100, 0.5]);
  });
});
