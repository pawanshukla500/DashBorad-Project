import { normalizeMarketplaceCategory } from './rateCard.js';

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

export async function loadRateCardCoverage(client, { marketplace, sellerAccount } = {}) {
  const channel = normalizeMarketplace(marketplace);
  const account = String(sellerAccount || '').trim();
  if (!['flipkart', 'shopsy'].includes(channel)) {
    throw new Error('Rate-card coverage is available only for Flipkart or Shopsy jobs.');
  }
  if (!account) throw new Error('A seller account is required to verify rate-card coverage.');
  if (!client || typeof client.query !== 'function') throw new Error('Rate-card coverage database is unavailable.');

  const configured = new Set();
  for (const table of RATE_CARD_CONFIG_TABLES) {
    let result;
    try {
      result = await client.query(
        `SELECT DISTINCT category FROM ${table} WHERE marketplace = $1 AND seller_account = $2
          AND (start_date IS NULL OR start_date <= CURRENT_DATE)
          AND (end_date IS NULL OR end_date >= CURRENT_DATE)`,
        [channel, account],
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
      SELECT DISTINCT category, fsn
      FROM orders
      WHERE (($1 = 'shopsy' AND (marketplace = 'shopsy'
               OR (marketplace = 'flipkart' AND LEFT(LOWER(TRIM(category)), 7) = 'shopsy_')))
          OR ($1 = 'flipkart' AND marketplace = 'flipkart'
               AND LEFT(LOWER(TRIM(category)), 7) <> 'shopsy_'))
        AND COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2
        AND category IS NOT NULL AND TRIM(category) <> ''
        AND fsn IS NOT NULL AND UPPER(TRIM(fsn)) ~ '^[A-Z0-9]{16}$'
    `, [channel, account]);
  } catch (cause) {
    const error = new Error('Rate-card coverage is unavailable because the account-scoped FSN catalog could not be read.');
    error.code = 'RATE_CARD_COVERAGE_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }

  const fsnCategories = new Set();
  for (const row of catalog.rows || []) {
    const category = normalizeMarketplaceCategory(row.category, channel);
    const fsn = String(row.fsn || '').trim();
    if (category && /^[A-Z0-9]{16}$/i.test(fsn)) fsnCategories.add(category);
  }

  const configuredCategories = [...configured].sort();
  const missingFsnCategories = configuredCategories.filter(category => !fsnCategories.has(category));
  return {
    marketplace: channel,
    sellerAccount: account,
    configuredCategories,
    fsnCategories: [...fsnCategories].sort(),
    missingFsnCategories,
  };
}

export function assertRateObservationCoverage(observations, coverage) {
  if (!coverage || !Array.isArray(coverage.configuredCategories) || !coverage.configuredCategories.length) {
    throw new Error('Configured rate-card category coverage is unavailable.');
  }
  if (coverage.missingFsnCategories?.length) {
    const error = new Error(`Configured rate-card categories have no account-scoped database FSN: ${coverage.missingFsnCategories.join(', ')}.`);
    error.code = 'RATE_CARD_COVERAGE_INCOMPLETE';
    throw error;
  }

  const expected = new Set(coverage.configuredCategories.map(category =>
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
