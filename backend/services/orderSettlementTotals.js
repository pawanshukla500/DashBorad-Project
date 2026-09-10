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

/** Create the table and build it once for an existing database. */
export async function ensureOrderSettlementTotals(pool) {
  await pool.query(`
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
  const { rows: existingColumns } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = $1
      AND column_name IN ('settled_row_count', 'negative_bank_amount')
  `, [ORDER_SETTLEMENT_TOTALS_TABLE]);
  const existingColumnNames = new Set(existingColumns.map(row => row.column_name));
  const needsMetricBackfill = existingColumnNames.size < 2;
  await pool.query(`ALTER TABLE ${ORDER_SETTLEMENT_TOTALS_TABLE} ADD COLUMN IF NOT EXISTS settled_row_count BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE ${ORDER_SETTLEMENT_TOTALS_TABLE} ADD COLUMN IF NOT EXISTS negative_bank_amount NUMERIC(14,2) NOT NULL DEFAULT 0`);
  const { rows } = await pool.query(`
    SELECT COUNT(*) AS count, COALESCE(SUM(settled_row_count), 0) AS settled_rows
    FROM ${ORDER_SETTLEMENT_TOTALS_TABLE}
  `);
  if (needsMetricBackfill || Number(rows[0]?.count || 0) === 0 || Number(rows[0]?.settled_rows || 0) === 0) {
    await refreshOrderSettlementTotals(pool);
  }
}

/** Rebuild atomically in the caller's transaction after settlement-source writes. */
export async function refreshOrderSettlementTotals(queryable) {
  const ownsTransaction = typeof queryable.connect === 'function';
  const client = ownsTransaction ? await queryable.connect() : queryable;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    // DELETE keeps concurrent dashboard reads on the previously committed
    // snapshot. TRUNCATE would take an ACCESS EXCLUSIVE lock and make every tab
    // wait behind a multi-second import refresh.
    await client.query(`DELETE FROM ${ORDER_SETTLEMENT_TOTALS_TABLE}`);
    const result = await client.query(`
      INSERT INTO ${ORDER_SETTLEMENT_TOTALS_TABLE} (${COLUMNS.join(', ')})
      ${ORDER_SETTLEMENT_TOTALS_SELECT}
    `);
    if (ownsTransaction) await client.query('COMMIT');
    return { rowsRefreshed: result.rowCount || 0 };
  } catch (error) {
    if (ownsTransaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}
