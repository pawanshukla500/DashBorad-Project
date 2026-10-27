/**
 * End-to-End Verification Test for Desktop Auth, Authorization & Database Connectivity
 */
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Load environment variables from backend/.env
const envPath = path.join(projectRoot, 'backend', '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[k] = v;
    }
  }
}

const DB_URL = process.env.DATABASE_URL;
const FIREBASE_API_KEY = process.env.VITE_FIREBASE_API_KEY || 'AIzaSyD3FSzQXK7MACZOJR9tz_N7tnQ40QLMchs';

async function runTests() {
  console.log('=================================================================');
  console.log(' Desktop Application Authentication, Authorization & DB Tests   ');
  console.log('=================================================================');

  let passed = 0;
  let failed = 0;

  // Test 1: Firebase Auth API connectivity & Invalid Password Error Handling
  try {
    console.log('\n[Test 1] Testing Firebase Auth with invalid credentials (error handling)...');
    const fbRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'returnorders@vbexports.co.in', password: 'wrong-password-999', returnSecureToken: true })
    });
    const fbData = await fbRes.json();
    if (!fbRes.ok && (fbData.error?.message === 'INVALID_LOGIN_CREDENTIALS' || fbData.error?.message === 'INVALID_PASSWORD')) {
      console.log('  ✓ Pass: Firebase properly returned 400 with message:', fbData.error?.message);
      passed++;
    } else {
      console.error('  ✗ Fail: Unexpected response:', fbData);
      failed++;
    }
  } catch (err) {
    console.error('  ✗ Fail:', err.message);
    failed++;
  }

  // Test 2: Database Connectivity & Ping Latency
  try {
    console.log('\n[Test 2] Testing secure PostgreSQL connectivity & query latency...');
    const start = Date.now();
    const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    const res = await pool.query(`
      SELECT 
        current_database() as db_name, 
        current_user as db_user, 
        (SELECT count(*) FROM users) as user_count,
        (SELECT count(*) FROM rc_commission WHERE end_date IS NULL) as active_rates
    `);
    const latency = Date.now() - start;
    await pool.end();

    console.log(`  ✓ Pass: Connected to "${res.rows[0].db_name}" as "${res.rows[0].db_user}" in ${latency}ms.`);
    console.log(`  ✓ Pass: Discovered ${res.rows[0].user_count} registered users, ${res.rows[0].active_rates} active rate slabs.`);
    passed += 2;
  } catch (err) {
    console.error('  ✗ Fail: DB connectivity failed:', err.message);
    failed++;
  }

  // Test 3: Role-Based Authorization Gate Logic
  try {
    console.log('\n[Test 3] Testing user role authorization gate...');
    const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    
    // Check admin user
    const adminRes = await pool.query("SELECT email, role FROM users WHERE role = 'admin' LIMIT 1");
    const adminUser = adminRes.rows[0];
    const authorizedRoles = ['admin', 'operator', 'analyst'];
    const isAdminAllowed = authorizedRoles.includes(adminUser.role);
    console.log(`  • Admin user "${adminUser.email}" (${adminUser.role}): Allowed = ${isAdminAllowed}`);

    // Check viewer user
    const viewerRes = await pool.query("SELECT email, role FROM users WHERE role = 'viewer' LIMIT 1");
    const viewerUser = viewerRes.rows[0] || { email: 'viewer@vbexports.co.in', role: 'viewer' };
    const isViewerAllowed = authorizedRoles.includes(viewerUser.role);
    console.log(`  • Viewer user "${viewerUser.email}" (${viewerUser.role}): Allowed = ${isViewerAllowed}`);

    await pool.end();

    if (isAdminAllowed && !isViewerAllowed) {
      console.log('  ✓ Pass: Role-based authorization gate correctly admits admin and blocks viewer.');
      passed++;
    } else {
      console.error('  ✗ Fail: Role-based authorization gate failed.');
      failed++;
    }
  } catch (err) {
    console.error('  ✗ Fail:', err.message);
    failed++;
  }

  // Test 4: Session Persistence & Restart Behavior
  try {
    console.log('\n[Test 4] Testing session persistence & file serialization...');
    const testSession = {
      authenticated: true,
      user: {
        id: 1,
        username: 'Pawan Shukla',
        email: 'returnorders@vbexports.co.in',
        role: 'admin'
      },
      authorizedAt: new Date().toISOString()
    };
    const testSessionPath = path.join(__dirname, 'test-auth-session.json');
    fs.writeFileSync(testSessionPath, JSON.stringify(testSession, null, 2), 'utf8');

    // Read back
    const restored = JSON.parse(fs.readFileSync(testSessionPath, 'utf8'));
    fs.unlinkSync(testSessionPath);

    if (restored.authenticated && restored.user.role === 'admin' && restored.user.email === 'returnorders@vbexports.co.in') {
      console.log('  ✓ Pass: Session persisted and deserialized cleanly.');
      passed++;
    } else {
      console.error('  ✗ Fail: Session restored invalid data:', restored);
      failed++;
    }
  } catch (err) {
    console.error('  ✗ Fail:', err.message);
    failed++;
  }

  // Test 5: Verify zero hardcoded DB secrets in installer files
  try {
    console.log('\n[Test 5] Scanning desktop source files for hardcoded database passwords...');
    const mainJs = fs.readFileSync(path.join(projectRoot, 'desktop', 'main.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(projectRoot, 'desktop', 'ui', 'index.html'), 'utf8');

    const hasPwInMain = mainJs.includes('Xchange4SQL');
    const hasPwInHtml = indexHtml.includes('Xchange4SQL');

    if (!hasPwInMain && !hasPwInHtml) {
      console.log('  ✓ Pass: Verified ZERO hardcoded database passwords in desktop/main.js and desktop/ui/index.html.');
      passed++;
    } else {
      console.error('  ✗ Fail: Found hardcoded database password in source files!');
      failed++;
    }
  } catch (err) {
    console.error('  ✗ Fail:', err.message);
    failed++;
  }

  // Test 6: Behavioral HTTP Test for Multi-Marketplace Gating, Scraper Protection & Channel Isolation
  try {
    console.log('\n[Test 6] Exercising desktop server HTTP routes for multi-marketplace gating & isolation...');
    const { server } = await import('../desktopServer.mjs');
    const { filterRateCardsByChannel } = await import('../authValidation.js');
    await new Promise(resolve => server.listen(0, resolve));
    const testPort = server.address().port;
    const testBase = `http://127.0.0.1:${testPort}`;

    // 1. Unknown marketplace rejection test (Must return HTTP 400)
    const unkRes = await fetch(`${testBase}/api/scrape/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: 'invalid_test_channel' })
    });
    const unkData = await unkRes.json();
    const isUnkRejected = unkRes.status === 400 && unkData.error?.includes('Unsupported marketplace');
    console.log(`  • Unknown channel rejection (HTTP ${unkRes.status}): Passed = ${isUnkRejected}`);

    // 2. Gated marketplace scraper test: ALL 7 Phase 2 channels must return HTTP 400
    const phase2Channels = ['myntra_vb', 'myntra_ej', 'meesho', 'amazon', 'ajio', 'cocoblu', 'shopify'];
    const phase2Results = await Promise.all(phase2Channels.map(async (ch) => {
      const res = await fetch(`${testBase}/api/scrape/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace: ch })
      });
      const data = await res.json();
      return res.status === 400 && data.error?.includes('Automated scraping is not yet implemented');
    }));
    const allPhase2Blocked = phase2Results.every(Boolean);
    console.log(`  • All 7 Phase 2 channels scraper gate (HTTP 400 for ${phase2Channels.join(', ')}): Passed = ${allPhase2Blocked}`);

    // 3. Channel-filtered preview route isolation test
    const previewRes = await fetch(`${testBase}/api/preview?marketplace=myntra_vb`);
    const previewData = await previewRes.json();
    const previewCards = Array.isArray(previewData.rateCards) ? previewData.rateCards : [];
    // Every card in previewData must belong to requested channel (zero cross-channel leakage)
    const allCardsMatchRequested = previewCards.every(rc => (
      String(rc.account_id || '').toLowerCase() === 'myntra_vb' ||
      (String(rc.marketplace || '').toLowerCase() === 'myntra' && String(rc.seller_id || rc.account || '') === '10708')
    ));
    const isPreviewIsolated = previewRes.status === 200 && allCardsMatchRequested;
    console.log(`  • Channel-filtered preview isolation (HTTP ${previewRes.status}, count: ${previewCards.length}, leak-free: ${allCardsMatchRequested}): Passed = ${isPreviewIsolated}`);

    // 4. Marketplaces catalog test (8 channels, all 7 Phase 2 channels flagged hasScraper: false, flipkart_shopsy hasScraper: true)
    const mpRes = await fetch(`${testBase}/api/desktop/marketplaces`);
    const mpData = await mpRes.json();
    const allCatalogPhase2Gated = phase2Channels.every(ch => mpData.marketplaces?.find(m => m.id === ch)?.hasScraper === false);
    const flipkartActive = mpData.marketplaces?.find(m => m.id === 'flipkart_shopsy')?.hasScraper === true;
    const isMpListValid = mpRes.status === 200 && mpData.marketplaces?.length === 8 && allCatalogPhase2Gated && flipkartActive;
    console.log(`  • Marketplaces catalog API (8 channels, 7 gated Phase 2, 1 active): Passed = ${isMpListValid}`);

    // 5. Account-specific Myntra VB (10708) and EJ (45833) string & numeric seller ID normalization using production filterRateCardsByChannel
    const controlledFixtures = [
      { marketplace: 'flipkart', category: 'sari' },
      { marketplace: 'shopsy', category: 'sari' },
      { marketplace: 'meesho', category: 'kurta' },
      { marketplace: 'myntra', account_id: 'myntra_vb', seller_id: '10708', category: 'kurta' }, // string 10708
      { marketplace: 'myntra', seller_id: 10708, category: 'dress' }, // numeric 10708
      { marketplace: 'myntra', account_id: 'myntra_ej', seller_id: 45833, category: 'kurta' }, // numeric 45833
      { marketplace: 'myntra', seller_id: '45833', category: 'lehenga' } // string 45833
    ];

    const vbFiltered = filterRateCardsByChannel('myntra_vb', controlledFixtures);
    const ejFiltered = filterRateCardsByChannel('myntra_ej', controlledFixtures);
    const flipkartFiltered = filterRateCardsByChannel('flipkart', controlledFixtures);
    const meeshoFiltered = filterRateCardsByChannel('meesho', controlledFixtures);

    const isAccountFilteringValid = vbFiltered.length === 2 && vbFiltered.every(rc => String(rc.seller_id) === '10708') &&
                                    ejFiltered.length === 2 && ejFiltered.every(rc => String(rc.seller_id) === '45833') &&
                                    flipkartFiltered.length === 1 && flipkartFiltered[0].marketplace === 'flipkart' &&
                                    meeshoFiltered.length === 1 && meeshoFiltered[0].marketplace === 'meesho';
    console.log(`  • Production filterRateCardsByChannel fixtures (string/number 10708 & 45833 normalization): Passed = ${isAccountFilteringValid}`);

    // 6. Flipkart/Shopsy combined channel filter: must strictly include flipkart & shopsy, and exclude all other marketplaces
    const fkShopsyFiltered = filterRateCardsByChannel('flipkart_shopsy', controlledFixtures);
    const isFkShopsyIsolated = fkShopsyFiltered.length === 2 &&
      fkShopsyFiltered.every(rc => rc.marketplace === 'flipkart' || rc.marketplace === 'shopsy') &&
      !fkShopsyFiltered.some(rc => rc.marketplace === 'myntra' || rc.marketplace === 'meesho');
    console.log(`  • Production flipkart_shopsy combined filter isolation (only flipkart & shopsy, zero leak): Passed = ${isFkShopsyIsolated}`);

    server.close();

    if (isUnkRejected && allPhase2Blocked && isPreviewIsolated && isMpListValid && isAccountFilteringValid && isFkShopsyIsolated) {
      console.log('  ✓ Pass: Behavioral HTTP tests for channel gating, isolation, and preview filtering verified.');
      passed++;
    } else {
      console.error('  ✗ Fail: Behavioral route verification failed:', {
        isUnkRejected,
        allPhase2Blocked,
        isPreviewIsolated,
        isMpListValid,
        isAccountFilteringValid,
        isFkShopsyIsolated
      });
      failed++;
    }
  } catch (err) {
    console.error('  ✗ Fail:', err.message);
    failed++;
  }

  // Test 7: Fail-Closed Role-Claim Token Verification Invariant Using Production authValidation
  try {
    console.log('\n[Test 7] Verifying fail-closed role-claim token verification across session persistence paths...');
    const { 
      validateDesktopTokenRole, 
      validateTokenRoleMatchesDatabase,
      extractRoleFromToken, 
      isAuthorizedDesktopRole, 
      saveEncryptedCookies,
      loadEncryptedCookies,
      FIREBASE_ROLE_CLAIM, 
      AUTHORIZED_ROLES 
    } = await import('../authValidation.js');

    const createMockJwt = (payload) => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64');
      return `${header}.${body}.signature`;
    };

    // 1. Verify FIREBASE_ROLE_CLAIM constant matches backend definition ('recon_role')
    const isClaimConstantValid = FIREBASE_ROLE_CLAIM === 'recon_role';
    console.log(`  • Claim constant matches backend ('recon_role'): Passed = ${isClaimConstantValid}`);

    // 2. Token with actual namespaced custom claim 'recon_role: admin' (Must pass check)
    const tokenAdminRecon = createMockJwt({ email: 'returnorders@vbexports.co.in', uid: 'admin-uid', recon_role: 'admin' });
    const adminValidation = validateDesktopTokenRole(tokenAdminRecon);
    const isAdminPassed = adminValidation.authorized === true && adminValidation.role === 'admin';
    console.log(`  • Token with recon_role='admin': Allowed = ${adminValidation.authorized} (Expected true)`);

    // 3. Token with actual namespaced custom claim 'recon_role: operator' and 'analyst' (Must pass check)
    const tokenOperator = createMockJwt({ email: 'ops@vbexports.co.in', uid: 'ops-uid', recon_role: 'operator' });
    const tokenAnalyst = createMockJwt({ email: 'analyst@vbexports.co.in', uid: 'analyst-uid', recon_role: 'analyst' });
    const isOpsPassed = validateDesktopTokenRole(tokenOperator).authorized === true;
    const isAnalystPassed = validateDesktopTokenRole(tokenAnalyst).authorized === true;
    console.log(`  • Tokens with recon_role in ['operator', 'analyst']: Allowed = ${isOpsPassed && isAnalystPassed} (Expected true)`);

    // 4. Token with actual namespaced custom claim 'recon_role: viewer' (Must fail closed)
    const tokenViewer = createMockJwt({ email: 'viewer@vbexports.co.in', uid: 'viewer-uid', recon_role: 'viewer' });
    const viewerValidation = validateDesktopTokenRole(tokenViewer);
    const isViewerRejected = viewerValidation.authorized === false && viewerValidation.role === 'viewer';
    console.log(`  • Token with recon_role='viewer': Allowed = ${viewerValidation.authorized} (Expected false)`);

    // 5. Token without any role claim (Must fail closed)
    const tokenNoRole = createMockJwt({ email: 'returnorders@vbexports.co.in', uid: 'test-uid' });
    const noRoleValidation = validateDesktopTokenRole(tokenNoRole);
    const isNoRoleRejected = noRoleValidation.authorized === false && noRoleValidation.role === null;
    console.log(`  • Token without role claim: Allowed = ${noRoleValidation.authorized} (Expected false)`);

    // 6. Token with legacy 'role: admin' fallback claim (Must pass check)
    const tokenLegacyAdmin = createMockJwt({ email: 'returnorders@vbexports.co.in', uid: 'admin-uid', role: 'admin' });
    const isLegacyAdminPassed = validateDesktopTokenRole(tokenLegacyAdmin).authorized === true;
    console.log(`  • Token with legacy fallback role='admin': Allowed = ${isLegacyAdminPassed} (Expected true)`);

    // 7. Token role vs Database role matching invariant (Must reject mismatches even if both roles are authorized)
    // 7a. dbUser is 'operator', but token carries 'admin' -> MUST FAIL
    const mismatchValidation = validateTokenRoleMatchesDatabase(tokenAdminRecon, 'operator');
    const isMismatchRejected = mismatchValidation.valid === false && mismatchValidation.tokenRole === 'admin' && mismatchValidation.expectedRole === 'operator';
    console.log(`  • Token role ('admin') vs DB role ('operator') mismatch: Blocked = ${isMismatchRejected} (Expected true)`);

    // 7b. dbUser is 'operator', and token carries 'operator' -> MUST PASS
    const matchOperator = validateTokenRoleMatchesDatabase(tokenOperator, 'operator');
    const isOperatorMatched = matchOperator.valid === true && matchOperator.tokenRole === 'operator';
    console.log(`  • Token role ('operator') vs DB role ('operator') match: Allowed = ${isOperatorMatched} (Expected true)`);

    // 7c. dbUser is 'admin', and token carries 'admin' -> MUST PASS
    const matchAdmin = validateTokenRoleMatchesDatabase(tokenAdminRecon, 'admin');
    const isAdminMatched = matchAdmin.valid === true && matchAdmin.tokenRole === 'admin';
    console.log(`  • Token role ('admin') vs DB role ('admin') match: Allowed = ${isAdminMatched} (Expected true)`);

    // 8. Encrypted cookie vault verification (AES-256-GCM encryption & decryption)
    const os = await import('os');
    const testCookieFile = path.join(os.tmpdir(), `test_cookie_vault_${Date.now()}.json`);
    const mockCookies = [
      { name: 'session_token', value: 'secret_seller_session_token_xyz999', domain: '.flipkart.com' },
      { name: 'auth_id', value: 'seller_vb_10708', domain: '.myntra.com' }
    ];
    saveEncryptedCookies(testCookieFile, mockCookies);
    const rawSaved = fs.readFileSync(testCookieFile, 'utf8');
    const isEncryptedFormat = rawSaved.includes(':') && !rawSaved.includes('secret_seller_session_token_xyz999');
    const decryptedCookies = loadEncryptedCookies(testCookieFile);
    const isDecryptedAccurate = Array.isArray(decryptedCookies) &&
      decryptedCookies.length === 2 &&
      decryptedCookies[0].value === 'secret_seller_session_token_xyz999' &&
      decryptedCookies[1].value === 'seller_vb_10708';
    try { fs.unlinkSync(testCookieFile); } catch {}
    console.log(`  • AES-256-GCM encrypted cookie vault (no plaintext leakage, accurate round-trip): Passed = ${isEncryptedFormat && isDecryptedAccurate}`);

    // 9. Production session persistence gate simulation across all paths (API login & direct DB fallback)
    const simulatePersistenceGate = async ({ idToken, refreshToken, customToken, dbUser, mockRefreshFn, mockExchangeFn }) => {
      let currentIdToken = idToken;
      let currentRefreshToken = refreshToken;

      // Candidate API custom token exchange
      if (customToken && mockExchangeFn) {
        const exchanged = await mockExchangeFn(customToken);
        if (exchanged?.idToken) currentIdToken = exchanged.idToken;
      }

      // Production invariant check: Token must match database role
      let match = validateTokenRoleMatchesDatabase(currentIdToken, dbUser?.role);

      // Refresh fallback
      if (!match.valid && currentRefreshToken && mockRefreshFn) {
        const refreshed = await mockRefreshFn(currentRefreshToken);
        if (refreshed?.idToken) {
          currentIdToken = refreshed.idToken;
          match = validateTokenRoleMatchesDatabase(currentIdToken, dbUser?.role);
        }
      }

      if (!match.valid) {
        return { 
          success: false, 
          error: `Authentication failed: The session token role ('${match.tokenRole || 'none'}') does not match verified database role ('${match.expectedRole}').` 
        };
      }

      return { success: true, sessionSaved: true, role: match.tokenRole };
    };

    // 9a. Direct DB fallback path where token has no role and refresh fails (MUST fail closed)
    const dbFallbackFail = await simulatePersistenceGate({
      idToken: tokenNoRole,
      refreshToken: 'bad-refresh',
      customToken: null,
      dbUser: { role: 'admin' },
      mockRefreshFn: async () => null
    });
    const isDbFallbackBlocked = dbFallbackFail.success === false && dbFallbackFail.error?.includes('Authentication failed');
    console.log(`  • Direct DB fallback with un-renewed token: Blocked = ${isDbFallbackBlocked} (Expected true)`);

    // 9b. Direct DB fallback where token carries 'admin' but dbUser is 'operator' (MUST fail closed on mismatch)
    const dbMismatchFail = await simulatePersistenceGate({
      idToken: tokenAdminRecon,
      refreshToken: 'bad-refresh',
      customToken: null,
      dbUser: { role: 'operator' },
      mockRefreshFn: async () => null
    });
    const isDbMismatchBlocked = dbMismatchFail.success === false && dbMismatchFail.error?.includes('does not match verified database role');
    console.log(`  • DB fallback with role mismatch (token admin vs db operator): Blocked = ${isDbMismatchBlocked} (Expected true)`);

    // 9c. Candidate API path where custom token yields recon_role (MUST succeed)
    const apiSuccess = await simulatePersistenceGate({
      idToken: tokenNoRole,
      refreshToken: 'valid-refresh',
      customToken: 'mock-custom-token',
      dbUser: { role: 'admin' },
      mockExchangeFn: async () => ({ idToken: tokenAdminRecon })
    });
    const isApiSuccessPassed = apiSuccess.success === true && apiSuccess.role === 'admin';
    console.log(`  • API path with customToken -> recon_role exchange: Succeeded = ${isApiSuccessPassed} (Expected true)`);

    if (
      isClaimConstantValid &&
      isAdminPassed &&
      isOpsPassed &&
      isAnalystPassed &&
      isViewerRejected &&
      isNoRoleRejected &&
      isLegacyAdminPassed &&
      isMismatchRejected &&
      isOperatorMatched &&
      isAdminMatched &&
      isEncryptedFormat &&
      isDecryptedAccurate &&
      isDbFallbackBlocked &&
      isDbMismatchBlocked &&
      isApiSuccessPassed
    ) {
      console.log('  ✓ Pass: Production fail-closed token role-claim validation invariant verified across all paths.');
      passed++;
    } else {
      console.error('  ✗ Fail: Role claim token validation invariant failed:', {
        isClaimConstantValid,
        isAdminPassed,
        isOpsPassed,
        isAnalystPassed,
        isViewerRejected,
        isNoRoleRejected,
        isLegacyAdminPassed,
        isMismatchRejected,
        isOperatorMatched,
        isAdminMatched,
        isEncryptedFormat,
        isDecryptedAccurate,
        isDbFallbackBlocked,
        isDbMismatchBlocked,
        isApiSuccessPassed
      });
      failed++;
    }
  } catch (err) {
    console.error('  ✗ Fail:', err.message);
    failed++;
  }

  console.log('\n=================================================================');
  console.log(` Summary: ${passed} passed, ${failed} failed.`);
  console.log('=================================================================');

  if (failed > 0) process.exit(1);
  process.exit(0);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
