// Amazon's settlement file is a long ledger, not a rate card.  Keep the
// source descriptions intact in amazon_settlement_lines and translate them to
// these stable internal codes only when reporting/reconciling.
//
// A fee rule is deliberately not seeded here. Amazon fees depend on the
// seller's contracted rate card, programme, product/weight slab and period.
// Unconfigured fees must remain "not configured", never be compared against
// a public/default Amazon rate.

export const AMAZON_FEE_CATALOG = Object.freeze([
  {
    code: 'commission',
    label: 'Commission / Referral Fee',
    programs: ['ALL', 'FBA', 'FLEX'],
    defaultBasis: 'percent_of_sale',
    reconcilable: true,
    description: 'Marketplace commission. Refund-commission credits are shown separately from sale charges.',
  },
  {
    code: 'fixed_closing_fee',
    label: 'Fixed Closing Fee',
    programs: ['ALL', 'FBA', 'FLEX'],
    defaultBasis: 'per_unit',
    reconcilable: true,
    description: 'Flat closing fee charged on the sale line.',
  },
  {
    code: 'fba_pick_pack',
    label: 'FBA Pick & Pack Fee',
    programs: ['FBA'],
    defaultBasis: 'per_unit',
    reconcilable: true,
    description: 'FBA fulfilment charge. This is not applied to Flex orders.',
  },
  {
    code: 'fba_weight_handling',
    label: 'Weight Handling Fee',
    programs: ['FBA', 'FLEX'],
    defaultBasis: 'per_unit',
    reconcilable: true,
    description: 'Weight/handling charge present in both observed FBA and Flex settlement rows.',
  },
  {
    code: 'technology_fee',
    label: 'Flex Technology Fee',
    programs: ['FLEX'],
    defaultBasis: 'per_unit',
    reconcilable: true,
    description: 'Flex charge used instead of FBA Pick & Pack.',
  },
  {
    code: 'return_processing_fee',
    label: 'Return Processing Fee',
    programs: ['FBA', 'FLEX'],
    defaultBasis: 'per_unit',
    reconcilable: true,
    description: 'Specific fee charged for returns in certain categories (Apparel, Shoes).',
  },
  {
    code: 'shipping_chargeback',
    label: 'Shipping Chargeback',
    programs: ['ALL', 'FBA', 'FLEX'],
    defaultBasis: 'per_unit',
    reconcilable: true,
    description: 'Only configure when this is a contracted, order-level charge.',
  },
]);

export const AMAZON_RECONCILABLE_FEE_CODES = Object.freeze(
  AMAZON_FEE_CATALOG.filter(item => item.reconcilable).map(item => item.code),
);

export const AMAZON_CALCULATION_BASES = Object.freeze([
  'per_order_line',
  'per_unit',
  'percent_of_sale',
]);

export const AMAZON_PROGRAMS = Object.freeze(['ALL', 'FBA', 'FLEX']);

// This expression is intentionally more detailed than CATEGORY_CASE_SQL. The
// existing dashboard uses broad buckets for cross-marketplace summaries;
// Amazon fee reconciliation needs each contracted charge and its GST split.
export const AMAZON_FEE_CODE_CASE_SQL = `
  CASE
    WHEN amount_description = 'Principal' THEN 'principal'
    WHEN amount_description = 'Product Tax' THEN 'product_tax'
    WHEN amount_description = 'Shipping' THEN 'shipping'
    WHEN amount_description IN ('Shipping tax', 'Shipping Tax') THEN 'shipping_tax'
    WHEN amount_description ILIKE 'Shipping tax discount%' THEN 'shipping_tax_discount'
    WHEN amount_description ILIKE 'Shipping discount%' THEN 'shipping_discount'

    WHEN amount_type = 'ItemTCS' THEN 'tcs'
    WHEN amount_type = 'ItemTDS' THEN 'tds'

    WHEN amount_description ILIKE 'FBA Pick & Pack Fee%'
      AND (amount_description ILIKE '%CGST%' OR amount_description ILIKE '%SGST%' OR amount_description ILIKE '%IGST%' OR amount_description ILIKE '%GST%')
      THEN 'fba_pick_pack_tax'
    WHEN amount_description ILIKE 'FBA Pick & Pack Fee%' THEN 'fba_pick_pack'

    WHEN amount_description ILIKE 'FBA Weight Handling Fee%'
      AND (amount_description ILIKE '%CGST%' OR amount_description ILIKE '%SGST%' OR amount_description ILIKE '%IGST%' OR amount_description ILIKE '%GST%')
      THEN 'fba_weight_handling_tax'
    WHEN amount_description ILIKE 'FBA Weight Handling Fee%' THEN 'fba_weight_handling'

    WHEN amount_description ILIKE 'Fixed closing fee%'
      AND (amount_description ILIKE '%CGST%' OR amount_description ILIKE '%SGST%' OR amount_description ILIKE '%IGST%' OR amount_description ILIKE '%GST%')
      THEN 'fixed_closing_fee_tax'
    WHEN amount_description ILIKE 'Fixed closing fee%' THEN 'fixed_closing_fee'

    WHEN amount_description ILIKE 'Technology%Fee%'
      AND (amount_description ILIKE '%CGST%' OR amount_description ILIKE '%SGST%' OR amount_description ILIKE '%IGST%' OR amount_description ILIKE '%GST%')
      THEN 'technology_fee_tax'
    WHEN amount_description ILIKE 'Technology%Fee%' THEN 'technology_fee'

    WHEN amount_description ILIKE '%commission%'
      AND (amount_description ILIKE '%CGST%' OR amount_description ILIKE '%SGST%' OR amount_description ILIKE '%IGST%' OR amount_description ILIKE '%GST%')
      THEN 'commission_tax'
    WHEN amount_description ILIKE 'Commission%'
      OR amount_description ILIKE 'Refund commission%'
      THEN 'commission'

    WHEN amount_description ILIKE 'Return Processing Fee%'
      AND (amount_description ILIKE '%CGST%' OR amount_description ILIKE '%SGST%' OR amount_description ILIKE '%IGST%' OR amount_description ILIKE '%GST%')
      THEN 'return_processing_fee_tax'
    WHEN amount_description ILIKE 'Return Processing Fee%' THEN 'return_processing_fee'

    WHEN amount_description ILIKE 'Shipping Chargeback%'
      AND (amount_description ILIKE '%CGST%' OR amount_description ILIKE '%SGST%' OR amount_description ILIKE '%IGST%' OR amount_description ILIKE '%GST%')
      THEN 'shipping_chargeback_tax'
    WHEN amount_description ILIKE 'Return Processing Fee%'
      AND (amount_description ILIKE '%CGST%' OR amount_description ILIKE '%SGST%' OR amount_description ILIKE '%IGST%' OR amount_description ILIKE '%GST%')
      THEN 'return_processing_fee_tax'
    WHEN amount_description ILIKE 'Return Processing Fee%' THEN 'return_processing_fee'

    WHEN amount_description ILIKE 'Shipping Chargeback%' THEN 'shipping_chargeback'

    WHEN amount_description ILIKE 'Gift wrap%' OR amount_description ILIKE 'Gift Wrap%' THEN 'gift_wrap'
    WHEN amount_type = 'Promotion' OR amount_description ILIKE '%discount%' OR amount_description ILIKE 'Promo%' THEN 'promotion'
    WHEN amount_type = 'FBA Inventory Reimbursement' THEN 'inventory_reimbursement'
    ELSE 'other'
  END
`;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sameText(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function dateInRange(date, startDate, endDate) {
  if (!date) return true;
  const value = String(date).slice(0, 10);
  if (startDate && value < String(startDate).slice(0, 10)) return false;
  if (endDate && value > String(endDate).slice(0, 10)) return false;
  return true;
}

function normalizedRule(rule) {
  return {
    ...rule,
    code: String(rule.fee_code || rule.code || '').trim(),
    sellerAccount: String(rule.seller_account || rule.sellerAccount || 'default').trim() || 'default',
    program: String(rule.program || 'ALL').trim().toUpperCase(),
    category: String(rule.category || 'ALL').trim() || 'ALL',
    brandName: String(rule.brand_name || rule.brandName || '').trim(),
    weightSlab: String(rule.weight_slab || rule.weightSlab || '').trim(),
    basis: String(rule.calculation_basis || rule.basis || 'per_unit').trim(),
    rate: number(rule.rate),
    taxRate: number(rule.tax_rate ?? rule.taxRate),
    priceMin: number(rule.price_min ?? rule.priceMin, 0),
    priceMax: number(rule.price_max ?? rule.priceMax, 999999),
    priority: number(rule.priority),
  };
}

function ruleSpecificity(rule, row) {
  return [
    rule.sellerAccount === String(row.seller_account || 'default') ? 8 : 0,
    rule.program === String(row.program || '').toUpperCase() ? 4 : 0,
    !['', 'ALL'].includes(rule.category.toUpperCase()) ? 2 : 0,
    rule.brandName ? 2 : 0,
    rule.weightSlab ? 2 : 0,
    rule.start_date ? 1 : 0,
    rule.priority,
    number(rule.id),
  ];
}

function compareSpecificity(left, right, row) {
  const a = ruleSpecificity(left, row);
  const b = ruleSpecificity(right, row);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

export function matchAmazonRateRule(rules, row, feeCode) {
  const program = String(row.program || '').toUpperCase();
  const category = String(row.category || '').trim();
  const brandName = String(row.brand_name || '').trim();
  const weightSlab = String(row.weight_slab || '').trim();
  const sellerAccount = String(row.seller_account || 'default').trim() || 'default';
  const saleAmount = number(row.sale_amount);
  const orderDate = row.order_date || row.first_posted;

  return (rules || [])
    .map(normalizedRule)
    .filter(rule => rule.code === feeCode)
    .filter(rule => rule.sellerAccount === sellerAccount || rule.sellerAccount === 'default')
    .filter(rule => rule.program === 'ALL' || rule.program === program)
    .filter(rule => ['ALL', ''].includes(rule.category.toUpperCase()) || sameText(rule.category, category))
    .filter(rule => !rule.brandName || sameText(rule.brandName, brandName))
    .filter(rule => !rule.weightSlab || sameText(rule.weightSlab, weightSlab))
    .filter(rule => saleAmount >= rule.priceMin && saleAmount <= rule.priceMax)
    .filter(rule => dateInRange(orderDate, rule.start_date, rule.end_date))
    .sort((a, b) => compareSpecificity(a, b, row))[0] || null;
}

export function calculateAmazonExpectedFee(rule, row) {
  if (!rule) return null;
  const normalized = normalizedRule(rule);
  const quantity = Math.max(1, number(row.quantity, 1));
  const saleAmount = number(row.sale_amount);
  let base = 0;

  if (normalized.basis === 'percent_of_sale') base = saleAmount * normalized.rate;
  else if (normalized.basis === 'per_order_line') base = normalized.rate;
  else base = quantity * normalized.rate; // per_unit is the default

  const tax = base * normalized.taxRate;
  return {
    ruleId: normalized.id ?? null,
    basis: normalized.basis,
    expectedBase: Number(base.toFixed(2)),
    expectedTax: Number(tax.toFixed(2)),
    expectedTotal: Number((base + tax).toFixed(2)),
  };
}

export function buildAmazonFeeComparison(row, rules) {
  const fees = {};
  for (const fee of AMAZON_FEE_CATALOG) {
    const actualBase = Math.max(0, -number(row[`${fee.code}_base`]));
    const actualTax = Math.max(0, -number(row[`${fee.code}_tax`]));
    const credits = Math.max(0, number(row[`${fee.code}_credit`]));
    const actualTotal = Number((actualBase + actualTax - credits).toFixed(2));
    // A row containing a customer refund or fulfilment-fee refund may represent
    // only part of a multi-unit order. Do not compare its net fee to a full-sale
    // rate rule: it needs return quantity / credit verification instead.
    const isReturnLifecycle = Boolean(row.has_refund || row.has_fee_refund);
    const rule = row.sale_amount > 0 && !isReturnLifecycle && !['MIXED', 'UNKNOWN'].includes(String(row.program || '').toUpperCase())
      ? matchAmazonRateRule(rules, row, fee.code)
      : null;
    const expected = calculateAmazonExpectedFee(rule, row);
    const variance = expected ? Number((actualTotal - expected.expectedTotal).toFixed(2)) : null;
    fees[fee.code] = {
      code: fee.code,
      label: fee.label,
      actualBase,
      actualTax,
      credits,
      actualTotal,
      ruleId: expected?.ruleId ?? null,
      expectedBase: expected?.expectedBase ?? null,
      expectedTax: expected?.expectedTax ?? null,
      expectedTotal: expected?.expectedTotal ?? null,
      variance,
      status: isReturnLifecycle
        ? 'return_review'
        : expected
          ? (Math.abs(variance) <= 0.01 ? 'matched' : variance > 0 ? 'overcharged' : 'undercharged')
          : (actualTotal > 0 ? 'not_configured' : 'not_applicable'),
    };
  }
  return fees;
}
