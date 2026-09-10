// Meesho settlement rows live in `meesho_settlement_items`.
// This module provides the Meesho branch of `unified_settlements` aligning with
// Flipkart, Amazon, and Myntra branches across all 68 canonical columns.

export function meeshoSettlementUnifiedSelect() {
  return `
SELECT
    COALESCE(m.settlement_id, '') AS neft_id,
    NULL AS neft_type,
    m.payment_date,
    COALESCE(m.bank_settlement, 0) AS bank_settlement,
    0::numeric AS input_gst_tcs,
    0::numeric AS income_tax_credits,
    COALESCE(MAX(o.order_id), m.order_item_id) AS order_id,
    m.order_item_id,
    COALESCE(m.sale_amount, 0) AS sale_amount,
    0::numeric AS total_offer_amount,
    0::numeric AS my_share,
    0::numeric AS customer_addons,
    0::numeric AS marketplace_fee,
    0::numeric AS taxes,
    0::numeric AS offer_adjustments,
    0::numeric AS protection_fund,
    CASE
      WHEN m.transaction_type ILIKE '%return%' OR m.bank_settlement < 0 THEN -ABS(COALESCE(m.sale_amount, 0))
      ELSE 0::numeric
    END AS refund,
    NULL AS tier,
    0::numeric AS commission_rate,
    ABS(COALESCE(m.commission_fee, 0)) AS commission,
    ABS(COALESCE(m.fixed_fee, 0)) AS fixed_fee,
    0::numeric AS collection_fee,
    0::numeric AS pick_pack_fee,
    ABS(COALESCE(m.shipping_fee, 0)) AS shipping_fee,
    ABS(COALESCE(m.reverse_shipping, 0)) AS reverse_shipping,
    0::numeric AS no_cost_emi_fee,
    NULL::numeric AS installation_fee,
    NULL::numeric AS tech_visit_fee,
    NULL::numeric AS uninstallation_fee,
    0::numeric AS customer_addon_recovery,
    0::numeric AS franchise_fee,
    0::numeric AS shopsy_marketing_fee,
    0::numeric AS cancellation_fee,
    ABS(COALESCE(m.tcs, 0)) AS tcs,
    ABS(COALESCE(m.tds, 0)) AS tds,
    0::numeric AS gst_on_mp_fees,
    COALESCE(m.other_fee, 0) AS mp_other_fee,
    NULL AS offer_amount_discount_mp,
    0::numeric AS item_gst_rate,
    NULL::numeric AS discount_mp_fees,
    0::numeric AS gst_on_discount,
    NULL::numeric AS total_discount_mp_fee,
    NULL AS offer_adjustment_detail,
    NULL::numeric AS dead_weight,
    NULL AS dimensions,
    NULL::numeric AS volumetric_weight,
    NULL AS chargeable_weight_source,
    NULL AS chargeable_weight_type,
    NULL AS chargeable_weight_slab,
    NULL AS shipping_zone,
    MAX(o.order_date) AS order_date,
    NULL::date AS dispatch_date,
    MAX(o.fulfilment_type) AS fulfilment_type,
    COALESCE(MAX(m.sku), MAX(o.sku)) AS seller_sku,
    COALESCE(MAX(o.qty), 1)::bigint AS quantity,
    MAX(o.category) AS product_sub_category,
    NULL AS additional_info,
    CASE
      WHEN m.transaction_type ILIKE '%rto%' THEN 'RTO'
      WHEN m.transaction_type ILIKE '%return%' THEN 'Customer Return'
      ELSE NULL
    END AS return_type,
    NULL AS shopsy_order,
    MAX(m.transaction_type) AS item_return_status,
    NULL AS invoice_id,
    NULL::date AS invoice_date,
    'meesho'::text AS marketplace,
    MAX(m.uploaded_at) AS uploaded_at,
    BOOL_OR(COALESCE(m.claims, 0) > 0) AS spf_received,
    MAX(CASE WHEN COALESCE(m.claims, 0) > 0 THEN m.payment_date ELSE NULL END) AS spf_received_date,
    COALESCE(SUM(m.claims), 0) AS spf_received_amount,
    MAX(CASE WHEN COALESCE(m.claims, 0) > 0 THEN m.settlement_id ELSE NULL END) AS spf_received_neft_id
FROM meesho_settlement_items m
LEFT JOIN orders o
  ON o.marketplace = 'meesho'
 AND o.order_item_id = m.order_item_id
WHERE m.order_item_id IS NOT NULL
GROUP BY
    m.settlement_id,
    m.payment_date,
    m.order_item_id,
    m.bank_settlement,
    m.sale_amount,
    m.transaction_type,
    m.commission_fee,
    m.fixed_fee,
    m.shipping_fee,
    m.reverse_shipping,
    m.tcs,
    m.tds,
    m.other_fee
`;
}
