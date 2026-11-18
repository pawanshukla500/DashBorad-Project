// Compact, marketplace-neutral totals used by the dashboard/report CTEs.
// Raw settlement ledgers and `unified_settlements` remain the audit source;
// this table only stores the exact per-order aggregate the application already
// computes repeatedly on every tab.

export const ORDER_SETTLEMENT_TOTALS_TABLE = 'order_settlement_totals';

export const ORDER_SETTLEMENT_TOTALS_SELECT = `
  SELECT
    order_item_id,
    SUM(bank_settlement)                                             AS net_bank,
    SUM(CASE WHEN bank_settlement < 0 THEN ABS(bank_settlement) ELSE 0 END) AS negative_bank_amount,
    SUM(CASE WHEN refund < 0 THEN ABS(refund) ELSE 0 END)           AS refund_amount,
    MIN(payment_date)                                               AS payment_date,
    COUNT(*)                                                        AS row_count,
    COUNT(CASE WHEN refund < 0 THEN 1 END)                          AS refund_count,
    COUNT(CASE WHEN bank_settlement > 0 THEN 1 END)                 AS settled_row_count,
    SUM(CASE WHEN bank_settlement > 0 THEN ABS(COALESCE(commission,0))       ELSE 0 END) AS commission,
    SUM(CASE WHEN bank_settlement > 0 THEN ABS(COALESCE(fixed_fee,0))        ELSE 0 END) AS fixed_fee,
    SUM(CASE WHEN bank_settlement > 0 THEN ABS(COALESCE(collection_fee,0))   ELSE 0 END) AS collection_fee,
    SUM(CASE WHEN bank_settlement > 0 THEN ABS(COALESCE(pick_pack_fee,0))    ELSE 0 END) AS pick_pack_fee,
    SUM(CASE WHEN bank_settlement > 0 THEN ABS(COALESCE(shipping_fee,0))     ELSE 0 END) AS shipping_fee,
    SUM(ABS(COALESCE(reverse_shipping,0)))                                               AS reverse_shipping,
    SUM(CASE WHEN bank_settlement > 0 THEN ABS(COALESCE(franchise_fee,0))    ELSE 0 END) AS franchise_fee,
    SUM(CASE WHEN bank_settlement > 0 THEN ABS(COALESCE(tcs,0))              ELSE 0 END) AS tcs,
    SUM(CASE WHEN bank_settlement > 0 THEN ABS(COALESCE(tds,0))              ELSE 0 END) AS tds,
    SUM(CASE WHEN bank_settlement > 0 THEN ABS(COALESCE(gst_on_mp_fees,0))   ELSE 0 END) AS gst_on_mp_fees
  FROM unified_settlements
  -- A null settlement key cannot join an order, so excluding it preserves all
  -- dashboard/report results while allowing a strong primary key on the read model.
  WHERE order_item_id IS NOT NULL
  GROUP BY order_item_id
`;

const COLUMNS = [
  'order_item_id', 'net_bank', 'negative_bank_amount', 'refund_amount', 'payment_date', 'row_count', 'refund_count', 'settled_row_count',
  'commission', 'fixed_fee', 'collection_fee', 'pick_pack_fee', 'shipping_fee',
  'reverse_shipping', 'franchise_fee', 'tcs', 'tds', 'gst_on_mp_fees',
];

/**
 * Create the table and build it once for an existing database. Schema
 * statements run on `ddl` (initDb's lock_timeout-limited session); the
 * rebuild needs `pool` to run in its own transaction.
 */
export async function ensureOrderSettlementTotals(pool, ddl = pool) {
  await ddl.query(`
    CREATE TABLE IF NOT EXISTS ${ORDER_SETTLEMENT_TOTALS_TABLE} (
      order_item_id TEXT PRIMARY KEY,
      net_bank NUMERIC(14,2) NOT NULL DEFAULT 0,
      negative_bank_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      refund_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      payment_date DATE,
      row_count BIGINT NOT NULL DEFAULT 0,
      refund_count BIGINT NOT NULL DEFAULT 0,
      settled_row_count BIGINT NOT NULL DEFAULT 0,
      commission NUMERIC(14,2) NOT NULL DEFAULT 0,
      fixed_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      collection_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      pick_pack_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      shipping_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      reverse_shipping NUMERIC(14,2) NOT NULL DEFAULT 0,
      franchise_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      tcs NUMERIC(14,2) NOT NULL DEFAULT 0,
      tds NUMERIC(14,2) NOT NULL DEFAULT 0,
      gst_on_mp_fees NUMERIC(14,2) NOT NULL DEFAULT 0
    )
  `);
  // This model evolves independently of the broader schema version. Detect
  // columns before adding them so an established model is rebuilt exactly once
  // after a shape change rather than returning a default-filled new metric.
  const { rows: existingColumns } = await ddl.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = $1
      AND column_name IN ('settled_row_count', 'negative_bank_amount')
  `, [ORDER_SETTLEMENT_TOTALS_TABLE]);
  const existingColumnNames = new Set(existingColumns.map(row => row.column_name));
  const needsMetricBackfill = existingColumnNames.size < 2;
  // ALTER TABLE takes an ACCESS EXCLUSIVE lock even when the column exists,
  // and every dashboard report joins this table, so only add what is missing.
  if (!existingColumnNames.has('settled_row_count')) {
    await ddl.query(`ALTER TABLE ${ORDER_SETTLEMENT_TOTALS_TABLE} ADD COLUMN IF NOT EXISTS settled_row_count BIGINT NOT NULL DEFAULT 0`);
  }
  if (!existingColumnNames.has('negative_bank_amount')) {
    await ddl.query(`ALTER TABLE ${ORDER_SETTLEMENT_TOTALS_TABLE} ADD COLUMN IF NOT EXISTS negative_bank_amount NUMERIC(14,2) NOT NULL DEFAULT 0`);
  }
  const { rows } = await pool.query(`
    SELECT COUNT(*) AS count, COALESCE(SUM(settled_row_count), 0) AS settled_rows
    FROM ${ORDER_SETTLEMENT_TOTALS_TABLE}
  `);

  const healedCount = await healAmazonOrderItemIds(pool);

  if (needsMetricBackfill || Number(rows[0]?.count || 0) === 0 || Number(rows[0]?.settled_rows || 0) === 0 || healedCount > 0) {
    await refreshOrderSettlementTotals(pool);
  }
}

/**
 * Give Amazon orders that are missing an order_item_id the settlement's
 * order_item_code (latest posting per order/SKU). Runs on every startup.
 *
 * It starts from the (few) orders that still lack an id and probes
 * amazon_settlement_lines through its (order_id, sku) index. The previous form
 * sorted the ENTIRE settlement ledger with DISTINCT ON on every boot, under the
 * 45 s statement timeout and without a catch: once the ledger grew large
 * enough, startup failed, /api stayed 503 and every retry repeated the scan.
 * A failure is now logged and leaves readiness alone; the heal is retried on
 * the next start.
 */
export async function healAmazonOrderItemIds(pool) {
  try {
    const { rows } = await pool.query(`
      WITH missing AS (
        SELECT id, order_id, sku
        FROM orders
        WHERE marketplace = 'amazon'
          AND (order_item_id IS NULL OR order_item_id = '')
          AND order_id IS NOT NULL
          AND sku IS NOT NULL
      ),
      sl AS (
        SELECT DISTINCT ON (l.order_id, l.sku) l.order_id, l.sku, l.order_item_code
        FROM amazon_settlement_lines l
        JOIN (SELECT DISTINCT order_id, sku FROM missing) m
          ON m.order_id = l.order_id AND m.sku = l.sku
        WHERE l.order_item_code IS NOT NULL AND l.order_item_code <> ''
        ORDER BY l.order_id, l.sku, l.posted_date DESC
      ),
      healed_from_settlement AS (
        UPDATE orders o
        SET order_item_id = sl.order_item_code
        FROM missing m
        JOIN sl ON sl.order_id = m.order_id AND sl.sku = m.sku
        WHERE o.id = m.id
          AND (o.order_item_id IS NULL OR o.order_item_id = '')
        RETURNING o.id
      )
      SELECT COUNT(*) AS healed_count FROM healed_from_settlement
    `);
    return Number(rows[0]?.healed_count || 0);
  } catch (error) {
    console.warn('[db] Non-critical: Amazon order_item_id heal skipped:', error.message);
    return 0;
  }
}

// Transaction-scoped advisory lock that serializes rebuilds. Without it, two
// imports finishing together both ran DELETE+INSERT: the second transaction
// could not see the first's uncommitted rows and failed on the primary key
// (rolling back a whole Flipkart NEFT import, or silently leaving totals stale).
export const ORDER_SETTLEMENT_TOTALS_LOCK_KEY = 7_140_231_117;

const METRIC_COLUMNS = COLUMNS.filter(column => column !== 'order_item_id');
// Stored types of the metric columns (see the CREATE TABLE above).
const METRIC_COLUMN_TYPES = Object.fromEntries(METRIC_COLUMNS.map(column => [
  column,
  column === 'payment_date' ? 'DATE' : column.endsWith('_count') ? 'BIGINT' : 'NUMERIC(14,2)',
]));
const NEXT_TABLE = 'order_settlement_totals_next';

/** Rebuild atomically in the caller's transaction after settlement-source writes. */
export async function refreshOrderSettlementTotals(queryable) {
  const ownsTransaction = typeof queryable.connect === 'function' && typeof queryable.release !== 'function';
  const client = ownsTransaction ? await queryable.connect() : queryable;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ORDER_SETTLEMENT_TOTALS_LOCK_KEY]);

    // Compute the complete model once, then write only the rows that changed.
    // An import usually changes a few thousand of ~330K rows; the previous
    // DELETE-all + INSERT-all rewrote every row (and its index entry and WAL)
    // on each upload and left a table's worth of dead tuples behind. The end
    // state is identical: rows missing from the new model are deleted, and
    // every other row is inserted or updated to exactly the new values.
    // Concurrent dashboard reads keep their committed snapshot throughout.
    await client.query(`DROP TABLE IF EXISTS pg_temp.${NEXT_TABLE}`);
    const built = await client.query(`
      CREATE TEMP TABLE ${NEXT_TABLE} ON COMMIT DROP AS
      ${ORDER_SETTLEMENT_TOTALS_SELECT}
    `);
    // Temp tables are never auto-analyzed; without statistics the planner can
    // pick a nested-loop anti join over two 300K-row inputs.
    await client.query(`ANALYZE ${NEXT_TABLE}`);
    const removed = await client.query(`
      DELETE FROM ${ORDER_SETTLEMENT_TOTALS_TABLE} existing
      WHERE NOT EXISTS (
        SELECT 1 FROM ${NEXT_TABLE} fresh WHERE fresh.order_item_id = existing.order_item_id
      )
    `);
    // The change test runs in the SELECT, against the stored row, so unchanged
    // rows never reach ON CONFLICT. A `DO UPDATE ... WHERE <unchanged>` still
    // locks every conflicting row (PostgreSQL stamps each tuple and WAL-logs
    // the lock), which rewrote pages for all ~330K orders on every upload.
    // Fresh values are cast to the stored column types (NUMERIC(14,2), ...) so
    // the comparison uses the same rounding the table applies on write.
    const written = await client.query(`
      INSERT INTO ${ORDER_SETTLEMENT_TOTALS_TABLE} (${COLUMNS.join(', ')})
      SELECT ${COLUMNS.map(column => `fresh.${column}`).join(', ')}
      FROM ${NEXT_TABLE} fresh
      LEFT JOIN ${ORDER_SETTLEMENT_TOTALS_TABLE} existing ON existing.order_item_id = fresh.order_item_id
      WHERE existing.order_item_id IS NULL
         OR (${METRIC_COLUMNS.map(column => `existing.${column}`).join(', ')})
            IS DISTINCT FROM (${METRIC_COLUMNS.map(column => `fresh.${column}::${METRIC_COLUMN_TYPES[column]}`).join(', ')})
      ON CONFLICT (order_item_id) DO UPDATE SET
        ${METRIC_COLUMNS.map(column => `${column} = EXCLUDED.${column}`).join(',\n        ')}
    `);
    if (ownsTransaction) await client.query('COMMIT');
    return {
      rowsRefreshed: built.rowCount || 0,
      rowsChanged: (written.rowCount || 0) + (removed.rowCount || 0),
    };
  } catch (error) {
    if (ownsTransaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}
