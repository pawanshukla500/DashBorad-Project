import { describe, it, expect, vi } from 'vitest';
import { compareScrapedRatesWithActive } from '../services/rateCardCanonicalEngine.js';
import { publishRateCardObservations } from '../services/rateCardPublisher.js';
import { RATE_TABLES, normalizeObservationRow, validateRateObservations } from '../services/rateCardObservationPlan.js';
import { calculateFees, normalizeCategory, normalizeMarketplaceCategory } from '../services/rateCard.js';
import { assertRateObservationCoverage, loadRateCardCoverage, RATE_CARD_CONFIG_TABLES } from '../services/rateCardCoverage.js';
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
const compare = (db, observations = cards(), effectiveDate = date, marketplace = 'flipkart') => compareScrapedRatesWithActive(observations, { marketplace,sellerAccount:'default',effectiveDate,dbClient:db.client });
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
  it('rejects missing mode evidence and missing FBF pick-and-pack evidence before publication', () => {
    const [complete] = cards();
    expect(() => validateRateObservations([{...complete,portalEvidence:[]}], {marketplace:'flipkart',complete:true}))
      .toThrow(/Missing FBF Seller Hub response evidence/);
    const withoutFbf = structuredClone(complete);
    withoutFbf.portalEvidence = withoutFbf.portalEvidence.filter(item => item.fulfilment !== 'FBF');
    expect(() => validateRateObservations([withoutFbf], {marketplace:'flipkart',complete:true}))
      .toThrow(/Missing FBF Seller Hub response evidence/);
    const withoutPickEvidence = structuredClone(complete);
    withoutPickEvidence.portalEvidence.find(item => item.fulfilment === 'FBF').fees.pickAndPackFee.slabs.shippingSlab = [];
    expect(() => validateRateObservations([withoutPickEvidence], {marketplace:'flipkart',complete:true}))
      .toThrow(/Missing FBF pick-and-pack response evidence/);
    expect(() => validateRateObservations([{...complete,pickPackFees:[]}], {marketplace:'flipkart',complete:true}))
      .toThrow(/Missing pickPackFees/);
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
  it('reports removed slabs separately from modified rates in review summaries', async () => {
    const db = database();
    db.tables.rc_commission.push({...db.tables.rc_commission[0],id:900,price_min:2000,price_max:2500});
    const changed = cards();
    changed[0].commissions[0].rate += 0.01;
    const review = await compare(db, changed);
    expect(review.summary.modified).toBe(1);
    expect(review.summary.removed).toBe(1);
    expect(review.summary.added).toBe(0);
  });
  it('closes a replaced active price slab and inserts only the newly observed ranges', async () => {
    const db = database();
    const changed = cards();
    const oldId = db.tables.rc_commission[0].id;
    const original = changed[0].commissions[0];
    changed[0].commissions = [
      { ...original, price_max: 4999999 },
      { ...original, price_min: 5000000 },
    ];

    const review = await compare(db, changed);
    const commissionDiffs = review.diffs.filter(diff => diff.table === 'rc_commission');
    expect(commissionDiffs.filter(diff => diff.changeType === 'REMOVED')).toHaveLength(1);
    expect(commissionDiffs.filter(diff => diff.changeType === 'ADDED')).toHaveLength(2);

    await publishRateCardObservations(changed, {
      pool: db.pool, publishedBy: 'fixture-reviewer', effectiveDate: date, reviewFingerprint: review.fingerprint,
    });

    const writes = mutations(db);
    const oldSlabClose = writes.find(([sql, params]) => sql.startsWith('UPDATE rc_commission') && params.at(-1) === oldId);
    expect(oldSlabClose).toBeDefined();
    expect(oldSlabClose[1]).toEqual(['2026-10-29', oldId]);
    const insertedSlabs = writes.filter(([sql]) => sql.startsWith('INSERT INTO rc_commission'));
    expect(insertedSlabs).toHaveLength(2);
    expect(insertedSlabs.map(([, params]) => params.slice(6, 8))).toEqual([[0, 4999999], [5000000, 10000000]]);
    expect(writes.some(([sql]) => /rc_fixed_fee|rc_collection_fee|rc_reverse_shipping|rc_pick_pack/.test(sql))).toBe(false);
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
  it('binds reviewed rate differences to the effective extraction date', async () => {
    const db=database();
    const changed=cards();
    changed[0].commissions[0].rate += 0.01;
    const sameDay=await compare(db,changed,'2026-10-30');
    const nextDay=await compare(db,changed,'2026-10-31');
    expect(nextDay.diffs).toEqual(sameDay.diffs);
    expect(nextDay.fingerprint).not.toBe(sameDay.fingerprint);
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
    expect(mutations(db).find(([sql])=>sql.startsWith('UPDATE rc_commission'))[0]).toContain('end_date = $2');
    expect(mutations(db).find(([sql])=>sql.startsWith('UPDATE rc_commission'))[1][1]).toBeNull();
  });

  it('bounds a changed same-day row before an existing future period', async () => {
    const db = database();
    db.tables.rc_commission[0].start_date = date;
    db.tables.rc_commission[0].rate = 0.25;
    const future = { ...db.tables.rc_commission[0], id: 901, start_date: '2026-12-01', end_date: null, rate: 0.18 };
    const originalQuery = db.client.query.getMockImplementation();
    db.client.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('start_date > $3') && String(sql).includes('FROM rc_commission')) return { rows: [future] };
      return originalQuery(sql, params);
    });

    const review = await compare(db);
    await publishRateCardObservations(cards(), {
      pool: db.pool, publishedBy: 'fixture', effectiveDate: date, reviewFingerprint: review.fingerprint,
    });

    const futureRead = db.client.query.mock.calls.find(([sql]) => String(sql).includes('start_date > $3') && String(sql).includes('FROM rc_commission'));
    expect(futureRead[1]).toEqual(['flipkart', 'default', date]);
    const update = mutations(db).find(([sql]) => sql.startsWith('UPDATE rc_commission'));
    expect(update[0]).toContain('end_date = $2');
    expect(update[1].slice(0, 2)).toEqual([db.tables.rc_commission[0].id, '2026-11-30']);
  });

  it('preserves an intentional gap when a replacement row ends before the next scheduled period', async () => {
    const db = database();
    db.tables.rc_commission[0].rate = 0.25;
    db.tables.rc_commission[0].end_date = '2026-11-15';
    const future = { ...db.tables.rc_commission[0], id: 903, start_date: '2026-12-01', end_date: null, rate: 0.18 };
    const originalQuery = db.client.query.getMockImplementation();
    db.client.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('start_date > $3') && String(sql).includes('FROM rc_commission')) return { rows: [future] };
      return originalQuery(sql, params);
    });

    const review = await compare(db);
    await publishRateCardObservations(cards(), {
      pool: db.pool, publishedBy: 'fixture', effectiveDate: date, reviewFingerprint: review.fingerprint,
    });

    const insert = mutations(db).find(([sql]) => sql.startsWith('INSERT INTO rc_commission'));
    expect(insert[1][3]).toBe('2026-11-15');
  });

  it('matches future commission periods by identity without validating another slab rate', async () => {
    const db = database();
    db.tables.rc_commission[0].rate = 0.25;
    const active = db.tables.rc_commission[0];
    const otherSlab = { ...active, id: 904, start_date: '2026-11-15', price_min: Number(active.price_max) + 1,
      price_max: Number(active.price_max) + 500, rate: 14 };
    const matchingSlab = { ...active, id: 905, start_date: '2026-12-01', end_date: null, rate: 0.18 };
    const originalQuery = db.client.query.getMockImplementation();
    db.client.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('start_date > $3') && String(sql).includes('FROM rc_commission')) {
        return { rows: [otherSlab, matchingSlab] };
      }
      return originalQuery(sql, params);
    });

    const review = await compare(db);
    const commissionChange = review.diffs.find(diff => diff.table === 'rc_commission');
    expect(commissionChange.nextPeriodStart).toBe('2026-12-01');
  });

  it('loads future periods once per changed table per review and publication pass', async () => {
    const first = cards()[0];
    const second = { ...structuredClone(first), brand: 'Sangria' };
    const observations = [first, second];
    const db = database([]);
    const review = await compare(db, observations);
    const reviewFutureReads = db.client.query.mock.calls.filter(([sql]) => String(sql).includes('start_date > $3'));
    expect(reviewFutureReads).toHaveLength(RATE_TABLES.length);

    await publishRateCardObservations(observations, {
      pool: db.pool, publishedBy: 'fixture', effectiveDate: date, reviewFingerprint: review.fingerprint,
    });

    const futureReads = db.client.query.mock.calls.filter(([sql]) => String(sql).includes('start_date > $3'));
    const futureTables = futureReads.map(([sql]) => RATE_TABLES.find(item => String(sql).includes(`FROM ${item.table}`))?.table);
    expect(futureReads).toHaveLength(RATE_TABLES.length * 2);
    expect(new Set(futureTables.slice(0, RATE_TABLES.length)).size).toBe(RATE_TABLES.length);
    expect(new Set(futureTables.slice(RATE_TABLES.length)).size).toBe(RATE_TABLES.length);
  });

  it('invalidates review when the matching future period boundary changes', async () => {
    const db = database();
    db.tables.rc_commission[0].rate = 0.25;
    let future = { ...db.tables.rc_commission[0], id: 902, start_date: '2026-12-01', end_date: null, rate: 0.18 };
    const originalQuery = db.client.query.getMockImplementation();
    db.client.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('start_date > $3') && String(sql).includes('FROM rc_commission')) return { rows: [future] };
      return originalQuery(sql, params);
    });

    const review = await compare(db);
    expect(review.diffs.find(diff => diff.table === 'rc_commission').nextPeriodStart).toBe('2026-12-01');
    future = { ...future, start_date: '2026-12-15' };

    await expect(publishRateCardObservations(cards(), {
      pool: db.pool, publishedBy: 'fixture', effectiveDate: date, reviewFingerprint: review.fingerprint,
    })).rejects.toThrow(/REVIEW_STALE/);
    expect(mutations(db)).toEqual([]);
  });

  it('does not normalize malformed future commission rows for a different brand', async () => {
    const db = database();
    db.tables.rc_commission[0].rate = 0.25;
    const malformedOtherBrand = {
      ...db.tables.rc_commission[0], id: 904, brand_name: 'Other Brand',
      start_date: '2026-12-01', end_date: null, price_min: null, rate: 'not-a-rate',
    };
    const originalQuery = db.client.query.getMockImplementation();
    db.client.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('start_date > $3') && String(sql).includes('FROM rc_commission')) return { rows: [malformedOtherBrand] };
      return originalQuery(sql, params);
    });

    const review = await compare(db);
    expect(review.diffs.find(diff => diff.table === 'rc_commission').nextPeriodStart).toBeNull();
  });

  it('rejects observations from another seller account before opening a publish transaction', async () => {
    const db = database();
    const observations = cards();
    observations[0].seller_account = 'seller_ej';

    await expect(publishRateCardObservations(observations, {
      pool: db.pool, marketplace: 'flipkart', sellerAccount: 'default', publishedBy: 'fixture',
      reviewFingerprint: 'a'.repeat(64),
    })).rejects.toThrow(/seller account does not match/i);

    expect(db.client.query).not.toHaveBeenCalled();
  });

  it('closes a changed current row before a future period stored under a legacy category alias', async () => {
    const observed = cards().map(card => ({ ...card, category: 'ethnic_set' }));
    const db = database(observed);
    db.tables.rc_commission[0].rate = 0.25;
    const futureAlias = { ...db.tables.rc_commission[0], id: 900, category: 'ethnic-set',
      start_date: '2026-12-01', end_date: null, rate: 0.18 };
    const originalQuery = db.client.query.getMockImplementation();
    db.client.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('start_date > $3') && String(sql).includes('FROM rc_commission')) return { rows: [futureAlias] };
      return originalQuery(sql, params);
    });
    const review = await compare(db, observed);
    await publishRateCardObservations(observed, { pool: db.pool, marketplace: 'flipkart', publishedBy: 'fixture',
      effectiveDate: date, reviewFingerprint: review.fingerprint });
    const futureQuery = db.client.query.mock.calls.find(([sql]) => String(sql).includes('start_date > $3') && String(sql).includes('FROM rc_commission'));
    expect(futureQuery[1]).toEqual(['flipkart', 'default', date]);
    expect(normalizeMarketplaceCategory(futureAlias.category, 'flipkart')).toBe('ethnic_set');
    const insert = mutations(db).find(([sql]) => sql.startsWith('INSERT INTO rc_commission'));
    expect(insert[1][3]).toBe('2026-11-30');
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

  it('ignores malformed legacy rows outside the category and brand scopes being reviewed', async () => {
    const db=database();
    db.tables.rc_fixed_fee.push({id:999,category:'unrelated_category',marketplace:'flipkart',seller_account:'default',
      fulfilment_type:'FBF',price_min:0,price_max:null,rate:12,start_date:'2026-10-01',end_date:null});
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

  it('normalizes gram reverse-shipping labels and matches the same legacy slab', async () => {
    const descriptor = RATE_TABLES.find(item => item.table === 'rc_reverse_shipping');
    const normalized = normalizeObservationRow(descriptor, {
      category: 'kurta',
      weight_slab: '0-500 gm', price_min: 0, price_max: 1000,
      local_fee: 10, zonal_fee: 20, national_fee: 30
    });
    expect(normalized.weight_min).toBe(0);
    expect(normalized.weight_max).toBe(0.5);
    expect(normalized.weight_slab).toBe('0kg-0.5kg');

    const db = database();
    db.tables.rc_reverse_shipping[0].weight_slab = '0-500 gm';
    db.tables.rc_reverse_shipping[0].weight_min = null;
    db.tables.rc_reverse_shipping[0].weight_max = null;
    const observed = cards();
    observed[0].reverseShipping[0].weight_slab = '0-500 gm';
    expect((await compare(db, observed)).diffs.filter(diff => diff.table === 'rc_reverse_shipping')).toHaveLength(0);
  });

  it('matches legacy category casing without adding duplicate active rows', async () => {
    const db = database();
    for (const rows of Object.values(db.tables)) for (const row of rows) row.category = 'Kurta';
    expect((await compare(db)).diffCount).toBe(0);
  });

  it('canonicalizes legacy category aliases during active-row comparison', async () => {
    const observed = cards().map(card => ({ ...card, vertical: 'salwar_kurta_dupatta' }));
    const db = database(observed);
    for (const rows of Object.values(db.tables)) for (const row of rows) row.category = 'salwar suit';
    expect((await compare(db, observed)).diffCount).toBe(0);
  });

  it('normalizes Shopsy-prefixed category aliases consistently', () => {
    expect(normalizeCategory('shopsy_saree')).toBe('shopsy_sari');
    expect(normalizeCategory('Shopsy Saree')).toBe('shopsy_sari');
    expect(normalizeMarketplaceCategory('saree', 'shopsy')).toBe('shopsy_sari');
    expect(normalizeMarketplaceCategory('shopsy_kurta set', 'shopsy')).toBe('shopsy_salwar_kurta_dupatta');
    const rc = { commission: [{ category: 'shopsy_sari', brandName: null, startDate: '2026-01-01', priceMin: 0, priceMax: 1000, rate: 0 }],
      fixedFee: [], collectionFee: [], franchiseFee: [], pickAndPack: [], reverseShipping: [] };
    expect(calculateFees(rc, { category: 'shopsy_saree', price: 100, orderDate: date }).category).toBe('shopsy_sari');
    expect(calculateFees(rc, { category: 'shopsy_saree', price: 100, orderDate: date }).commissionRate).toBe(0);
  });

  it('matches Shopsy legacy aliases during rate-card comparison', async () => {
    const observed = cards().map(card => ({ ...card, marketplace: 'shopsy', vertical: 'shopsy_sari' }));
    const db = database(observed);
    for (const rows of Object.values(db.tables)) for (const row of rows) {
      row.category = 'shopsy_saree';
      row.marketplace = 'shopsy';
    }
    expect((await compare(db, observed, date, 'shopsy')).diffCount).toBe(0);
  });

  it('requires server-derived configured categories and account-scoped real FSNs', async () => {
    const rowsByTable = Object.fromEntries(RATE_CARD_CONFIG_TABLES.map(table => [table, [{ category: 'Kurta' }]]));
    const queries = [];
    const client = { query: vi.fn(async (sql, params) => {
      queries.push({ sql: String(sql), params });
      const configTable = RATE_CARD_CONFIG_TABLES.find(table => String(sql).includes(`FROM ${table}`));
      if (configTable) return { rows: rowsByTable[configTable] };
      if (String(sql).includes('FROM orders')) return { rows: [{ category: 'Kurta', order_rows: 1, valid_fsn_order_rows: 1 }] };
      throw new Error(`Unexpected query: ${sql}`);
    }) };
    const coverage = await loadRateCardCoverage(client, { marketplace: 'flipkart', sellerAccount: 'seller_ej', effectiveDate: date });
    expect(coverage.configuredCategories).toEqual(['kurta']);
    expect(coverage.missingFsnCategories).toEqual([]);
    expect(queries).toHaveLength(7);
    expect(queries.every(query => query.params?.[1] === 'seller_ej')).toBe(true);
    expect(queries.filter(query => !query.sql.includes('FROM orders')).every(query => query.params?.[2] === date)).toBe(true);
    expect(queries.every(query => query.sql.includes("COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2"))).toBe(true);
    expect(queries.filter(query => !query.sql.includes('FROM orders')).every(query =>
      query.sql.includes('start_date <= $3::date') && query.sql.includes('end_date >= $3::date'))).toBe(true);
    expect(queries.filter(query => !query.sql.includes('FROM orders')).every(query =>
      query.sql.includes("$1 <> 'flipkart' OR LOWER(TRIM(category)) !~ '^shopsy([[:space:]_-]+)'"))).toBe(true);
    const catalogRead = queries.find(query => query.sql.includes('FROM orders'));
    expect(catalogRead.sql).toContain('COUNT(*) FILTER (WHERE fsn IS NOT NULL AND UPPER(TRIM(fsn)) ~');
    expect(catalogRead.sql).toContain('GROUP BY category');
    expect(assertRateObservationCoverage(cards(), coverage)).toEqual(['kurta']);
  });

  it('maps legacy Shopsy FSNs stored under Flipkart into the separate Shopsy namespace', async () => {
    const rowsByTable = Object.fromEntries(RATE_CARD_CONFIG_TABLES.map(table => [table, [{ category: 'saree' }]]));
    let catalogQuery = '';
    const client = { query: vi.fn(async sql => {
      const text = String(sql);
      const configTable = RATE_CARD_CONFIG_TABLES.find(table => text.includes(`FROM ${table}`));
      if (configTable) return { rows: rowsByTable[configTable] };
      catalogQuery = text;
      return { rows: [{ marketplace: 'flipkart', category: 'Shopsy Saree', order_rows: 1, valid_fsn_order_rows: 1 }] };
    }) };
    const coverage = await loadRateCardCoverage(client, { marketplace: 'shopsy', sellerAccount: 'seller_ej' });
    expect(coverage.configuredCategories).toEqual(['shopsy_sari']);
    expect(coverage.fsnCategories).toEqual(['shopsy_sari']);
    expect(coverage.missingFsnCategories).toEqual([]);
    expect(catalogQuery).toContain("LOWER(TRIM(marketplace)) = 'flipkart'");
    expect(catalogQuery).toContain("LOWER(TRIM(category)) ~ '^shopsy([[:space:]_-]+)'");
  });

  it('includes NULL and blank legacy rate-card accounts in the default category scope', async () => {
    const queries = [];
    const client = { query: vi.fn(async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes('FROM orders')) return { rows: [{ category: 'Kurta', order_rows: 1, valid_fsn_order_rows: 1 }] };
      return { rows: [{ category: 'Kurta' }] };
    }) };
    const coverage = await loadRateCardCoverage(client, { marketplace: 'flipkart', sellerAccount: 'default' });
    expect(coverage.configuredCategories).toEqual(['kurta']);
    expect(coverage.missingFsnCategories).toEqual([]);
    const configReads = queries.filter(query => !query.sql.includes('FROM orders'));
    expect(configReads).toHaveLength(RATE_CARD_CONFIG_TABLES.length);
    expect(configReads.every(query => query.params[1] === 'default' &&
      query.sql.includes("COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2"))).toBe(true);
  });

  it('includes inherited default categories for named accounts while keeping FSNs account-scoped', async () => {
    const queries = [];
    const client = { query: vi.fn(async (sql, params) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (text.includes('FROM orders')) {
        return { rows: [
          { category: 'Kurta', order_rows: 1, valid_fsn_order_rows: 1 },
          { category: 'Saree', order_rows: 1, valid_fsn_order_rows: 1 },
        ] };
      }
      if (text.includes('FROM rc_commission')) return { rows: [{ category: 'Kurta' }, { category: 'Saree' }] };
      return { rows: [{ category: 'Kurta' }] };
    }) };
    const coverage = await loadRateCardCoverage(client, { marketplace: 'flipkart', sellerAccount: 'seller_ej' });
    expect(coverage.configuredCategories).toEqual(['kurta', 'sari']);
    expect(coverage.missingFsnCategories).toEqual([]);
    const configReads = queries.filter(query => !query.sql.includes('FROM orders'));
    expect(configReads.every(query => query.sql.includes("COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2 OR COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = 'default"))).toBe(true);
    const catalogRead = queries.find(query => query.sql.includes('FROM orders'));
    expect(catalogRead.params).toEqual(['flipkart', 'seller_ej']);
    expect(catalogRead.sql).toContain("COALESCE(NULLIF(TRIM(seller_account), ''), 'default') = $2");
  });

  it('skips configured categories with no order FSN and distinguishes absent orders from missing FSNs', async () => {
    const client = { query: vi.fn(async sql => {
      const text = String(sql);
      if (text.includes('FROM orders')) return { rows: [
        { category: 'Kurta', order_rows: 10, valid_fsn_order_rows: 10 },
        { category: 'Dress', order_rows: 3, valid_fsn_order_rows: 0 },
      ] };
      if (text.includes('FROM rc_commission')) return { rows: [
        { category: 'Kurta' }, { category: 'Dress' }, { category: 'Lehenga Choli' },
      ] };
      return { rows: [] };
    }) };
    const coverage = await loadRateCardCoverage(client, { marketplace: 'flipkart', sellerAccount: 'default' });
    expect(coverage.fsnBackedConfiguredCategories).toEqual(['kurta']);
    expect(coverage.missingFsnCategories).toEqual(['dress', 'lehenga_choli']);
    expect(coverage.configuredCategoriesWithOrdersButNoFsns).toEqual(['dress']);
    expect(coverage.configuredCategoriesWithoutOrders).toEqual(['lehenga_choli']);
    expect(assertRateObservationCoverage([{ vertical: 'kurta' }], coverage)).toEqual(['kurta']);
    expect(() => assertRateObservationCoverage([{ vertical: 'kurta' }, { vertical: 'dress' }], coverage))
      .toThrow(/unconfigured rate-card categories: dress/);
  });

  it('does not accept extraction results when every configured category lacks a database FSN', () => {
    expect(() => assertRateObservationCoverage([{ vertical: 'lehenga_choli' }], {
      marketplace: 'flipkart',
      configuredCategories: ['lehenga_choli'],
      fsnCategories: [],
      fsnBackedConfiguredCategories: [],
      missingFsnCategories: ['lehenga_choli'],
    })).toThrow(/No configured rate-card category has an account-scoped database FSN/);
  });

  it('fails closed when a configuration table is missing', async () => {
    const client = { query: vi.fn(async sql => {
      if (String(sql).includes('FROM rc_fixed_fee')) throw new Error('relation does not exist');
      return { rows: [{ category: 'kurta' }] };
    }) };
    await expect(loadRateCardCoverage(client, { marketplace: 'flipkart', sellerAccount: 'default' }))
      .rejects.toMatchObject({ code: 'RATE_CARD_COVERAGE_UNAVAILABLE', message: expect.stringContaining('rc_fixed_fee') });
  });

  it('rejects partial and unconfigured category sets even if job parameters claim a smaller scope', async () => {
    const coverage = { marketplace: 'flipkart', configuredCategories: ['kurta', 'dress'], fsnCategories: ['kurta', 'dress'], missingFsnCategories: [] };
    expect(() => assertRateObservationCoverage(cards(), coverage)).toThrow(/Missing configured rate-card categories: dress/);
    expect(() => assertRateObservationCoverage([...cards(), { ...cards()[0], vertical: 'blouse' }], {
      ...coverage, configuredCategories: ['kurta'], fsnCategories: ['kurta']
    })).toThrow(/unconfigured rate-card categories: blouse/);
  });

  it('blocks publisher coverage bypass before any rate-table writes', async () => {
    const db = database();
    const originalQuery = db.client.query.getMockImplementation();
    db.client.query.mockImplementation(async (sql, params) => {
      const text = String(sql);
      const configTable = RATE_CARD_CONFIG_TABLES.find(table => text.includes(`FROM ${table}`));
      if (configTable) return { rows: [{ category: 'kurta' }, { category: 'dress' }] };
      if (text.includes('FROM orders')) return { rows: [
        { category: 'kurta', order_rows: 1, valid_fsn_order_rows: 1 },
        { category: 'dress', order_rows: 1, valid_fsn_order_rows: 1 }
      ] };
      return originalQuery(sql, params);
    });
    await expect(publishRateCardObservations(cards(), {
      pool: db.pool, marketplace: 'flipkart', sellerAccount: 'default', publishedBy: 'fixture',
      requireConfiguredCoverage: true, reviewFingerprint: 'caller-supplied-review'
    })).rejects.toThrow(/Missing configured rate-card categories: dress/);
    expect(mutations(db)).toEqual([]);
  });

});
