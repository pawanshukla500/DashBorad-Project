import { buildFsnPlan } from '../fsnPlan.js';
import { normalizeScrapedCards } from '../scrapeResults.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { isFlipkartAuthenticated, portalPartition } from '../portalSession.js';
import { createRateCardCapture } from '../rateCardCapture.js';
import { parsePortalRateSnapshot } from '../portalRates.js';
import { createWorkerEngine } from '../workerEngine.js';
import { getStagingDb, stageReview, recoverReview, supersedeReviews, saveStagedJob, saveStagedObservations, getStagedObservations, closeStagingDb } from '../localStaging.js';
import { buildBrandRateCardSet } from '../rateCardService.js';
import { captureScrapeFailure } from '../scrapeDiagnostics.js';
import { rateFixture } from './fixtures/portalRateFixture.js';

test('public Seller Hub, visible login and OTP challenges never count as authentication', () => {
  const element = (text, href = '') => ({innerText:text,getClientRects:()=>[{}],getAttribute:()=>href});
  const check = ({pathname='/',hash='',inputs=[],controls=[]}={}) => vm.runInNewContext(`(${isFlipkartAuthenticated.toString()})()`, {
    location:{hostname:'seller.flipkart.com',pathname,hash}, getComputedStyle:()=>({visibility:'visible',display:'block'}),
    document:{querySelectorAll:selector=>selector.startsWith('input')?inputs:controls}
  });
  assert.equal(check({controls:[element('Seller Hub')]}),false);
  const route={pathname:'/index.html',hash:'#dashboard/payments/rate-card',controls:[element('Payments','#dashboard/payments/account-summary')]};
  assert.equal(check(route),true);
  assert.equal(check({...route,controls:[element('Home','#dashboard/home-page'),element('Advertising','#dashboard/ads/home'),element('Help','#dashboard/assistance/node/landing')]}),true);
  assert.equal(check({...route,controls:[element('Home','#dashboard/home-page')]}),false);
  assert.equal(check({...route,inputs:[element('OTP')]}),false);
  assert.equal(check({...route,controls:[...route.controls,element('Login')]}),false);
  assert.equal(portalPartition('flipkart'),portalPartition('shopsy'));
});

test('response capture rejects stale category/mode/date data and incomplete responses', () => {
  const capture=createRateCardCapture(), date='2026-10-30 12:00:00';
  const context={vertical:'kurta',marketplace:'flipkart',fulfilment:'FBF',date};
  const input={vertical:'kurta',partnerContext:'flipkart',serviceProfile:'FBF',date,darwinTier:'fixture'};
  const observe=(key,fee,change={})=>capture.observe({url:'https://seller.flipkart.com/orchestrator/graphql',status:200,
    postData:JSON.stringify({variables:{input:{...input,...change}}}),body:{data:{settlement:{[key]:fee}},dataErrors:{},graphErrors:[]}});
  const fixture=rateFixture('FBF');
  observe('platformFee',fixture.fees.platformFee,{vertical:'shirt'});
  assert.equal(capture.snapshot(context).missing.length,5);
  for(const [key,fee] of Object.entries(fixture.fees))observe(key,fee);
  const snapshot=capture.snapshot(context);
  assert.deepEqual(snapshot.missing,[]);
  const parsed=parsePortalRateSnapshot(snapshot,{vertical:'kurta',marketplace:'flipkart',fulfilment:'FBF',effectiveDate:'2026-10-30',portalVertical:'kurta'});
  assert.equal(parsed.reverseShipping[0].national_additional_fee,4);
  assert.equal(parsed.commissions[0].price_max,10000000);
  const changed=structuredClone(fixture.fees.platformFee);changed.slabs.asp[0].agreementParameters.fixedRate='13%';
  observe('platformFee',changed);
  assert.throws(()=>capture.snapshot(context),/Conflicting duplicate/);
});

test('unrecognized layouts and missing fees cannot be substituted with Shopsy constants', () => {
  const fixture=rateFixture('FBF');delete fixture.fees.closingFee;fixture.missing=['closingFee'];
  assert.throws(()=>parsePortalRateSnapshot(fixture,{marketplace:'shopsy'}),/Incomplete/);
  const malformed=rateFixture();malformed.fees.collectionFee.slabs.asp[0].agreementParameters.prepaid='pending';
  assert.throws(()=>parsePortalRateSnapshot(malformed,{marketplace:'flipkart',fulfilment:'NON_FBF'}),/Invalid/);
});

test('SQLite review survives restart, rejects a different owner and rolls back a failed replacement', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rate-review-'));
  try {
    let db=getStagingDb(dir);
    saveStagedJob(db,{id:'interrupted',marketplace:'flipkart',status:'staging',parameters:{owner:'recovery-owner'}});
    saveStagedObservations(db,'interrupted',[{category:'shopsy_kurta',commissions:[{rate:0}]}]);
    closeStagingDb();db=getStagingDb(dir);
    assert.equal(recoverReview(db,'recovery-owner').cards[0].category,'shopsy_kurta','complete observations survive a crash before the final review status write');
    stageReview(db,'review','owner','flipkart',[{category:'kurta',commissions:[{rate:0.1}]}]);
    assert.throws(()=>saveStagedObservations(db,'review',[{category:'dress'},null]));
    assert.equal(getStagedObservations(db,'review')[0].category,'kurta');
    closeStagingDb();db=getStagingDb(dir);
    assert.equal(recoverReview(db,'owner').cards[0].category,'kurta');
    assert.equal(recoverReview(db,'another-owner'),null);
    saveStagedJob(db,{id:'stale-staging',marketplace:'flipkart',status:'staging',parameters:{owner:'owner'}});
    saveStagedObservations(db,'stale-staging',[{category:'dress',commissions:[{rate:0.2}]}]);
    supersedeReviews(db,'owner');
    closeStagingDb();db=getStagingDb(dir);
    assert.equal(recoverReview(db,'owner'),null,'A superseded review must not return after a failed new extraction');
    assert.equal(getStagedObservations(db,'review').length,1,'Audit evidence remains available');
  } finally { closeStagingDb();fs.rmSync(dir,{recursive:true,force:true}); }
});

test('worker registers and polls immediately, coalesces duplicate starts and never overlaps jobs', async () => {
  let registrations=0,claims=0,concurrent=0,max=0,finish;
  const engine=createWorkerEngine({getSession:async()=>({idToken:'fixture'}),register:async()=>{registrations++;},heartbeat:async()=>{},
    claim:async()=>{claims++;return {success:true,job:{id:1}};},execute:async()=>{concurrent++;max=Math.max(max,concurrent);await new Promise(r=>{finish=r;});concurrent--;},intervalMs:10,log:()=>{}});
  try {
    const started=Date.now();await engine.start();await engine.start();
    await new Promise(r=>setTimeout(r,50));
    assert.ok(Date.now()-started<5000);assert.equal(registrations,1);assert.equal(claims,1);assert.equal(max,1);
  } finally {engine.stop();finish?.();}
});

test('stopping during a job claim prevents executing a late claim response', async () => {
  let finish,executed=false;
  const engine=createWorkerEngine({getSession:async()=>({idToken:'fixture'}),register:async()=>{},heartbeat:async()=>{},
    claim:()=>new Promise(r=>{finish=r;}),execute:async()=>{executed=true;},log:()=>{}});
  const started=engine.start();await new Promise(r=>setImmediate(r));engine.stop();finish({success:true,job:{id:1}});await started;
  assert.equal(executed,false);
});

test('real HTTP worker registration and initial claim complete within five seconds', async () => {
  const calls=[];
  const server=http.createServer((req,res)=>{calls.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/health'?{dataSource:'sql'}:{success:true,job:null}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const previous={node:process.env.NODE_ENV,api:process.env.API_SERVER_URL},originalFetch=globalThis.fetch;
  process.env.NODE_ENV='test';process.env.API_SERVER_URL=`http://127.0.0.1:${server.address().port}`;
  globalThis.fetch=(url,options)=>String(url).startsWith(process.env.API_SERVER_URL)?originalFetch(url,options):Promise.reject(new Error('External network disabled in fixture test'));
  const client=await import('../workerClient.js');client.clearCachedActiveServer();
  const session={idToken:'fixture'};
  const engine=createWorkerEngine({getSession:async()=>session,register:s=>client.registerWorkerWithBackend(s,{id:'fixture',name:'fixture'}),
    heartbeat:async()=>{},claim:s=>client.claimNextWorkerJob(s,'fixture'),execute:async()=>{},log:()=>{}});
  try {
    const start=Date.now();await engine.start();assert.ok(Date.now()-start<5000);assert.ok(calls.includes('/api/workers/register'));assert.ok(calls.includes('/api/workers/jobs/claim'));
    let current=true;
    const submission=client.submitJobResults(session,'fixture-job',[],'fixture',()=>current);
    current=false;
    await assert.rejects(submission,/account changed/);
    assert.equal(calls.some(url=>url.endsWith('/results')),false,'An account switch during the await must prevent the HTTP submission');
  }
  finally {engine.stop();client.clearCachedActiveServer();globalThis.fetch=originalFetch;
    if(previous.node===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.node;
    if(previous.api===undefined)delete process.env.API_SERVER_URL;else process.env.API_SERVER_URL=previous.api;
    await new Promise(resolve=>server.close(resolve));}
});

test('database FSN plan covers every brand/category/channel without static vertical aliases', () => {
  const catalog=[
    {marketplace:'flipkart',category:'kurta',brand:'Sangria',sample_fsn:'ABCDEFGHIJKLMNOP'},
    {marketplace:'flipkart',category:'kurta',brand:'Youthnic',sample_fsn:'QRSTUVWXYZ123456'},
    {marketplace:'flipkart',category:'shopsy_kurta',brand:'Youthnic',sample_fsn:'1234567890ABCDEF'}
  ];
  assert.equal(buildFsnPlan(catalog).length,3);
  assert.equal(buildFsnPlan(catalog,{marketplace:'shopsy'})[0].marketplace,'shopsy');
  const plainShopsy=buildFsnPlan([{marketplace:'shopsy',category:'kurta',brand:'Youthnic',sample_fsn:'1234567890ABCDEF'}],
    {marketplace:'shopsy',requiredVerticals:['shopsy_kurta']});
  assert.equal(plainShopsy[0].category,'shopsy_kurta','Shopsy order categories map to the configured Shopsy vertical');
  assert.equal(buildFsnPlan(catalog,{brand:'sangria'}).length,1);
  assert.throws(()=>buildFsnPlan(catalog,{verticals:['missing']}),/No database FSN/);
  assert.throws(()=>buildFsnPlan([{...catalog[0],sample_fsn:''}]),/invalid real FSN/);
  const raw=catalog.slice(0,2).flatMap(t=>['FBF','NON_FBF'].map(fulfilment_type=>({...t,vertical:t.category,fulfilment_type,commissions:[{price_min:0,price_max:500,rate:t.brand==='Sangria'?0.12:0.15}]})));
  const cards=normalizeScrapedCards(raw);
  assert.equal(cards.length,2);
  assert.notEqual(cards[0].commissions[0].rate,cards[1].commissions[0].rate);
});

test('rate-card snapshot keeps seller accounts in separate cards', async () => {
  const rows=[
    {marketplace:'flipkart',seller_account:'default',category:'kurta',brand_name:'Youthnic',price_min:0,price_max:500,rate:0.1},
    {marketplace:'flipkart',seller_account:'seller-b',category:'kurta',brand_name:'Youthnic',price_min:0,price_max:500,rate:0.2}
  ];
  const pool={query:async (sql,params)=>({rows:sql.includes('FROM rc_commission')?rows.filter(row=>params[1]==='all'||row.seller_account===params[1]):[]})};
  const cards=await buildBrandRateCardSet(pool,'all');
  assert.equal(cards.length,2);
  assert.deepEqual(cards.map(card=>card.seller_account).sort(),['default','seller-b']);
  assert.equal((await buildBrandRateCardSet(pool)).length,1,'the visible review defaults to the same seller account used by publication');
});

test('scrape diagnostics rotate screenshots and bound error logs', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rate-diagnostics-'));
  try {
    const page={url:()=> 'https://seller.flipkart.com/index.html#dashboard/rate-card',screenshot:async()=>Buffer.from('fixture-png')};
    for(let index=0;index<24;index++) await captureScrapeFailure(page,dir,{stage:'test'},Object.assign(new Error('Authorization: Bearer supersecret'),{code:'FIXTURE'}));
    const files=fs.readdirSync(dir);
    assert.equal(files.filter(name=>name.endsWith('.png')).length,20,'only the most recent 20 screenshots are retained');
    const log=fs.readFileSync(path.join(dir,'errors.jsonl'),'utf8');
    assert.ok(Buffer.byteLength(log)<=1024*1024,'the diagnostic log stays within its size bound');
    assert.ok(!log.includes('supersecret'),'authorization values are redacted');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('desktop fixes retry backend discovery and render unchanged pick-pack rows', () => {
  const main=fs.readFileSync(new URL('../main.js',import.meta.url),'utf8');
  const start=main.indexOf('async function executeScrapeProcess');
  const loop=main.indexOf('for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)',start);
  const catalog=main.indexOf('fetchBrandCatalogFromApi(session)',loop);
  assert.ok(start>=0 && loop>start && catalog>loop,'catalog lookup is inside the extraction retry loop');
  const server=fs.readFileSync(new URL('../desktopServer.mjs',import.meta.url),'utf8');
  assert.match(server,/scopeVerticals:\s*targetVerticals/,'the standalone scrape route passes its selected verticals to the scraper');
  const renderer=fs.readFileSync(new URL('../ui/renderer.js',import.meta.url),'utf8');
  assert.match(renderer,/for\s*\(const fee of pickPackFees\)/,'unchanged observed FBF pick-and-pack fees are visible in review');
});

test('installed-package smoke harness imports its evidence writer', () => {
  const smoke=fs.readFileSync(new URL('../packagedSmoke.js',import.meta.url),'utf8');
  assert.match(smoke,/import fs from ['"]node:fs['"];/,'the installed smoke harness must be able to write its JSON result and screenshot');
  assert.match(smoke,/window\.show\(\)/,'the smoke harness makes the installed host window visible before Chromium screenshot capture');
  const browser=fs.readFileSync(new URL('../embeddedBrowser.js',import.meta.url),'utf8');
  assert.match(browser,/capturePage\(undefined,\s*\{\s*stayAwake:\s*true\s*\}\)/,'live browser diagnostics allow Electron to reveal hidden contents while capturing');
});

test('FSN response matching never accepts category-only or other-product fees', () => {
  const capture=createRateCardCapture(), date='2026-10-30 12:00:00';
  const context={fsn:'ABCDEFGHIJKLMNOP',marketplace:'flipkart',fulfilment:'NON_FBF',date};
  const fixture=rateFixture('NON_FBF');
  const send=search=>{for(const [key,fee] of Object.entries(fixture.fees))capture.observe({url:'https://seller.flipkart.com/orchestrator/graphql',status:200,postData:JSON.stringify({variables:{input:{...search,partnerContext:'flipkart',serviceProfile:'NON_FBF',date,darwinTier:'fixture'}}}),body:{data:{settlement:{[key]:fee}}}});};
  send({vertical:'kurta'});send({fsn:'QRSTUVWXYZ123456'});
  assert.equal(capture.snapshot(context).missing.length,4);
  send({fsn:context.fsn});assert.equal(capture.snapshot(context).missing.length,0);
});

test('unexpected Shopsy commission is rejected without replacing the observed rate with zero', () => {
  const raw={marketplace:'shopsy',vertical:'shopsy_kurta',fulfilment_type:'NON_FBF',commissions:[{price_min:0,price_max:500,rate:0.1}]};
  assert.throws(()=>normalizeScrapedCards([raw]),/Unexpected nonzero Shopsy/);
  assert.equal(raw.commissions[0].rate,0.1);
});
