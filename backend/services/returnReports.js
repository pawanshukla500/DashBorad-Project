const TRACKER_FILTERS = Object.freeze({
  'not-received': 'AND rr.order_item_id IS NULL',
  bad: 'AND rr.is_bad_return = TRUE',
  'spf-pending': 'AND rr.is_bad_return = TRUE AND COALESCE(ost.spf_received, FALSE) = FALSE',
});

export async function getReturnsReceivedSummary(pool) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE rr.order_item_id IS NOT NULL) AS received,
      COUNT(*) FILTER (WHERE rr.is_bad_return = TRUE) AS bad,
      COUNT(*) FILTER (
        WHERE rr.is_bad_return = TRUE
          AND COALESCE(ost.spf_received, FALSE) = FALSE
      ) AS spf_pending
    FROM returns r
    LEFT JOIN returns_received rr ON rr.order_item_id = r.order_item_id
    LEFT JOIN order_spf_tracking ost ON ost.order_item_id = r.order_item_id
  `);

  const total = +(rows[0]?.total || 0);
  const received = +(rows[0]?.received || 0);
  const bad = +(rows[0]?.bad || 0);
  return {
    total,
    received,
    notReceived: total - received,
    good: received - bad,
    bad,
    spfPending: +(rows[0]?.spf_pending || 0),
  };
}

export async function getSpfSummary(pool) {
  const [deductedResult, receivedResult] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(DISTINCT order_item_id) AS cnt,
        SUM(ABS(COALESCE(protection_fund, 0))) AS total
      FROM fk_settlement_orders
      WHERE protection_fund IS NOT NULL AND protection_fund <> 0
    `),
    pool.query(`
      SELECT COUNT(*) AS cnt, SUM(COALESCE(spf_received_amount, 0)) AS total
      FROM order_spf_tracking
      WHERE spf_received = TRUE
    `),
  ]);

  const deducted = Math.abs(+(deductedResult.rows[0]?.total || 0));
  const received = +(receivedResult.rows[0]?.total || 0);
  return {
    ordersWithSpf: +(deductedResult.rows[0]?.cnt || 0),
    spfDeducted: deducted,
    ordersReceived: +(receivedResult.rows[0]?.cnt || 0),
    spfReceived: received,
    spfPending: +(deducted - received).toFixed(2),
  };
}

export async function getSpfTracking(pool, { page, pageSize, offset }) {
  const spfCte = `
    WITH spf AS (
      SELECT
        order_item_id,
        MIN(order_date) AS order_date,
        MAX(payment_date) AS payment_date,
        SUM(ABS(COALESCE(protection_fund, 0))) AS spf_deducted
      FROM fk_settlement_orders
      WHERE protection_fund IS NOT NULL AND protection_fund <> 0
      GROUP BY order_item_id
    )
  `;
  const [dataResult, countResult] = await Promise.all([
    pool.query(`${spfCte}
      SELECT
        spf.order_item_id,
        spf.order_date,
        spf.payment_date,
        spf.spf_deducted,
        COALESCE(ost.spf_received, FALSE) AS spf_received,
        ost.spf_received_date,
        ost.spf_received_amount,
        ost.status AS spf_status,
        (r.order_item_id IS NOT NULL) AS has_return,
        r.return_reason,
        r.final_condition,
        r.return_type
      FROM spf
      LEFT JOIN order_spf_tracking ost ON ost.order_item_id = spf.order_item_id
      LEFT JOIN order_returns r ON r.order_item_id = spf.order_item_id
      ORDER BY spf.payment_date DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [pageSize, offset]),
    pool.query(`${spfCte} SELECT COUNT(*) AS cnt FROM spf`),
  ]);

  return {
    data: dataResult.rows,
    total: +(countResult.rows[0]?.cnt || 0),
    page,
    pageSize,
  };
}

export async function markSpfReceived(pool, {
  orderItemIds,
  receivedDate = null,
  receivedAmount = 0,
  neftId = '',
  claimId = '',
}) {
  const ids = [...new Set(orderItemIds.map(id => String(id).trim()).filter(Boolean))];
  if (!ids.length) return 0;

  const result = await pool.query(`
    WITH requested AS (
      SELECT DISTINCT UNNEST($1::text[]) AS order_item_id
    ),
    spf AS (
      SELECT fko.order_item_id, SUM(COALESCE(fko.protection_fund, 0)) AS spf_deducted
      FROM fk_settlement_orders fko
      JOIN requested r ON r.order_item_id = fko.order_item_id
      GROUP BY fko.order_item_id
    )
    INSERT INTO order_spf_tracking
      (order_item_id, spf_deducted, spf_received, spf_received_date,
       spf_received_amount, neft_id, spf_claim_id, status)
    SELECT order_item_id, spf_deducted, TRUE, $2::date, $3, $4, $5, 'received'
    FROM spf
    ON CONFLICT (order_item_id) DO UPDATE SET
      spf_deducted = EXCLUDED.spf_deducted,
      spf_received = TRUE,
      spf_received_date = EXCLUDED.spf_received_date,
      spf_received_amount = EXCLUDED.spf_received_amount,
      neft_id = EXCLUDED.neft_id,
      spf_claim_id = EXCLUDED.spf_claim_id,
      status = 'received',
      updated_at = NOW()
    RETURNING order_item_id
  `, [ids, receivedDate, receivedAmount, neftId, claimId]);

  return result.rowCount;
}

export async function getReturnsTracker(pool, {
  filter = 'all',
  marketplace = null,
  page,
  pageSize,
  offset,
}) {
  const values = [];
  const mpRaw = marketplace ? String(marketplace).trim() : null;
  const mpKey = mpRaw ? mpRaw.toLowerCase() : null;
  let marketplaceWhere = '';
  if (mpKey === 'myntra_vb') {
    marketplaceWhere = "AND r.marketplace = 'myntra' AND COALESCE(r.seller_account, 'myntra_vb') = 'myntra_vb'";
  } else if (mpKey === 'myntra_ej') {
    marketplaceWhere = "AND r.marketplace = 'myntra' AND r.seller_account = 'myntra_ej'";
  } else if (mpKey === 'myntra') {
    marketplaceWhere = "AND r.marketplace = 'myntra'";
  } else if (mpRaw) {
    marketplaceWhere = `AND r.marketplace = $${values.push(mpRaw)}`;
  }
  const filterWhere = TRACKER_FILTERS[filter] || '';

  // First reduce to the requested page of returns. Amazon return rows use an
  // LPN/RMA key, so resolving their related sales item before pagination makes
  // the tracker scan every order for every return.
  const dataQuery = `
    WITH return_page AS (
      SELECT
        r.*,
        rr.order_item_id AS received_return_item_id,
        rr.is_bad_return,
        rr.received_date,
        rr.notes,
        ost.spf_received,
        ost.spf_received_date,
        ost.spf_received_amount
      FROM returns r
      LEFT JOIN returns_received rr ON rr.order_item_id = r.order_item_id
      LEFT JOIN order_spf_tracking ost ON ost.order_item_id = r.order_item_id
      WHERE r.order_item_id IS NOT NULL ${marketplaceWhere} ${filterWhere}
      ORDER BY r.return_requested_date DESC NULLS LAST
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    ),
    spf_agg AS (
      SELECT fko.order_item_id, SUM(ABS(COALESCE(fko.protection_fund, 0))) AS spf_total
      FROM fk_settlement_orders fko
      JOIN return_page r ON r.order_item_id = fko.order_item_id
      WHERE fko.protection_fund IS NOT NULL AND fko.protection_fund <> 0
      GROUP BY fko.order_item_id
    ),
    sett_agg AS (
      SELECT fko.order_item_id, SUM(fko.bank_settlement) AS net_bank
      FROM fk_settlement_orders fko
      JOIN return_page r ON r.order_item_id = fko.order_item_id
      GROUP BY fko.order_item_id
    )
    SELECT
      r.order_item_id,
      COALESCE(o_exact.order_id, o_amazon.order_id, r.order_id) AS order_id,
      COALESCE(o_exact.fsn, o_amazon.fsn, r.fsn, r.asin) AS fsn,
      COALESCE(o_exact.sku, o_amazon.sku, r.sku) AS sku,
      COALESCE(o_exact.category, o_amazon.category) AS category,
      CASE
        WHEN COALESCE(o_exact.marketplace, o_amazon.marketplace, r.marketplace) = 'myntra'
          THEN COALESCE(r.seller_account, o_exact.seller_account, 'myntra_vb')
        ELSE COALESCE(o_exact.marketplace, o_amazon.marketplace, r.marketplace)
      END AS marketplace,
      r.return_type,
      r.return_reason,
      r.return_status,
      r.final_condition AS system_condition,
      TO_CHAR(r.return_requested_date, 'YYYY-MM-DD') AS return_date,
      TO_CHAR(COALESCE(o_exact.order_date, o_amazon.order_date), 'YYYY-MM-DD') AS order_date,
      COALESCE(r.quantity, 1) AS quantity,
      COALESCE(o_exact.final_invoice_amount, o_amazon.final_invoice_amount, 0) AS invoice_amount,
      (r.received_return_item_id IS NOT NULL) AS is_received,
      r.is_bad_return,
      TO_CHAR(r.received_date, 'YYYY-MM-DD') AS received_date,
      r.notes,
      COALESCE(spf.spf_total, 0) AS spf_deducted,
      COALESCE(r.spf_received, FALSE) AS spf_received,
      TO_CHAR(r.spf_received_date, 'YYYY-MM-DD') AS spf_received_date,
      COALESCE(r.spf_received_amount, 0) AS spf_received_amount,
      COALESCE(sa.net_bank, 0) AS net_bank
    FROM return_page r
    -- Amazon FBA/Flex reports have an LPN/RMA return key, not the sales-item key.
    -- Use two indexed joins so exact item keys take precedence and Amazon
    -- rows can fall back to their verified order-id + seller-SKU pair.
    LEFT JOIN orders o_exact ON o_exact.order_item_id = r.order_item_id
    LEFT JOIN orders o_amazon ON o_amazon.marketplace = 'amazon'
      AND o_amazon.order_id = r.order_id
      AND o_amazon.sku = r.sku
      AND o_exact.order_item_id IS NULL
    LEFT JOIN spf_agg spf ON spf.order_item_id = r.order_item_id
    LEFT JOIN sett_agg sa ON sa.order_item_id = r.order_item_id
    ORDER BY r.return_requested_date DESC NULLS LAST
  `;

  const countQuery = `SELECT COUNT(*) AS cnt
    FROM returns r
    LEFT JOIN returns_received rr ON rr.order_item_id = r.order_item_id
    LEFT JOIN order_spf_tracking ost ON ost.order_item_id = r.order_item_id
    WHERE r.order_item_id IS NOT NULL ${marketplaceWhere} ${filterWhere}
  `;

  const dataValues = [...values, pageSize, offset];
  const [dataResult, countResult] = await Promise.all([
    pool.query(dataQuery, dataValues),
    pool.query(countQuery, values),
  ]);

  return {
    data: dataResult.rows,
    total: +(countResult.rows[0]?.cnt || 0),
    page,
    pageSize,
  };
}
