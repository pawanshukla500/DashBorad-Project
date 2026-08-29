/**
 * Shared settlement SQL fragments used across data routes.
 * Keep money math here so KPI definitions cannot drift.
 */
import { ORDER_SETTLEMENT_TOTALS_TABLE } from './orderSettlementTotals.js';

/** Read the transactionally refreshed per-order settlement totals. */
export const SETT_CTE = `
WITH sett AS (
  SELECT * FROM ${ORDER_SETTLEMENT_TOTALS_TABLE}
)
`;

/** Fee total expression on sett alias `s` */
export const SETT_FEE_SQL = `
  COALESCE(s.commission,0)+COALESCE(s.fixed_fee,0)+COALESCE(s.collection_fee,0)+
  COALESCE(s.pick_pack_fee,0)+COALESCE(s.shipping_fee,0)+COALESCE(s.reverse_shipping,0)+
  COALESCE(s.franchise_fee,0)+COALESCE(s.tcs,0)+COALESCE(s.tds,0)+COALESCE(s.gst_on_mp_fees,0)
`;

/**
 * Pure helpers for summary KPI math (unit-tested).
 * bankReceived === legacy myShare / totalSettlement.
 */
export function computeSummaryMetrics({
  totalOrders = 0,
  totalRevenue = 0,
  bankReceived = 0,
  totalFees = 0,
  returnCount = 0,
  unsettledCount = 0,
} = {}) {
  const orders = +totalOrders || 0;
  const revenue = +totalRevenue || 0;
  const bank = +bankReceived || 0;
  const fees = +totalFees || 0;
  const returns = +returnCount || 0;
  const unsettled = +unsettledCount || 0;
  return {
    totalOrders: orders,
    totalRevenue: revenue,
    bankReceived: bank,
    myShare: bank,           // legacy alias
    totalSettlement: bank,   // legacy alias — same as bankReceived
    totalFees: fees,
    unsettledCount: unsettled,
    returnCount: returns,
    returnRate: orders > 0 ? (returns / orders) * 100 : 0,
    avgOrderValue: orders > 0 ? revenue / orders : 0,
  };
}
