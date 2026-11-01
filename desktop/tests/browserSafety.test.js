import { buildFsnPlan, describeCoverageBlockers, hasKnownMarketplaceFsnCoverage, missingFsnCategoriesForMarketplace, normalizeScrapeVertical, resolveFsnBackedScrapeVerticals, resolveScrapeVerticals, uncoveredCategoriesForMarketplace } from '../fsnPlan.js';
import { normalizeScrapedCards, resolveSellerAccountForRateCards } from '../scrapeResults.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { inspectFlipkartLoginState, isFlipkartAuthenticated, portalPartition } from '../portalSession.js';
import { createRateCardCapture } from '../rateCardCapture.js';
import { parsePortalRateSnapshot } from '../portalRates.js';
import { createWorkerEngine } from '../workerEngine.js';
import { isPermanentScrapeError, permanentScrapeError } from '../scrapeErrors.js';
import { getStagingDb, stageReview, recoverReview, supersedeReviews, saveStagedJob, saveStagedObservations, getStagedObservations, closeStagingDb } from '../localStaging.js';
import { buildBrandRateCardSet } from '../rateCardService.js';
import { captureScrapeFailure } from '../scrapeDiagnostics.js';
import { readSellerHubProfileState, writeSellerHubProfileState } from '../portalProfileState.js';
import { rateFixture } from './fixtures/portalRateFixture.js';

test('public Seller Hub, visible login and OTP challenges never count as authentication', () => {
  const element = (text, href = '', fields = {}) => ({
    innerText:text,type:fields.type||'',name:fields.name||'',id:fields.id||'',autocomplete:fields.autocomplete||'',
    getClientRects:()=>[{}],getAttribute:name=>name==='href'?href:''
  });
  const check = ({pathname='/',hash='',inputs=[],controls=[]}={}) => vm.runInNewContext(`(${isFlipkartAuthenticated.toString()})()`, {
    location:{hostname:'seller.flipkart.com',pathname,hash}, getComputedStyle:()=>({visibility:'visible',display:'block'}),
    document:{querySelectorAll:selector=>selector.startsWith('input')?inputs:controls}
  });
  assert.equal(check({controls:[element('Seller Hub')]}),false);
  const route={pathname:'/index.html',hash:'#dashboard/payments/rate-card',controls:[element('Payments','#dashboard/payments/account-summary')]};
  assert.equal(check(route),true);
  assert.equal(check({...route,controls:[element('Home','#dashboard/home-page'),element('Advertising','#dashboard/ads/home'),element('Help','#dashboard/assistance/node/landing')]}),true);
  assert.equal(check({...route,controls:[element('Home','#dashboard/home-page')]}),false);
  assert.equal(check({...route,inputs:[element('OTP','',{name:'otp'})]}),false);
  assert.equal(check({...route,inputs:[element('CAPTCHA','',{id:'captchaResponse'})]}),false);
  assert.equal(check({...route,controls:[...route.controls,element('Login')]}),false);
  assert.equal(portalPartition('flipkart'),portalPartition('shopsy'));
});

test('Seller Hub login inspection follows the username, password, challenge and dashboard stages', () => {
  const element = (text, href = '', fields = {}) => ({
    innerText: text,
    href,
    type: fields.type || '',
    name: fields.name || '',
    id: fields.id || '',
    autocomplete: fields.autocomplete || '',
    placeholder: fields.placeholder || '',
    src: fields.src || '',
    getClientRects: () => [{}],
    getAttribute: name => name === 'href' ? href : name === 'src' ? (fields.src || '') :
      name === 'aria-label' ? (fields.ariaLabel || '') : ''
  });
  const inspect = ({ pathname='/',hash='',inputs=[],controls=[],iframes=[] }={}) => vm.runInNewContext(
    `(${inspectFlipkartLoginState.toString()})()`,
    {
      location:{hostname:'seller.flipkart.com',pathname,hash},
      getComputedStyle:()=>({visibility:'visible',display:'block'}),
      document:{
        querySelectorAll:selector=>selector === 'input' ? inputs : selector === 'iframe' ? iframes :
          selector === '[role="dialog"], [aria-modal="true"], .form-modal' ? [] : controls
      }
    }
  );

  const loginControl = element('Login');
  assert.equal(inspect({controls:[loginControl]}).stage,'public');
  assert.equal(inspect({controls:[loginControl]}).publicLanding,true);
  assert.equal(inspect({inputs:[element('', '', {name:'username'})],controls:[loginControl]}).stage,'username');
  assert.equal(inspect({inputs:[element('', '', {type:'password',name:'password'})],controls:[loginControl]}).stage,'password');
  assert.equal(inspect({inputs:[element('', '', {name:'otp',autocomplete:'one-time-code'})],controls:[loginControl]}).stage,'challenge');
  assert.equal(inspect({inputs:[element('', '', {id:'captchaResponse'})],controls:[loginControl]}).stage,'challenge');
  assert.equal(inspect({inputs:[element('', '', {placeholder:'Enter captcha'})],controls:[loginControl]}).captchaInputVisible,true);
  const dashboard = inspect({
    pathname:'/index.html',hash:'#dashboard/home-page',
    controls:[element('Home','#dashboard/home-page'),element('Advertising','#dashboard/ads/home'),element('Help','#dashboard/assistance/')]
  });
  assert.equal(dashboard.authenticated,true);
  assert.equal(dashboard.stage,'authenticated');
  const dashboardWithLogin = inspect({
    pathname:'/index.html',hash:'#dashboard/home-page',
    controls:[element('Home','#dashboard/home-page'),element('Advertising','#dashboard/ads/home'),element('Help','#dashboard/assistance/'),loginControl]
  });
  assert.equal(dashboardWithLogin.authenticated,false,
    'dashboard route plus navigation links are insufficient while Seller Hub still offers Login');
});

test('Seller Hub profile state distinguishes verified sessions from initialized Chrome stores', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-profile-handoff-'));
  const profileDir = path.join(tempDir, 'profile');
  try {
    fs.mkdirSync(profileDir);
    assert.equal(readSellerHubProfileState(profileDir), 'unknown',
      'profiles created by older versions must enter the cookie-handoff migration state');

    const cookieStore = path.join(profileDir, 'Default', 'Network', 'Cookies');
    fs.mkdirSync(path.dirname(cookieStore), { recursive: true });
    fs.writeFileSync(cookieStore, 'chromium-cookie-store');
    assert.equal(readSellerHubProfileState(profileDir), 'unknown',
      'a generic initialized Chromium store does not prove Seller Hub authentication');

    writeSellerHubProfileState(profileDir, 'authenticated');
    assert.equal(readSellerHubProfileState(profileDir), 'authenticated');
    writeSellerHubProfileState(profileDir, 'snapshot_available');
    assert.equal(readSellerHubProfileState(profileDir), 'snapshot_available',
      'a newly saved Electron login snapshot must be eligible for external Chrome handoff');
    writeSellerHubProfileState(profileDir, 'signed_out');
    assert.equal(readSellerHubProfileState(profileDir), 'signed_out',
      'a confirmed sign-out must prevent a stale encrypted snapshot from restoring the prior session');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  const parsed=parsePortalRateSnapshot(snapshot,{vertical:'kurta',marketplace:'flipkart',fulfilment:'FBF',effectiveDate:'2026-10-30',portalVertical:'kurta',sellerAccount:'seller-ej'});
  assert.equal(parsed.seller_account,'seller-ej','the account selected for FSN discovery stays attached to Seller Hub observations');
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
    const coverage={complete:false,configuredVerticals:['kurta','lehenga_choli'],scopeVerticals:['kurta'],unavailableConfiguredVerticals:['lehenga_choli'],incompleteByMarketplace:{flipkart:['lehenga_choli'],shopsy:[]},uncoveredByMarketplace:{flipkart:['lehenga_choli'],shopsy:[]}};
    stageReview(db,'review','owner','flipkart',[{category:'kurta',commissions:[{rate:0.1}]}],{coverage});
    assert.throws(()=>saveStagedObservations(db,'review',[{category:'dress'},null]));
    assert.equal(getStagedObservations(db,'review')[0].category,'kurta');
    closeStagingDb();db=getStagingDb(dir);
    assert.equal(recoverReview(db,'owner').cards[0].category,'kurta');
    assert.deepEqual(recoverReview(db,'owner').coverage,coverage,'coverage gaps survive a restart with the staged review');
    assert.equal(recoverReview(db,'owner').sellerAccount,'default','the recovery metadata retains the seller account');
    assert.equal(hasKnownMarketplaceFsnCoverage(null,'flipkart'),false,'legacy SQLite reviews without coverage metadata cannot pass publication checks');
    assert.equal(hasKnownMarketplaceFsnCoverage(coverage,'flipkart'),true,'current review metadata records a complete coverage shape even when it contains gaps');
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
  let finish,executed=false,released=null;
  const engine=createWorkerEngine({getSession:async()=>({idToken:'fixture'}),register:async()=>{},heartbeat:async()=>{},
    claim:()=>new Promise(r=>{finish=r;}),releaseClaim:async(_session,job)=>{released=job.id;},execute:async()=>{executed=true;},log:()=>{}});
  const started=engine.start();await new Promise(r=>setImmediate(r));engine.stop();finish({success:true,job:{id:1}});await started;
  assert.equal(executed,false);
  assert.equal(released,1,'a claim returned after stop is released immediately instead of waiting for its lease to expire');
});

test('real HTTP worker registration and initial claim complete within five seconds', async () => {
  const calls=[];let pendingResults=null;
  const server=http.createServer((req,res)=>{calls.push(req.url);res.setHeader('Content-Type','application/json');
    if(req.url==='/api/health')return res.end(JSON.stringify({dataSource:'sql'}));
    if(req.url.endsWith('/results')){pendingResults=res;return;}
    res.end(JSON.stringify({success:true,job:null}));});
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
    await client.releaseClaimedWorkerJob(session,{id:'fixture-job'},'fixture');
    assert.ok(calls.includes('/api/workers/jobs/release'),'the desktop client has an authenticated worker-claim release API');
    let current=true;
    const submission=client.submitJobResults(session,'fixture-job',[],'fixture',()=>current);
    current=false;
    await assert.rejects(submission,/account changed/);
    assert.equal(calls.some(url=>url.endsWith('/results')),false,'An account switch during the await must prevent the HTTP submission');
    current=true;
    client.clearCachedActiveServer();
    const inFlight=client.submitJobResults(session,'fixture-job',[],'fixture',()=>current);
    for(let attempt=0;attempt<20&&!pendingResults;attempt++)await new Promise(resolve=>setTimeout(resolve,5));
    if(!pendingResults) await assert.rejects(inFlight);
    assert.ok(pendingResults,`the result request is in flight; current=${current}; requests seen: ${calls.join(', ')}`);
    current=false;
    pendingResults.end(JSON.stringify({success:true}));pendingResults=null;
    await assert.rejects(inFlight,/Results were discarded/);
    assert.ok(calls.some(url=>url.endsWith('/discard-results')),'a late successful response is cleared at the authenticated backend');
  }
  finally {engine.stop();client.clearCachedActiveServer();globalThis.fetch=originalFetch;
    if(previous.node===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.node;
    if(previous.api===undefined)delete process.env.API_SERVER_URL;else process.env.API_SERVER_URL=previous.api;
    await new Promise(resolve=>server.close(resolve));}
});

test('configured category discovery normalizes marketplace before selecting channels', async () => {
  const requested=[];
  const server=http.createServer((req,res)=>{
    requested.push(req.url);res.setHeader('Content-Type','application/json');
    if(req.url==='/api/health')return res.end(JSON.stringify({dataSource:'sql'}));
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/rate-card/brand-fsn-catalog')return res.end(JSON.stringify({success:true,catalog:[
      {marketplace:'flipkart',category:'salwar_kurta_dupatta',brand:'Youthnic',sample_fsn:'ABCDEFGHIJKLMNOP'}
    ]}));
    const type=url.pathname.split('/').at(-1);
    const marketplace=url.searchParams.get('marketplace');
    const flipkartCategories={commission:'kurta',fixed_fee:'dress',collection_fee:'sari',pick_pack:'gown',reverse_shipping:'top',franchise_fee:'fabric'};
    const rows=marketplace==='shopsy'
      ? [{category:'kurta'},{category:'shopsy_sari'}]
      : [{category:flipkartCategories[type]},{category:'shopsy_kurta'}];
    res.end(JSON.stringify({rows}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const previous={node:process.env.NODE_ENV,api:process.env.API_SERVER_URL},originalFetch=globalThis.fetch;
  process.env.NODE_ENV='test';process.env.API_SERVER_URL=`http://127.0.0.1:${server.address().port}`;
  globalThis.fetch=(url,options)=>String(url).startsWith(process.env.API_SERVER_URL)?originalFetch(url,options):Promise.reject(new Error('External network disabled in fixture test'));
  const client=await import('../workerClient.js');client.clearCachedActiveServer();
  try {
    assert.deepEqual(await client.fetchConfiguredVerticals({idToken:'fixture'},'  FLIPKART ',[],'seller_ej'),
      ['kurta','dress','sari','gown','top','fabric']);
    assert.equal(requested.filter(url=>url.includes('/api/rate-card/config/')&&url.includes('marketplace=flipkart')).length,6,
      'all six configured fee tables are read through the authenticated API');
    assert.equal(requested.filter(url=>url.includes('/api/rate-card/config/')&&url.includes('seller_account=seller_ej')).length,6,
      'all six configured fee tables are scoped to the selected seller account');
    assert.equal(requested.filter(url=>url.includes('/api/rate-card/config/')&&url.includes('active_only=true')).length,6,
      'the current marketplace discovery requests only current rate periods');
    assert.equal(requested.some(url=>url.endsWith('marketplace=shopsy')),false,'Flipkart extraction must not add Shopsy categories');
    assert.deepEqual(await client.fetchConfiguredVerticals({idToken:'fixture'},' ShOpSy '),['shopsy_kurta','shopsy_sari']);
    assert.equal(requested.filter(url=>url.includes('/api/rate-card/config/')&&url.includes('marketplace=shopsy')).length,6,
      'Shopsy categories are discovered independently from all six configured fee tables');
    assert.deepEqual(await client.fetchConfiguredVerticals({idToken:'fixture'},'flipkart_shopsy'),
      ['kurta','dress','sari','gown','top','fabric','shopsy_kurta','shopsy_sari']);
    const catalog=await client.fetchBrandCatalogFromApi({idToken:'fixture'},{marketplace:'flipkart',sellerAccount:'seller_ej'});
    assert.equal(catalog.catalog[0].sample_fsn,'ABCDEFGHIJKLMNOP');
    assert(requested.some(url=>url==='/api/rate-card/brand-fsn-catalog?marketplace=flipkart&seller_account=seller_ej'),
      'the authenticated FSN catalog request uses the same marketplace and seller account');
  } finally {
    client.clearCachedActiveServer();globalThis.fetch=originalFetch;
    if(previous.node===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.node;
    if(previous.api===undefined)delete process.env.API_SERVER_URL;else process.env.API_SERVER_URL=previous.api;
    await new Promise(resolve=>server.close(resolve));
  }
});

test('missing rate-card configuration tables fail closed before extraction', async () => {
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/health')return res.end(JSON.stringify({dataSource:'sql'}));
    if(req.url.includes('/config/pick_pack?'))return res.writeHead(500).end(JSON.stringify({error:'table missing'}));
    res.end(JSON.stringify({rows:[{category:'kurta'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const previous={node:process.env.NODE_ENV,api:process.env.API_SERVER_URL},originalFetch=globalThis.fetch;
  process.env.NODE_ENV='test';process.env.API_SERVER_URL=`http://127.0.0.1:${server.address().port}`;
  globalThis.fetch=(url,options)=>String(url).startsWith(process.env.API_SERVER_URL)?originalFetch(url,options):Promise.reject(new Error('External network disabled in fixture test'));
  const client=await import('../workerClient.js');client.clearCachedActiveServer();
  try {
    await assert.rejects(client.fetchConfiguredVerticals({idToken:'fixture'},'flipkart'),/rate-card table 'pick_pack' unavailable/);
  } finally {
    client.clearCachedActiveServer();globalThis.fetch=originalFetch;
    if(previous.node===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.node;
    if(previous.api===undefined)delete process.env.API_SERVER_URL;else process.env.API_SERVER_URL=previous.api;
    await new Promise(resolve=>server.close(resolve));
  }
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
  assert.equal(buildFsnPlan(catalog,{brand:'sangria',verticals:['kurta','dress']}).length,1,
    'selecting a brand does not require it to have an FSN in every configured category');
  assert.deepEqual(resolveScrapeVerticals({configuredVerticals:['kurta','dress'],brand:'all'}),
    {scopeVerticals:['kurta','dress'],requiredVerticals:['kurta','dress']});
  assert.deepEqual(resolveScrapeVerticals({configuredVerticals:['kurta','dress'],brand:'sangria'}),
    {scopeVerticals:['kurta','dress'],requiredVerticals:[]});
  assert.deepEqual(resolveScrapeVerticals({requestedVerticals:['kurta'],configuredVerticals:['dress'],brand:'sangria'}),
    {scopeVerticals:['kurta'],requiredVerticals:['kurta']});
  assert.deepEqual(resolveScrapeVerticals({configuredVerticals:[' kurta ', 'kurta', 'dress'], savedVerticals:['blouse'], brand:'all'}),
    {scopeVerticals:['kurta','dress'],requiredVerticals:['kurta','dress']},
    'live backend categories replace stale category defaults from older worker configs');
  assert.throws(()=>buildFsnPlan(catalog,{verticals:['missing']}),/No database FSN/);
  assert.throws(()=>buildFsnPlan([{...catalog[0],sample_fsn:''}]),/invalid real FSN/);
  assert.equal(normalizeScrapeVertical('salwar suit'), 'salwar_kurta_dupatta');
  assert.equal(normalizeScrapeVertical('shopsy_saree'), 'shopsy_sari');
  assert.equal(normalizeScrapeVertical('saree', 'shopsy'), 'shopsy_sari');
  const legacyAlias = buildFsnPlan([{marketplace:'flipkart',category:'salwar kurta dupatta',brand:'Youthnic',sample_fsn:'ABCDEFGHIJKLMNOP'}],
    {marketplace:'flipkart',verticals:['salwar suit'],requiredVerticals:['salwar suit']});
  assert.equal(legacyAlias[0].category,'salwar_kurta_dupatta','legacy selected categories match canonical FSN keys');
  const legacyShopsy = buildFsnPlan([{marketplace:'flipkart',category:'shopsy_saree',brand:'Youthnic',sample_fsn:'QRSTUVWXYZ123456'}],
    {marketplace:'shopsy',verticals:['shopsy_sari'],requiredVerticals:['shopsy_saree']});
  assert.equal(legacyShopsy[0].category,'shopsy_sari','legacy Shopsy categories keep their separate namespace');
  const legacySpacedShopsy = buildFsnPlan([{marketplace:'flipkart',category:'Shopsy Saree',brand:'Youthnic',sample_fsn:'QRSTUVWX12345678'}],
    {marketplace:'shopsy',verticals:['shopsy_sari'],requiredVerticals:['shopsy_saree']});
  assert.equal(legacySpacedShopsy[0].category,'shopsy_sari','space-separated Shopsy aliases use the same channel and canonical category');
  const raw=catalog.slice(0,2).flatMap(t=>['FBF','NON_FBF'].map(fulfilment_type=>({...t,vertical:t.category,fulfilment_type,commissions:[{price_min:0,price_max:500,rate:t.brand==='Sangria'?0.12:0.15}]})));
  const cards=normalizeScrapedCards(raw);
  assert.equal(cards.length,2);
  assert.notEqual(cards[0].commissions[0].rate,cards[1].commissions[0].rate);
});

test('default extraction scope uses real FSN-backed categories and blocks incomplete publication', () => {
  const catalog=[
    {marketplace:'flipkart',category:'kurta',brand:'Sangria',sample_fsn:'ABCDEFGHIJKLMNOP'},
    {marketplace:'flipkart',category:'shopsy_kurta',brand:'Youthnic',sample_fsn:'QRSTUVWXYZ123456'},
    {marketplace:'flipkart',category:'legacy_orders_category',brand:'Youthnic',sample_fsn:'ABCDEF0123456789'}
  ];
  const coverage=resolveFsnBackedScrapeVerticals({
    configuredVerticals:['kurta','blouse','lehenga_choli','shopsy_kurta','shopsy_fabric'],
    catalog,marketplace:'flipkart_shopsy',brand:'all'
  });
  assert.deepEqual(coverage.scopeVerticals,['kurta','shopsy_kurta']);
  assert.deepEqual(coverage.requiredVerticals,['kurta','shopsy_kurta']);
  assert.deepEqual(coverage.unavailableConfiguredVerticals,['blouse','lehenga_choli','shopsy_fabric']);
  assert.deepEqual(missingFsnCategoriesForMarketplace(coverage,'flipkart'),['blouse','lehenga_choli']);
  assert.deepEqual(missingFsnCategoriesForMarketplace(coverage,'shopsy'),['shopsy_fabric']);
  assert.deepEqual(uncoveredCategoriesForMarketplace(coverage,'flipkart'),['blouse','lehenga_choli']);
  assert.equal(describeCoverageBlockers(coverage,'flipkart'),'categories without database FSNs: blouse, lehenga_choli');
  assert.equal(coverage.complete,false);
  assert.equal(buildFsnPlan(catalog,{verticals:coverage.scopeVerticals,requiredVerticals:coverage.requiredVerticals}).length,2,
    'only configured verticals with real FSNs are targets; unconfigured order-history categories stay out');
});

test('default extraction does not scrape unconfigured order-history categories or run without configured tables', () => {
  const catalog=[
    {marketplace:'flipkart',category:'kurta',brand:'Sangria',sample_fsn:'ABCDEFGHIJKLMNOP'},
    {marketplace:'flipkart',category:'legacy_orders_category',brand:'Youthnic',sample_fsn:'ABCDEF0123456789'}
  ];
  const coverage=resolveFsnBackedScrapeVerticals({configuredVerticals:['kurta'],catalog,brand:'all'});
  assert.deepEqual(coverage.scopeVerticals,['kurta']);
  assert.deepEqual(coverage.availableVerticals,['kurta','legacy_orders_category']);
  assert.throws(()=>resolveFsnBackedScrapeVerticals({configuredVerticals:[],catalog,brand:'all'}),/No configured rate-card categories/);
  assert.throws(()=>resolveFsnBackedScrapeVerticals({configuredVerticals:['blouse'],catalog,brand:'all'}),/No configured rate-card category has a database FSN/);
});

test('explicit missing categories fail and filtered scopes cannot publish incomplete configured coverage', () => {
  const catalog=[{marketplace:'flipkart',category:'kurta',brand:'Sangria',sample_fsn:'ABCDEFGHIJKLMNOP'}];
  assert.throws(
    ()=>resolveFsnBackedScrapeVerticals({requestedVerticals:['blouse'],configuredVerticals:['blouse'],catalog,brand:'all'}),
    /Selected categories have no database FSNs.*blouse.*Nothing was scraped/,
    'an explicitly selected category without an FSN stops before the browser is opened'
  );

  const explicitSubset=resolveFsnBackedScrapeVerticals({requestedVerticals:['kurta'],configuredVerticals:['kurta','lehenga_choli'],catalog,brand:'all'});
  assert.deepEqual(explicitSubset.unavailableConfiguredVerticals,['lehenga_choli'],
    'an explicit category request still discovers configured categories missing a real FSN');
  assert.deepEqual(missingFsnCategoriesForMarketplace(explicitSubset,'flipkart'),['lehenga_choli']);
  assert.equal(explicitSubset.complete,false);

  const omittedScope=resolveFsnBackedScrapeVerticals({requestedVerticals:['kurta'],configuredVerticals:['kurta','blouse'],catalog:[...catalog,{marketplace:'flipkart',category:'blouse',brand:'Sangria',sample_fsn:'QRSTUVWXYZ123456'}],brand:'all'});
  assert.deepEqual(uncoveredCategoriesForMarketplace(omittedScope,'flipkart'),['blouse']);
  assert.equal(describeCoverageBlockers(omittedScope,'flipkart'),'configured categories omitted from this extraction: blouse');

  const brandScope=resolveFsnBackedScrapeVerticals({configuredVerticals:['kurta','lehenga_choli'],catalog,brand:'Sangria'});
  assert.deepEqual(brandScope.scopeVerticals,['kurta']);
  assert.deepEqual(brandScope.requiredVerticals,['kurta']);
  assert.equal(brandScope.complete,false,'categories omitted by a brand filter cannot be treated as a complete all-category extraction');
});

test('permanent coverage failures do not trigger transient extraction retries', () => {
  assert.equal(isPermanentScrapeError(permanentScrapeError('configured categories have no database FSNs: dress')), true);
  assert.equal(isPermanentScrapeError(new Error('ECONNRESET')), false);
});

test('extracted portal evidence retains the Seller Hub vertical used for the FSN search', () => {
  const source = fs.readFileSync(new URL('../portalScraper.js', import.meta.url), 'utf8');
  assert.match(source, /portalVertical:\s*vertical/);
});

test('seller-account selection is derived from staged cards and rejects cross-account review', () => {
  const cards=normalizeScrapedCards([{marketplace:'flipkart',vertical:'kurta',seller_account:'seller-ej',commissions:[{price_min:0,price_max:500,rate:0.1}]}]);
  assert.equal(cards[0].seller_account,'seller-ej');
  assert.equal(resolveSellerAccountForRateCards(cards),'seller-ej','an omitted UI option resolves to the scraped account');
  assert.throws(()=>resolveSellerAccountForRateCards(cards,'default'),/does not match/);
  assert.throws(()=>resolveSellerAccountForRateCards([...cards,{...cards[0],seller_account:'default'}]),/one seller account/);
});

test('rate-card snapshot keeps seller accounts in separate cards', async () => {
  const rows=[
    {marketplace:'flipkart',seller_account:'default',category:'kurta',brand_name:'Youthnic',price_min:0,price_max:500,rate:0.1},
    {marketplace:'flipkart',seller_account:'seller-b',category:'kurta',brand_name:'Youthnic',price_min:0,price_max:500,rate:0.2}
  ];
  const pickPackRows=[
    {marketplace:'flipkart',seller_account:'default',category:'kurta',fulfilment_type:'FBF',price_min:0,price_max:999999,weight_min:0,weight_max:50000,price_scope:'all',rate:14},
    {marketplace:'flipkart',seller_account:'seller-b',category:'kurta',fulfilment_type:'FBF',price_min:0,price_max:999999,weight_min:0,weight_max:50000,price_scope:'all',rate:18}
  ];
  const catalogRows=[
    {marketplace:'flipkart',seller_account:'default',category:'kurta',brand:'Youthnic',sample_fsn:'ABCDEFGHIJKLMNOP',sample_sku:'SKU-DEFAULT',order_count:6},
    {marketplace:'flipkart',seller_account:'seller-b',category:'kurta',brand:'Youthnic',sample_fsn:'QRSTUVWXYZ123456',sample_sku:'SKU-B',order_count:3}
  ];
  const pool={query:async (sql,params)=>({rows:sql.includes('FROM orders')?catalogRows:
    sql.includes('FROM rc_commission')?rows.filter(row=>params[1]==='all'||row.seller_account===params[1]):
    sql.includes('FROM rc_pick_pack')?pickPackRows.filter(row=>params[1]==='all'||row.seller_account===params[1]):[]})};
  const cards=await buildBrandRateCardSet(pool,'all');
  assert.equal(cards.length,4);
  assert.deepEqual(cards.map(card=>card.seller_account).sort(),['default','default','seller-b','seller-b']);
  assert.deepEqual(cards.filter(card=>card.pickPackFees?.length).map(card=>[card.seller_account,card.pickPackFees[0].rate]).sort(),[['default',14],['seller-b',18]]);
  assert.deepEqual(cards.filter(card=>card.commissions.length).map(card=>[card.seller_account,card.sample_fsn,card.sample_sku,card.order_count]).sort(),
    [['default','ABCDEFGHIJKLMNOP','SKU-DEFAULT',6],['seller-b','QRSTUVWXYZ123456','SKU-B',3]]);
  const defaultCards=await buildBrandRateCardSet(pool);
  assert.ok(defaultCards.length>0 && defaultCards.every(card=>card.seller_account==='default'),'the visible review defaults to the same seller account used by publication');
});

test('review helpers do not mark incomplete errors as success or duplicate active rate details', () => {
  const source=fs.readFileSync(new URL('../ui/reviewHelpers.js',import.meta.url),'utf8');
  const context={window:{}};vm.runInNewContext(source,context);
  const helpers=context.window.rateCardReviewHelpers;
  assert.equal(helpers.isSuccessfulMessage('Extraction incomplete: missing fees'),false);
  assert.equal(helpers.isSuccessfulMessage('Extraction completed'),true);
  assert.equal(helpers.shouldRenderChangeDetail({table:'rc_commission',changeType:'MODIFIED',slab:'₹0-500'}),false);
  assert.equal(helpers.shouldRenderChangeDetail({table:'rc_commission',changeType:'REMOVED',slab:'₹0-500'}),true);
  assert.equal(helpers.shouldRenderChangeDetail({table:'rc_fixed_fee',details:'summary without slab'}),true);
});

test('normalization keeps sample SKU attached to its marketplace, category, brand and account group', () => {
  const fee=(sample_sku,seller_account,brand='Youthnic')=>({marketplace:'flipkart',vertical:'kurta',brand,sample_fsn:'ABCDEFGHIJKLMNOP',sample_sku,seller_account,
    fulfilment_type:'NON_FBF',commissions:[{price_min:0,price_max:500,rate:0.1}]});
  const cards=normalizeScrapedCards([fee('SKU-A','account-a'),fee('SKU-B','account-b'),fee('SKU-OTHER-BRAND','account-a','Sangria')]);
  assert.equal(cards.find(card=>card.sample_sku==='SKU-A').sample_sku,'SKU-A');
  assert.equal(cards.find(card=>card.sample_sku==='SKU-B').sample_sku,'SKU-B');
  assert.equal(cards.find(card=>card.brand==='Sangria').sample_sku,'SKU-OTHER-BRAND');
  assert.equal(cards.length,3,'seller and brand groups remain distinct even when the FSN is repeated');
});

test('failed sync result submission cancels the unused RATE_CARD_SYNC job', async () => {
  const calls=[];
  const server=http.createServer((req,res)=>{
    calls.push(req.url);res.setHeader('Content-Type','application/json');
    if(req.url==='/api/health')return res.end(JSON.stringify({dataSource:'sql'}));
    if(req.url==='/api/worker-jobs')return res.end(JSON.stringify({success:true,job:{id:'sync-1'}}));
    if(req.url.endsWith('/results')){res.statusCode=500;return res.end(JSON.stringify({error:'fixture submission failure'}));}
    if(req.url.endsWith('/discard-results'))return res.end(JSON.stringify({success:true,discarded:true}));
    if(req.url.endsWith('/publish'))return res.end(JSON.stringify({success:true}));
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const previous={node:process.env.NODE_ENV,api:process.env.API_SERVER_URL},originalFetch=globalThis.fetch;
  process.env.NODE_ENV='test';process.env.API_SERVER_URL=`http://127.0.0.1:${server.address().port}`;
  globalThis.fetch=(url,options)=>String(url).startsWith(process.env.API_SERVER_URL)?originalFetch(url,options):Promise.reject(new Error('External network disabled in fixture test'));
  const client=await import('../workerClient.js');client.clearCachedActiveServer();
  try {
    await assert.rejects(client.publishReviewedRatesViaApi({idToken:'fixture',user:{role:'admin'}},
      [{marketplace:'flipkart',category:'kurta'}],{flipkart:'fingerprint'}),/fixture submission failure/);
    assert.ok(calls.some(url=>url==='/api/worker-jobs/sync-1/discard-results'));
    assert.equal(calls.some(url=>url.endsWith('/publish')),false,'failed review data never reaches publication');
  } finally {
    client.clearCachedActiveServer();globalThis.fetch=originalFetch;
    if(previous.node===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous.node;
    if(previous.api===undefined)delete process.env.API_SERVER_URL;else process.env.API_SERVER_URL=previous.api;
    await new Promise(resolve=>server.close(resolve));
  }
});

test('scrape diagnostics rotate screenshots and bound error logs', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rate-diagnostics-'));
  try {
    const evaluations=[];
    const page={url:()=> 'https://seller.flipkart.com/index.html#dashboard/rate-card',evaluate:async(...args)=>{evaluations.push(args);return evaluations.length%2?[null]:undefined;},screenshot:async()=>Buffer.from('fixture-png')};
    for(let index=0;index<24;index++) await captureScrapeFailure(page,dir,{stage:'test'},Object.assign(new Error('Authorization: Bearer supersecret'),{code:'FIXTURE'}));
    const files=fs.readdirSync(dir);
    assert.equal(files.filter(name=>name.endsWith('.png')).length,20,'only the most recent 20 screenshots are retained');
    const log=fs.readFileSync(path.join(dir,'errors.jsonl'),'utf8');
    assert.ok(Buffer.byteLength(log)<=1024*1024,'the diagnostic log stays within its size bound');
    assert.ok(!log.includes('supersecret'),'authorization values are redacted');
    assert.ok(evaluations.length>=2 && evaluations[0][1].includes('input,textarea'),'diagnostic capture masks editable form fields');
    assert.match(String(evaluations[0][0]),/transparent/,'input text is hidden before capturing');
    assert.match(String(evaluations[1][0]),/removeAttribute/,'original styles are restored after capture');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('scrape diagnostics skip screenshots when editable controls cannot be redacted', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rate-redacted-diagnostics-'));
  try {
    let screenshots=0;
    const page={url:()=> 'https://seller.flipkart.com/login',evaluate:async()=>{throw new Error('renderer unavailable');},screenshot:async()=>{screenshots++;return Buffer.from('unsafe');}};
    const result=await captureScrapeFailure(page,dir,{stage:'login'},new Error('fixture failure'));
    assert.equal(screenshots,0,'an unredacted screenshot is never used as a fallback');
    assert.match(result.screenshotError,/could not be redacted/i);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('desktop fixes retry backend discovery and render unchanged pick-pack rows', () => {
  const main=fs.readFileSync(new URL('../main.js',import.meta.url),'utf8');
  const start=main.indexOf('async function executeScrapeProcess');
  const loop=main.indexOf('for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)',start);
  const catalog=main.indexOf('fetchBrandCatalogFromApi(session, { marketplace:',loop);
  assert.ok(start>=0 && loop>start && catalog>loop,'catalog lookup is inside the extraction retry loop');
  const server=fs.readFileSync(new URL('../desktopServer.mjs',import.meta.url),'utf8');
  assert.match(server,/scopeVerticals:\s*targetVerticals/,'the standalone scrape route passes its selected verticals to the scraper');
  assert.match(server,/fetchConfiguredVerticals\(loadAuthSession\(\),\s*normalizedChannel,\s*\[\],\s*sellerAccount\)/,'the standalone route scopes category discovery to its seller account');
  assert.match(server,/fetchBrandCatalogFromApi\(loadAuthSession\(\),\s*\{\s*marketplace:\s*normalizedChannel,\s*sellerAccount\s*\}\)/,'the standalone route scopes real FSN discovery to the same seller account');
  assert.match(main,/const configuredVerticalsPromise = fetchConfiguredVerticals\(session, effectiveConfig\.marketplace, \[\], sellerAccount\)/,
    'explicit category runs still discover all configured categories for completeness checks');
  assert.match(server,/const configuredVerticals = await fetchConfiguredVerticals\(loadAuthSession\(\), normalizedChannel, \[\], sellerAccount\)/,
    'the standalone route discovers configured categories even for explicit requests');
  const workerStart=server.indexOf('const serverWorker = createWorkerEngine');
  const workerEnd=server.indexOf('const sseClients = new Set()',workerStart);
  const worker=server.slice(workerStart,workerEnd);
  assert.match(worker,/const configuredVerticals = await fetchConfiguredVerticals\(session, job\.marketplace, \[\], sellerAccount\)/,
    'standalone claimed jobs discover configured categories even when verticals are explicit');
  assert.match(worker,/scrapeFlipkartRateCards\(\{ marketplace: job\.marketplace, seller_account: sellerAccount,/,
    'standalone claimed jobs preserve the selected seller account in extracted observations');
  assert.match(main,/canSync:\s*coverageKnown && filteredRateCards\.length > 0 && missingCategories\.length === 0 && uncoveredCategories\.length === 0/,
    'the desktop review blocks empty, incomplete, omitted-category, or legacy unknown-coverage previews');
  assert.match(server,/canSync:\s*coverageKnown && filteredRateCards\.length > 0 && missingCategories\.length === 0 && uncoveredCategories\.length === 0/,
    'the standalone review blocks empty, incomplete, omitted-category, or legacy unknown-coverage previews');
  const renderer=fs.readFileSync(new URL('../ui/renderer.js',import.meta.url),'utf8');
  assert.match(renderer,/extraction omitted configured categories/,
    'review logs explain when a configured category was excluded from the selected extraction scope');
  assert.match(renderer,/Local extraction is available, but PostgreSQL comparison failed/,
    'a comparison contract failure keeps staged rate cards visible and explains the blocked publication');
  assert.match(renderer,/currentComparisonAvailable \? 'Active \/ Matched' : 'Uncompared'/,
    'uncompared staged values are never presented as unchanged PostgreSQL rates');
  assert.match(renderer,/for\s*\(const fee of pickPackFees\)/,'unchanged observed FBF pick-and-pack fees are visible in review');
});

test('installed-package smoke harness imports its evidence writer', () => {
  const smoke=fs.readFileSync(new URL('../packagedSmoke.js',import.meta.url),'utf8');
  assert.match(smoke,/import fs from ['"]node:fs['"];/,'the installed smoke harness must be able to write its JSON result and screenshot');
  assert.match(smoke,/window\.show\(\)/,'the smoke harness makes the installed host window visible before Chromium screenshot capture');
  assert.ok(smoke.indexOf('if (!fs.existsSync(outputDirectory)) fs.mkdirSync(outputDirectory') < smoke.indexOf('fs.writeFileSync(`${output}.png`'),'the output directory exists before screenshot evidence is written');
  const browser=fs.readFileSync(new URL('../embeddedBrowser.js',import.meta.url),'utf8');
  assert.match(browser,/capturePage\(undefined,\s*\{\s*stayAwake:\s*true\s*\}\)/,'live browser diagnostics allow Electron to reveal hidden contents while capturing');
});

test('rate-card detail rows follow the selected fee filter', () => {
  const renderer=fs.readFileSync(new URL('../ui/renderer.js',import.meta.url),'utf8');
  assert.match(renderer,/changeFilterByTable\[change\.table\].*changeFilterByTable\[change\.type\]/s,'changed detail rows map backend table names and local fee types to the active filter');
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
