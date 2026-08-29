// SKU settlement benchmark read model.
//
// This deliberately reads the compact, payment-backed sources instead of
// copying every Excel row into another table.  Raw files remain the audit
// evidence; this service returns a small, cacheable report for the UI.

const REPORT_CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export const BENCHMARK_MARKETPLACES = ['flipkart', 'amazon', 'meesho', 'myntra'];

function isMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

function monthStart(month) {
  return `${month}-01`;
}

function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function number(value) {
  return Number(value || 0);
}

// A completed sale for this report must be linked to an order in the selected
// *order month*, have a positive received settlement, and have no return,
// refund, cancellation, or RTO evidence. `settlement_per_unit` makes a
// 3-unit order comparable to a 1-unit order of the same SKU.
//
// The uploaded Amazon and Flipkart order layouts do not provide a separate
// delivered-date field. For those sources, a positive final settlement with no
// negative lifecycle evidence is the reliable delivered-sale signal.
function sourceSql(marketplace) {
  if (marketplace === 'flipkart') {
    return `
      WITH selected_orders AS MATERIALIZED (
        SELECT order_item_id, seller_account, sku, qty, order_date
        FROM orders
        WHERE marketplace = 'flipkart'
          AND order_date >= $1::date
          AND order_date < $2::date
          AND COALESCE(orders_status, '') !~* '(cancel|return|rto)'
      ),
      returned_items AS MATERIALIZED (
        SELECT r.order_item_id
        FROM returns r
        JOIN selected_orders o ON o.order_item_id = r.order_item_id
        WHERE r.marketplace = 'flipkart'
        UNION
        SELECT returned_item.order_item_id
        FROM fk_settlement_orders returned_item
        JOIN selected_orders o ON o.order_item_id = returned_item.order_item_id
        WHERE NULLIF(TRIM(returned_item.return_type), '') IS NOT NULL
      )
      SELECT
        DATE_TRUNC('month', o.order_date)::date AS order_month,
        COALESCE(o.seller_account, 'default') AS seller_account,
        f.order_item_id AS order_item_key,
        COALESCE(NULLIF(TRIM(f.seller_sku), ''), NULLIF(TRIM(o.sku), '')) AS sku,
        COALESCE(NULLIF(MAX(f.quantity), 0), NULLIF(MAX(o.qty), 0), 1)::numeric AS quantity,
        SUM(COALESCE(f.bank_settlement, 0)) AS net_settlement
      FROM fk_settlement_orders f
      JOIN selected_orders o ON o.order_item_id = f.order_item_id
      LEFT JOIN returned_items ri ON ri.order_item_id = f.order_item_id
      WHERE f.marketplace = 'flipkart'
        AND COALESCE(f.bank_settlement, 0) > 0
        AND ri.order_item_id IS NULL
      GROUP BY 1, 2, 3, 4
      HAVING COALESCE(NULLIF(TRIM(COALESCE(MAX(f.seller_sku), MAX(o.sku))), ''), '') <> ''
         AND SUM(COALESCE(f.bank_settlement, 0)) > 0
    `;
  }

  if (marketplace === 'amazon') return `
    WITH selected_orders AS MATERIALIZED (
      SELECT order_item_id, order_id, sku, seller_account, qty, order_date
      FROM orders
      WHERE marketplace = 'amazon'
        AND order_date >= $1::date
        AND order_date < $2::date
        AND COALESCE(orders_status, '') !~* '(cancel|return|rto)'
    ),
    excluded_order_lines AS MATERIALIZED (
      SELECT a.order_id, a.sku
      FROM amazon_order_settlement_rollups a
      JOIN selected_orders o ON o.order_id = a.order_id AND o.sku = a.sku
      WHERE a.has_refund OR a.has_fee_refund
      GROUP BY 1, 2
      UNION
      SELECT r.order_id, o.sku
      FROM returns r
      JOIN selected_orders o
        ON o.order_id = r.order_id
       AND (NULLIF(TRIM(r.sku), '') IS NULL OR o.sku = r.sku)
      WHERE r.marketplace = 'amazon'
      GROUP BY 1, 2
    )
    SELECT
      DATE_TRUNC('month', o.order_date)::date AS order_month,
      COALESCE(o.seller_account, 'default') AS seller_account,
      o.order_item_id AS order_item_key,
      NULLIF(TRIM(a.sku), '') AS sku,
      GREATEST(COALESCE(MAX(o.qty), 0), 1)::numeric AS quantity,
      SUM(CASE WHEN COALESCE(a.net_settlement, 0) > 0 THEN a.net_settlement ELSE 0 END) AS net_settlement
    FROM amazon_order_settlement_rollups a
    JOIN selected_orders o ON o.order_id = a.order_id AND o.sku = a.sku
    LEFT JOIN excluded_order_lines excluded
      ON excluded.order_id = a.order_id AND excluded.sku = a.sku
    WHERE excluded.order_id IS NULL
      AND a.order_line_count > 0
      AND NULLIF(TRIM(a.sku), '') IS NOT NULL
    GROUP BY 1, 2, 3, 4
    HAVING BOOL_OR(COALESCE(a.sale_amount, 0) > 0)
       AND BOOL_OR(COALESCE(a.net_settlement, 0) > 0)
       AND NOT BOOL_OR(COALESCE(a.has_refund, FALSE) OR COALESCE(a.has_fee_refund, FALSE))
  `;

  // Myntra and Meesho use the invoice settlement importer. `invoice_date` is
  // their stored sale/order date, so it controls the month selector; payment
  // date is intentionally not used. Paid status and a positive received amount
  // prevent open, blank, and negative invoice rows from entering the median.
  // The invoice id remains in the key because one invoice can legitimately
  // contain several SKU lines.
  return `
    SELECT
      DATE_TRUNC('month', i.invoice_date)::date AS order_month,
      COALESCE(NULLIF(TRIM(i.seller_account), ''), 'default') AS seller_account,
      COALESCE(NULLIF(TRIM(i.invoice_number), ''), 'invoice') || ':' || i.id::text AS order_item_key,
      NULLIF(TRIM(i.sku), '') AS sku,
      GREATEST(COALESCE(i.quantity, 1), 1)::numeric AS quantity,
      COALESCE(i.amount_received, 0)::numeric AS net_settlement
    FROM mp_invoices i
    WHERE i.marketplace = $5
      AND i.invoice_date >= $1::date
      AND i.invoice_date < $2::date
      AND LOWER(TRIM(COALESCE(i.status, ''))) = 'paid'
      AND COALESCE(i.amount_received, 0) > 0
      AND NULLIF(TRIM(i.sku), '') IS NOT NULL
  `;
}

function monthsSql(marketplace) {
  if (marketplace === 'flipkart') {
    return `
      SELECT DISTINCT TO_CHAR(DATE_TRUNC('month', o.order_date), 'YYYY-MM') AS month
      FROM fk_settlement_orders f
      JOIN orders o ON o.marketplace = 'flipkart' AND o.order_item_id = f.order_item_id
      WHERE f.marketplace = 'flipkart'
        AND o.order_date IS NOT NULL
        AND COALESCE(f.bank_settlement, 0) > 0
        AND COALESCE(o.orders_status, '') !~* '(cancel|return|rto)'
        AND NOT EXISTS (
          SELECT 1 FROM returns r
          WHERE r.marketplace = 'flipkart' AND r.order_item_id = f.order_item_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM fk_settlement_orders returned_item
          WHERE returned_item.order_item_id = f.order_item_id
            AND NULLIF(TRIM(returned_item.return_type), '') IS NOT NULL
        )
      ORDER BY month DESC
      LIMIT 24
    `;
  }
  if (marketplace === 'amazon') return `
    SELECT DISTINCT TO_CHAR(DATE_TRUNC('month', o.order_date), 'YYYY-MM') AS month
    FROM amazon_order_settlement_rollups a
    JOIN orders o ON o.marketplace = 'amazon' AND o.order_id = a.order_id AND o.sku = a.sku
    WHERE o.order_date IS NOT NULL
      AND a.order_line_count > 0
      AND COALESCE(a.sale_amount, 0) > 0
      AND COALESCE(a.net_settlement, 0) > 0
      AND COALESCE(o.orders_status, '') !~* '(cancel|return|rto)'
      AND NOT EXISTS (
        SELECT 1 FROM amazon_order_settlement_rollups refunded
        WHERE refunded.order_id = a.order_id
          AND refunded.sku = a.sku
          AND (refunded.has_refund OR refunded.has_fee_refund)
      )
      AND NOT EXISTS (
        SELECT 1 FROM returns r
        WHERE r.marketplace = 'amazon'
          AND r.order_id = a.order_id
          AND (NULLIF(TRIM(r.sku), '') IS NULL OR r.sku = a.sku)
      )
    ORDER BY month DESC
    LIMIT 24
  `;
  return `
    SELECT DISTINCT TO_CHAR(DATE_TRUNC('month', invoice_date), 'YYYY-MM') AS month
    FROM mp_invoices
    WHERE marketplace = $1
      AND invoice_date IS NOT NULL
      AND LOWER(TRIM(COALESCE(status, ''))) = 'paid'
      AND COALESCE(amount_received, 0) > 0
      AND NULLIF(TRIM(sku), '') IS NOT NULL
    ORDER BY month DESC
    LIMIT 24
  `;
}

export async function getSkuSettlementMonths(pool, marketplace) {
  const normalized = String(marketplace || '').toLowerCase();
  if (!BENCHMARK_MARKETPLACES.includes(normalized)) throw new Error('Unsupported marketplace');
  const invoiceMarketplace = normalized === 'myntra' || normalized === 'meesho';
  const result = await pool.query(monthsSql(normalized), invoiceMarketplace ? [normalized] : []);
  return result.rows.map(row => row.month).filter(isMonth);
}

/**
 * The operational SKU median price is the highest-frequency ±₹0.50 band around
 * a whole-rupee centre.  This intentionally groups ₹429.50, ₹430.00 and
 * ₹430.50 under the ₹430 candidate.  Exact statistical median is returned in
 * a separate column for auditing; it is not silently substituted for the
 * operational "most common" value requested by finance.
 */
export async function getSkuSettlementBenchmark(pool, { marketplace, month }) {
  const normalized = String(marketplace || '').toLowerCase();
  if (!BENCHMARK_MARKETPLACES.includes(normalized)) throw new Error('Unsupported marketplace');

  const months = await getSkuSettlementMonths(pool, normalized);
  const selectedMonth = isMonth(month) ? month : months[0];
  if (!selectedMonth) {
    return {
      marketplace: normalized, month: null, sourceReady: true,
      sourceMessage: 'No eligible completed-sale settlement rows have been imported yet.',
      availableMonths: months, rows: [],
      summary: { skuCount: 0, deliveredOrders: 0, units: 0, alerts: 0 },
    };
  }

  const cacheKey = `order-month-v2:${normalized}:${selectedMonth}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const previousMonth = shiftMonth(selectedMonth, -1);
  const startDate = monthStart(previousMonth);
  const endDate = monthStart(shiftMonth(selectedMonth, 1));
  const sql = `
    -- PostgreSQL can inline a reused CTE and repeatedly scan the raw
    -- settlement tables.  These are deliberately materialized: the report
    -- needs at most the selected month and its predecessor, then reuses that
    -- compact data for the median and the tolerance-band calculation.
    WITH source_rows AS MATERIALIZED (${sourceSql(normalized)}),
    payment_rows AS MATERIALIZED (
      SELECT
        order_month, seller_account, order_item_key, sku, quantity,
        net_settlement / NULLIF(quantity, 0) AS settlement_per_unit
      FROM source_rows
      WHERE quantity > 0
    ),
    selected_rows AS MATERIALIZED (
      SELECT * FROM payment_rows
      WHERE order_month = $3::date OR order_month = $4::date
    ),
    exact_stats AS MATERIALIZED (
      SELECT
        order_month, seller_account, sku,
        COUNT(*)::int AS delivered_orders,
        SUM(quantity)::int AS units,
        SUM(settlement_per_unit) AS total_settlement_per_unit,
        MIN(settlement_per_unit) AS min_settlement,
        MAX(settlement_per_unit) AS max_settlement,
        -- Convert the percentile back to NUMERIC for the money-facing response.
        PERCENTILE_CONT(0.5::float) WITHIN GROUP (ORDER BY settlement_per_unit::float)::numeric AS exact_median
      FROM selected_rows
      GROUP BY 1, 2, 3
    ),
    -- Each amount belongs to one nearest-rupee band.  A value exactly at the
    -- shared edge (for example ₹430.50) contributes to both adjacent bands,
    -- which lets the ₹430 group explicitly include the user's ₹429.50–₹430.50
    -- tolerance without an expensive SKU-row × candidate-row join.
    band_contributions AS MATERIALIZED (
      SELECT order_month, seller_account, sku, quantity,
             FLOOR(settlement_per_unit + 0.5)::numeric AS centre
      FROM selected_rows
      UNION ALL
      SELECT order_month, seller_account, sku, quantity,
             FLOOR(settlement_per_unit)::numeric AS centre
      FROM selected_rows
      WHERE settlement_per_unit - FLOOR(settlement_per_unit) = 0.5
    ),
    bands AS MATERIALIZED (
      SELECT order_month, seller_account, sku, centre,
             COUNT(*)::int AS tolerance_orders,
             SUM(quantity)::int AS tolerance_units
      FROM band_contributions
      GROUP BY 1, 2, 3, 4
    ),
    ranked_bands AS MATERIALIZED (
      SELECT
        b.*,
        ROW_NUMBER() OVER (
          PARTITION BY b.order_month, b.seller_account, b.sku
          ORDER BY b.tolerance_orders DESC,
                   ABS(b.centre - e.exact_median) ASC,
                   b.centre ASC
        ) AS rank
      FROM bands b
      JOIN exact_stats e
        ON e.order_month = b.order_month
       AND e.seller_account = b.seller_account
       AND e.sku = b.sku
    ),
    benchmarks AS MATERIALIZED (
      SELECT
        e.*, b.centre AS representative_settlement,
        b.tolerance_orders, b.tolerance_units
      FROM exact_stats e
      JOIN ranked_bands b
        ON b.order_month = e.order_month
       AND b.seller_account = e.seller_account
       AND b.sku = e.sku
       AND b.rank = 1
    ),
    current_month AS (
      SELECT * FROM benchmarks WHERE order_month = $3::date
    ),
    previous_month AS (
      SELECT * FROM benchmarks WHERE order_month = $4::date
    )
    SELECT
      c.seller_account, c.sku, c.delivered_orders, c.units,
      c.representative_settlement, c.exact_median, c.min_settlement, c.max_settlement,
      c.tolerance_orders, c.tolerance_units,
      p.representative_settlement AS previous_representative_settlement,
      p.exact_median AS previous_exact_median,
      CASE WHEN p.representative_settlement IS NULL THEN NULL
           ELSE c.representative_settlement - p.representative_settlement END AS change_from_previous,
      CASE WHEN p.representative_settlement IS NOT NULL
                 AND ABS(c.representative_settlement - p.representative_settlement) > 2
           THEN TRUE ELSE FALSE END AS has_change_alert
    FROM current_month c
    LEFT JOIN previous_month p
      ON p.seller_account = c.seller_account AND p.sku = c.sku
    ORDER BY has_change_alert DESC, ABS(COALESCE(c.representative_settlement - p.representative_settlement, 0)) DESC, c.delivered_orders DESC, c.sku
  `;
  const invoiceMarketplace = normalized === 'myntra' || normalized === 'meesho';
  const result = await pool.query(
    sql,
    invoiceMarketplace
      ? [startDate, endDate, monthStart(selectedMonth), monthStart(previousMonth), normalized]
      : [startDate, endDate, monthStart(selectedMonth), monthStart(previousMonth)]
  );
  const rows = result.rows.map(row => ({
    ...row,
    delivered_orders: number(row.delivered_orders), units: number(row.units),
    representative_settlement: number(row.representative_settlement), exact_median: number(row.exact_median),
    min_settlement: number(row.min_settlement), max_settlement: number(row.max_settlement),
    tolerance_orders: number(row.tolerance_orders), tolerance_units: number(row.tolerance_units),
    previous_representative_settlement: row.previous_representative_settlement === null ? null : number(row.previous_representative_settlement),
    previous_exact_median: row.previous_exact_median === null ? null : number(row.previous_exact_median),
    change_from_previous: row.change_from_previous === null ? null : number(row.change_from_previous),
  }));
  const value = {
    marketplace: normalized,
    month: selectedMonth,
    previousMonth,
    sourceReady: true,
    sourceMessage: invoiceMarketplace
      ? 'The selected month is the invoice/order month, not payment month. Only paid, positive invoice rows are included. Myntra VB and EJ stay separate by seller account; multi-quantity lines are converted to a per-unit value.'
      : 'The selected month is the uploaded order month, not payment or settlement month. Only positive completed sales with no return, refund, cancellation, or RTO evidence are included. Multi-quantity lines are converted to a per-unit value.',
    availableMonths: months,
    rows,
    summary: {
      skuCount: rows.length,
      deliveredOrders: rows.reduce((sum, row) => sum + row.delivered_orders, 0),
      units: rows.reduce((sum, row) => sum + row.units, 0),
      alerts: rows.filter(row => row.has_change_alert).length,
    },
  };
  cache.set(cacheKey, { value, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
  return value;
}

export function clearSkuSettlementBenchmarkCache(marketplace = null) {
  const prefix = marketplace ? `order-month-v2:${String(marketplace).toLowerCase()}:` : '';
  for (const key of cache.keys()) if (!prefix || key.startsWith(prefix)) cache.delete(key);
}
