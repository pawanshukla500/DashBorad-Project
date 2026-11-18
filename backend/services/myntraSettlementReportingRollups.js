// Myntra payment rows already live in `mp_invoices` at settlement-line grain,
// so no precomputed rollup table is needed (unlike Amazon's long raw ledger).
// This module contributes the Myntra branch of `unified_settlements` at the
// same order-line/day grain as the Flipkart and Amazon branches, following the
// read-model conventions they established:
//
//   refund          = refunded principal, stored NEGATIVE (FK convention)
//   bank_settlement = money the marketplace actually moved, EXCLUDING the
//                     refunded principal (netBank = bank - |refund|)
//
// A Myntra order settles more than once: a Forward payout, a Reverse refund
// row for the same order line, and sometimes a second payout under a new NEFT.
// Rows of one order line that share a payment date collapse into a single
// view row; `order_settlement_totals` then nets all of an order's rows.
//
// Example (order 100013851148): Forward +1161.37 and Reverse -1411.53 on the
// same day net to -250.16 in the bank, with the -1435.24 refunded principal
// carried by `refund` so bank + refund reproduces the true net.

// One row of `mp_invoices` is a Forward or Reverse settlement. Older rows
// imported before order_type existed keep their sign as the fallback signal.
const REVERSE_PREDICATE = `COALESCE(i.order_type, CASE WHEN i.invoice_amount < 0 THEN 'reverse' ELSE 'forward' END) = 'reverse'`;

/** The Myntra portion of unified_settlements. Orders stay a live join so order
 *  imports are visible immediately; only payment rows come from storage. */
export function myntraInvoicesUnifiedSelect() {
  return `
SELECT
    MAX(NULLIF(i.payment_reference, '')),
    NULL,
    -- A GROUP BY key, so this equals MAX(i.payment_date); exposing the plain
    -- column lets date filters on unified_settlements reach mp_invoices
    -- instead of aggregating every Myntra invoice first.
    i.payment_date,
    -- Reverse rows already deduct the refunded principal from amount_received;
    -- report that principal through \`refund\` instead so it is not netted twice.
    SUM(i.amount_received)
      - SUM(CASE WHEN ${REVERSE_PREDICATE} THEN i.invoice_amount ELSE 0 END) AS bank_settlement,
    0, 0,
    i.order_release_id,
    i.order_line_id,
    SUM(CASE WHEN NOT ${REVERSE_PREDICATE} THEN i.invoice_amount ELSE 0 END) AS sale_amount,
    0, 0, 0, 0, 0, 0, 0,
    SUM(CASE WHEN ${REVERSE_PREDICATE} THEN i.invoice_amount ELSE 0 END) AS refund,
    NULL, 0,
    ABS(SUM(i.commission_amount)) AS commission,
    ABS(SUM(COALESCE(i.fixed_fee_amount, 0))) AS fixed_fee,
    0,
    ABS(SUM(COALESCE(i.pick_pack_fee_amount, 0))) AS pick_pack_fee,
    -- Shipping_Fee is charged on Reverse rows (forward PPMP orders ship free);
    -- FK reports forward shipping in shipping_fee and return shipping in
    -- reverse_shipping, so the Myntra charge lands in reverse_shipping.
    ABS(SUM(CASE WHEN NOT ${REVERSE_PREDICATE} THEN COALESCE(i.shipping_fee_amount, 0) ELSE 0 END)) AS shipping_fee,
    ABS(SUM(CASE WHEN ${REVERSE_PREDICATE} THEN COALESCE(i.shipping_fee_amount, 0) ELSE 0 END)) AS reverse_shipping,
    0, 0, 0, 0, 0, 0, 0, 0,
    ABS(SUM(COALESCE(i.tcs_amount, 0))) AS tcs,
    ABS(SUM(i.tds_amount)) AS tds,
    ABS(SUM(COALESCE(i.gst_on_mp_fees, 0))) AS gst_on_mp_fees,
    ABS(SUM(COALESCE(i.gateway_fee_amount, 0))) AS mp_other_fee,
    0, 0, 0, 0, 0, NULL, 0, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL,
    MAX(o.fulfilment_type),
    MAX(o.sku),
    SUM(CASE WHEN NOT ${REVERSE_PREDICATE} THEN i.quantity ELSE 0 END),
    MAX(o.category),
    NULL,
    MAX(CASE WHEN ${REVERSE_PREDICATE} THEN 'Customer Return' ELSE NULL END),
    NULL,
    NULL,
    NULL,
    MAX(i.invoice_date),
    'myntra'::text,
    MAX(i.updated_at),
    FALSE,
    NULL,
    0,
    NULL,
    i.seller_account
FROM mp_invoices i
LEFT JOIN orders o
  ON o.marketplace = 'myntra'
 AND o.seller_account = i.seller_account
 AND o.order_item_id = i.order_line_id
WHERE i.marketplace = 'myntra'
  AND i.order_release_id IS NOT NULL
  AND i.order_line_id IS NOT NULL
  -- NOD (non-order deduction) rows have no order identity; they stay visible in
  -- the Myntra payment reconciliation tabs but cannot join a reporting order.
  AND COALESCE(i.order_type, '') <> 'nod'
GROUP BY i.seller_account, i.order_release_id, i.order_line_id, i.payment_date
`;
}

// Order columns written from Myntra payment rows (see the backfill below).
export const MYNTRA_PAYMENT_ORDER_COLUMNS = [
  'settlement_amount', 'commission', 'fixed_fee', 'pick_pack_fee', 'shipping_fee', 'reverse_shipping',
  'tcs', 'tds', 'gst_on_mp', 'collection_fee', 'return_received_amount',
];

/**
 * Reasons the blank-tracking rule writes on synthesized "cancelled before
 * dispatch" returns (return_id RTO-<line>): the current upload's spelling and
 * the one an older repair backfill wrote.
 */
export const MYNTRA_SYNTHESIZED_RETURN_REASONS = ['Cancel Before Dispached', 'Cancel before ship'];

const uniqueTexts = values => [...new Set((values || []).map(value => String(value ?? '').trim()).filter(Boolean))];

/**
 * A refresh scope: null = the whole account (or every account); otherwise the
 * order lines named in `lineIds` plus every line of the release ids in
 * `releaseIds` (from orders or payment rows). A plain array means release ids.
 */
function normalizeMyntraScope(scope) {
  if (scope == null) return null;
  if (Array.isArray(scope)) return { lineIds: [], releaseIds: uniqueTexts(scope) };
  return { lineIds: uniqueTexts(scope.lineIds), releaseIds: uniqueTexts(scope.releaseIds) };
}

/**
 * SQL (and params) selecting the affected Myntra order line ids. Payments link
 * to an order by (seller_account, order_line_id = orders.order_item_id); reset
 * and backfill both work on that same identity, so a payment that has a line
 * id but no release id is never missed by one of them.
 */
function myntraScopeSql(params, sellerAccount, scope) {
  let sellerParam = null;
  if (sellerAccount && sellerAccount !== 'all') {
    params.push(sellerAccount);
    sellerParam = `$${params.length}`;
  }
  const seller = alias => (sellerParam ? ` AND ${alias}.seller_account = ${sellerParam}` : '');
  if (!scope) return { seller, lines: null };
  params.push(scope.lineIds);
  const lineParam = `$${params.length}::text[]`;
  params.push(scope.releaseIds);
  const releaseParam = `$${params.length}::text[]`;
  const lines = `(
      SELECT unnest(${lineParam})
      UNION SELECT so.order_item_id FROM orders so
        WHERE so.marketplace = 'myntra'${seller('so')} AND so.order_id = ANY(${releaseParam})
      UNION SELECT si.order_line_id FROM mp_invoices si
        WHERE si.marketplace = 'myntra'${seller('si')} AND si.order_release_id = ANY(${releaseParam})
          AND si.order_line_id IS NOT NULL
    )`;
  return { seller, lines };
}

/**
 * Clear the payment-derived columns of Myntra orders that no longer have any
 * payment row, after payments were deleted or cleared. The backfill below only
 * updates orders that still have rows, so removed payments stayed on the orders
 * themselves. The Myntra orders upload never sets these columns, so NULL is
 * their state before any payment. `scope` limits the reset (see
 * normalizeMyntraScope); null means the whole account.
 */
export async function resetOrdersWithoutMyntraPayment(pool, sellerAccount = null, scope = null) {
  const normalized = normalizeMyntraScope(scope);
  if (normalized && !normalized.lineIds.length && !normalized.releaseIds.length) return { ordersReset: 0 };
  const params = [];
  const { seller, lines } = myntraScopeSql(params, sellerAccount, normalized);
  const result = await pool.query(`
    UPDATE orders o
    SET ${MYNTRA_PAYMENT_ORDER_COLUMNS.map(column => `${column} = NULL`).join(', ')}
    WHERE o.marketplace = 'myntra'${seller('o')}${lines ? ` AND o.order_item_id IN ${lines}` : ''}
      AND (${MYNTRA_PAYMENT_ORDER_COLUMNS.map(column => `o.${column} IS NOT NULL`).join(' OR ')})
      AND NOT EXISTS (
        SELECT 1 FROM mp_invoices i
        WHERE i.marketplace = 'myntra'
          AND i.seller_account = o.seller_account
          AND i.order_line_id = o.order_item_id
          AND COALESCE(i.order_type, '') <> 'nod'
      )
  `, params);
  return { ordersReset: result.rowCount || 0 };
}

/**
 * The backfill turns a Delivered/Shipped order into "Return Initiated" when it
 * sees a reverse payment. When that reverse payment is deleted and no actual
 * return record supports the status, put back the status the orders upload
 * derives from the stored order details (same rules as orderLifecycle in
 * routes/myntraUpload.js).
 */
export async function restoreMyntraStatusesWithoutReverse(pool, sellerAccount = null, scope = null) {
  const normalized = normalizeMyntraScope(scope);
  if (normalized && !normalized.lineIds.length && !normalized.releaseIds.length) return { ordersRestored: 0 };
  const params = [];
  const { seller, lines } = myntraScopeSql(params, sellerAccount, normalized);
  const result = await pool.query(`
    UPDATE orders o
    SET orders_status = lc.status
    FROM (
      SELECT d.seller_account, d.order_line_id,
        CASE
          WHEN NULLIF(BTRIM(d.tracking_number), '') IS NULL THEN 'Cancelled'
          WHEN d.cancelled_on IS NOT NULL THEN 'Cancelled'
          WHEN d.rto_creation_date IS NOT NULL THEN 'RTO'
          WHEN d.return_creation_date IS NOT NULL THEN 'Return Initiated'
          WHEN d.delivered_on IS NOT NULL THEN 'Delivered'
          ELSE d.order_status
        END AS status
      FROM myntra_order_details d
      WHERE d.marketplace = 'myntra'${seller('d')}${lines ? ` AND d.order_line_id IN ${lines}` : ''}
    ) lc
    WHERE o.marketplace = 'myntra'
      AND o.seller_account = lc.seller_account
      AND o.order_item_id = lc.order_line_id
      AND o.orders_status = 'Return Initiated'
      AND lc.status IS DISTINCT FROM 'Return Initiated'
      AND NOT EXISTS (
        SELECT 1 FROM mp_invoices i
        WHERE i.marketplace = 'myntra' AND i.seller_account = o.seller_account
          AND i.order_line_id = o.order_item_id AND COALESCE(i.order_type, '') = 'reverse'
      )
      AND NOT EXISTS (
        SELECT 1 FROM returns r
        WHERE r.marketplace = 'myntra' AND r.seller_account = o.seller_account AND r.order_item_id = o.order_item_id
      )
  `, params);
  return { ordersRestored: result.rowCount || 0 };
}

/**
 * Propagate Myntra settlement calculations back into the orders table.
 * Populates settlement_amount, commission, fixed_fee, shipping_fee, reverse_shipping,
 * tcs, tds, gst_on_mp, collection_fee, return_received_amount, and orders_status.
 * `scope` (see normalizeMyntraScope) limits it to the affected order lines;
 * every payment of an affected line is aggregated, not only the payments
 * matching the scope, so partial sums are never written. An empty scope is a
 * no-op; null means the whole account.
 */
export async function backfillOrdersFromMyntraPayment(pool, sellerAccount = null, scope = null) {
  const normalized = normalizeMyntraScope(scope);
  if (normalized && !normalized.lineIds.length && !normalized.releaseIds.length) return { ordersUpdated: 0 };

  const params = [];
  const { seller, lines } = myntraScopeSql(params, sellerAccount, normalized);
  let invoiceFilter = "WHERE i.marketplace = 'myntra' AND i.order_line_id IS NOT NULL AND COALESCE(i.order_type, '') <> 'nod'"
    + seller('i') + (lines ? ` AND i.order_line_id IN ${lines}` : '');
  let ordersFilter = "WHERE o.marketplace = 'myntra'" + seller('o') + (lines ? ` AND o.order_item_id IN ${lines}` : '');

  const query = `
    UPDATE orders o
    SET
      settlement_amount = s.settlement_amount,
      commission = s.commission,
      fixed_fee = s.fixed_fee,
      pick_pack_fee = s.pick_pack_fee,
      shipping_fee = s.shipping_fee,
      reverse_shipping = s.reverse_shipping,
      tcs = s.tcs,
      tds = s.tds,
      gst_on_mp = s.gst_on_mp,
      collection_fee = s.gateway_fee,
      return_received_amount = s.return_received_amount,
      orders_status = CASE 
        WHEN s.has_reverse AND (o.orders_status IS NULL OR o.orders_status IN ('Delivered', 'Shipped')) 
          THEN 'Return Initiated' 
        ELSE o.orders_status 
      END
    FROM (
      SELECT
        i.seller_account,
        i.order_line_id,
        ROUND(SUM(i.amount_received), 2) AS settlement_amount,
        ROUND(SUM(COALESCE(i.commission_amount, 0)), 2) AS commission,
        ROUND(SUM(CASE WHEN COALESCE(i.order_type, '') <> 'reverse' THEN COALESCE(i.fixed_fee_amount, 0) ELSE 0 END), 2) AS fixed_fee,
        ROUND(SUM(CASE WHEN COALESCE(i.order_type, '') <> 'reverse' THEN COALESCE(i.shipping_fee_amount, 0) ELSE 0 END), 2) AS shipping_fee,
        ROUND(SUM(CASE WHEN COALESCE(i.order_type, '') = 'reverse' THEN COALESCE(i.shipping_fee_amount, 0) ELSE 0 END), 2) AS reverse_shipping,
        ROUND(SUM(COALESCE(i.pick_pack_fee_amount, 0)), 2) AS pick_pack_fee,
        ROUND(SUM(COALESCE(i.gateway_fee_amount, 0)), 2) AS gateway_fee,
        ROUND(SUM(COALESCE(i.tcs_amount, 0)), 2) AS tcs,
        ROUND(SUM(COALESCE(i.tds_amount, 0)), 2) AS tds,
        ROUND(SUM(COALESCE(i.gst_on_mp_fees, 0)), 2) AS gst_on_mp,
        ROUND(ABS(SUM(CASE WHEN COALESCE(i.order_type, '') = 'reverse' THEN i.invoice_amount ELSE 0 END)), 2) AS return_received_amount,
        BOOL_OR(COALESCE(i.order_type, '') = 'reverse') AS has_reverse
      FROM mp_invoices i
      ${invoiceFilter}
      GROUP BY i.seller_account, i.order_line_id
    ) s
    ${ordersFilter}
      AND o.seller_account = s.seller_account
      AND o.order_item_id = s.order_line_id
  `;

  const result = await pool.query(query, params);
  return { ordersUpdated: result.rowCount || 0 };
}

