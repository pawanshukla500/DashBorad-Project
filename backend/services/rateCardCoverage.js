import { normalizeMarketplaceCategory } from './rateCard.js';
import { resolveRateCardEffectiveDate } from '../utils/rateCardDate.js';

// Keep this allowlist aligned with the rate-card configuration API. Identifiers
// are constants; marketplace and seller account values remain parameters.
export const RATE_CARD_CONFIG_TABLES = [
  'rc_commission',
  'rc_fixed_fee',
  'rc_collection_fee',
  'rc_pick_pack',
  'rc_reverse_shipping',
  'rc_franchise_fee',
];

const normalizeMarketplace = value => String(value || '').trim().toLowerCase();

export async function loadRateCardCoverage(client, { marketplace, sellerAccount, effectiveDate } = {}) {
  const channel = normalizeMarketplace(marketplace);
  const account = String(sellerAccount || '').trim();
  if (!['flipkart', 'shopsy'].includes(channel)) {
    throw new Error('Rate-card coverage is available only for Flipkart or Shopsy jobs.');
  }
  if (!account) throw new Error('A seller account is required to verify rate-card coverage.');
  if (!client || typeof client.query !== 'function') throw new Error('Rate-card coverage database is unavailable.');
  const activeDate = resolveRateCardEffectiveDate(effectiveDate);

  const sellerAccountFilter = account === 'default'
    ? "COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2"
    : "(COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2 OR COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = 'default')";
  const configured = new Set();
  for (const table of RATE_CARD_CONFIG_TABLES) {
    let result;
    try {
      result = await client.query(
        `SELECT DISTINCT category FROM ${table} WHERE marketplace = $1
          AND ${sellerAccountFilter}
          AND ($1 <> 'flipkart' OR LOWER(TRIM(category)) !~ '^shopsy([[:space:]_-]+)')
          AND (start_date IS NULL OR start_date <= $3::date)
          AND (end_date IS NULL OR end_date >= $3::date)`,
        [channel, account, activeDate],
      );
    } catch (cause) {
      const error = new Error(`Rate-card coverage is unavailable because ${table} could not be read.`);
      error.code = 'RATE_CARD_COVERAGE_UNAVAILABLE';
      error.cause = cause;
      throw error;
    }
    for (const row of result.rows || []) {
      const category = normalizeMarketplaceCategory(row.category, channel);
      if (category) configured.add(category);
    }
  }

  if (!configured.size) {
    const error = new Error(`No configured ${channel} rate-card categories were found for seller account ${account}.`);
    error.code = 'RATE_CARD_COVERAGE_UNAVAILABLE';
    throw error;
  }

  let catalog;
  try {
    catalog = await client.query(`
      SELECT category,
        COUNT(*)::int AS order_rows,
        COUNT(*) FILTER (WHERE fsn IS NOT NULL AND UPPER(TRIM(fsn)) ~ '^[A-Z0-9]{16}$')::int AS valid_fsn_order_rows
      FROM orders
      WHERE (($1 = 'shopsy' AND (LOWER(TRIM(marketplace)) = 'shopsy'
               OR (LOWER(TRIM(marketplace)) = 'flipkart' AND LOWER(TRIM(category)) ~ '^shopsy([[:space:]_-]+)')))
          OR ($1 = 'flipkart' AND LOWER(TRIM(marketplace)) = 'flipkart'
               AND LOWER(TRIM(category)) !~ '^shopsy([[:space:]_-]+)'))
        AND COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2
        AND category IS NOT NULL AND TRIM(category) <> ''
      GROUP BY category
    `, [channel, account]);
  } catch (cause) {
    const error = new Error('Rate-card coverage is unavailable because the account-scoped FSN catalog could not be read.');
    error.code = 'RATE_CARD_COVERAGE_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }

  const fsnCategories = new Set();
  const orderCategories = new Set();
  for (const row of catalog.rows || []) {
    const category = normalizeMarketplaceCategory(row.category, channel);
    if (!category) continue;
    orderCategories.add(category);
    const validFsnOrderRows = Number(row.valid_fsn_order_rows ?? row.validFsnOrderRows ?? 0);
    if (validFsnOrderRows > 0) fsnCategories.add(category);
  }

  const configuredCategories = [...configured].sort();
  const missingFsnCategories = configuredCategories.filter(category => !fsnCategories.has(category));
  const fsnBackedConfiguredCategories = configuredCategories.filter(category => fsnCategories.has(category));
  return {
    marketplace: channel,
    sellerAccount: account,
    configuredCategories,
    fsnCategories: [...fsnCategories].sort(),
    fsnBackedConfiguredCategories,
    missingFsnCategories,
    configuredCategoriesWithoutOrders: missingFsnCategories.filter(category => !orderCategories.has(category)),
    configuredCategoriesWithOrdersButNoFsns: missingFsnCategories.filter(category => orderCategories.has(category)),
  };
}

export function assertRateObservationCoverage(observations, coverage) {
  if (!coverage || !Array.isArray(coverage.configuredCategories) || !coverage.configuredCategories.length) {
    throw new Error('Configured rate-card category coverage is unavailable.');
  }
  const fsnBackedConfiguredCategories = Array.isArray(coverage.fsnBackedConfiguredCategories)
    ? coverage.fsnBackedConfiguredCategories
    : coverage.configuredCategories.filter(category => !(coverage.missingFsnCategories || []).includes(category));
  if (!fsnBackedConfiguredCategories.length) {
    const error = new Error('No configured rate-card category has an account-scoped database FSN. No extraction results can be accepted.');
    error.code = 'RATE_CARD_NO_FSN_BACKED_CATEGORIES';
    throw error;
  }

  const expected = new Set(fsnBackedConfiguredCategories.map(category =>
    normalizeMarketplaceCategory(category, coverage.marketplace)));
  const actual = new Set((observations || []).map(observation =>
    normalizeMarketplaceCategory(observation.vertical || observation.category, coverage.marketplace)).filter(Boolean));
  const missing = [...expected].filter(category => !actual.has(category));
  const unexpected = [...actual].filter(category => !expected.has(category));
  if (missing.length) {
    const error = new Error(`Missing configured rate-card categories: ${missing.sort().join(', ')}.`);
    error.code = 'RATE_CARD_COVERAGE_INCOMPLETE';
    throw error;
  }
  if (unexpected.length) {
    const error = new Error(`Extraction contains unconfigured rate-card categories: ${unexpected.sort().join(', ')}.`);
    error.code = 'RATE_CARD_COVERAGE_INCOMPLETE';
    throw error;
  }
  return [...expected].sort();
}
