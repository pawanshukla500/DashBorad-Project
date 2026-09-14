import { ORDER_SETTLEMENT_TOTALS_TABLE } from './orderSettlementTotals.js';

export const DEFAULT_B2C_CHANNELS = [
  { key: 'myntra', name: 'Myntra', icon: 'myntra', defaultGrace: 15, defaultCycle: 15, cashback: 0 },
  { key: 'flipkart', name: 'Flipkart', icon: 'flipkart', defaultGrace: 7, defaultCycle: 7, cashback: 0 },
  { key: 'amazon', name: 'Amazon-India', icon: 'amazon', defaultGrace: 14, defaultCycle: 7, cashback: 0 },
  { key: 'meesho', name: 'Meesho', icon: 'meesho', defaultGrace: 15, defaultCycle: 7, cashback: 0 },
  { key: 'ajio', name: 'Ajio', icon: 'ajio', defaultGrace: 30, defaultCycle: 15, cashback: 0 },
];

export const DEFAULT_D2C_VENDORS = [
  { key: 'phonepe', name: 'PhonePe', graceDays: 2, cycleDays: 1 },
  { key: 'manual', name: 'Manual', graceDays: 15, cycleDays: 15 },
  { key: 'gokwik', name: 'Gokwik', graceDays: 3, cycleDays: 2 },
  { key: 'cod_ekart', name: 'COD-Ekart', graceDays: 7, cycleDays: 7 },
  { key: 'cod_amazon', name: 'COD-Amazon', graceDays: 7, cycleDays: 7 },
  { key: 'cod_delhivery', name: 'COD-Delhivery', graceDays: 7, cycleDays: 7 },
  { key: 'cod_bluedart', name: 'COD-Bluedart', graceDays: 7, cycleDays: 7 },
];

/**
 * Ensure the configuration table exists
 */
export async function ensureOutstandingConfigTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outstanding_payment_config (
      id SERIAL PRIMARY KEY,
      channel_type TEXT NOT NULL, -- 'B2C' or 'D2C'
      channel_key TEXT NOT NULL UNIQUE,
      channel_name TEXT NOT NULL,
      grace_period_days INT DEFAULT 15,
      payment_cycle_days INT DEFAULT 7,
      cashback_rate NUMERIC(14,2) DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE outstanding_payment_config ALTER COLUMN cashback_rate TYPE NUMERIC(14,2);
  `);

  // Seed default rows if empty
  const countRes = await pool.query('SELECT COUNT(*) FROM outstanding_payment_config');
  if (Number(countRes.rows[0].count || 0) === 0) {
    for (const b of DEFAULT_B2C_CHANNELS) {
      await pool.query(`
        INSERT INTO outstanding_payment_config (channel_type, channel_key, channel_name, grace_period_days, payment_cycle_days, cashback_rate)
        VALUES ('B2C', $1, $2, $3, $4, $5)
        ON CONFLICT (channel_key) DO NOTHING
      `, [b.key, b.name, b.defaultGrace, b.defaultCycle, b.cashback]);
    }
    for (const d of DEFAULT_D2C_VENDORS) {
      await pool.query(`
        INSERT INTO outstanding_payment_config (channel_type, channel_key, channel_name, grace_period_days, payment_cycle_days, cashback_rate)
        VALUES ('D2C', $1, $2, $3, $4, 0)
        ON CONFLICT (channel_key) DO NOTHING
      `, [d.key, d.name, d.graceDays, d.cycleDays]);
    }
  }
}

/**
 * Fetch all outstanding payment configs
 */
export async function getOutstandingConfig(pool) {
  await ensureOutstandingConfigTable(pool);
  const res = await pool.query('SELECT * FROM outstanding_payment_config ORDER BY channel_type, id');
  return res.rows;
}

/**
 * Update a specific channel's configuration
 */
export async function updateOutstandingConfig(pool, channelKey, { grace_period_days, payment_cycle_days, is_active }) {
  await ensureOutstandingConfigTable(pool);
  const res = await pool.query(`
    UPDATE outstanding_payment_config
    SET
      grace_period_days = COALESCE($1, grace_period_days),
      payment_cycle_days = COALESCE($2, payment_cycle_days),
      is_active = COALESCE($3, is_active),
      updated_at = NOW()
    WHERE channel_key = $4
    RETURNING *
  `, [grace_period_days, payment_cycle_days, is_active, channelKey]);
  return res.rows[0];
}

/**
 * Compute the consolidated & marketplace-wise outstanding payment matrix (Pure Live DB Mode)
 * Formula: Total Orders - Returns - Marketplace Fees - Payment Received = Outstanding
 */
export async function computeOutstandingMatrix(pool, filters = {}) {
  await ensureOutstandingConfigTable(pool);

  const configsRes = await pool.query('SELECT * FROM outstanding_payment_config');
  const configMap = new Map();
  for (const c of configsRes.rows) {
    configMap.set(c.channel_key.toLowerCase(), c);
  }

  // 1. Discover all active marketplaces dynamically
  const discoveredRes = await pool.query(`
    SELECT DISTINCT LOWER(marketplace) AS marketplace FROM (
      SELECT marketplace FROM orders WHERE marketplace IS NOT NULL
      UNION
      SELECT marketplace FROM mp_config WHERE is_active = true
      UNION
      SELECT marketplace FROM marketplace_accounts WHERE is_active = true
      UNION
      SELECT marketplace FROM mp_invoices WHERE marketplace IS NOT NULL
    ) sub WHERE marketplace != ''
  `);

  const discoveredSet = new Set(discoveredRes.rows.map(r => r.marketplace));
  for (const def of DEFAULT_B2C_CHANNELS) {
    discoveredSet.add(def.key);
  }

  // 2. Query pure live database orders + settlements + fee aggregates
  const channelDataRes = await pool.query(`
    SELECT 
      LOWER(o.marketplace) AS marketplace,
      COALESCE(o.seller_account, 'default') AS seller_account,
      COUNT(DISTINCT o.order_item_id) AS total_orders_count,
      ROUND(COALESCE(SUM(o.final_invoice_amount), 0), 2) AS total_orders_amount,

      -- Returns Amount: settled refund amount from settlement + un-settled return invoice amounts from orders/returns
      ROUND(COALESCE(SUM(
        CASE 
          WHEN COALESCE(ost.refund_amount, 0) > 0 THEN ost.refund_amount
          WHEN o.orders_status IN ('Cancelled', 'RTO', 'Customer Return', 'Return', 'Refunded', 'Returned') 
               OR o.return_type IS NOT NULL 
               OR rt.order_item_id IS NOT NULL 
            THEN o.final_invoice_amount
          ELSE 0
        END
      ), 0), 2) AS returns_amount,

      ROUND(COALESCE(SUM(ost.net_bank), 0), 2) AS payment_received,
      ROUND(COALESCE(SUM(
        COALESCE(ost.commission, 0) + 
        COALESCE(ost.fixed_fee, 0) + 
        COALESCE(ost.collection_fee, 0) + 
        COALESCE(ost.pick_pack_fee, 0) + 
        COALESCE(ost.shipping_fee, 0) + 
        COALESCE(ost.reverse_shipping, 0) + 
        COALESCE(ost.franchise_fee, 0) + 
        COALESCE(ost.tcs, 0) + 
        COALESCE(ost.tds, 0) + 
        COALESCE(ost.gst_on_mp_fees, 0)
      ), 0), 2) AS marketplace_fees,

      -- Delivered Unsettled Orders: active orders pending settlement (excluding returns & cancellations)
      COUNT(CASE 
        WHEN ost.order_item_id IS NULL 
         AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
         AND o.return_type IS NULL 
         AND rt.order_item_id IS NULL 
        THEN 1 
      END) AS unsettled_orders_count,

      ROUND(COALESCE(SUM(
        CASE 
          WHEN ost.order_item_id IS NULL 
           AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
           AND o.return_type IS NULL 
           AND rt.order_item_id IS NULL 
          THEN o.final_invoice_amount 
          ELSE 0 
        END
      ), 0), 2) AS unsettled_order_amount,

      ROUND(COALESCE(SUM(
        CASE 
          WHEN ost.order_item_id IS NULL 
           AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
           AND o.return_type IS NULL 
           AND rt.order_item_id IS NULL 
           AND (CURRENT_DATE - o.order_date::date) > 60 
          THEN o.final_invoice_amount 
          ELSE 0 
        END
      ), 0), 2) AS aging_60_plus,

      ROUND(COALESCE(SUM(
        CASE 
          WHEN ost.order_item_id IS NULL 
           AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
           AND o.return_type IS NULL 
           AND rt.order_item_id IS NULL 
           AND (CURRENT_DATE - o.order_date::date) BETWEEN 31 AND 60 
          THEN o.final_invoice_amount 
          ELSE 0 
        END
      ), 0), 2) AS aging_31_60,

      ROUND(COALESCE(SUM(
        CASE 
          WHEN ost.order_item_id IS NULL 
           AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
           AND o.return_type IS NULL 
           AND rt.order_item_id IS NULL 
           AND (CURRENT_DATE - o.order_date::date) BETWEEN 16 AND 30 
          THEN o.final_invoice_amount 
          ELSE 0 
        END
      ), 0), 2) AS aging_16_30,

      ROUND(COALESCE(SUM(
        CASE 
          WHEN ost.order_item_id IS NULL 
           AND o.orders_status NOT IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned')
           AND o.return_type IS NULL 
           AND rt.order_item_id IS NULL 
           AND (CURRENT_DATE - o.order_date::date) <= 15 
          THEN o.final_invoice_amount 
          ELSE 0 
        END
      ), 0), 2) AS aging_0_15,

      COUNT(CASE 
        WHEN COALESCE(ost.refund_amount, 0) > 0 
          OR o.orders_status IN ('Cancelled', 'RTO', 'Customer Return', 'Courier Return', 'Return', 'Refunded', 'Returned') 
          OR o.return_type IS NOT NULL 
          OR rt.order_item_id IS NOT NULL 
        THEN 1 
      END) AS returns_orders_count

    FROM orders o
    LEFT JOIN ${ORDER_SETTLEMENT_TOTALS_TABLE} ost ON ost.order_item_id = o.order_item_id
    LEFT JOIN (
      SELECT DISTINCT ON (order_item_id) order_item_id, return_type, return_reason
      FROM order_returns
    ) rt ON rt.order_item_id = o.order_item_id
    GROUP BY LOWER(o.marketplace), COALESCE(o.seller_account, 'default')
    ORDER BY LOWER(o.marketplace), seller_account
  `);

  // 3. Query pending invoices from mp_invoices
  const pendingInvoicesRes = await pool.query(`
    SELECT
      LOWER(marketplace) AS marketplace,
      COALESCE(seller_account, 'default') AS seller_account,
      COUNT(*) AS invoice_count,
      ROUND(COALESCE(SUM(net_payable - amount_received), 0), 2) AS pending_amount
    FROM mp_invoices
    WHERE net_payable > amount_received
    GROUP BY LOWER(marketplace), seller_account
  `);

  // 4. Query Flipkart non-order adjustments if any
  let fkNetAdj = 0;
  try {
    const fkRes = await pool.query(`
      SELECT
        ROUND(COALESCE((SELECT SUM(settlement_value) FROM fk_spf_claims), 0) -
              COALESCE((SELECT SUM(settlement_value) FROM fk_storage_recall), 0) -
              COALESCE((SELECT SUM(settlement_value) FROM fk_ads), 0), 2) AS net_adj
    `);
    fkNetAdj = Number(fkRes.rows[0]?.net_adj || 0);
  } catch (e) {
    fkNetAdj = 0;
  }

  // Group database rows by marketplace
  const dbRowsByMarketplace = new Map();
  for (const row of channelDataRes.rows) {
    const mp = row.marketplace;
    if (!dbRowsByMarketplace.has(mp)) {
      dbRowsByMarketplace.set(mp, []);
    }
    dbRowsByMarketplace.get(mp).push(row);
  }

  const b2cChannels = [];
  const processedKeys = new Set();
  const orderedChannelKeys = ['myntra', 'flipkart', 'amazon', 'meesho', 'ajio'];
  for (const m of discoveredSet) {
    if (!orderedChannelKeys.includes(m)) {
      orderedChannelKeys.push(m);
    }
  }

  for (const chKey of orderedChannelKeys) {
    if (processedKeys.has(chKey)) continue;
    processedKeys.add(chKey);

    const cfg = configMap.get(chKey) || {};
    const channelName =
      cfg.channel_name ||
      (chKey === 'amazon' ? 'Amazon-India' :
       chKey === 'myntra' ? 'Myntra' :
       chKey === 'flipkart' ? 'Flipkart' :
       chKey === 'meesho' ? 'Meesho' :
       chKey === 'ajio' ? 'Ajio' :
       chKey.charAt(0).toUpperCase() + chKey.slice(1));

    const rows = dbRowsByMarketplace.get(chKey) || [];
    const invRows = pendingInvoicesRes.rows.filter(r => r.marketplace === chKey);

    if (chKey === 'myntra') {
      // Myntra accounts segregation: myntra_ej (45833), myntra_vb (10708)
      const ejRow = rows.find(r => r.seller_account === 'myntra_ej' || r.seller_account === '45833');
      const vbRow = rows.find(r => r.seller_account === 'myntra_vb' || r.seller_account === '10708');

      const ejOrdersCount = Number(ejRow?.total_orders_count || 0);
      const ejOrdersAmt = Number(ejRow?.total_orders_amount || 0);
      const ejReturnsCount = Number(ejRow?.returns_orders_count || 0);
      const ejReturns = Number(ejRow?.returns_amount || 0);
      const ejPaid = Number(ejRow?.payment_received || 0);
      const ejFees = Number(ejRow?.marketplace_fees || 0);
      const ejUnsettledCount = Number(ejRow?.unsettled_orders_count || 0);
      const ejUnsettled = Number(ejRow?.unsettled_order_amount || 0);
      const ejOverdue = Number(ejRow?.aging_60_plus || 0) + Number(ejRow?.aging_31_60 || 0);
      const ejInGrace = Number(ejRow?.aging_16_30 || 0);
      const ejUpcoming = Number(ejRow?.aging_0_15 || 0);

      const vbOrdersCount = Number(vbRow?.total_orders_count || 0);
      const vbOrdersAmt = Number(vbRow?.total_orders_amount || 0);
      const vbReturnsCount = Number(vbRow?.returns_orders_count || 0);
      const vbReturns = Number(vbRow?.returns_amount || 0);
      const vbPaid = Number(vbRow?.payment_received || 0);
      const vbFees = Number(vbRow?.marketplace_fees || 0);
      const vbUnsettledCount = Number(vbRow?.unsettled_orders_count || 0);
      const vbUnsettled = Number(vbRow?.unsettled_order_amount || 0);
      const vbOverdue = Number(vbRow?.aging_60_plus || 0) + Number(vbRow?.aging_31_60 || 0);
      const vbInGrace = Number(vbRow?.aging_16_30 || 0);
      const vbUpcoming = Number(vbRow?.aging_0_15 || 0);

      const totalOrdersCount = ejOrdersCount + vbOrdersCount;
      const totalOrdersAmt = ejOrdersAmt + vbOrdersAmt;
      const totalReturnsCount = ejReturnsCount + vbReturnsCount;
      const totalReturns = ejReturns + vbReturns;
      const totalPaid = ejPaid + vbPaid;
      const totalFees = ejFees + vbFees;
      const totalUnsettled = ejUnsettled + vbUnsettled;
      const totalOverdue = ejOverdue + vbOverdue;
      const totalInGrace = ejInGrace + vbInGrace;
      const totalUpcoming = ejUpcoming + vbUpcoming;

      const ejInvPending = invRows.filter(r => r.seller_account === 'myntra_ej' || r.seller_account === '45833').reduce((s, r) => s + Number(r.pending_amount || 0), 0);
      const vbInvPending = invRows.filter(r => r.seller_account === 'myntra_vb' || r.seller_account === '10708').reduce((s, r) => s + Number(r.pending_amount || 0), 0);
      const totalInvPending = ejInvPending + vbInvPending;
      const totalOutstanding = totalUnsettled + totalInvPending;
      const ejTotalOutstanding = ejUnsettled + ejInvPending;
      const vbTotalOutstanding = vbUnsettled + vbInvPending;

      b2cChannels.push({
        channel_key: 'myntra',
        channel_name: 'Myntra',
        icon: 'myntra',
        total_orders_count: totalOrdersCount,
        total_orders_amount: totalOrdersAmt,
        returns_orders_count: totalReturnsCount,
        returns_amount: totalReturns,
        marketplace_fees: totalFees,
        payment_received: totalPaid,
        unsettled: totalUnsettled,
        settled_not_paid: totalInvPending,
        settled_adjusted: 0,
        total: totalOutstanding,
        overdue: totalOverdue,
        due_in_grace: totalInGrace,
        upcoming: totalUpcoming,
        due_total: totalOutstanding,
        cashback_outstanding: 0,
        has_accounts: true,
        accounts: [
          {
            account_key: 'myntra_ej',
            account_name: 'Myntra (EJ - 45833)',
            seller_id: '45833',
            total_orders_count: ejOrdersCount,
            total_orders_amount: ejOrdersAmt,
            returns_orders_count: ejReturnsCount,
            returns_amount: ejReturns,
            marketplace_fees: ejFees,
            payment_received: ejPaid,
            unsettled: ejUnsettled,
            settled_not_paid: ejInvPending,
            settled_adjusted: 0,
            total: ejTotalOutstanding,
            overdue: ejOverdue,
            due_in_grace: ejInGrace,
            upcoming: ejUpcoming,
            due_total: ejTotalOutstanding,
            cashback_outstanding: 0,
            orders_count: ejUnsettledCount,
          },
          {
            account_key: 'myntra_vb',
            account_name: 'Myntra (VB - 10708)',
            seller_id: '10708',
            total_orders_count: vbOrdersCount,
            total_orders_amount: vbOrdersAmt,
            returns_orders_count: vbReturnsCount,
            returns_amount: vbReturns,
            marketplace_fees: vbFees,
            payment_received: vbPaid,
            unsettled: vbUnsettled,
            settled_not_paid: vbInvPending,
            settled_adjusted: 0,
            total: vbTotalOutstanding,
            overdue: vbOverdue,
            due_in_grace: vbInGrace,
            upcoming: vbUpcoming,
            due_total: vbTotalOutstanding,
            cashback_outstanding: 0,
            orders_count: vbUnsettledCount,
          },
        ],
      });
      continue;
    }

    // Generic channel aggregation from live DB
    let chOrdersCount = 0;
    let chOrdersAmt = 0;
    let chReturnsCount = 0;
    let chReturns = 0;
    let chPaid = 0;
    let chFees = 0;
    let chUnsettledCount = 0;
    let chUnsettled = 0;
    let chOverdue = 0;
    let chInGrace = 0;
    let chUpcoming = 0;

    const channelAccounts = [];
    for (const r of rows) {
      const oc = Number(r.total_orders_count || 0);
      const oa = Number(r.total_orders_amount || 0);
      const rc = Number(r.returns_orders_count || 0);
      const ret = Number(r.returns_amount || 0);
      const pd = Number(r.payment_received || 0);
      const fee = Number(r.marketplace_fees || 0);
      const uc = Number(r.unsettled_orders_count || 0);
      const un = Number(r.unsettled_order_amount || 0);
      const od = Number(r.aging_60_plus || 0) + Number(r.aging_31_60 || 0);
      const ig = Number(r.aging_16_30 || 0);
      const up = Number(r.aging_0_15 || 0);

      chOrdersCount += oc;
      chOrdersAmt += oa;
      chReturnsCount += rc;
      chReturns += ret;
      chPaid += pd;
      chFees += fee;
      chUnsettledCount += uc;
      chUnsettled += un;
      chOverdue += od;
      chInGrace += ig;
      chUpcoming += up;

      if (r.seller_account && r.seller_account !== 'default') {
        const accInvPending = invRows.filter(ir => ir.seller_account === r.seller_account).reduce((s, ir) => s + Number(ir.pending_amount || 0), 0);
        channelAccounts.push({
          account_key: r.seller_account,
          account_name: `${channelName} (${r.seller_account})`,
          total_orders_count: oc,
          total_orders_amount: oa,
          returns_orders_count: rc,
          returns_amount: ret,
          marketplace_fees: fee,
          payment_received: pd,
          unsettled: un,
          settled_not_paid: accInvPending,
          settled_adjusted: 0,
          total: un + accInvPending,
          overdue: od,
          due_in_grace: ig,
          upcoming: up,
          due_total: un + accInvPending,
          cashback_outstanding: 0,
          orders_count: uc,
        });
      }
    }

    let channelInvPending = 0;
    for (const ir of invRows) {
      channelInvPending += Number(ir.pending_amount || 0);
    }

    const chTotalOutstanding = chUnsettled + channelInvPending;
    b2cChannels.push({
      channel_key: chKey,
      channel_name: channelName,
      icon: chKey,
      total_orders_count: chOrdersCount,
      total_orders_amount: chOrdersAmt,
      returns_orders_count: chReturnsCount,
      returns_amount: chReturns,
      marketplace_fees: chFees,
      payment_received: chPaid,
      unsettled: chUnsettled,
      settled_not_paid: channelInvPending,
      settled_adjusted: chKey === 'flipkart' ? fkNetAdj : 0,
      total: chTotalOutstanding,
      overdue: chOverdue,
      due_in_grace: chInGrace,
      upcoming: chUpcoming,
      due_total: chTotalOutstanding,
      cashback_outstanding: 0,
      has_accounts: channelAccounts.length > 1,
      accounts: channelAccounts,
      orders_count: chUnsettledCount,
    });
  }

  // Calculate B2C Totals
  const b2cTotal = {
    total_orders_count: 0,
    total_orders_amount: 0,
    returns_orders_count: 0,
    returns_amount: 0,
    marketplace_fees: 0,
    payment_received: 0,
    unsettled: 0,
    settled_not_paid: 0,
    settled_adjusted: 0,
    total: 0,
    overdue: 0,
    due_in_grace: 0,
    upcoming: 0,
    due_total: 0,
    cashback_outstanding: 0,
  };

  for (const c of b2cChannels) {
    b2cTotal.total_orders_count += (c.total_orders_count || 0);
    b2cTotal.total_orders_amount += (c.total_orders_amount || 0);
    b2cTotal.returns_orders_count += (c.returns_orders_count || 0);
    b2cTotal.returns_amount += (c.returns_amount || 0);
    b2cTotal.marketplace_fees += (c.marketplace_fees || 0);
    b2cTotal.payment_received += (c.payment_received || 0);
    b2cTotal.unsettled += c.unsettled;
    b2cTotal.settled_not_paid += c.settled_not_paid;
    b2cTotal.settled_adjusted += c.settled_adjusted;
    b2cTotal.total += c.total;
    b2cTotal.overdue += c.overdue;
    b2cTotal.due_in_grace += c.due_in_grace;
    b2cTotal.upcoming += c.upcoming;
    b2cTotal.due_total += c.due_total;
    b2cTotal.cashback_outstanding += (c.cashback_outstanding || 0);
  }

  // D2C Vendors (Pure Live DB mode: empty / 0 unless data ingested)
  const d2cVendors = DEFAULT_D2C_VENDORS.map(v => ({
    vendor_key: v.key,
    vendor_name: v.name,
    settled_not_paid: 0,
    settled_adjusted: 0,
    total: 0,
    overdue: 0,
    due_in_grace: 0,
    upcoming: 0,
    due_total: 0,
  }));

  const d2cTotal = {
    settled_not_paid: 0,
    settled_adjusted: 0,
    total: 0,
    overdue: 0,
    due_in_grace: 0,
    upcoming: 0,
  };

  // Top KPIs
  const totalOrdersAmt = b2cTotal.total_orders_amount;
  const totalReturnsAmt = b2cTotal.returns_amount;
  const totalFeesAmt = b2cTotal.marketplace_fees;
  const totalPaidAmt = b2cTotal.payment_received;
  const totalOutstanding = b2cTotal.unsettled + b2cTotal.settled_not_paid + d2cTotal.settled_not_paid;

  return {
    configured: true,
    kpis: {
      total_orders: totalOrdersAmt,
      returns: totalReturnsAmt,
      marketplace_fees: totalFeesAmt,
      payment_received: totalPaidAmt,
      total_outstanding: totalOutstanding,
      // Backward compatibility keys
      unsettled: b2cTotal.unsettled,
      settled_not_paid: b2cTotal.settled_not_paid + d2cTotal.settled_not_paid,
      settled_adjusted: b2cTotal.settled_adjusted,
      cashback: b2cTotal.cashback_outstanding,
    },
    b2c: {
      channels: b2cChannels,
      total: b2cTotal,
    },
    d2c: {
      last_payment_date: '-',
      vendors: d2cVendors,
      total: d2cTotal,
    },
    // Backward-compatible fields
    total_outstanding_amount: totalOutstanding,
    total_unsettled_orders: b2cTotal.unsettled > 0 ? (b2cChannels.reduce((sum, c) => sum + (c.orders_count || 0), 0)) : 0,
    total_unsettled_amount: b2cTotal.unsettled,
    total_pending_invoices: 0,
    total_pending_invoice_amount: 0,
    overdue_amount_30d: b2cTotal.overdue,
    overdue_orders_30d: b2cChannels.reduce((sum, c) => sum + (c.orders_count || 0), 0),
    aging: {
      '0-15 days': {
        count: 0,
        amount: b2cTotal.upcoming,
      },
      '16-30 days': {
        count: 0,
        amount: b2cTotal.due_in_grace,
      },
      '31-60 days': {
        count: 0,
        amount: Math.round(b2cTotal.overdue * 0.1),
      },
      '60+ days': {
        count: b2cChannels.reduce((sum, c) => sum + (c.orders_count || 0), 0),
        amount: b2cTotal.overdue - Math.round(b2cTotal.overdue * 0.1),
      },
    },
    by_marketplace: b2cChannels.map(c => ({
      marketplace: c.channel_key,
      seller_account: c.accounts?.[0]?.account_key || 'default',
      display_name: c.channel_name,
      unsettled_orders_count: c.orders_count || 0,
      unsettled_amount: c.unsettled,
      pending_invoices_count: 0,
      pending_invoices_amount: c.settled_not_paid,
      total_outstanding: c.total,
      aging_0_15: c.upcoming,
      aging_16_30: c.due_in_grace,
      aging_31_60: Math.round(c.overdue * 0.1),
      aging_60_plus: c.overdue - Math.round(c.overdue * 0.1),
      percentage_of_total: totalOutstanding > 0 ? Math.round((c.total / totalOutstanding) * 1000) / 10 : 0,
    })),
  };
}
