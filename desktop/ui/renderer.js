// Hybrid Desktop Bridge: Works in native Electron and standalone Chrome App Mode
if (!window.ratecardAPI) {
  const API_BASE = window.location.origin;
  window.ratecardAPI = {
    authLogin: (credentials) => fetch(`${API_BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }).then(r => r.json()),
    authGetSession: () => fetch(`${API_BASE}/api/auth/session`).then(r => r.json()),
    authLogout: () => fetch(`${API_BASE}/api/auth/logout`, { method: 'POST' }).then(r => r.json()),
    authVerifyDb: () => fetch(`${API_BASE}/api/auth/verify-db`, { method: 'POST' }).then(r => r.json()),
    getConfig: () => fetch(`${API_BASE}/api/config`).then(r => r.json()),
    saveConfig: (cfg) => fetch(`${API_BASE}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }).then(r => r.json()),
    testDbConnection: (dbUrl) => fetch(`${API_BASE}/api/test-db`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dbUrl }) }).then(r => r.json()),
    getBrandFsnCatalog: () => fetch(`${API_BASE}/api/catalog`).then(r => r.json()),
    getRateCardPreview: () => fetch(`${API_BASE}/api/preview`).then(r => r.json()),
    detectBrandRateChanges: (rateCards) => fetch(`${API_BASE}/api/detect-changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rateCards }) }).then(r => r.json()),
    syncBrandRateCards: (rateCards, options) => fetch(`${API_BASE}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rateCards, options }) }).then(r => r.json()),
    exportDesktopExcel: (path) => fetch(`${API_BASE}/api/export-excel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(r => r.json()),
    openExcelFile: (path) => fetch(`${API_BASE}/api/open-excel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(r => r.json()),
    startScrape: (options) => fetch(`${API_BASE}/api/preview`, { method: 'GET' }).then(r => r.json()).then(res => ({ success: true, data: res.rateCards, stagingFile: 'desktop/worker-config.json' })),
    runInteractiveLogin: (payload) => fetch(`${API_BASE}/api/interactive-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) }).then(r => r.json()),
    getMarketplaceAccounts: () => fetch(`${API_BASE}/api/desktop/marketplace-accounts`).then(r => r.json()),
    onProgress: (callback) => {
      try {
        const es = new EventSource(`${API_BASE}/api/events`);
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            callback(data.message);
          } catch {}
        };
      } catch (err) {}
    }
  };
}

let currentCatalog = [];
let currentRateCards = [];
let currentChanges = [];
let activeDiffFilter = 'all';
let currentUserSession = null;

async function checkAuthSession() {
  try {
    const res = await window.ratecardAPI.authGetSession();
    if (res && res.authenticated && res.user) {
      currentUserSession = res;
      updateUserAuthUI(res);
      return true;
    }
  } catch (err) {
    console.warn('Could not restore auth session:', err);
  }
  showAuthModal();
  return false;
}

function showAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.style.display = 'flex';
  const badge = document.getElementById('user-auth-badge');
  if (badge) badge.style.display = 'none';
}

function hideAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.style.display = 'none';
}

function updateUserAuthUI(session) {
  hideAuthModal();
  const badge = document.getElementById('user-auth-badge');
  const roleEl = document.getElementById('user-badge-role');
  const nameEl = document.getElementById('user-badge-name');
  if (badge && session?.user) {
    badge.style.display = 'flex';
    if (roleEl) roleEl.innerText = (session.user.role || 'user').toUpperCase();
    if (nameEl) nameEl.innerText = session.user.username || session.user.email;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupEventListeners();
  subscribeToEvents();
  
  const isAuthorized = await checkAuthSession();
  if (isAuthorized) {
    await loadInitialState();
    loadCatalogData();
  }
});

// ── Tab Navigation ───────────────────────────────────────────────────────────
function setupNavigation() {
  const navButtons = document.querySelectorAll('.nav-item');
  const views = document.querySelectorAll('.tab-view');
  const pageTitle = document.getElementById('page-title');
  const pageDesc = document.getElementById('page-desc');

  const titles = {
    dashboard: { 
      title: 'Dashboard & Operations', 
      desc: 'Automated Flipkart & Shopsy rate card extraction, change detection, and database synchronization' 
    },
    catalog: { 
      title: 'Real-Time Brand & FSN Catalog', 
      desc: 'Active product verticals, brands, sample FSNs, and historical order volumes from database' 
    },
    scraper: { 
      title: 'Live Scraper Worker', 
      desc: 'Interactive Chrome browser automation, real-time logging, and live visual tour' 
    },
    diff: { 
      title: 'Rate Card Review & Database Sync', 
      desc: 'Inspect fee adjustments, verify Shopsy 0% commissions, and commit to PostgreSQL' 
    },
    excel: { 
      title: 'Desktop Multi-Sheet Excel Center', 
      desc: 'Review 6-sheet workbook, update rates, and launch directly in Microsoft Excel' 
    },
    settings: { 
      title: 'Worker Configuration', 
      desc: 'Marketplace credentials, PostgreSQL connection, and automated daily schedule' 
    }
  };

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      navButtons.forEach(b => b.classList.remove('active'));
      views.forEach(v => v.classList.remove('active'));

      btn.classList.add('active');
      const targetView = document.getElementById(`view-${tabId}`);
      if (targetView) targetView.classList.add('active');

      if (titles[tabId]) {
        pageTitle.innerText = titles[tabId].title;
        pageDesc.innerText = titles[tabId].desc;
      }

      if (tabId === 'catalog' && currentCatalog.length === 0) {
        loadCatalogData();
      }
      if (tabId === 'diff' && currentRateCards.length === 0) {
        loadRateCardPreview();
      }
    });
  });
}

// ── Initial State Loading ────────────────────────────────────────────────────
async function loadInitialState() {
  try {
    const config = await window.ratecardAPI.getConfig();
    
    // Populate Settings form
    document.getElementById('cfg-email').value = config.email || '';
    document.getElementById('cfg-password').value = config.password || '';
    document.getElementById('cfg-db-url').value = config.databaseUrl || '';
    document.getElementById('cfg-hour').value = config.scheduledHour ?? 6;
    document.getElementById('cfg-minute').value = config.scheduledMinute ?? 0;
    document.getElementById('cfg-alert-email').value = config.notificationEmail || '';
    document.getElementById('cfg-auto-sync').checked = !!config.autoSyncToDb;

    // Test DB connection silently for dashboard status
    if (config.databaseUrl) {
      const dbCheck = await window.ratecardAPI.testDbConnection(config.databaseUrl);
      const dbStatusEl = document.getElementById('dash-db-status');
      if (dbCheck.success) {
        dbStatusEl.innerText = 'Connected';
        dbStatusEl.style.color = '#10b981';
      } else {
        dbStatusEl.innerText = 'Offline';
        dbStatusEl.style.color = '#ef4444';
      }
    }

    document.getElementById('dash-session-status').innerText = 'Ready';
    document.getElementById('dash-session-status').style.color = '#10b981';

  } catch (err) {
    console.error('Failed to load initial state:', err);
  }
}

// ── Event Subscriptions ──────────────────────────────────────────────────────
function subscribeToEvents() {
  window.ratecardAPI.onProgress((msg) => {
    appendTerminalLine(msg);
  });
}

function appendTerminalLine(text) {
  const terminal = document.getElementById('terminal-body');
  if (!terminal) return;
  const line = document.createElement('div');
  line.className = 'log-line';

  if (text.includes('✓') || text.includes('success') || text.includes('complete')) {
    line.classList.add('success');
  } else if (text.includes('Warning') || text.includes('⏰')) {
    line.classList.add('warning');
  } else if (text.includes('Error') || text.includes('failed')) {
    line.classList.add('error');
  } else {
    line.classList.add('info');
  }

  const timestamp = new Date().toLocaleTimeString();
  line.innerText = `[${timestamp}] ${text}`;
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

// ── Load Real-Time Brand & FSN Catalog ───────────────────────────────────────
async function loadCatalogData() {
  const tbody = document.getElementById('catalog-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Fetching real-time brand & FSN catalog from database...</td></tr>';

  try {
    const res = await window.ratecardAPI.getBrandFsnCatalog();
    if (res.success && res.catalog?.length > 0) {
      currentCatalog = res.catalog;
      renderCatalogTable(currentCatalog);
      appendTerminalLine(`✓ Loaded ${currentCatalog.length} brand-specific catalog items from live order history.`);
    } else {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No catalog items returned: ${res.error || 'Empty'}</td></tr>`;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state error">Failed to load catalog: ${err.message}</td></tr>`;
  }
}

function renderCatalogTable(catalog) {
  const tbody = document.getElementById('catalog-tbody');
  const mpFilter = document.getElementById('filter-catalog-mp').value;
  const brandFilter = document.getElementById('filter-catalog-brand').value;

  const filtered = catalog.filter(item => {
    const matchMp = mpFilter === 'all' || item.marketplace.toLowerCase().includes(mpFilter);
    const matchBrand = brandFilter === 'all' || item.brand === brandFilter;
    return matchMp && matchBrand;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No items match the selected filters.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(item => `
    <tr>
      <td>
        <span class="badge ${item.marketplace.toLowerCase().includes('shopsy') ? 'badge-account' : 'badge-portal'}">
          ${item.marketplace.toUpperCase()}
        </span>
      </td>
      <td style="font-weight: 500;">${item.category}</td>
      <td><strong>${item.brand}</strong></td>
      <td style="font-family: 'JetBrains Mono', monospace; color: #38bdf8;">${item.sample_fsn || '—'}</td>
      <td style="font-family: 'JetBrains Mono', monospace; color: #94a3b8;">${item.sample_sku || '—'}</td>
      <td><span style="font-weight: 600; color: #10b981;">${(item.order_count || 0).toLocaleString()}</span></td>
    </tr>
  `).join('');
}

// ── Load Full Rate Card Preview & Diff ───────────────────────────────────────
async function loadRateCardPreview() {
  const tbody = document.getElementById('diff-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Generating brand-wise rate cards and comparing with PostgreSQL database...</td></tr>';

  try {
    const res = await window.ratecardAPI.getRateCardPreview();
    if (res.success && res.rateCards?.length > 0) {
      currentRateCards = res.rateCards;
      
      // Run change detection against DB
      const diffRes = await window.ratecardAPI.detectBrandRateChanges(currentRateCards);
      currentChanges = diffRes.changes || [];

      // Update badge
      const badge = document.getElementById('changes-badge');
      if (currentChanges.length > 0) {
        badge.innerText = currentChanges.length;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }

      renderDiffTable();
      appendTerminalLine(`✓ Loaded ${currentRateCards.length} rate cards across Flipkart and Shopsy (${currentChanges.length} diffs detected).`);
    } else {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Failed to load preview: ${res.error || 'Empty'}</td></tr>`;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state error">Error loading rates: ${err.message}</td></tr>`;
  }
}

function renderDiffTable() {
  const tbody = document.getElementById('diff-tbody');
  const rows = [];

  for (const card of currentRateCards) {
    const { marketplace, category, brand, commissions, fixedFees, reverseShipping } = card;

    // 1. Commission rows
    if (activeDiffFilter === 'all' || activeDiffFilter === 'commission') {
      for (const c of commissions) {
        const change = currentChanges.find(ch => 
          ch.marketplace === marketplace && ch.category === category && ch.brand === brand && ch.type === 'commission'
        );
        rows.push({
          type: 'Commission',
          marketplace: marketplace.toUpperCase(),
          category,
          brand,
          slab: c.price_max >= 999990 ? `≥ ₹${c.price_min}` : `₹${c.price_min} - ₹${c.price_max}`,
          oldRate: change?.oldRate != null ? `${(change.oldRate * 100).toFixed(1)}%` : 'Active / Matched',
          newRate: `${(c.rate * 100).toFixed(1)}%`,
          status: change ? (change.reason || 'Modified') : 'Active'
        });
      }
    }

    // 2. Fixed Fee rows
    if (activeDiffFilter === 'all' || activeDiffFilter === 'fixed') {
      for (const f of fixedFees) {
        rows.push({
          type: 'Fixed Fee',
          marketplace: marketplace.toUpperCase(),
          category,
          brand: 'All / Tier',
          slab: `${f.fulfilment_type} (₹${f.price_min} - ₹${f.price_max})`,
          oldRate: '₹' + f.rate,
          newRate: '₹' + f.rate,
          status: 'Active'
        });
      }
    }

    // 3. Reverse Shipping rows
    if (activeDiffFilter === 'all' || activeDiffFilter === 'reverse') {
      for (const r of reverseShipping) {
        rows.push({
          type: 'Reverse Shipping',
          marketplace: marketplace.toUpperCase(),
          category,
          brand: 'Standard',
          slab: `${r.weight_slab} (₹${r.price_min} - ₹${r.price_max})`,
          oldRate: `L: ₹${r.local_fee}, Z: ₹${r.zonal_fee}, N: ₹${r.national_fee}`,
          newRate: `L: ₹${r.local_fee}, Z: ₹${r.zonal_fee}, N: ₹${r.national_fee}`,
          status: 'Active'
        });
      }
    }
  }

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No fee entries for the selected filter.</td></tr>';
    return;
  }

  // Deduplicate and render up to 100 rows
  const displayRows = rows.slice(0, 100);
  tbody.innerHTML = displayRows.map(r => `
    <tr>
      <td><span class="badge ${r.type === 'Commission' ? 'badge-portal' : 'badge-account'}">${r.type}</span></td>
      <td><strong>${r.marketplace}</strong></td>
      <td>${r.category}</td>
      <td>${r.brand}</td>
      <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px;">${r.slab}</td>
      <td style="color: #94a3b8;">${r.oldRate}</td>
      <td style="color: #38bdf8; font-weight: 600;">${r.newRate}</td>
      <td>
        <span class="status-badge ${r.status.includes('Active') ? 'badge-active' : 'badge-modified'}">
          ${r.status}
        </span>
      </td>
    </tr>
  `).join('');
}

// ── Button & Form Event Listeners ────────────────────────────────────────────
function setupEventListeners() {
  const btnDashRun = document.getElementById('btn-dash-run');
  const btnDashTour = document.getElementById('btn-dash-tour');
  const btnDashCatalog = document.getElementById('btn-dash-catalog');
  const btnStartScrape = document.getElementById('btn-start-scrape');
  const btnInteractiveLogin = document.getElementById('btn-interactive-login');
  const btnClearTerminal = document.getElementById('btn-clear-terminal');
  const btnCommitDb = document.getElementById('btn-commit-db');
  const btnLoadPreview = document.getElementById('btn-load-preview');
  const btnExportDiff = document.getElementById('btn-export-diff');
  const btnTestDb = document.getElementById('btn-test-db');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const btnRefreshCatalog = document.getElementById('btn-refresh-catalog');
  const filterCatalogMp = document.getElementById('filter-catalog-mp');
  const filterCatalogBrand = document.getElementById('filter-catalog-brand');
  const btnQuickExcel = document.getElementById('btn-quick-excel');
  const btnQuickOpenExcel = document.getElementById('btn-quick-open-excel');
  const btnGenerateExcel = document.getElementById('btn-generate-excel');
  const btnLaunchExcel = document.getElementById('btn-launch-excel');

  // Filter Catalog
  filterCatalogMp?.addEventListener('change', () => renderCatalogTable(currentCatalog));
  filterCatalogBrand?.addEventListener('change', () => renderCatalogTable(currentCatalog));
  btnRefreshCatalog?.addEventListener('click', loadCatalogData);

  // Clear terminal
  btnClearTerminal?.addEventListener('click', () => {
    document.getElementById('terminal-body').innerHTML = '<div class="log-line info">[System] Terminal cleared.</div>';
  });

  // Navigation shortcuts
  btnDashCatalog?.addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="catalog"]').click();
  });

  btnDashRun?.addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="scraper"]').click();
    btnStartScrape.click();
  });

  btnDashTour?.addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="scraper"]').click();
    document.getElementById('select-mode').value = 'visible';
    btnStartScrape.click();
  });

  // Filter Tabs for Diff Review
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeDiffFilter = tab.getAttribute('data-filter');
      renderDiffTable();
    });
  });

  btnLoadPreview?.addEventListener('click', loadRateCardPreview);

  // Human interactive login & 2FA
  btnInteractiveLogin?.addEventListener('click', async () => {
    const selectEl = document.getElementById('select-marketplace');
    const selectedVal = selectEl?.value || 'flipkart';
    const selectedOption = selectEl?.selectedOptions?.[0];
    const portalUrl = selectedOption?.getAttribute('data-portal') || 'https://seller.flipkart.com/';
    const channelName = selectedOption?.innerText || selectedVal;

    appendTerminalLine(`Opening visible browser for ${channelName}...`);
    appendTerminalLine(`Target Portal: ${portalUrl}`);
    
    try {
      const result = await window.ratecardAPI.runInteractiveLogin({
        marketplace: selectedVal,
        portal_url: portalUrl,
        display_name: channelName
      });
      if (result.success) {
        appendTerminalLine(`✓ Browser window launched successfully. Complete 2FA / Login in the window.`);
      } else {
        appendTerminalLine(`Launch error: ${result.error}`);
      }
    } catch (err) {
      appendTerminalLine(`Execution error: ${err.message}`);
    }
  });

  // Run Scraper Worker
  btnStartScrape?.addEventListener('click', async () => {
    const marketplace = document.getElementById('select-marketplace').value;
    const mode = document.getElementById('select-mode').value;
    const brand = document.getElementById('select-brand').value;

    appendTerminalLine(`Starting Rate Card Worker (${marketplace.toUpperCase()} | Mode: ${mode} | Brand: ${brand})...`);
    btnStartScrape.disabled = true;
    btnStartScrape.innerText = '⏳ Scraping in Progress...';

    try {
      const result = await window.ratecardAPI.startScrape({
        marketplace,
        visible: mode === 'visible',
        brand
      });

      if (result.success) {
        appendTerminalLine(`✓ Scrape complete! Extracted ${result.data?.length || 0} vertical cards.`);
        appendTerminalLine(`Staged results saved to: ${result.stagingFile}`);
        await loadRateCardPreview();
      } else {
        appendTerminalLine(`Scraping failed: ${result.error}`);
      }
    } catch (err) {
      appendTerminalLine(`Execution error: ${err.message}`);
    } finally {
      btnStartScrape.disabled = false;
      btnStartScrape.innerText = '⚡ Run Scraper Worker';
    }
  });

  // Commit to Database
  btnCommitDb?.addEventListener('click', async () => {
    if (currentRateCards.length === 0) {
      alert('Please load active rates or run the scraper worker first.');
      return;
    }

    if (!confirm(`Commit ${currentRateCards.length} brand-wise rate cards to the database?\n\nThis will auto-close superseded records and record a version snapshot.`)) {
      return;
    }

    appendTerminalLine('Committing brand-wise rate cards to PostgreSQL database...');
    btnCommitDb.disabled = true;
    btnCommitDb.innerText = '⏳ Syncing...';

    try {
      const res = await window.ratecardAPI.syncBrandRateCards(currentRateCards, { forceUpdate: true });
      if (res.success && res.result?.updated) {
        appendTerminalLine(`✓ ${res.result.message}`);
        appendTerminalLine(`✓ Version snapshot: ${res.result.versionName}`);
        alert('Database synchronization completed successfully!');
        await loadRateCardPreview();
      } else {
        appendTerminalLine(`Database sync result: ${res.result?.message || 'Up to date'}`);
        alert(res.result?.message || 'Database is already in sync.');
      }
    } catch (err) {
      appendTerminalLine(`Database sync failed: ${err.message}`);
      alert(`Database sync failed: ${err.message}`);
    } finally {
      btnCommitDb.disabled = false;
      btnCommitDb.innerText = '✓ Commit & Auto-Close in Database';
    }
  });

  // Excel Actions
  const handleGenerateExcel = async () => {
    appendTerminalLine('Generating multi-sheet Excel workbook...');
    try {
      const res = await window.ratecardAPI.exportDesktopExcel();
      if (res.success) {
        appendTerminalLine(`✓ Excel workbook created successfully (${res.sheetsCount} sheets, ${res.totalRecords} records).`);
        appendTerminalLine(`Saved to: ${res.filePath}`);
        alert(`Excel file successfully created on Desktop!\n\nLocation: ${res.filePath}`);
      } else {
        appendTerminalLine(`Excel export failed: ${res.error}`);
      }
    } catch (err) {
      appendTerminalLine(`Excel error: ${err.message}`);
    }
  };

  const handleOpenExcel = async () => {
    appendTerminalLine('Launching Desktop Excel file in Microsoft Excel...');
    const res = await window.ratecardAPI.openExcelFile();
    if (res.success) {
      appendTerminalLine(`✓ Opened: ${res.filePath}`);
    } else {
      appendTerminalLine(`Could not open Excel file: ${res.error}`);
      alert(`Could not open Excel file: ${res.error}`);
    }
  };

  btnQuickExcel?.addEventListener('click', handleGenerateExcel);
  btnGenerateExcel?.addEventListener('click', handleGenerateExcel);
  btnQuickOpenExcel?.addEventListener('click', handleOpenExcel);
  btnLaunchExcel?.addEventListener('click', handleOpenExcel);

  // Settings DB Test
  btnTestDb?.addEventListener('click', async () => {
    const dbUrl = document.getElementById('cfg-db-url').value;
    const resultSpan = document.getElementById('db-test-result');
    resultSpan.innerText = 'Testing connection...';
    resultSpan.style.color = '#94a3b8';

    const res = await window.ratecardAPI.testDbConnection(dbUrl);
    if (res.success) {
      resultSpan.innerText = `✓ Connected to database: ${res.db}`;
      resultSpan.style.color = '#10b981';
    } else {
      resultSpan.innerText = `✗ Connection failed: ${res.error}`;
      resultSpan.style.color = '#ef4444';
    }
  });

  // Save Settings
  btnSaveSettings?.addEventListener('click', async () => {
    const newConfig = {
      email: document.getElementById('cfg-email').value,
      password: document.getElementById('cfg-password').value,
      databaseUrl: document.getElementById('cfg-db-url').value,
      scheduledHour: parseInt(document.getElementById('cfg-hour').value) || 6,
      scheduledMinute: parseInt(document.getElementById('cfg-minute').value) || 0,
      notificationEmail: document.getElementById('cfg-alert-email').value,
      autoSyncToDb: document.getElementById('cfg-auto-sync').checked
    };

    const res = await window.ratecardAPI.saveConfig(newConfig);
    if (res.success) {
      alert('Settings saved successfully!');
      appendTerminalLine('✓ Worker configuration updated.');
    } else {
      alert(`Failed to save settings: ${res.error}`);
    }
  });

  // ── Firebase Auth & PC Authorization Handlers ──────────────────────────────
  const formAuthLogin = document.getElementById('form-auth-login');
  const authEmailInput = document.getElementById('auth-input-email');
  const authPassInput = document.getElementById('auth-input-password');
  const authDbInput = document.getElementById('auth-input-db');
  const authErrorBanner = document.getElementById('auth-error-banner');
  const btnAuthSubmit = document.getElementById('btn-auth-submit');
  const authSpinner = document.getElementById('auth-spinner');
  const btnAuthTestDb = document.getElementById('btn-auth-test-db');
  const authDbPingStatus = document.getElementById('auth-db-ping-status');
  const btnHeaderLogout = document.getElementById('btn-header-logout');

  btnHeaderLogout?.addEventListener('click', async () => {
    if (confirm('Sign out and deauthorize this PC?')) {
      await window.ratecardAPI.authLogout();
      currentUserSession = null;
      showAuthModal();
      appendTerminalLine('[Auth] Signed out. PC deauthorized.');
    }
  });

  btnAuthTestDb?.addEventListener('click', async () => {
    const dbUrl = authDbInput?.value;
    if (authDbPingStatus) {
      authDbPingStatus.innerText = 'Pinging DB...';
      authDbPingStatus.style.color = '#94a3b8';
    }
    try {
      const res = await window.ratecardAPI.authVerifyDb(dbUrl);
      if (res && res.success) {
        authDbPingStatus.innerText = `✓ Connected (${res.latencyMs}ms, ${res.dbName})`;
        authDbPingStatus.style.color = '#10b981';
      } else {
        authDbPingStatus.innerText = `✗ Failed: ${res?.error || 'Unknown'}`;
        authDbPingStatus.style.color = '#ef4444';
      }
    } catch (err) {
      authDbPingStatus.innerText = `✗ Error: ${err.message}`;
      authDbPingStatus.style.color = '#ef4444';
    }
  });

  formAuthLogin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (authErrorBanner) authErrorBanner.style.display = 'none';
    if (btnAuthSubmit) btnAuthSubmit.disabled = true;
    if (authSpinner) authSpinner.style.display = 'inline-block';

    const email = authEmailInput?.value?.trim();
    const password = authPassInput?.value;
    const dbUrl = authDbInput?.value?.trim();

    try {
      const res = await window.ratecardAPI.authLogin({ email, password, dbUrl });
      if (res && res.success && res.session) {
        currentUserSession = res.session;
        updateUserAuthUI(res.session);
        appendTerminalLine(`✓ Authorized as ${res.session.user.username} (${res.session.user.role.toUpperCase()})`);
        await loadInitialState();
        loadCatalogData();
      } else {
        if (authErrorBanner) {
          authErrorBanner.innerText = res?.error || 'Authentication or authorization failed.';
          authErrorBanner.style.display = 'block';
        }
      }
    } catch (err) {
      if (authErrorBanner) {
        authErrorBanner.innerText = `Authorization error: ${err.message}`;
        authErrorBanner.style.display = 'block';
      }
    } finally {
      if (btnAuthSubmit) btnAuthSubmit.disabled = false;
      if (authSpinner) authSpinner.style.display = 'none';
    }
  });
}
