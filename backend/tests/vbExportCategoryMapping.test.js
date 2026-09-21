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
    const client = {
      query: vi.fn(async (sql, params = []) => {
        calls.push([sql, params]);
        if (sql.includes('COUNT(*) AS total_orders')) {
          return { rows: [{ total_orders: '1', mapped_orders: '1', unmerged_orders: '0' }] };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const poolQuery = vi.fn(async () => ({ rows: [{ ready: true }] }));
    const pool = {
      query: poolQuery,
      connect: vi.fn(async () => client),
    };

    await syncVbExportCatalog({ pool, buffer });

    // Schema already present: no DDL at all, and none inside the transaction
    // (ALTER TABLE orders there locked every dashboard read until COMMIT).
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(calls.some(([sql]) => /ALTER TABLE|CREATE (TABLE|INDEX)/.test(sql))).toBe(false);

    // Verify transaction control
    const sqlTexts = calls.map(([sql]) => sql);
    expect(sqlTexts.some(s => s === 'BEGIN')).toBe(true);
    expect(sqlTexts.some(s => s === 'COMMIT')).toBe(true);

    const vbInsert = calls.find(([sql]) => sql.includes('INSERT INTO vb_sku_master'));
    expect(vbInsert[1]).toEqual(['VB-1', 'Canonical Category', 100, 0.5]);

    const listingInsert = calls.find(([sql]) => sql.includes('INSERT INTO sku_master'));
    expect(listingInsert[1]).toEqual(['VB-1', 'all', 'LIST-1', 'Canonical Category', 100, 0.5]);

    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back and releases the client when an error occurs mid-sync', async () => {
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['Marketplace SKU', "VB EXPORT SKU's", 'VB Export Product Category', 'Weight Slab (kg)', 'COGS (₹)', 'Marketplace'],
      ['LIST-1', 'VB-1', 'Cat', 1, 200, 'amazon'],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Catalog');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const client = {
      query: vi.fn(async (sql) => {
        if (sql.includes('INSERT INTO vb_sku_master')) throw new Error('connection lost');
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = { query: vi.fn(async () => ({ rows: [{ ready: true }] })), connect: vi.fn(async () => client) };

    await expect(syncVbExportCatalog({ pool, buffer })).rejects.toThrow('connection lost');

    const sqlTexts = client.query.mock.calls.map(([s]) => s);
    expect(sqlTexts.some(s => s === 'ROLLBACK')).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('creates missing catalog schema before the transaction, never inside it', async () => {
    const order = [];
    const pool = {
      query: vi.fn(async (sql) => {
        order.push(/ALTER TABLE|CREATE TABLE/.test(sql) ? 'ddl' : 'check');
        return { rows: [{ ready: false }] };
      }),
      connect: vi.fn(async () => {
        order.push('connect');
        return { query: vi.fn(async () => ({ rows: [{}], rowCount: 0 })), release: vi.fn() };
      }),
    };
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['Marketplace SKU', "VB EXPORT SKU's", 'VB Export Product Category', 'Weight Slab (kg)', 'COGS (₹)', 'Marketplace'],
      ['LIST-1', 'VB-1', 'Cat', 1, 200, 'all'],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Catalog');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    await syncVbExportCatalog({ pool, buffer });

    expect(order.slice(0, 3)).toEqual(['check', 'ddl', 'connect']);
  });
});
