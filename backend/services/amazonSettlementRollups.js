import { AMAZON_FEE_CATALOG, AMAZON_FEE_CODE_CASE_SQL } from './amazonReconciliation.js';

// This is application-owned metadata, not a value parsed from Amazon's file.
// The seller confirmed that every Amazon sale belongs to this one brand.
export const AMAZON_BRAND = 'Ethnic Juction';

const BASE_COLUMNS = [
  'settlement_id', 'posted_month', 'order_id', 'sku', 'first_posted', 'last_posted',
  'line_count', 'order_line_count', 'refund_line_count', 'has_refund', 'has_fee_refund',
  'settlement_quantity', 'sale_amount', 'refund_amount', 'principal_amount', 'product_tax_amount',
  'shipping_amount', 'shipping_tax_amount', 'shipping_discount_amount', 'shipping_tax_discount_amount',
  'tcs_amount', 'tds_amount', 'net_settlement', 'has_fba_pick_pack', 'has_technology_fee',
  'has_weight_handling',
];

const FEE_COLUMNS = AMAZON_FEE_CATALOG.flatMap(fee => [
  `${fee.code}_base`, `${fee.code}_tax`, `${fee.code}_credit`,
]);
const ALL_COLUMNS = [...BASE_COLUMNS, ...FEE_COLUMNS];
const NUMERIC_COLUMNS = new Set([
  'sale_amount', 'refund_amount', 'principal_amount', 'product_tax_amount', 'shipping_amount',
  'shipping_tax_amount', 'shipping_discount_amount', 'shipping_tax_discount_amount', 'tcs_amount',
  'tds_amount', 'net_settlement', ...FEE_COLUMNS,
]);

function feeSelects() {
  return AMAZON_FEE_CATALOG.map(fee => `
    COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'Order' AND fee_code = '${fee.code}'), 0) AS ${fee.code}_base,
    COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'Order' AND fee_code = '${fee.code}_tax'), 0) AS ${fee.code}_tax,
    COALESCE(SUM(amount) FILTER (WHERE transaction_type <> 'Order' AND fee_code IN ('${fee.code}', '${fee.code}_tax')), 0) AS ${fee.code}_credit
  `).join(',');
}

function columnDefinition(column) {
  if (['settlement_id', 'order_id', 'sku'].includes(column)) return `${column} TEXT NOT NULL`;
  if (column === 'posted_month') return `${column} DATE NOT NULL`;
  if (['first_posted', 'last_posted'].includes(column)) return `${column} DATE`;
  if (['line_count', 'order_line_count', 'refund_line_count', 'settlement_quantity'].includes(column)) return `${column} INT NOT NULL DEFAULT 0`;
  if (['has_refund', 'has_fee_refund', 'has_fba_pick_pack', 'has_technology_fee', 'has_weight_handling'].includes(column)) return `${column} BOOL NOT NULL DEFAULT FALSE`;
  if (NUMERIC_COLUMNS.has(column)) return `${column} NUMERIC(14,2) NOT NULL DEFAULT 0`;
  throw new Error(`Unknown Amazon settlement rollup column: ${column}`);
}

/**
 * Keeps payment reconciliation proportional to order/SKU/month rows instead of
 * source-ledger rows. The original Amazon lines remain the audit source; this
 * table is a fully reproducible, replaceable read model.
 */
export async function ensureAmazonSettlementRollups(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS amazon_order_settlement_rollups (
      ${ALL_COLUMNS.map(columnDefinition).join(',\n      ')},
      PRIMARY KEY (settlement_id, posted_month, order_id, sku)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_amzn_rollup_month_order
      ON amazon_order_settlement_rollups(posted_month DESC, order_id, sku)
  `);

  const { rows } = await pool.query(`SELECT COUNT(*) AS count FROM amazon_order_settlement_rollups`);
  if (Number(rows[0]?.count || 0) === 0) {
    // One controlled historical build on first deployment. Every later upload
    // refreshes only its own settlement, so normal imports remain inexpensive.
    await refreshAmazonSettlementRollups(pool);
  }
}

/** Refresh one settlement, or all historic rows when settlementId is omitted. */
export async function refreshAmazonSettlementRollups(queryable, settlementId = null) {
  const params = settlementId ? [settlementId] : [];
  const scope = settlementId ? 'AND l.settlement_id = $1' : '';
  if (settlementId) {
    await queryable.query(`DELETE FROM amazon_order_settlement_rollups WHERE settlement_id = $1`, [settlementId]);
  }

  const updateColumns = ALL_COLUMNS
    .filter(column => !['settlement_id', 'posted_month', 'order_id', 'sku'].includes(column))
    .map(column => `${column} = EXCLUDED.${column}`)
    .join(', ');

  const result = await queryable.query(`
    INSERT INTO amazon_order_settlement_rollups (${ALL_COLUMNS.join(', ')})
    WITH classified AS (
      SELECT
        l.settlement_id,
        COALESCE(DATE_TRUNC('month', l.posted_date)::date, DATE '1970-01-01') AS posted_month,
        l.order_id,
        COALESCE(l.sku, '') AS sku,
        l.posted_date,
        l.transaction_type,
        l.amount,
        l.quantity,
        ${AMAZON_FEE_CODE_CASE_SQL} AS fee_code
      FROM amazon_settlement_lines l
      WHERE l.order_id IS NOT NULL ${scope}
    )
    SELECT
      settlement_id,
      posted_month,
      order_id,
      sku,
      MIN(posted_date) AS first_posted,
      MAX(posted_date) AS last_posted,
      COUNT(*) AS line_count,
      COUNT(*) FILTER (WHERE transaction_type = 'Order') AS order_line_count,
      COUNT(*) FILTER (WHERE transaction_type = 'Refund') AS refund_line_count,
      BOOL_OR(transaction_type = 'Refund') AS has_refund,
      BOOL_OR(transaction_type = 'Fulfillment Fee Refund') AS has_fee_refund,
      COALESCE(MAX(quantity) FILTER (WHERE transaction_type = 'Order' AND fee_code = 'principal'), 0) AS settlement_quantity,
      COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'Order' AND fee_code IN ('principal', 'product_tax')), 0) AS sale_amount,
      COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'Refund' AND fee_code IN ('principal', 'product_tax')), 0) AS refund_amount,
      COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'Order' AND fee_code = 'principal'), 0) AS principal_amount,
      COALESCE(SUM(amount) FILTER (WHERE transaction_type = 'Order' AND fee_code = 'product_tax'), 0) AS product_tax_amount,
      COALESCE(SUM(amount) FILTER (WHERE fee_code = 'shipping'), 0) AS shipping_amount,
      COALESCE(SUM(amount) FILTER (WHERE fee_code = 'shipping_tax'), 0) AS shipping_tax_amount,
      COALESCE(SUM(amount) FILTER (WHERE fee_code = 'shipping_discount'), 0) AS shipping_discount_amount,
      COALESCE(SUM(amount) FILTER (WHERE fee_code = 'shipping_tax_discount'), 0) AS shipping_tax_discount_amount,
      COALESCE(SUM(amount) FILTER (WHERE fee_code = 'tcs'), 0) AS tcs_amount,
      COALESCE(SUM(amount) FILTER (WHERE fee_code = 'tds'), 0) AS tds_amount,
      COALESCE(SUM(amount), 0) AS net_settlement,
      BOOL_OR(transaction_type = 'Order' AND fee_code = 'fba_pick_pack') AS has_fba_pick_pack,
      BOOL_OR(transaction_type = 'Order' AND fee_code = 'technology_fee') AS has_technology_fee,
      BOOL_OR(fee_code = 'fba_weight_handling') AS has_weight_handling,
      ${feeSelects()}
    FROM classified
    GROUP BY settlement_id, posted_month, order_id, sku
    ON CONFLICT (settlement_id, posted_month, order_id, sku) DO UPDATE SET ${updateColumns}
  `, params);

  return { rowsRefreshed: result.rowCount || 0 };
}
