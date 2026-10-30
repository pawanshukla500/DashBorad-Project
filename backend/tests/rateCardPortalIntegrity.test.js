import { describe, it, expect, vi } from 'vitest';
import { compareScrapedRatesWithActive } from '../services/rateCardCanonicalEngine.js';
import { publishRateCardObservations } from '../services/rateCardPublisher.js';
import { RATE_TABLES, normalizeObservationRow, validateRateObservations } from '../services/rateCardObservationPlan.js';
import { calculateFees } from '../services/rateCard.js';
import { parsePortalRateSnapshot } from '../../desktop/portalRates.js';
import { normalizeScrapedCards } from '../../desktop/scrapeResults.js';
import { rateFixture } from '../../desktop/tests/fixtures/portalRateFixture.js';

const date = '2026-10-30';
const cards = () => normalizeScrapedCards(['FBF','NON_FBF'].map(fulfilment => parsePortalRateSnapshot(rateFixture(fulfilment),
  { vertical: 'kurta', marketplace: 'flipkart', fulfilment, effectiveDate: date, portalVertical: 'kurta' })));
function database(observations = cards(), { ready = true } = {}) {
  let id = 0;
  const tables = Object.fromEntries(RATE_TABLES.map(d => [d.table, observations.flatMap(o => (o[d.field] || []).map(row =>
    ({ id: ++id, start_date: '2026-10-01', end_date: null, ...normalizeObservationRow(d, row, o) })))]));
  const client = { release: vi.fn(), query: vi.fn(async (sql, params) => {
    if (sql.includes('FROM pg_indexes')) return { rows: ready ? Array.from({length:5}, () => ({})) : [] };
    if (sql.includes('FROM information_schema.columns')) return { rows: ready ? Array.from({length:21}, () => ({})) : [] };
    if (sql.includes('SELECT MIN')) return { rows: [{ next_start: null }] };
    const descriptor = RATE_TABLES.find(d => sql.includes(`FROM ${d.table}`));
    if (sql.includes('SELECT *') && descriptor) return { rows: tables[descriptor.table] };
    if (sql.includes('INSERT INTO rate_card_versions')) return { rows: [{id:1}] };
    return { rows: [] };
  }) };
  return { client, tables, pool: { connect: async () => client } };
}
const compare = (db, observations = cards()) => compareScrapedRatesWithActive(observations, { marketplace:'flipkart',sellerAccount:'default',effectiveDate:date,dbClient:db.client });
const mutations = db => db.client.query.mock.calls.filter(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql));

describe('Portal observations and reviewed publication', () => {
  it('retains exact six-decimal rates, both fixed modes, shipping increments and FBF pick/pack', () => {
    const [card] = cards();
    expect(card.commissions[0].rate).toBeCloseTo(0.123456, 9);
    expect(card.collectionFees[0].prepaid).toBeCloseTo(0.003456, 9);
    expect(card.fixedFees.map(f=>f.fulfilment_type)).toEqual(['FBF','NON_FBF']);
    expect(card.reverseShipping[0].national_additional_fee).toBe(4);
    expect(card.pickPackFees).toHaveLength(1);
    expect(card.portalEvidence).toHaveLength(2);
  });
  it('rejects missing fee families, mixed marketplaces, duplicates and invalid values before writes', () => {
    const complete = cards();
    expect(() => validateRateObservations([{...complete[0],reverseShipping:[]}], {marketplace:'flipkart',complete:true})).toThrow(/Missing reverseShipping/);
    expect(() => validateRateObservations(complete, {marketplace:'shopsy'})).toThrow(/Mixed marketplace/);
    expect(() => validateRateObservations([{...complete[0],marketplace:'shopsy'}], {marketplace:'shopsy',complete:true})).toThrow(/Unexpected nonzero Shopsy/);
    expect(() => validateRateObservations([complete[0],complete[0]], {marketplace:'flipkart'})).toThrow(/Duplicate/);
    expect(() => validateRateObservations([{...complete[0],commissions:[{price_min:0,price_max:500,rate:NaN}]}], {marketplace:'flipkart'})).toThrow(/Invalid/);
    expect(() => validateRateObservations(complete, {marketplace:'flipkart',expectedVerticals:['dress']})).toThrow(/Missing configured category/);
  });
  it('performs zero rate or version writes for unchanged observations, even on the legacy schema', async () => {
    const db = database(cards(), {ready:false});
    const review = await compare(db);
    expect(review.diffCount).toBe(0);
    const result = await publishRateCardObservations(cards(), {pool:db.pool,marketplace:'flipkart',publishedBy:'fixture-reviewer',reviewFingerprint:review.fingerprint});
    expect(result.published).toBe(false);
    expect(mutations(db)).toEqual([]);
  });
  it('rejects duplicate active natural identities instead of silently selecting one', async () => {
    const db = database(); db.tables.rc_commission.push({...db.tables.rc_commission[0],id:900});
    await expect(compare(db)).rejects.toThrow(/Duplicate active/);
  });
  it('detects changes below four decimals and shipping range/increment changes', async () => {
    const db = database(); db.tables.rc_commission[0].rate -= 0.000001;
    db.tables.rc_reverse_shipping[0].national_additional_fee += 1;
    const review = await compare(db);
    expect(review.diffCount).toBe(2);
    expect(review.diffs.map(d=>d.table)).toContain('rc_reverse_shipping');
  });
  it('rejects stale approval and missing dimensional migrations without any rate writes', async () => {
    const db = database(cards(), {ready:false});
    const review = await compare(db);
    db.tables.rc_commission[0].rate = 0.25;
    await expect(publishRateCardObservations(cards(), {pool:db.pool,publishedBy:'fixture',reviewFingerprint:review.fingerprint})).rejects.toThrow(/REVIEW_STALE/);
    const fresh = await compare(db);
    await expect(publishRateCardObservations(cards(), {pool:db.pool,publishedBy:'fixture',reviewFingerprint:fresh.fingerprint})).rejects.toThrow(/RATE_SCHEMA_NOT_READY/);
    expect(mutations(db)).toEqual([]);
  });
  it('closes and replaces only the genuinely changed row, preserving unchanged slabs and tables', async () => {
    const db = database(); db.tables.rc_commission[0].rate = 0.25;
    const review = await compare(db);
    const result = await publishRateCardObservations(cards(), {pool:db.pool,publishedBy:'fixture',reviewFingerprint:review.fingerprint});
    expect(result.published).toBe(true);
    const writes = mutations(db);
    expect(writes.filter(([sql])=>sql.startsWith('UPDATE rc_commission'))).toHaveLength(1);
    expect(writes.filter(([sql])=>sql.startsWith('INSERT INTO rc_commission'))).toHaveLength(1);
    expect(writes.some(([sql])=>/rc_fixed_fee|rc_reverse_shipping|rc_pick_pack/.test(sql))).toBe(false);
    expect(writes.find(([sql])=>sql.startsWith('UPDATE'))[1]).toEqual(['2026-10-29',db.tables.rc_commission[0].id]);
  });
  it('updates a changed same-day row by id without invalid date closure or duplicate insert', async () => {
    const db=database(); db.tables.rc_commission[0].start_date=date; db.tables.rc_commission[0].rate=0.25;
    const review=await compare(db);
    await publishRateCardObservations(cards(),{pool:db.pool,publishedBy:'fixture',reviewFingerprint:review.fingerprint});
    expect(mutations(db).some(([sql])=>sql.startsWith('INSERT INTO rc_commission'))).toBe(false);
    expect(mutations(db).find(([sql])=>sql.startsWith('UPDATE rc_commission'))[0]).not.toContain('end_date');
  });
  it('calculates incremental reverse and FBF pick/pack fees at exact and fractional weights', () => {
    const rc={commission:[],fixedFee:[],collectionFee:[],franchiseFee:[],pickAndPack:[{category:'kurta',fulfilmentType:'FBF',priceMin:0,priceMax:999999,weightMin:0,weightMax:50000,rate:14,local:14,zonal:14,national:14,baseWeight:1,incrementWeight:1,localAdditional:5,zonalAdditional:5,nationalAdditional:5}],reverseShipping:[{category:'kurta',priceMin:0,priceMax:500,weightSlab:'2kg-3kg',weightMin:2,weightMax:3,local:30,zonal:40,national:50,baseWeight:2,incrementWeight:0.5,localAdditional:4,zonalAdditional:5,nationalAdditional:6}]};
    const fees=calculateFees(rc,{category:'kurta',price:300,fulfilmentType:'FBF',weight:2.1,zone:'local',isReturn:true,orderDate:date});
    expect(fees.pickPack).toBe(24);
    expect(fees.reverseShipping).toBe(34);
  });
  it('deduplicates identical category-wide fees across brands while preserving distinct commission slabs', async () => {
    const a={...cards()[0],brand:'Sangria'}, b={...structuredClone(cards()[0]),brand:'Youthnic'};
    b.commissions[0].rate=0.15;
    expect(()=>validateRateObservations([a,b],{marketplace:'flipkart',complete:true})).not.toThrow();
    const db=database([]);const review=await compare(db,[a,b]);
    expect(review.diffs.filter(d=>d.table==='rc_commission')).toHaveLength(2);
    expect(review.diffs.filter(d=>d.table==='rc_fixed_fee')).toHaveLength(2);
    b.fixedFees[0].rate+=1;
    expect(()=>validateRateObservations([a,b],{marketplace:'flipkart'})).toThrow(/conflicting/);
  });
  it('invalidates approval when only a shipping incremental component changes', async () => {
    const db=database();db.tables.rc_reverse_shipping[0].national_additional_fee+=1;
    const review=await compare(db);db.tables.rc_reverse_shipping[0].national_additional_fee+=1;
    await expect(publishRateCardObservations(cards(),{pool:db.pool,publishedBy:'fixture',reviewFingerprint:review.fingerprint})).rejects.toThrow(/REVIEW_STALE/);
    expect(mutations(db)).toEqual([]);
  });

  it('compares PostgreSQL NUMERIC weight strings with portal numbers without false replacement', async () => {
    const db=database();
    for(const table of ['rc_reverse_shipping','rc_pick_pack'])for(const row of db.tables[table])for(const key of Object.keys(row))if(typeof row[key]==='number'&&key!=='id')row[key]=row[key].toFixed(3);
    expect((await compare(db)).diffCount).toBe(0);
  });

  it('preserves portal pick/pack all-price scope without imposing an invented price ceiling', () => {
    expect(cards()[0].pickPackFees[0].price_scope).toBe('all');
    const rc={commission:[],fixedFee:[],collectionFee:[],franchiseFee:[],reverseShipping:[],pickAndPack:[{category:'kurta',fulfilmentType:'FBF',priceMin:0,priceMax:999999,allPrices:true,rate:14}]};
    expect(calculateFees(rc,{category:'kurta',price:2000000,fulfilmentType:'FBF',orderDate:date}).pickPack).toBe(14);
  });

  it('matches brand case aliases without writes and rejects duplicate effective brand identities', async () => {
    const observed=[{...cards()[0],brand:'Here&Now'}];
    const db=database([{...cards()[0],brand:'HERE&NOW'}]);
    expect((await compare(db,observed)).diffCount).toBe(0);
    db.tables.rc_commission.push({...db.tables.rc_commission[0],id:999,brand_name:'here&now'});
    await expect(compare(db,observed)).rejects.toThrow(/Duplicate active/);
  });

});
