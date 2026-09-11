import { pagination } from '../utils/requestParams.js';

// Keep the settlement vocabulary in one place. Every report and backfill uses
// this expression so a fee can never be classified differently by two screens.
export const CATEGORY_CASE_SQL = `
  CASE
    WHEN amount_description = 'Principal' THEN 'order_revenue'
    WHEN amount_description IN ('Product Tax','Shipping tax','Shipping Tax') THEN 'order_tax'
    WHEN amount_description = 'Shipping' THEN 'order_shipping'
    WHEN amount_description ILIKE 'Shipping Chargeback%' THEN 'order_shipping'

    WHEN amount_description ILIKE 'Commission%'
      OR amount_description ILIKE 'Refund commission%'
      THEN 'order_commission'

    WHEN amount_description ILIKE 'Fixed closing fee%' THEN 'order_closing_fee'
    WHEN amount_description ILIKE 'FBA Weight Handling Fee%'
      OR amount_description ILIKE 'FBA Pick & Pack Fee%'
      OR amount_description ILIKE 'FBA Inbound%'
      OR (amount_type = 'ItemFees' AND amount_description ILIKE 'FBA%')
      THEN 'order_fba_fee'
    WHEN amount_description ILIKE 'Technology%Fee%' THEN 'order_tech_fee'
    WHEN amount_type = 'ItemTCS' THEN 'order_tcs'
    WHEN amount_type = 'ItemTDS' THEN 'order_tds'
    WHEN amount_description ILIKE 'Gift wrap%' OR amount_description ILIKE 'Gift Wrap%'
      THEN 'order_gift_wrap'
    WHEN amount_type = 'Promotion'
      OR amount_description ILIKE '%discount%'
      OR amount_description ILIKE 'Promo%'
      THEN 'order_promotion'

    WHEN amount_type = 'FBA Inventory Reimbursement'
      OR amount_description ILIKE '%SAFE-T%'
      THEN 'inventory_reimbursement'
    WHEN amount_description ILIKE 'RemovalComplete%'
      OR amount_type ILIKE 'FBA Removal Order%'
      THEN 'removal_fee'
    WHEN amount_description ILIKE 'FBAStorageFee%'
      OR amount_description ILIKE '%Long%Term%Storage%'
      OR amount_description ILIKE 'StorageFee%'
      OR amount_description ILIKE '%Storage Utilization%'
      OR amount_type ILIKE 'FBA%Storage%'
      THEN 'storage_fee'
    WHEN amount_description ILIKE 'Sponsored%'
      OR amount_description ILIKE '%Advertising%'
      OR amount_description ILIKE 'Ads%'
      OR amount_description ILIKE 'CPC%'
      OR amount_type = 'Cost of Advertising'
      THEN 'ads_billing'
    WHEN amount_type = 'Seller Rewards'
      THEN 'other_credit'
    WHEN amount_description ILIKE 'Subscription%'
      OR amount_description ILIKE '%Pro Seller%'
      THEN 'subscription_fee'
    WHEN amount_description ILIKE 'Service%Fee%'
      OR amount_description ILIKE 'Account Health%'
      OR amount_description ILIKE 'VariableClosingFee%'
      THEN 'service_fee'
    WHEN amount_description ILIKE '%Reimbursement%Lost%'
      OR amount_description ILIKE '%Lost package%'
      OR amount_description ILIKE '%Lost packages%'
      THEN 'lost_package_credit'

    -- Unknown order-linked money belongs to that order, not to non-order P&L.
    WHEN order_id IS NOT NULL AND amount IS NULL THEN 'order_unclassified'
    WHEN order_id IS NOT NULL AND amount >= 0 THEN 'order_other_credit'
    WHEN order_id IS NOT NULL THEN 'order_other_debit'
    WHEN amount IS NULL THEN 'unclassified'
    WHEN amount >= 0 THEN 'other_credit'
    ELSE 'other_debit'
  END
`;

export const NON_ORDER_CATEGORIES = Object.freeze([
  'removal_fee',
  'storage_fee',
  'ads_billing',
  'subscription_fee',
  'service_fee',
  'lost_package_credit',
  'other_credit',
  'other_debit',
  'unclassified',
]);

export class InvalidAmazonMonthError extends Error {
  constructor(value) {
    super(`Invalid month "${value}". Expected YYYY-MM.`);
    this.name = 'InvalidAmazonMonthError';
    this.statusCode = 400;
  }
}

export function amazonMonthRange(value) {
  if (value == null || value === '') return null;
  const match = /^(\d{4})-(\d{2})$/.exec(String(value));
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) throw new InvalidAmazonMonthError(value);

  const year = Number(match[1]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: `${match[1]}-${match[2]}-01`,
    end: `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`,
  };
}

function categoryParams(startAt = 1) {
  return NON_ORDER_CATEGORIES.map((_, index) => `$${startAt + index}`).join(',');
}

export async function fetchAmazonNonOrderReport(pool, query = {}) {
  const settlementId = query.settlement_id || null;
  const month = query.month || null;
  const range = amazonMonthRange(month);
  const { page, pageSize, offset } = pagination(query, {
    defaultPageSize: 100,
    maxPageSize: 500,
  });

  const filters = [];
  const filterParams = [];
  if (settlementId) {
    filterParams.push(settlementId);
    filters.push(`l.settlement_id = $${filterParams.length}`);
  }
  if (range) {
    filterParams.push(range.start, range.end);
    filters.push(
      `l.posted_date >= $${filterParams.length - 1}::date`,
      `l.posted_date < $${filterParams.length}::date`,
    );
  }

  const filterSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const categoriesSql = categoryParams(filterParams.length + 1);
  const reportParams = [...filterParams, ...NON_ORDER_CATEGORIES];
  const detailParams = [...reportParams, pageSize, offset];

  const [totalsResult, linesResult] = await Promise.all([
    pool.query(`
      WITH classified AS (
        SELECT l.posted_date, l.amount, ${CATEGORY_CASE_SQL} AS category
        FROM amazon_settlement_lines l
        ${filterSql}
      )
      SELECT
        category,
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS net_amount,
        COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS credit_total,
        COALESCE(ABS(SUM(amount) FILTER (WHERE amount < 0)), 0) AS debit_total,
        MIN(posted_date) AS first_posted,
        MAX(posted_date) AS last_posted
      FROM classified
      WHERE category IN (${categoriesSql})
      GROUP BY category
      ORDER BY ABS(SUM(amount)) DESC NULLS LAST
    `, reportParams),
    pool.query(`
      WITH classified AS (
        SELECT l.*, ${CATEGORY_CASE_SQL} AS category
        FROM amazon_settlement_lines l
        ${filterSql}
      )
      SELECT
        id, settlement_id, posted_date, posted_at,
        transaction_type, amount_type, amount_description, amount,
        order_id, sku, adjustment_id, category,
        COUNT(*) OVER () AS total_count
      FROM classified
      WHERE category IN (${categoriesSql})
      ORDER BY posted_date DESC NULLS LAST, id DESC
      LIMIT $${detailParams.length - 1} OFFSET $${detailParams.length}
    `, detailParams),
  ]);

  const grand = totalsResult.rows.reduce((total, row) => {
    total.credit_total += Number(row.credit_total || 0);
    total.debit_total += Number(row.debit_total || 0);
    total.net_amount += Number(row.net_amount || 0);
    total.count += Number(row.count || 0);
    return total;
  }, { credit_total: 0, debit_total: 0, net_amount: 0, count: 0 });

  const total = Number(linesResult.rows[0]?.total_count || 0);
  const lines = linesResult.rows.map(({ total_count: _totalCount, ...line }) => line);

  return {
    filters: { settlement_id: settlementId, month },
    grand,
    totals: totalsResult.rows,
    lines,
    pagination: { page, pageSize, total },
  };
}

export async function fetchAmazonSettlementSummary(pool) {
  const nonOrderSql = NON_ORDER_CATEGORIES.map(category => `'${category}'`).join(',');

  const [periodResult, metricsResult, feeResult, depositsResult, nonOrderResult] = await Promise.all([
    pool.query(`
      SELECT
        MIN(settlement_start_date) AS start,
        MAX(settlement_end_date) AS "end",
        COUNT(*) AS settlement_count,
        COALESCE(SUM(total_amount), 0) AS total_deposit
      FROM amazon_settlements
    `),
    pool.query(`
      WITH classified AS (
        SELECT
          order_id, transaction_type, amount_type, amount_description, amount,
          ${CATEGORY_CASE_SQL} AS category
        FROM amazon_settlement_lines
      )
      SELECT
        COALESCE(SUM(amount) FILTER (
          WHERE transaction_type = 'Order' AND amount_description = 'Principal'
        ), 0) AS gross_sales,
        COALESCE(SUM(ABS(amount)) FILTER (WHERE category = 'order_fba_fee'), 0) AS total_fba_fee,
        COALESCE(SUM(ABS(amount)) FILTER (WHERE category = 'order_closing_fee'), 0) AS closing_fee,
        COALESCE(SUM(ABS(amount)) FILTER (
          WHERE transaction_type = 'Refund' AND amount_description = 'Principal'
        ), 0) AS total_refunds,
        COALESCE(SUM(ABS(amount)) FILTER (WHERE category = 'order_commission'), 0) AS total_commission,
        COALESCE(SUM(amount) FILTER (WHERE category IN (${nonOrderSql})), 0) AS non_order_net,
        COALESCE(SUM(amount) FILTER (
          WHERE category IN (${nonOrderSql}) AND amount > 0
        ), 0) AS non_order_credits,
        COALESCE(ABS(SUM(amount) FILTER (
          WHERE category IN (${nonOrderSql}) AND amount < 0
        )), 0) AS non_order_debits,
        COALESCE(SUM(amount) FILTER (WHERE category = 'inventory_reimbursement'), 0)
          AS inventory_reimbursement_total
      FROM classified
    `),
    pool.query(`
      SELECT amount_description AS fee_type, COUNT(*) AS count, SUM(ABS(amount)) AS total
      FROM amazon_settlement_lines
      WHERE amount IS NOT NULL AND amount <> 0
      GROUP BY amount_description
      ORDER BY total DESC
      LIMIT 20
    `),
    pool.query(`
      SELECT settlement_id, deposit_date, total_amount
      FROM amazon_settlements
      WHERE deposit_date IS NOT NULL
      ORDER BY deposit_date DESC
      LIMIT 24
    `),
    pool.query(`
      WITH classified AS (
        SELECT order_id, amount, ${CATEGORY_CASE_SQL} AS category
        FROM amazon_settlement_lines
      )
      SELECT
        category,
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS net_amount,
        COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS credits,
        COALESCE(ABS(SUM(amount) FILTER (WHERE amount < 0)), 0) AS debits
      FROM classified
      WHERE category IN (${nonOrderSql})
      GROUP BY category
      ORDER BY ABS(SUM(amount)) DESC NULLS LAST
    `),
  ]);

  return {
    period: { ...periodResult.rows[0], ...metricsResult.rows[0] },
    byFeeType: feeResult.rows,
    deposits: depositsResult.rows,
    nonOrderByCategory: nonOrderResult.rows,
  };
}
