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

/**
 * Propagate Myntra settlement calculations back into the orders table.
 * Populates settlement_amount, commission, fixed_fee, shipping_fee, reverse_shipping,
 * tcs, tds, gst_on_mp, collection_fee, return_received_amount, and orders_status.
 */
export async function backfillOrdersFromMyntraPayment(pool, sellerAccount = null, affectedOrderIds = null) {
  const scopedOrderIds = Array.isArray(affectedOrderIds)
    ? [...new Set(affectedOrderIds.map(v => String(v || '').trim()).filter(Boolean))]
    : null;

  const params = [];
  let invoiceFilter = "WHERE i.marketplace = 'myntra' AND i.order_line_id IS NOT NULL AND COALESCE(i.order_type, '') <> 'nod'";
  let ordersFilter = "WHERE o.marketplace = 'myntra'";

  if (sellerAccount && sellerAccount !== 'all') {
    params.push(sellerAccount);
    invoiceFilter += ` AND i.seller_account = $${params.length}`;
    ordersFilter += ` AND o.seller_account = $${params.length}`;
  }

  if (scopedOrderIds && scopedOrderIds.length > 0) {
    params.push(scopedOrderIds);
    invoiceFilter += ` AND i.order_release_id = ANY($${params.length}::text[])`;
    ordersFilter += ` AND o.order_id = ANY($${params.length}::text[])`;
  }

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

