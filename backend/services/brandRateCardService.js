/**
 * Read-only Flipkart/Shopsy rate-card catalog and published-rate snapshot.
 * Seller Hub observations are staged and reviewed by the worker pipeline;
 * this module never estimates fees or writes rate-card tables.
 */
import { getPool } from '../db/index.js';
import { normalizeMarketplaceCategory } from './rateCard.js';
import { resolveRateCardEffectiveDate } from '../utils/rateCardDate.js';

const RATE_TABLES = [
  ['rc_commission', 'commissions', true],
  ['rc_fixed_fee', 'fixedFees', false],
  ['rc_collection_fee', 'collectionFees', false],
  ['rc_pick_pack', 'pickPackFees', false],
  ['rc_reverse_shipping', 'reverseShipping', false],
  ['rc_franchise_fee', 'franchiseFees', true],
];
const NUMERIC_FIELDS = new Set([
  'price_min', 'price_max', 'rate', 'prepaid', 'postpaid', 'local_fee', 'zonal_fee', 'national_fee',
  'weight_min', 'weight_max', 'base_weight', 'increment_weight',
  'local_additional_fee', 'zonal_additional_fee', 'national_additional_fee',
]);

const normalized = value => String(value ?? '').trim().toLowerCase();
const normalizedAccount = value => String(value ?? '').trim() || 'default';
const isGenericRateBrand = value => !normalized(value) || ['general', 'all brands'].includes(normalized(value));

function channelFor(marketplace, category) {
  const rawMarketplace = normalized(marketplace);
  const normalizedCategory = normalizeMarketplaceCategory(category, rawMarketplace === 'shopsy' ? 'shopsy' : 'flipkart');
  return rawMarketplace === 'shopsy' || normalizedCategory.startsWith('shopsy_') ? 'shopsy' : rawMarketplace;
}

/** Return only valid, account-aware FSN samples from actual Flipkart/Shopsy orders. */
export async function getRealTimeBrandFsnSamples(pool = null, { marketplace = null, sellerAccount = null } = {}) {
  const p = pool || getPool();
  const filters = [
    "(marketplace ILIKE '%flipkart%' OR marketplace ILIKE '%shopsy%')",
    "category IS NOT NULL AND TRIM(category) <> ''",
  ];
  const params = [];
  if (marketplace) {
    params.push(normalized(marketplace));
    const marketplaceParam = `$${params.length}`;
    if (normalized(marketplace) === 'shopsy') {
      filters.push(`(LOWER(TRIM(marketplace)) = ${marketplaceParam} OR (LOWER(TRIM(marketplace)) = 'flipkart' AND LOWER(TRIM(category)) ~ '^shopsy([[:space:]_-]+)'))`);
    } else if (normalized(marketplace) === 'flipkart') {
      filters.push(`(LOWER(TRIM(marketplace)) = ${marketplaceParam} AND LOWER(TRIM(category)) !~ '^shopsy([[:space:]_-]+)')`);
    } else {
      filters.push(`LOWER(TRIM(marketplace)) = ${marketplaceParam}`);
    }
  }
  if (sellerAccount) {
    params.push(normalizedAccount(sellerAccount));
    filters.push(`COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $${params.length}`);
  }

  const result = await p.query(`
    WITH ranked AS (
      SELECT marketplace, category,
        COALESCE(NULLIF(TRIM(brand_name), ''), NULLIF(TRIM(brand), ''), 'General') AS brand,
        COALESCE(NULLIF(TRIM(seller_account), ''), 'default') AS seller_account,
        UPPER(TRIM(fsn)) AS fsn, sku,
        ROW_NUMBER() OVER (
          PARTITION BY marketplace, category,
            COALESCE(NULLIF(TRIM(brand_name), ''), NULLIF(TRIM(brand), ''), 'General'),
            COALESCE(NULLIF(TRIM(seller_account), ''), 'default')
          ORDER BY CASE WHEN UPPER(TRIM(fsn)) ~ '^[A-Z0-9]{16}$' THEN 0 ELSE 1 END, id DESC
        ) AS rn,
        COUNT(*) OVER (
          PARTITION BY marketplace, category,
            COALESCE(NULLIF(TRIM(brand_name), ''), NULLIF(TRIM(brand), ''), 'General'),
            COALESCE(NULLIF(TRIM(seller_account), ''), 'default')
        ) AS order_count
      FROM orders
      WHERE ${filters.join('\n        AND ')}
    )
    SELECT marketplace, category, brand, seller_account, fsn AS sample_fsn,
      sku AS sample_sku, order_count::int AS order_count
    FROM ranked WHERE rn = 1 AND UPPER(TRIM(fsn)) ~ '^[A-Z0-9]{16}$'
    ORDER BY marketplace, category, seller_account, order_count DESC
  `, params);
  return result.rows;
}

/** Load one consistent, read-only snapshot of active rates and their FSN catalog. */
export async function loadPublishedRateCardSnapshot(pool = null, sellerAccount = 'all') {
  const p = pool || getPool();
  const effectiveDate = resolveRateCardEffectiveDate();
  const accountFilter = normalizedAccount(sellerAccount);
  const client = await p.connect();
  const cards = new Map();

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const samples = await getRealTimeBrandFsnSamples(client, {
      sellerAccount: accountFilter === 'all' ? null : accountFilter,
    });

    for (const [table, field, brandSpecific] of RATE_TABLES) {
      const { rows } = await client.query(`
        SELECT * FROM ${table}
        WHERE marketplace IN ('flipkart', 'shopsy')
          AND ($2 = 'all' OR COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2)
          AND (start_date IS NULL OR start_date <= $1::date)
          AND (end_date IS NULL OR end_date >= $1::date)
        ORDER BY marketplace, category, id
      `, [effectiveDate, accountFilter]);

      for (const row of rows || []) {
        const channel = channelFor(row.marketplace, row.category);
        if (!['flipkart', 'shopsy'].includes(channel)) continue;
        const category = normalizeMarketplaceCategory(row.category, channel);
        const account = normalizedAccount(row.seller_account);
        const rawBrand = String(row.brand_name || '').trim();
        const genericBrand = brandSpecific && isGenericRateBrand(rawBrand);
        const brand = brandSpecific ? (genericBrand ? 'All brands' : rawBrand) : 'General';
        const scopedSamples = (samples || []).filter(item =>
          channelFor(item.marketplace, item.category) === channel &&
          normalizeMarketplaceCategory(item.category, channel) === category &&
          normalizedAccount(item.seller_account) === account
        );
        const sample = genericBrand || !brandSpecific
          ? scopedSamples[0]
          : scopedSamples.find(item => normalized(item.brand || 'General') === normalized(brand));
        if (!sample) continue;
        const orderCount = genericBrand || !brandSpecific
          ? scopedSamples.reduce((total, item) => total + Number(item.order_count || 0), 0)
          : Number(sample.order_count || 0);

        const key = JSON.stringify([channel, account, category, brand]);
        if (!cards.has(key)) {
          cards.set(key, {
            marketplace: channel,
            seller_account: account,
            category,
            brand,
            sample_fsn: sample.sample_fsn,
            sample_sku: sample.sample_sku,
            order_count: orderCount,
            source: 'published_database',
            effectiveDate,
            commissions: [], fixedFees: [], collectionFees: [], pickPackFees: [],
            reverseShipping: [], franchiseFees: [],
          });
        }
        const slab = { ...row };
        for (const fieldName of NUMERIC_FIELDS) {
          if (slab[fieldName] !== undefined && slab[fieldName] !== null) slab[fieldName] = Number(slab[fieldName]);
        }
        cards.get(key)[field].push(slab);
      }
    }

    await client.query('COMMIT');
    return { cards: [...cards.values()], catalog: samples, effectiveDate };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Read active published DB rates, attaching a real order FSN when one exists. */
export async function buildBrandRateCardSet(pool = null, sellerAccount = 'all') {
  const snapshot = await loadPublishedRateCardSnapshot(pool, sellerAccount);
  return snapshot.cards;
}
