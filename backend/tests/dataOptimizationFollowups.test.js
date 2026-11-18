import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MASTER_CATEGORY_SQL, masterCategoryScalarSql } from '../services/categorySql.js';
import { buildReturnsListQueries, likeContainsPattern, RETURN_ORDER_JOIN, searchOrderQueries } from '../routes/data.js';
import { forEachIsolated } from '../utils/isolatedBatches.js';
import { addSaleOrderShipment, saleOrderShipmentKey } from '../services/amazonSaleOrderShipments.js';
import { resetOrdersWithoutMyntraPayment } from '../services/myntraSettlementReportingRollups.js';
import { CONTINUATION_DEDUPE_SQL } from '../services/amazonSettlementIngest.js';

const source = file => fs.readFileSync(path.resolve(file), 'utf-8');

describe('master category is one definition for filters and breakdowns', () => {
  it('scalar form follows the joined form precedence and fallback', () => {
    const scalar = masterCategoryScalarSql('o');
    const order = ['vb_sku_master v', "marketplace = 'all')", 'marketplace = o.marketplace)', "NULLIF(o.vb_export_category, '')", "NULLIF(o.category, '')", "'Uncategorized'"];
    let at = -1;
    for (const part of order) {
      const next = scalar.indexOf(part, at + 1);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
    expect(MASTER_CATEGORY_SQL).toMatch(/^COALESCE\(vsm\.category, sm_all\.category, sm_mp\.category/);
  });

  it('insights groups by the master category, never raw orders.category', () => {
    const insights = source('routes/insights.js');
    expect(insights).toContain('const CATEGORY = MASTER_CATEGORY_SQL;');
    expect(insights).not.toMatch(/GROUP BY[^\n]*o\.category/);
    expect(insights).not.toContain("AND o.category IS NOT NULL AND o.category <> ''");
  });
});

describe('Returns list keeps Amazon and unmatched returns under filters', () => {
  it('joins Amazon returns by (order_id, sku) and others by order item id, one order per return', () => {
    expect(RETURN_ORDER_JOIN).toContain('LEFT JOIN LATERAL');
    expect(RETURN_ORDER_JOIN).toContain("o2.order_id = ret.order_id");
    expect(RETURN_ORDER_JOIN).toContain('o2.sku = ret.sku');
    expect(RETURN_ORDER_JOIN).toContain('o1.order_item_id = ret.order_item_id');
    expect(RETURN_ORDER_JOIN).toContain('LIMIT 1');
  });

  it('filters marketplace, account and dates on the return when no order matched', () => {
    const { dataSql, dataValues, countSql, countValues } = buildReturnsListQueries(
      { marketplace: 'amazon', startDate: '2026-04-01', endDate: '2026-04-30' },
      { pageSize: 50, offset: 100 },
    );
    expect(dataSql).toContain('COALESCE(o.order_date, ret.return_requested_date) >= $1');
    expect(dataSql).toContain('COALESCE(o.marketplace, ret.marketplace) = $3');
    expect(dataSql).toMatch(/LIMIT \$4 OFFSET \$5/);
    expect(dataValues).toEqual(['2026-04-01', '2026-04-30', 'amazon', 50, 100]);
    expect(countValues).toEqual(['2026-04-01', '2026-04-30', 'amazon']);
    expect(countSql).not.toContain('LIMIT $');
  });
});

describe('order search', () => {
  it('tries exact ids before the substring scan and escapes LIKE wildcards', () => {
    const exact = searchOrderQueries('= $1');
    expect(exact.orders).toContain('o.order_item_id = $1 OR o.order_id = $1');
    expect(exact.settlements).toContain('s.order_item_id = $1 OR s.order_id = $1');
    expect(likeContainsPattern('OD_12%3')).toBe('%OD\\_12\\%3%');
    expect(likeContainsPattern('171-55')).toBe('%171-55%');
    const route = source('routes/data.js');
    expect(route.indexOf("run('= $1', q)")).toBeLessThan(route.indexOf("run('ILIKE $1', likeContainsPattern(q))"));
  });
});

describe('report query shape', () => {
  const data = source('routes/data.js');

  it('has no non-sargable TO_CHAR month filters', () => {
    expect(data).not.toMatch(/TO_CHAR\([a-z_.]+, ?'YYYY-MM'\) ?= ?\$\d/);
    expect(data).toContain("TO_DATE($1, 'YYYY-MM')");
  });

  it('caps list pages and rebuilds push-report set-based in one transaction', () => {
    expect(data).toContain('const LIST_MAX_PAGE_SIZE = 10_000;');
    expect(data).not.toContain('maxPageSize: 100000');
    expect(source('../frontend/src/api/client.js')).toContain('const EXPORT_PAGE_SIZE = 10_000;');
    expect(data).toContain('INSERT INTO reconciliation_reports (${RECONCILIATION_REPORT_COLUMNS.join');
    const push = data.slice(data.indexOf("router.post('/settlement/push-report'"));
    expect(push.indexOf("client.query('BEGIN')")).toBeLessThan(push.indexOf("client.query('DELETE FROM reconciliation_reports')"));
  });

  it('month-pl matches rate cards once and reports failed sections', () => {
    const monthPl = data.slice(data.indexOf("router.get('/settlement/month-pl'"), data.indexOf("router.get('/settlement/non-order-detail'"));
    expect(monthPl).toContain('WITH base AS MATERIALIZED');
    expect(monthPl).not.toContain('FROM rc_commission rc\n            WHERE LOWER(rc.category) = REGEXP_REPLACE');
    expect(monthPl).not.toContain('.catch(() => ({ rows: [] }))');
    expect(monthPl).toContain('res.json({ months, marketplaces, data, warnings })');
  });

  it('splits Myntra VB / EJ cash by seller_account', () => {
    expect(data).toContain("settlementMpCond = \"AND marketplace = 'myntra' AND seller_account = 'myntra_ej'\"");
    expect(source('routes/insights.js')).toContain("mpWhere = \"AND marketplace = 'myntra' AND seller_account = 'myntra_ej'\"");
  });

  it('runs only the requested marketplace list in /reconcile/non-order', () => {
    const reconcile = source('routes/reconcile.js');
    expect(reconcile).toContain("requestedMp === 'meesho'");
    expect(reconcile.match(/nonOrderQuery\('/g)).toHaveLength(7);
  });

  it('never joins sku_master in a way that repeats order rows', () => {
    // (NOT EXISTS lookups may still use the OR form: they cannot fan out rows.)
    expect(data).not.toMatch(/JOIN sku_master sm\b[\s\S]{0,200}?OR sm\.marketplace = 'all'/);
    expect(data).not.toMatch(/LEFT JOIN sku_master sm ON sm\.listing_sku = o\.sku\s*\n/);
  });
});

describe('per-item isolation in grouped transactions', () => {
  function recordingClient(failFor = () => false) {
    const statements = [];
    return {
      statements,
      query: vi.fn(async sql => {
        statements.push(sql);
        if (failFor(sql)) throw new Error(`failed: ${sql}`);
        return { rows: [], rowCount: 0 };
      }),
    };
  }

  it('rolls a failing item back to its savepoint and commits the rest of the group', async () => {
    const client = recordingClient();
    const ok = [];
    const failed = [];
    await forEachIsolated(client, ['a', 'bad', 'c'], async item => {
      if (item === 'bad') throw new Error('bad row');
      await client.query(`work ${item}`);
      return item.toUpperCase();
    }, { onSuccess: (item, outcome) => ok.push(outcome), onError: item => failed.push(item) });
    expect(ok).toEqual(['A', 'C']);
    expect(failed).toEqual(['bad']);
    expect(client.statements.filter(sql => sql === 'BEGIN' || sql === 'COMMIT')).toEqual(['BEGIN', 'COMMIT']);
    expect(client.statements).toContain('ROLLBACK TO SAVEPOINT isolated_item');
  });

  it('commits in groups and reports every item of a group whose COMMIT fails', async () => {
    let commits = 0;
    const client = recordingClient(sql => sql === 'COMMIT' && ++commits === 2);
    const ok = [];
    const failed = [];
    await forEachIsolated(client, [1, 2, 3, 4, 5], async item => item, {
      groupSize: 2,
      onSuccess: item => ok.push(item),
      onError: item => failed.push(item),
    });
    expect(client.statements.filter(sql => sql === 'BEGIN')).toHaveLength(3);
    expect(ok).toEqual([1, 2, 5]);
    expect(failed).toEqual([3, 4]);
  });
});

describe('Amazon ingestion', () => {
  it('folds Sale Order rows into one entry per shipment', () => {
    const map = new Map();
    const row = (qty, amount, at = '2026-04-02T10:00:00.000Z') => ({
      order_id: '171-1', sku: 'S1', qty, product_amount: amount, item_tax: 1.25, sale_shipping_amount: 0,
      sale_gift_amount: 0, order_date: at.slice(0, 10), purchase_date_time: at,
    });
    addSaleOrderShipment(map, row(1, 499), 'blr7');
    addSaleOrderShipment(map, row(1, 499), 'BLR7');
    addSaleOrderShipment(map, row(2, 998, '2026-03-30T08:00:00.000Z'), 'BLR7');
    expect(map.size).toBe(2);
    const april = [...map.values()].find(s => s.shipment_date === '2026-04-02');
    expect(april).toMatchObject({ qty: 2, product_amount: 998, item_tax: 2.5, shipment_key: saleOrderShipmentKey('2026-04-02T10:00:00.000Z', 'BLR7') });
  });

  it('removes at most as many stored copies as a continuation file carries', () => {
    expect(CONTINUATION_DEDUPE_SQL).toContain('COUNT(*) AS copies');
    expect(CONTINUATION_DEDUPE_SQL).toContain('ROW_NUMBER() OVER (PARTITION BY');
    expect(CONTINUATION_DEDUPE_SQL).toContain('s.copy_no <= i.copies');
    expect(CONTINUATION_DEDUPE_SQL).toContain('IS NOT DISTINCT FROM');
  });

  it('resolves orphan refund SKUs across settlements for the uploaded orders', () => {
    const upload = source('routes/amazonUpload.js');
    expect(upload).toContain("resolveOrphanSkus(client, sid, { relatedOrders: true })");
    expect(source('services/amazonSettlementIngest.js')).toContain('for (const relatedId of relatedSettlementIds)');
  });
});

describe('Flipkart, Myntra and SOR write paths', () => {
  it('replaces Flipkart non-order sheets in one retried transaction', () => {
    const flipkart = source('routes/flipkartSettlement.js');
    for (const table of ['fk_spf_claims', 'fk_storage_recall', 'fk_ads', 'fk_google_ads']) {
      expect(flipkart).toContain(`replaceNeftRows(pool, '${table}'`);
    }
    expect(flipkart).not.toMatch(/for \(let attempt = 1; attempt <= 5; attempt\+\+\)/);
  });

  it('writes a Myntra file in one transaction and drops synthesized returns of shipped lines', () => {
    const myntra = source('routes/myntraUpload.js');
    expect(myntra.indexOf("client.query('BEGIN')")).toBeLessThan(myntra.indexOf('INSERT INTO myntra_order_details'));
    expect(myntra).toContain("AND return_id = 'RTO-' || order_item_id");
    expect(myntra).toContain('IS DISTINCT FROM s.orders_status');
    expect(source('routes/upload.js')).toContain('deleted.synthesized_returns = synthesized.rowCount');
  });

  it('resets payment columns only for Myntra orders left without any payment row', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 4 })) };
    await expect(resetOrdersWithoutMyntraPayment(pool, 'myntra_vb', ['REL-1', 'REL-1', ''])).resolves.toEqual({ ordersReset: 4 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("o.marketplace = 'myntra'");
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('settlement_amount = NULL');
    expect(params).toEqual(['myntra_vb', ['REL-1']]);
    await expect(resetOrdersWithoutMyntraPayment(pool, 'myntra_vb', [])).resolves.toEqual({ ordersReset: 0 });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('commits SOR uploads and the AJIO mirror in savepoint groups', () => {
    expect(source('services/sorUpload.js').match(/forEachIsolated\(/g)).toHaveLength(2);
    expect(source('services/sorMirror.js')).toContain('await forEachIsolated(');
  });
});

describe('database layer', () => {
  const initDb = source('db/initDb.js');

  it('drops redundant indexes once and no longer recreates them', () => {
    expect(initDb).toContain("const REDUNDANT_INDEX_CLEANUP_SCHEMA_VERSION = '2026.11.redundant-indexes-1';");
    expect(initDb.match(/await ensureRedundantIndexCleanup\(pool\);/g)).toHaveLength(2);
    for (const create of [
      'CREATE INDEX IF NOT EXISTS IX_amzn_lines_settlement ',
      'CREATE INDEX IF NOT EXISTS IX_amzn_lines_order_id ',
      'CREATE INDEX IF NOT EXISTS IX_returns_order_item_id ',
      'CREATE INDEX IF NOT EXISTS IX_returns_order_id ',
      'CREATE INDEX IF NOT EXISTS IX_sor_invoice_line_invoice ON',
    ]) {
      expect(initDb).not.toContain(create);
    }
    expect(initDb.match(/CREATE INDEX IF NOT EXISTS IX_orders_vb_export_sku/g)).toHaveLength(1);
  });

  it('keeps the API up when a rate-card migration is pending', () => {
    expect(initDb).not.toMatch(/throw new Error\(['`]Migration [^)]*failed to apply/);
  });

  it('builds lookup indexes and the SOR view without lock or timeout hazards', () => {
    expect(initDb).toContain('const builder = await pool.connect();');
    expect(initDb).toContain("await replaceViewIfChanged(pool, 'sor_outstanding', select,");
    expect(initDb.match(/await db\.query\(AMAZON_SALE_ORDER_SHIPMENTS_DDL\);/g)).toHaveLength(2);
  });

  it('fails fast on a saturated pool and wraps each client once', () => {
    const db = source('db/index.js');
    expect(db).toContain('if (isPoolAcquireTimeout(error)) break;');
    expect(db).toContain('if (client[INSTRUMENTED]) return client;');
  });
});
