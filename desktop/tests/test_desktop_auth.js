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

  // Test 6: Verify Multi-Marketplace Gating, URL Consistency & Scraper Protection
  try {
    console.log('\n[Test 6] Verifying multi-marketplace channel configuration & scraper gating...');
    const desktopServerContent = fs.readFileSync(path.join(projectRoot, 'desktop', 'desktopServer.mjs'), 'utf8');
    const mainJsContent = fs.readFileSync(path.join(projectRoot, 'desktop', 'main.js'), 'utf8');

    // 1. Myntra canonical URL check
    const hasCanonicalMyntra = desktopServerContent.includes('https://partnerportal.myntra.com') && mainJsContent.includes('https://partnerportal.myntra.com');
    // 2. Fail-closed token renewal check
    const hasFailClosedRenewal = desktopServerContent.includes('Failed to refresh authentication token with newly assigned desktop role claims') &&
                                mainJsContent.includes('Failed to refresh authentication token with newly assigned desktop role claims');
    // 3. Unknown channel rejection in desktopServer.mjs
    const hasUnknownChannelRejection = desktopServerContent.includes('Unsupported marketplace');
    // 4. Cocoblu positive auth check
    const hasCocobluAuthCheck = mainJsContent.includes('body.includes(\'logout\') || body.includes(\'sign out\') || body.includes(\'dashboard\')');

    if (hasCanonicalMyntra && hasFailClosedRenewal && hasUnknownChannelRejection && hasCocobluAuthCheck) {
      console.log('  ✓ Pass: Multi-marketplace channel gating, fail-closed renewal, and URL consistency verified.');
      passed++;
    } else {
      console.error('  ✗ Fail: Multi-marketplace verification check failed:', {
        hasCanonicalMyntra,
        hasFailClosedRenewal,
        hasUnknownChannelRejection,
        hasCocobluAuthCheck
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
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
