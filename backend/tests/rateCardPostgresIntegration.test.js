import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { publishRateCardObservations } from '../services/rateCardPublisher.js';
import { compareScrapedRatesWithActive } from '../services/rateCardCanonicalEngine.js';
import { parsePortalRateSnapshot } from '../../desktop/portalRates.js';
import { normalizeScrapedCards } from '../../desktop/scrapeResults.js';
import { rateFixture } from '../../desktop/tests/fixtures/portalRateFixture.js';

const url = process.env.RATECARD_TEST_DATABASE_URL;
describe.skipIf(!url)('Real PostgreSQL isolated rate-card migration and publication', () => {
  let pool, scoped, schema;
  const cards = () => normalizeScrapedCards(['FBF','NON_FBF'].map(fulfilment => parsePortalRateSnapshot(rateFixture(fulfilment),
    {vertical:'kurta',marketplace:'flipkart',fulfilment,effectiveDate:'2026-10-30',portalVertical:'kurta'})));
  beforeAll(async () => {
    const target = new URL(url);
    if (!['localhost','127.0.0.1'].includes(target.hostname) || target.pathname !== '/ratecard_fixture') throw new Error('Integration tests require an isolated loopback ratecard_fixture database.');
    pool = new Pool({connectionString:url});schema=`ratecard_${randomUUID().replaceAll('-','')}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    scoped = {connect:async()=>{const client=await pool.connect();await client.query(`SET search_path TO ${schema}`);return client;}};
    const client=await scoped.connect();
    try {
      for (const [table,extra] of [
        ['rc_commission','brand_name TEXT, rate NUMERIC(8,6)'],
        ['rc_fixed_fee','fulfilment_type TEXT, rate NUMERIC(12,2)'],
        ['rc_collection_fee',"fulfilment_type TEXT, prepaid NUMERIC(12,6), postpaid NUMERIC(12,6), prepaid_type TEXT, postpaid_type TEXT"],
        ['rc_reverse_shipping','weight_slab TEXT, local_fee NUMERIC(12,2), zonal_fee NUMERIC(12,2), national_fee NUMERIC(12,2)'],
        ['rc_pick_pack','fulfilment_type TEXT, rate NUMERIC(12,2)']
      ]) await client.query(`CREATE TABLE ${table}(id SERIAL PRIMARY KEY,marketplace TEXT,seller_account TEXT,category TEXT,start_date DATE,end_date DATE,price_min NUMERIC(12,2),price_max NUMERIC(12,2),updated_at TIMESTAMPTZ DEFAULT now(),${extra})`);
      await client.query('CREATE TABLE rate_card_versions(id SERIAL PRIMARY KEY,marketplace TEXT,seller_account TEXT,version_name TEXT,status TEXT,effective_from DATE,snapshot JSONB,created_at TIMESTAMPTZ,published_at TIMESTAMPTZ)');
      await client.query(fs.readFileSync(new URL('../db/migrations/2026-10-30-ratecard-portal-dimensions.sql',import.meta.url),'utf8'));
    } finally {client.release();}
  });
  afterAll(async()=>{if(pool){if(schema)await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();}});

  it('publishes full dimensions, blocks duplicate rows, preserves unchanged rows and is a zero-write replay',async()=>{
    const observations=cards();
    const client=await scoped.connect();
    try {
      let review=await compareScrapedRatesWithActive(observations,{dbClient:client});
      await publishRateCardObservations(observations,{pool:scoped,publishedBy:'integration-fixture',reviewFingerprint:review.fingerprint});
      const fixedBefore=(await client.query('SELECT * FROM rc_fixed_fee ORDER BY id')).rows;
      const shipping=(await client.query('SELECT national_additional_fee,weight_min,weight_max FROM rc_reverse_shipping')).rows[0];
      expect(Number(shipping.national_additional_fee)).toBe(4);
      expect((await client.query('SELECT * FROM rc_pick_pack')).rows).toHaveLength(1);
      await expect(client.query("INSERT INTO rc_commission(marketplace,seller_account,category,start_date,price_min,price_max,rate) SELECT marketplace,seller_account,category,start_date,price_min,price_max,rate FROM rc_commission LIMIT 1")).rejects.toThrow(/duplicate key/);
      observations[0].commissions[0].rate=0.15;
      review=await compareScrapedRatesWithActive(observations,{dbClient:client});
      await publishRateCardObservations(observations,{pool:scoped,publishedBy:'integration-fixture',reviewFingerprint:review.fingerprint});
      expect((await client.query('SELECT * FROM rc_fixed_fee ORDER BY id')).rows).toEqual(fixedBefore);
      expect((await client.query('SELECT * FROM rc_commission')).rows).toHaveLength(1);
      review=await compareScrapedRatesWithActive(observations,{dbClient:client});
      const before=(await client.query('SELECT COUNT(*)::int AS n FROM rate_card_versions')).rows[0].n;
      expect((await publishRateCardObservations(observations,{pool:scoped,publishedBy:'integration-fixture',reviewFingerprint:review.fingerprint})).published).toBe(false);
      expect((await client.query('SELECT COUNT(*)::int AS n FROM rate_card_versions')).rows[0].n).toBe(before);
    } finally {client.release();}
  });
});
