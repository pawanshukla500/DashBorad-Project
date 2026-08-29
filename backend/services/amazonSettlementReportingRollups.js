// The Amazon settlement source is a long ledger: a single order commonly has
// a dozen fee/tax rows.  Dashboard queries must not re-pivot that ledger on
// every page load.  This table is a transactionally maintained, reproducible
// read model at the same order/day grain used by the historic view.

export const AMAZON_REPORTING_ROLLUP_TABLE = 'amazon_settlement_reporting_rollups';

const REPORTING_COLUMNS = [
  'settlement_id', 'posted_date_key', 'posted_date', 'order_id', 'sku', 'order_item_code',
  'bank_settlement', 'sale_amount', 'marketplace_fee', 'refund_amount',
  'commission', 'fixed_fee', 'pick_pack_fee', 'shipping_fee', 'reverse_shipping',
  'tcs', 'tds', 'gst_on_mp_fees', 'mp_other_fee', 'fulfilment_id', 'quantity',
  'return_type', 'spf_received', 'spf_received_date', 'spf_received_amount', 'spf_received_neft_id',
];

const UPDATE_COLUMNS = REPORTING_COLUMNS
  .filter(column => !['settlement_id', 'posted_date_key', 'order_id', 'sku', 'order_item_code'].includes(column))
  .map(column => `${column} = EXCLUDED.${column}`)
  .join(', ');

// Keep this predicate byte-for-byte equivalent in meaning to the old
// `unified_settlements` Amazon branch.  The rollup changes when the work is
// performed, not which amounts are classified as an "other" marketplace fee.
const KNOWN_AMOUNT_SQL = `(
  (l.transaction_type = 'Order' AND l.amount_type = 'ItemPrice' AND l.amount_description IN ('Principal', 'Product Tax'))
  OR (l.transaction_type = 'Refund' AND l.amount_type = 'ItemPrice' AND l.amount_description IN ('Principal', 'Product Tax'))
  OR l.amount_description ILIKE 'Commission%'
  OR l.amount_description ILIKE 'Fixed closing fee%'
  OR l.amount_description ILIKE 'FBA Pick & Pack Fee%'
  OR l.amount_description ILIKE 'FBA Weight Handling Fee%'
  OR l.amount_description ILIKE 'Shipping Chargeback%'
  OR l.amount_description ILIKE 'Refund commission%'
  OR l.amount_description ILIKE 'TCS%'
  OR l.amount_description ILIKE 'TDS%'
  OR (l.amount_description ILIKE '%GST%' AND l.amount_type != 'FBA Inventory Reimbursement')
  OR l.amount_type = 'FBA Inventory Reimbursement'
  OR l.amount_description IN ('SAFE-T Reimbursement', 'Reimbursement for Lost packages')
)`;

function sourceSql(settlementScope = '') {
  return `
    SELECT
      COALESCE(l.settlement_id, '') AS settlement_id,
      COALESCE(l.posted_date, DATE '1970-01-01') AS posted_date_key,
      l.posted_date,
      l.order_id,
      COALESCE(l.sku, '') AS sku,
      COALESCE(l.order_item_code, '') AS order_item_code,
      SUM(COALESCE(l.amount, 0)) AS bank_settlement,
      SUM(CASE WHEN l.transaction_type = 'Order' AND l.amount_type = 'ItemPrice' AND l.amount_description IN ('Principal', 'Product Tax') THEN l.amount ELSE 0 END) AS sale_amount,
      SUM(CASE WHEN NOT ${KNOWN_AMOUNT_SQL} AND l.amount > 0 THEN l.amount ELSE 0 END) AS marketplace_fee,
      SUM(CASE WHEN l.transaction_type = 'Refund' AND l.amount_type = 'ItemPrice' AND l.amount_description IN ('Principal', 'Product Tax') THEN l.amount ELSE 0 END) AS refund_amount,
      -- Store signed components here. The unified view re-aggregates the
      -- compact rows at its historical order/day grain before applying ABS,
      -- preserving settlement/refund netting across multiple payouts.
      SUM(CASE WHEN l.amount_description ILIKE 'Commission%' THEN l.amount ELSE 0 END) AS commission,
      SUM(CASE WHEN l.amount_description ILIKE 'Fixed closing fee%' THEN l.amount ELSE 0 END) AS fixed_fee,
      SUM(CASE WHEN l.amount_description ILIKE 'FBA Pick & Pack Fee%' THEN l.amount ELSE 0 END) AS pick_pack_fee,
      SUM(CASE WHEN l.amount_description ILIKE 'FBA Weight Handling Fee%' OR l.amount_description ILIKE 'Shipping Chargeback%' THEN l.amount ELSE 0 END) AS shipping_fee,
      SUM(CASE WHEN l.amount_description ILIKE 'Refund commission%' THEN l.amount ELSE 0 END) AS reverse_shipping,
      SUM(CASE WHEN l.amount_description ILIKE 'TCS%' THEN l.amount ELSE 0 END) AS tcs,
      SUM(CASE WHEN l.amount_description ILIKE 'TDS%' THEN l.amount ELSE 0 END) AS tds,
      SUM(CASE WHEN l.amount_description ILIKE '%GST%' AND l.amount_type != 'FBA Inventory Reimbursement' THEN l.amount ELSE 0 END) AS gst_on_mp_fees,
      SUM(CASE WHEN NOT ${KNOWN_AMOUNT_SQL} AND l.amount < 0 THEN l.amount ELSE 0 END) AS mp_other_fee,
      MAX(l.fulfillment_id) AS fulfilment_id,
      COALESCE(SUM(l.quantity), 0) AS quantity,
      MAX(CASE WHEN l.transaction_type = 'Fulfillment Fee Refund' THEN 'RTO' WHEN l.transaction_type = 'Refund' THEN 'Customer Return' ELSE NULL END) AS return_type,
      BOOL_OR(CASE WHEN l.amount_type = 'FBA Inventory Reimbursement' OR l.amount_description IN ('SAFE-T Reimbursement', 'Reimbursement for Lost packages') THEN TRUE ELSE FALSE END) AS spf_received,
      MAX(CASE WHEN l.amount_type = 'FBA Inventory Reimbursement' OR l.amount_description IN ('SAFE-T Reimbursement', 'Reimbursement for Lost packages') THEN l.posted_date ELSE NULL END) AS spf_received_date,
      SUM(CASE WHEN l.amount_type = 'FBA Inventory Reimbursement' OR l.amount_description IN ('SAFE-T Reimbursement', 'Reimbursement for Lost packages') THEN l.amount ELSE 0 END) AS spf_received_amount,
      MAX(CASE WHEN l.amount_type = 'FBA Inventory Reimbursement' OR l.amount_description IN ('SAFE-T Reimbursement', 'Reimbursement for Lost packages') THEN l.settlement_id ELSE NULL END) AS spf_received_neft_id
    FROM amazon_settlement_lines l
    WHERE l.order_id ~ '^\\d{3}-\\d{7}-\\d{7}$' ${settlementScope}
    GROUP BY
      COALESCE(l.settlement_id, ''),
      COALESCE(l.posted_date, DATE '1970-01-01'),
      l.posted_date,
      l.order_id,
      COALESCE(l.sku, ''),
      COALESCE(l.order_item_code, '')
  `;
}

/** Build or backfill the compact Amazon read model. Safe on every boot. */
export async function ensureAmazonSettlementReportingRollups(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${AMAZON_REPORTING_ROLLUP_TABLE} (
      settlement_id TEXT NOT NULL,
      posted_date_key DATE NOT NULL,
      posted_date DATE,
      order_id TEXT NOT NULL,
      sku TEXT NOT NULL DEFAULT '',
      order_item_code TEXT NOT NULL DEFAULT '',
      bank_settlement NUMERIC(14,2) NOT NULL DEFAULT 0,
      sale_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      marketplace_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      refund_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      commission NUMERIC(14,2) NOT NULL DEFAULT 0,
      fixed_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      pick_pack_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      shipping_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      reverse_shipping NUMERIC(14,2) NOT NULL DEFAULT 0,
      tcs NUMERIC(14,2) NOT NULL DEFAULT 0,
      tds NUMERIC(14,2) NOT NULL DEFAULT 0,
      gst_on_mp_fees NUMERIC(14,2) NOT NULL DEFAULT 0,
      mp_other_fee NUMERIC(14,2) NOT NULL DEFAULT 0,
      fulfilment_id TEXT,
      quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
      return_type TEXT,
      spf_received BOOLEAN NOT NULL DEFAULT FALSE,
      spf_received_date DATE,
      spf_received_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      spf_received_neft_id TEXT,
      PRIMARY KEY (settlement_id, posted_date_key, order_id, sku, order_item_code)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_amzn_reporting_rollup_order_date
      ON ${AMAZON_REPORTING_ROLLUP_TABLE}(order_id, sku, posted_date DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_amzn_reporting_rollup_posted_date
      ON ${AMAZON_REPORTING_ROLLUP_TABLE}(posted_date DESC)
  `);

  const { rows } = await pool.query(`SELECT COUNT(*) AS count FROM ${AMAZON_REPORTING_ROLLUP_TABLE}`);
  if (Number(rows[0]?.count || 0) === 0) {
    // Historical build is deliberately one controlled query. Subsequent file
    // imports rebuild only the settlement they replace.
    await refreshAmazonSettlementReportingRollups(pool);
  }
}

/** Rebuild one settlement (or all historical data when settlementId is omitted). */
export async function refreshAmazonSettlementReportingRollups(queryable, settlementId = null) {
  const ownsTransaction = typeof queryable.connect === 'function';
  const client = ownsTransaction ? await queryable.connect() : queryable;
  const params = settlementId ? [settlementId] : [];
  const scope = settlementId ? 'AND l.settlement_id = $1' : '';
  try {
    if (ownsTransaction) await client.query('BEGIN');
    if (settlementId) {
      await client.query(`DELETE FROM ${AMAZON_REPORTING_ROLLUP_TABLE} WHERE settlement_id = $1`, [settlementId]);
    } else {
      // Keep readers on their prior committed snapshot while a clear/full
      // rebuild is in progress; TRUNCATE would block them with an exclusive lock.
      await client.query(`DELETE FROM ${AMAZON_REPORTING_ROLLUP_TABLE}`);
    }

    const result = await client.query(`
      INSERT INTO ${AMAZON_REPORTING_ROLLUP_TABLE} (${REPORTING_COLUMNS.join(', ')})
      ${sourceSql(scope)}
      ON CONFLICT (settlement_id, posted_date_key, order_id, sku, order_item_code)
      DO UPDATE SET ${UPDATE_COLUMNS}
    `, params);
    if (ownsTransaction) await client.query('COMMIT');
    return { rowsRefreshed: result.rowCount || 0 };
  } catch (error) {
    if (ownsTransaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

/**
 * The Amazon portion of unified_settlements. Orders and returns stay as live
 * joins so order imports and return corrections are visible immediately;
 * only the expensive raw-ledger pivot is precomputed.
 */
export function amazonReportingRollupUnifiedSelect() {
  return `
SELECT
    MAX(r.settlement_id), NULL, r.posted_date,
    SUM(r.bank_settlement) AS bank_settlement,
    0, 0, r.order_id,
    COALESCE(ord.order_item_id, NULLIF(r.order_item_code, ''), 'AMZ:' || r.order_id || ':' || NULLIF(r.sku, '')),
    SUM(r.sale_amount) AS sale_amount,
    0, 0,
    SUM(r.marketplace_fee) AS customer_addons,
    0, 0, 0, 0,
    SUM(r.refund_amount) AS refund,
    NULL, 0,
    ABS(SUM(r.commission)) AS commission,
    ABS(SUM(r.fixed_fee)) AS fixed_fee,
    0,
    ABS(SUM(r.pick_pack_fee)) AS pick_pack_fee,
    ABS(SUM(r.shipping_fee)) AS shipping_fee,
    ABS(SUM(r.reverse_shipping)) AS reverse_shipping,
    0, 0, 0, 0, 0, 0, 0, 0,
    ABS(SUM(r.tcs)) AS tcs,
    ABS(SUM(r.tds)) AS tds,
    ABS(SUM(r.gst_on_mp_fees)) AS gst_on_mp_fees,
    ABS(SUM(r.mp_other_fee)) AS mp_other_fee,
    0, 0, 0, 0, 0, NULL, 0, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL,
    MAX(r.fulfilment_id), MAX(NULLIF(r.sku, '')), SUM(r.quantity), NULL, NULL,
    MAX(r.return_type),
    MAX(ret.ret_reason), MAX(ret.ret_sub), MAX(ret.ret_status), NULL,
    'amazon'::text, NULL,
    BOOL_OR(r.spf_received),
    MAX(r.spf_received_date),
    SUM(r.spf_received_amount),
    MAX(r.spf_received_neft_id)
FROM ${AMAZON_REPORTING_ROLLUP_TABLE} r
LEFT JOIN (
  SELECT order_id, sku,
         MAX(return_reason) AS ret_reason,
         MAX(return_sub_reason) AS ret_sub,
         MAX(disposition) AS ret_status
  FROM returns
  WHERE marketplace = 'amazon'
  GROUP BY order_id, sku
) ret ON ret.order_id = r.order_id AND ret.sku = NULLIF(r.sku, '')
LEFT JOIN orders ord
  ON ord.marketplace = 'amazon'
 AND ord.order_id = r.order_id
 AND ord.sku = NULLIF(r.sku, '')
WHERE r.order_id ~ '^\\d{3}-\\d{7}-\\d{7}$'
GROUP BY COALESCE(ord.order_item_id, NULLIF(r.order_item_code, ''), 'AMZ:' || r.order_id || ':' || NULLIF(r.sku, '')),
         r.order_id, r.sku, r.posted_date
`;
}
