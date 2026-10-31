import { getPool } from '../db/index.js';
import { planRateCardChanges } from './rateCardObservationPlan.js';

export const roundCurrency = value => Number(Number(value).toFixed(2));
export const roundRate = value => Number(Number(value).toFixed(6));

export async function compareScrapedRatesWithActive(observations, options = {}) {
  const { marketplace = 'flipkart', sellerAccount = 'default',
    effectiveDate = observations?.[0]?.effectiveDate || new Date().toISOString().slice(0, 10), dbClient = null } = options;
  const client = dbClient || await getPool().connect();
  try { return await planRateCardChanges(client, observations, { marketplace, sellerAccount, effectiveDate }); }
  finally { if (!dbClient) client.release(); }
}
