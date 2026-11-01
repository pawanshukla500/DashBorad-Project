import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { publishRateCardObservations } from '../services/rateCardPublisher.js';
import { compareScrapedRatesWithActive } from '../services/rateCardCanonicalEngine.js';
import { RATE_TABLES, normalizeObservationRow } from '../services/rateCardObservationPlan.js';
import { getRealTimeBrandFsnSamples } from '../services/brandRateCardService.js';
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
      await client.query('CREATE TABLE orders(id SERIAL PRIMARY KEY,marketplace TEXT,seller_account TEXT,category TEXT,brand_name TEXT,brand TEXT,fsn TEXT,sku TEXT)');
      await client.query(fs.readFileSync(new URL('../db/migrations/2026-10-30-ratecard-portal-dimensions.sql',import.meta.url),'utf8'));
    } finally {client.release();}
  });
  afterAll(async()=>{if(pool){if(schema)await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();}});

  it('counts all matching orders while returning only a valid FSN sample', async () => {
    const client = await scoped.connect();
    try {
      await client.query(`INSERT INTO orders(marketplace,seller_account,category,brand_name,fsn,sku) VALUES
        ('flipkart','default','Women Kurtas','Youthnic','ABCDEFGHIJKLMNOP','SKU-VALID'),
        ('flipkart','default','Women Kurtas','Youthnic',NULL,'SKU-NULL-FSN'),
        ('flipkart','default','Women Kurtas','Youthnic','short','SKU-MALFORMED-FSN')`);

      const samples = await getRealTimeBrandFsnSamples(client, { marketplace: 'flipkart', sellerAccount: 'default' });

      expect(samples).toHaveLength(1);
      expect(samples[0]).toMatchObject({
        marketplace: 'flipkart', category: 'Women Kurtas', brand: 'Youthnic',
        seller_account: 'default', sample_fsn: 'ABCDEFGHIJKLMNOP',
        sample_sku: 'SKU-VALID', order_count: 3,
      });
    } finally { client.release(); }
  });

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
      await client.query("INSERT INTO rc_commission(marketplace,seller_account,category,brand_name,start_date,price_min,price_max,rate) SELECT marketplace,seller_account,'case_fixture','Here&Now',start_date,price_min,price_max,rate FROM rc_commission LIMIT 1");
      await expect(client.query("INSERT INTO rc_commission(marketplace,seller_account,category,brand_name,start_date,price_min,price_max,rate) SELECT marketplace,seller_account,'case_fixture','HERE&NOW',start_date,price_min,price_max,rate FROM rc_commission WHERE category='case_fixture' LIMIT 1")).rejects.toThrow(/duplicate key/);
      await client.query("DELETE FROM rc_commission WHERE category='case_fixture'");
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
  it('ends the inserted period before a future record with a different brand case',async()=>{
    const observations=cards().map(card=>({...card,category:'future_case',brand:'Here&Now'}));
    const client=await scoped.connect();
    try {
      await client.query("INSERT INTO rc_commission(marketplace,seller_account,category,brand_name,start_date,price_min,price_max,rate) VALUES ('flipkart','default','future_case','HERE&NOW','2026-12-01',0,10000000,0.2)");
      const review=await compareScrapedRatesWithActive(observations,{dbClient:client});
      await publishRateCardObservations(observations,{pool:scoped,publishedBy:'integration-fixture',reviewFingerprint:review.fingerprint});
      const result=await client.query("SELECT TO_CHAR(end_date,'YYYY-MM-DD') AS end_date FROM rc_commission WHERE category='future_case' AND start_date='2026-10-30'");
      expect(result.rows[0].end_date).toBe('2026-11-30');
    } finally {client.release();}
  });

  it('bounds a modified same-day row before a scheduled future period in PostgreSQL', async () => {
    const observations = cards().map(card => ({ ...card, vertical: 'same_day_future', category: 'same_day_future' }));
    const client = await scoped.connect();
    try {
      for (const observation of observations) for (const descriptor of RATE_TABLES) {
        for (const source of observation[descriptor.field] || []) {
          const row = normalizeObservationRow(descriptor, source, observation);
          if (descriptor.table === 'rc_commission') row.rate = 0.2;
          const columns = ['marketplace', 'seller_account', 'category', 'start_date', 'end_date', ...descriptor.keys, ...descriptor.values];
          const values = ['flipkart', 'default', row.category, '2026-10-30', null,
            ...descriptor.keys.map(key => row[key]), ...descriptor.values.map(key => row[key])];
          await client.query(`INSERT INTO ${descriptor.table} (${columns.join(',')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(',')})`, values);
        }
      }
      const commission = normalizeObservationRow(RATE_TABLES.find(item => item.table === 'rc_commission'),
        observations[0].commissions[0], observations[0]);
      const descriptor = RATE_TABLES.find(item => item.table === 'rc_commission');
      const futureValues = ['flipkart', 'default', commission.category, '2026-12-01', null,
        ...descriptor.keys.map(key => commission[key]), 0.18];
      const futureColumns = ['marketplace', 'seller_account', 'category', 'start_date', 'end_date', ...descriptor.keys, 'rate'];
      await client.query(`INSERT INTO rc_commission (${futureColumns.join(',')}) VALUES (${futureValues.map((_, i) => `$${i + 1}`).join(',')})`, futureValues);

      observations[0].commissions[0].rate = 0.15;
      const review = await compareScrapedRatesWithActive(observations, {
        marketplace: 'flipkart', sellerAccount: 'default', effectiveDate: '2026-10-30', dbClient: client,
      });
      expect(review.diffCount).toBe(1);
      await publishRateCardObservations(observations, {
        pool: scoped, marketplace: 'flipkart', sellerAccount: 'default', effectiveDate: '2026-10-30',
        publishedBy: 'integration-fixture', reviewFingerprint: review.fingerprint,
      });

      const periods = await client.query(`SELECT TO_CHAR(start_date,'YYYY-MM-DD') AS start_date,
          TO_CHAR(end_date,'YYYY-MM-DD') AS end_date, rate FROM rc_commission
        WHERE category = 'same_day_future' ORDER BY start_date`);
      expect(periods.rows).toHaveLength(2);
      expect(periods.rows[0]).toMatchObject({ start_date: '2026-10-30', end_date: '2026-11-30', rate: '0.150000' });
      expect(periods.rows[1]).toMatchObject({ start_date: '2026-12-01', end_date: null, rate: '0.180000' });
    } finally { client.release(); }
  });

  it('preserves the configured end date and gap before a later scheduled period in PostgreSQL', async () => {
    const observations = cards().map(card => ({ ...card, vertical: 'intentional_gap', category: 'intentional_gap' }));
    const client = await scoped.connect();
    try {
      const descriptor = RATE_TABLES.find(item => item.table === 'rc_commission');
      const commission = normalizeObservationRow(descriptor, observations[0].commissions[0], observations[0]);
      const columns = ['marketplace', 'seller_account', 'category', 'brand_name', 'start_date', 'end_date', 'price_min', 'price_max', 'rate'];
      await client.query(`INSERT INTO rc_commission (${columns.join(',')}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        ['flipkart', 'default', commission.category, commission.brand_name, '2026-10-01', '2026-11-15', commission.price_min, commission.price_max, 0.2]);
      await client.query(`INSERT INTO rc_commission (${columns.join(',')}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        ['flipkart', 'default', commission.category, commission.brand_name, '2026-12-01', null, commission.price_min, commission.price_max, 0.18]);

      const review = await compareScrapedRatesWithActive(observations, {
        marketplace: 'flipkart', sellerAccount: 'default', effectiveDate: '2026-10-30', dbClient: client,
      });
      await publishRateCardObservations(observations, {
        pool: scoped, marketplace: 'flipkart', sellerAccount: 'default', effectiveDate: '2026-10-30',
        publishedBy: 'integration-fixture', reviewFingerprint: review.fingerprint,
      });

      const periods = await client.query(`SELECT TO_CHAR(start_date,'YYYY-MM-DD') AS start_date,
          TO_CHAR(end_date,'YYYY-MM-DD') AS end_date, rate FROM rc_commission
        WHERE category = 'intentional_gap' ORDER BY start_date`);
      expect(periods.rows).toHaveLength(3);
      expect(periods.rows.map(row => [row.start_date, row.end_date])).toEqual([
        ['2026-10-01', '2026-10-29'],
        ['2026-10-30', '2026-11-15'],
        ['2026-12-01', null],
      ]);
    } finally { client.release(); }
  });

  it('compares NULL and blank legacy account rows as default without inserting duplicates',async()=>{
    const observations = ['legacy_null', 'legacy_blank'].flatMap((category, index) =>
      cards().map(card => ({ ...card, vertical: category, category })));
    const client = await scoped.connect();
    try {
      for (const observation of observations) for (const descriptor of RATE_TABLES) {
        for (const source of observation[descriptor.field] || []) {
          const row = normalizeObservationRow(descriptor, source, observation);
          const columns = ['marketplace','seller_account','category','start_date','end_date',...descriptor.keys,...descriptor.values];
          const values = ['flipkart', observation.vertical === 'legacy_null' ? null : '  ', row.category,
            '2026-10-01', null, ...descriptor.keys.map(key => row[key]), ...descriptor.values.map(key => row[key])];
          await client.query(`INSERT INTO ${descriptor.table} (${columns.join(',')}) VALUES (${values.map((_,i)=>`$${i+1}`).join(',')})`, values);
        }
      }
      const review = await compareScrapedRatesWithActive(observations, { marketplace: 'flipkart', sellerAccount: 'default', dbClient: client });
      expect(review.diffCount).toBe(0);
      expect(review.summary.unchanged).toBeGreaterThan(0);
      const result = await publishRateCardObservations(observations, { pool: scoped, marketplace: 'flipkart', sellerAccount: 'default', publishedBy: 'integration-fixture', reviewFingerprint: review.fingerprint });
      expect(result.published).toBe(false);
      expect((await client.query("SELECT COUNT(*)::int AS count FROM rc_commission WHERE category IN ('legacy_null','legacy_blank')")).rows[0].count).toBe(2);
    } finally { client.release(); }
  });

});
