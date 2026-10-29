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
    getRateCardPreview: (options) => {
      const params = new URLSearchParams(options || {}).toString();
      return fetch(`${API_BASE}/api/preview${params ? '?' + params : ''}`).then(r => r.json());
    },
    detectBrandRateChanges: (rateCards) => fetch(`${API_BASE}/api/detect-changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rateCards }) }).then(r => r.json()),
    syncBrandRateCards: (rateCards, options) => fetch(`${API_BASE}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rateCards, options }) }).then(r => r.json()),
    exportDesktopExcel: (path) => fetch(`${API_BASE}/api/export-excel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(r => r.json()),
    openExcelFile: (path) => fetch(`${API_BASE}/api/open-excel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(r => r.json()),
    startScrape: (options) => fetch(`${API_BASE}/api/scrape/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options || {}) }).then(r => r.json()),
    runInteractiveLogin: (payload) => fetch(`${API_BASE}/api/interactive-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) }).then(r => r.json()),
    getMarketplaces: () => fetch(`${API_BASE}/api/desktop/marketplaces`).then(r => r.json()),
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
    },
    // Auto-update exists only in the installed Electron app; the standalone
    // Chrome mode runs from local files, so these are honest no-ops.
    getUpdateStatus: () => Promise.resolve({ success: true, status: { status: 'unsupported' } }),
    checkForUpdates: () => Promise.resolve({ success: false, error: 'Updates are only available in the installed desktop app.' }),
    installUpdate: () => Promise.resolve({ success: false, error: 'Updates are only available in the installed desktop app.' }),
    onUpdateStatus: () => () => {}
  };
}

let currentCatalog = [];
let currentRateCards = [];
let currentChanges = [];
let activeDiffFilter = 'all';
let currentUserSession = null;
let currentCanSync = false;

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

// ── Auto-Update Banner (installed desktop app) ────────────────────────────────
let updateBannerHideTimer = null;

function applyUpdateBanner(status) {
  const banner = document.getElementById('update-banner');
  const text = document.getElementById('update-banner-text');
  const restartBtn = document.getElementById('btn-update-restart');
  if (!banner || !text || !restartBtn) return;

  if (updateBannerHideTimer) {
    clearTimeout(updateBannerHideTimer);
    updateBannerHideTimer = null;
  }

  const show = (message, showRestart) => {
    text.textContent = message;
    restartBtn.style.display = showRestart ? '' : 'none';
    banner.style.display = 'flex';
  };
  const hide = () => {
    banner.style.display = 'none';
    restartBtn.style.display = 'none';
  };

  const kind = status?.status;
  const version = status?.version ? ` v${status.version}` : '';
  if (kind === 'available') {
    show(`⬇ New app version${version} found — downloading in the background…`, false);
  } else if (kind === 'downloading') {
    const percent = Number.isFinite(status?.percent) ? ` (${status.percent}%)` : '';
    show(`⬇ Downloading app update${version}${percent}…`, false);
  } else if (kind === 'downloaded') {
    show(`✅ App update${version} is ready to install.`, true);
  } else if (kind === 'error') {
    // Transient network failures are expected and retried on the updater's
    // own schedule, so the banner only mentions the failure briefly.
    show('⚠ Update check failed — will retry automatically.', false);
    updateBannerHideTimer = setTimeout(hide, 30 * 1000);
  } else {
    // checking, not-available, idle, unsupported: nothing to surface.
    hide();
  }
}

async function initUpdateBanner() {
  try {
    const res = await window.ratecardAPI.getUpdateStatus();
    if (res?.success) applyUpdateBanner(res.status);
  } catch (err) {
    console.warn('Could not read update status:', err);
  }
  const restartBtn = document.getElementById('btn-update-restart');
  restartBtn?.addEventListener('click', async () => {
    restartBtn.disabled = true;
    restartBtn.textContent = 'Restarting…';
    try {
      const res = await window.ratecardAPI.installUpdate();
      if (!res?.success) {
        restartBtn.disabled = false;
        restartBtn.textContent = 'Restart to Update';
        alert(res?.error || 'The update could not be installed.');
      }
    } catch (err) {
      restartBtn.disabled = false;
      restartBtn.textContent = 'Restart to Update';
      console.warn('Install update failed:', err);
    }
  });
  window.ratecardAPI.onUpdateStatus((status) => applyUpdateBanner(status));
}

document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupEventListeners();
  subscribeToEvents();
  initUpdateBanner();

  const isAuthorized = await checkAuthSession();
  if (isAuthorized) {
    await loadInitialState();
    loadCatalogData();
    loadMarketplaceAccountsUI();
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
    // An analyst-provisioned read-only URL is not usable by privileged roles:
    // show the honest empty state instead of a URL their writes would fail on.
    document.getElementById('cfg-db-url').value = config.databaseUrlRole === 'analyst' ? '' : (config.databaseUrl || '');
    document.getElementById('cfg-hour').value = config.scheduledHour ?? 6;
    document.getElementById('cfg-minute').value = config.scheduledMinute ?? 0;
    document.getElementById('cfg-alert-email').value = config.notificationEmail || '';

    // Test DB connection silently for dashboard status
    const dbStatusEl = document.getElementById('dash-db-status');
    if (config.databaseUrl) {
      const dbCheck = await window.ratecardAPI.testDbConnection(config.databaseUrl);
      if (dbCheck.success) {
        dbStatusEl.innerText = 'Connected';
        dbStatusEl.style.color = '#10b981';
      } else {
        dbStatusEl.innerText = 'Offline';
        dbStatusEl.style.color = '#ef4444';
      }
    } else {
      dbStatusEl.innerText = 'Not Configured';
      dbStatusEl.style.color = '#94a3b8';
    }

    // Reflect the real marketplace session vault instead of a static "Ready" label.
    await loadSessionStatusUI();

  } catch (err) {
    console.error('Failed to load initial state:', err);
  }
}

// ── Marketplace Session Vault Status (real cookie checks, not static labels) ─
const CHANNEL_CARD_IDS = {
  flipkart_shopsy: 'status-ch-flipkart',
  myntra_vb: 'status-ch-myntra-vb',
  myntra_ej: 'status-ch-myntra-ej',
  meesho: 'status-ch-meesho'
};

async function loadSessionStatusUI() {
  const statusEl = document.getElementById('dash-session-status');
  const subEl = document.getElementById('dash-session-sub');
  try {
    const res = await window.ratecardAPI.getMarketplaces();
    const marketplaces = res?.marketplaces || [];

    // Per-channel session cards on the Dashboard
    for (const [channelId, elementId] of Object.entries(CHANNEL_CARD_IDS)) {
      const el = document.getElementById(elementId);
      const mp = marketplaces.find(m => m.id === channelId);
      if (!el || !mp) continue;
      if (mp.hasCookies) {
        el.innerText = `Session Saved (${mp.cookieCount ?? '?'} cookies)`;
        el.style.color = '#10b981';
      } else {
        el.innerText = 'No Session — 2FA Login';
        el.style.color = '#f59e0b';
      }
    }

    // KPI card reflects the vault for the selected scraper channel
    const selectEl = document.getElementById('select-marketplace');
    const channel = selectEl?.value || 'flipkart_shopsy';
    const current = marketplaces.find(m => m.id === channel) || marketplaces.find(m => m.id === 'flipkart_shopsy');
    if (statusEl && subEl) {
      if (current?.hasCookies) {
        statusEl.innerText = 'Session Saved';
        statusEl.style.color = '#10b981';
        const savedAt = current.lastSavedAt ? new Date(current.lastSavedAt).toLocaleString() : '';
        subEl.innerText = `${current.cookieCount ?? 0} cookies for ${current.name || channel}${savedAt ? ' · saved ' + savedAt : ''}`;
      } else {
        statusEl.innerText = 'No Session';
        statusEl.style.color = '#f59e0b';
        subEl.innerText = 'Run 2FA Login to store marketplace cookies for ' + (current?.name || channel);
      }
    }
  } catch (err) {
    for (const elementId of Object.values(CHANNEL_CARD_IDS)) {
      const el = document.getElementById(elementId);
      if (el) {
        el.innerText = 'Status Unknown';
        el.style.color = '#94a3b8';
      }
    }
    if (statusEl) {
      statusEl.innerText = 'Status Unknown';
      statusEl.style.color = '#94a3b8';
    }
    if (subEl) subEl.innerText = 'Could not read the local session vault';
  }
}

// ── Event Subscriptions ──────────────────────────────────────────────────────
function subscribeToEvents() {
  window.ratecardAPI.onProgress((msg) => {
    appendTerminalLine(msg);
    if (typeof msg !== 'string') return;
    // Cookie/session-related progress events may have changed the vault state
    if (/cookie|session|login/i.test(msg)) {
      loadSessionStatusUI();
    }
    // The standalone server completes scrapes asynchronously; refresh the staged preview
    if (/scraping job completed/i.test(msg)) {
      loadRateCardPreview();
    }
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

// Table content comes from the database and scraped portal pages, so every
// interpolated value is escaped and status rows are built with textContent.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function setTableMessage(tbody, colspan, message, isError = false) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.className = isError ? 'empty-state error' : 'empty-state';
  td.textContent = message;
  tr.appendChild(td);
  tbody.replaceChildren(tr);
}

// ── Load Real-Time Brand & FSN Catalog ───────────────────────────────────────
async function loadCatalogData() {
  const tbody = document.getElementById('catalog-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Fetching real-time brand & FSN catalog from database...</td></tr>';
  // Do not keep stale catalog rows available to filter after an empty or failed refresh.
  currentCatalog = [];

  // The Brands KPI must always reflect the real outcome — never stay on "Checking...".
  const brandsCountEl = document.getElementById('dash-brands-count');
  const brandsSubEl = document.getElementById('dash-brands-sub');
  const setBrandsKpi = (value, sub, color) => {
    if (brandsCountEl) {
      brandsCountEl.innerText = value;
      brandsCountEl.style.color = color;
    }
    if (brandsSubEl) brandsSubEl.innerText = sub;
  };

  try {
    const res = await window.ratecardAPI.getBrandFsnCatalog();
    if (res.success && res.catalog?.length > 0) {
      currentCatalog = res.catalog;
      renderCatalogTable(currentCatalog);
      const brands = [...new Set(currentCatalog.map(item => item.brand).filter(Boolean))];
      if (brands.length > 0) {
        setBrandsKpi(`${brands.length} Brand${brands.length === 1 ? '' : 's'}`, brands.join(', '), '#10b981');
      } else {
        setBrandsKpi('None Found', 'No brands in order history', '#94a3b8');
      }
      appendTerminalLine(`✓ Loaded ${currentCatalog.length} brand-specific catalog items from live order history.`);
    } else {
      const reason = res.error || 'Empty catalog returned';
      if (/not configured/i.test(reason)) {
        setBrandsKpi('Not Configured', 'Set the database URL in Settings to load brands', '#94a3b8');
      } else {
        setBrandsKpi('DB Offline', `Catalog unavailable: ${reason}`, '#ef4444');
      }
      setTableMessage(tbody, 6, `No catalog items returned: ${reason}`);
    }
  } catch (err) {
    setBrandsKpi('DB Offline', `Catalog unavailable: ${err.message}`, '#ef4444');
    setTableMessage(tbody, 6, `Failed to load catalog: ${err.message}`, true);
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
          ${escapeHtml(item.marketplace.toUpperCase())}
        </span>
      </td>
      <td style="font-weight: 500;">${escapeHtml(item.category)}</td>
      <td><strong>${escapeHtml(item.brand)}</strong></td>
      <td style="font-family: 'JetBrains Mono', monospace; color: #38bdf8;">${escapeHtml(item.sample_fsn || '—')}</td>
      <td style="font-family: 'JetBrains Mono', monospace; color: #94a3b8;">${escapeHtml(item.sample_sku || '—')}</td>
      <td><span style="font-weight: 600; color: #10b981;">${escapeHtml(Number(item.order_count || 0).toLocaleString())}</span></td>
    </tr>
  `).join('');
}

// ── Load Full Rate Card Preview & Diff ───────────────────────────────────────
// Overlapping previews share module state (channel switched while a slower
// request is still in flight). Only the newest request may write that state:
// a stale response is dropped, so it can never re-enable commit or render
// rate cards for a selection the user has already navigated away from.
let previewRequestSeq = 0;

async function loadRateCardPreview() {
  const requestId = ++previewRequestSeq;
  const tbody = document.getElementById('diff-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Generating brand-wise rate cards and comparing with PostgreSQL database...</td></tr>';

  try {
    const selectEl = document.getElementById('select-marketplace');
    const headerSelect = document.getElementById('header-select-marketplace');
    const selectedChannel = selectEl?.value || headerSelect?.value || 'flipkart_shopsy';
    // Reset BEFORE any await: while the preview request is in flight, staged cards
    // from a previous channel must not stay commit-enabled.
    currentCanSync = false;
    currentRateCards = [];
    currentChanges = [];
    const commitBtn = document.getElementById('btn-commit-db');
    if (commitBtn) commitBtn.disabled = true;
    const changesBadge = document.getElementById('changes-badge');
    if (changesBadge) changesBadge.style.display = 'none';
    const res = await window.ratecardAPI.getRateCardPreview({ marketplace: selectedChannel });
    if (requestId !== previewRequestSeq) return; // superseded by a newer selection
    if (res.success && res.rateCards?.length > 0) {
      const diffRes = await window.ratecardAPI.detectBrandRateChanges(res.rateCards);
      if (requestId !== previewRequestSeq) return; // superseded by a newer selection
      if (!diffRes?.success) throw new Error(diffRes?.error || 'Change detection failed.');
      currentRateCards = res.rateCards;
      currentChanges = diffRes.changes || [];
      // Without a reachable database the staged review still renders, but
      // nothing may be committed: diffs are unknowable and sync would fail.
      currentCanSync = Boolean(res.canSync) && diffRes.dbAvailable !== false;
      if (commitBtn) {
        commitBtn.disabled = !currentCanSync;
        commitBtn.title = !currentCanSync && diffRes.dbAvailable === false
          ? 'Database not reachable. Configure the PostgreSQL URL in Settings to detect changes and commit.'
          : (currentCanSync ? '' : 'Showing generated templates. Run a successful extraction to enable sync.');
      }

      // Update badge
      const badge = document.getElementById('changes-badge');
      if (currentChanges.length > 0) {
        badge.innerText = currentChanges.length;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }

      renderDiffTable();
      appendTerminalLine(`✓ Loaded ${currentRateCards.length} rate cards for channel: ${selectedChannel} (${diffRes.dbAvailable === false ? 'database not reachable — change detection skipped' : currentChanges.length + ' diffs detected'}).`);
    } else {
      currentRateCards = [];
      currentChanges = [];
      const badge = document.getElementById('changes-badge');
      if (badge) badge.style.display = 'none';
      setTableMessage(tbody, 8, res.error ? 'Failed to load preview: ' + res.error : 'No active rate cards configured for ' + selectedChannel + '. Automated scraping active for Flipkart & Shopsy.');
    }
  } catch (err) {
    // A stale request's failure belongs to a selection nobody is looking at
    // anymore: do not clobber the newer preview's state or table.
    if (requestId !== previewRequestSeq) return;
    currentCanSync = false;
    currentRateCards = [];
    currentChanges = [];
    const commitBtn = document.getElementById('btn-commit-db');
    if (commitBtn) commitBtn.disabled = true;
    setTableMessage(tbody, 8, `Error loading rates: ${err.message}`, true);
  }
}

function renderDiffTable() {
  const tbody = document.getElementById('diff-tbody');
  const rows = [];

  for (const card of currentRateCards) {
    const { marketplace, category, brand, commissions, fixedFees, reverseShipping, collectionFees = [] } = card;

    // 1. Commission rows
    if (activeDiffFilter === 'all' || activeDiffFilter === 'commission') {
      for (const c of commissions) {
        // Match changes per slab (count-level records carry no price bounds and
        // legitimately apply to every slab of that brand).
        const change = currentChanges.find(ch =>
          ch.marketplace === marketplace && ch.category === category && ch.brand === brand && ch.type === 'commission' &&
          (ch.priceMin == null ||
            (Math.abs(ch.priceMin - c.price_min) < 0.01 && Math.abs(ch.priceMax - c.price_max) < 1.0))
        );
        rows.push({
          type: 'Commission',
          marketplace: marketplace.toUpperCase(),
          category,
          brand,
          slab: c.price_max >= 999990 ? `≥ ₹${c.price_min}` : `₹${c.price_min} - ₹${c.price_max}`,
          oldRate: change?.oldRate != null ? `${(change.oldRate * 100).toFixed(1)}%` : (change ? '—' : 'Active / Matched'),
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

    // 3. Collection Fee rows (payment charges; staged scrapes commit these)
    if (activeDiffFilter === 'all' || activeDiffFilter === 'collection') {
      const fmtColl = (value, type) => (type === 'pct' ? `${(value * 100).toFixed(2)}%` : `₹${value}`);
      for (const cf of collectionFees) {
        // Match changes per slab so one slab's old/new rates never bleed onto
        // every other slab of that category.
        const change = currentChanges.find(ch =>
          ch.marketplace === marketplace && ch.category === category && ch.type === 'collection_fee' &&
          (ch.priceMin == null ||
            (Math.abs(ch.priceMin - cf.price_min) < 0.01 && Math.abs(ch.priceMax - cf.price_max) < 1.0))
        );
        rows.push({
          type: 'Collection Fee',
          marketplace: marketplace.toUpperCase(),
          category,
          brand: 'All',
          slab: cf.price_max >= 999990 ? `≥ ₹${cf.price_min}` : `₹${cf.price_min} - ₹${cf.price_max}`,
          oldRate: change?.oldRate != null ? change.oldRate : (change ? '—' : 'Active / Matched'),
          newRate: change?.newRate != null ? change.newRate : `Prepaid ${fmtColl(cf.prepaid, cf.prepaid_type)} / Postpaid ${fmtColl(cf.postpaid, cf.postpaid_type)}`,
          status: change ? (change.reason || 'Modified') : 'Active'
        });
      }
    }

    // 4. Reverse Shipping rows
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
      <td><span class="badge ${r.type === 'Commission' ? 'badge-portal' : 'badge-account'}">${escapeHtml(r.type)}</span></td>
      <td><strong>${escapeHtml(r.marketplace)}</strong></td>
      <td>${escapeHtml(r.category)}</td>
      <td>${escapeHtml(r.brand)}</td>
      <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px;">${escapeHtml(r.slab)}</td>
      <td style="color: #94a3b8;">${escapeHtml(r.oldRate)}</td>
      <td style="color: #38bdf8; font-weight: 600;">${escapeHtml(r.newRate)}</td>
      <td>
        <span class="status-badge ${String(r.status).includes('Active') ? 'badge-active' : 'badge-modified'}">
          ${escapeHtml(r.status)}
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

  btnExportDiff?.addEventListener('click', () => {
    if (!currentChanges || currentChanges.length === 0) {
      alert('No rate changes currently displayed to export.');
      return;
    }
    const blob = new Blob([JSON.stringify(currentChanges, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RateCard_Diff_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    appendTerminalLine(`✓ Exported ${currentChanges.length} rate changes to JSON.`);
  });

  // Marketplace Channel Synchronization
  const headerSelectMp = document.getElementById('header-select-marketplace');
  const scraperSelectMp = document.getElementById('select-marketplace');
  const headerBadgeChannel = document.getElementById('header-badge-channel');

  const syncMarketplaceSelection = (val) => {
    if (headerSelectMp) {
      const matchHeader = Array.from(headerSelectMp.options).find(o => o.value === val);
      if (matchHeader) headerSelectMp.value = val;
    }
    if (scraperSelectMp) {
      const matchScraper = Array.from(scraperSelectMp.options).find(o => o.value === val);
      if (matchScraper) scraperSelectMp.value = val;
    }
    if (headerBadgeChannel) {
      const selectedOpt = (scraperSelectMp && Array.from(scraperSelectMp.options).find(o => o.value === val)) ||
                          (headerSelectMp && Array.from(headerSelectMp.options).find(o => o.value === val));
      headerBadgeChannel.innerText = selectedOpt?.innerText?.split('—')?.[0]?.trim() || val.toUpperCase();
    }
  };

  headerSelectMp?.addEventListener('change', (e) => {
    syncMarketplaceSelection(e.target.value);
    loadRateCardPreview();
  });
  scraperSelectMp?.addEventListener('change', (e) => {
    syncMarketplaceSelection(e.target.value);
    loadRateCardPreview();
  });

  // Multi-Marketplace 2FA Login buttons (Dashboard & Settings)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-ch-login');
    if (!btn) return;
    const channel = btn.getAttribute('data-channel');
    if (!channel) return;

    syncMarketplaceSelection(channel);
    document.querySelector('.nav-item[data-tab="scraper"]')?.click();
    btnInteractiveLogin?.click();
  });

  // Human interactive login & 2FA
  btnInteractiveLogin?.addEventListener('click', async () => {
    const selectEl = document.getElementById('select-marketplace');
    const selectedVal = selectEl?.value || 'flipkart_shopsy';
    const selectedOption = selectEl?.selectedOptions?.[0] || (selectEl && Array.from(selectEl.options).find(o => o.value === selectedVal));
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
    const engineStatusEl = document.getElementById('engine-status');
    if (engineStatusEl) engineStatusEl.innerText = 'Running';

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
      const engineStatusEl = document.getElementById('engine-status');
      if (engineStatusEl) engineStatusEl.innerText = 'Idle';
      loadSessionStatusUI();
    }
  });

  // Commit to Database
  btnCommitDb?.addEventListener('click', async () => {
    if (currentRateCards.length === 0 || !currentCanSync) {
      alert('Run a successful extraction first. Generated template rates cannot be committed as live rates.');
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
        const excelPathEl = document.getElementById('excel-path-display');
        const excelBadgeEl = document.getElementById('excel-size-badge');
        if (excelPathEl) excelPathEl.innerText = res.filePath || 'Workbook generated';
        if (excelBadgeEl) excelBadgeEl.innerText = 'Generated';
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
      const excelPathEl = document.getElementById('excel-path-display');
      if (excelPathEl && res.filePath) excelPathEl.innerText = res.filePath;
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
      notificationEmail: document.getElementById('cfg-alert-email').value
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
      const res = await window.ratecardAPI.authLogout();
      // A failed session-file removal leaves working tokens on disk: the UI
      // must not claim a clean deauthorization it did not get.
      if (!res?.success) {
        alert(res?.error || 'Sign-out failed: the saved session could not be removed.');
        appendTerminalLine(`[Auth] ${res?.error || 'Sign-out failed.'}`);
        return;
      }
      currentUserSession = null;
      showAuthModal();
      appendTerminalLine('[Auth] Signed out. PC deauthorized.');
      const sessionStatusEl = document.getElementById('dash-session-status');
      const sessionSubEl = document.getElementById('dash-session-sub');
      const dbStatusEl = document.getElementById('dash-db-status');
      const engineStatusEl = document.getElementById('engine-status');
      if (sessionStatusEl) {
        sessionStatusEl.innerText = 'Signed Out';
        sessionStatusEl.style.color = '#94a3b8';
      }
      if (sessionSubEl) sessionSubEl.innerText = 'Sign in again to check marketplace sessions';
      if (dbStatusEl) {
        dbStatusEl.innerText = 'Signed Out';
        dbStatusEl.style.color = '#94a3b8';
      }
      if (engineStatusEl) engineStatusEl.innerText = 'Idle';
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
        if (res.session.user.role === 'analyst' && authDbInput) {
          authDbInput.value = '';
        }
        if (res.databaseConfigured === false) {
          const setupHint = res.session.user.role === 'analyst'
            ? 'Ask the server operator to configure DESKTOP_ANALYST_DATABASE_URL with a read-only PostgreSQL role.'
            : 'Set DESKTOP_DATABASE_URL on the API server or configure the URL in Settings.';
          appendTerminalLine(`⚠ No database URL was configured. ${setupHint}`);
        }
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

// ── Load Connected Marketplace Accounts from Backend ─────────────────────────
async function loadMarketplaceAccountsUI() {
  try {
    const res = await window.ratecardAPI.getMarketplaceAccounts();
    const accounts = Array.isArray(res) 
      ? res 
      : (Array.isArray(res?.accounts) ? res.accounts : (res?.accounts?.accounts || []));

    if (accounts.length > 0) {
      const tbody = document.getElementById('tbody-marketplace-accounts');
      if (tbody) {
        tbody.innerHTML = '';
        accounts.forEach(acc => {
          const hasPassword = Boolean(acc.has_password || acc.has_credentials);
          const channelKey = acc.account_id || (acc.marketplace || '').toLowerCase();
          const accountLabel = acc.login_id || acc.account_id || (acc.seller_id ? 'Seller ID: ' + acc.seller_id : 'Primary');

          const tr = document.createElement('tr');

          // TD 1: Display name
          const tdName = document.createElement('td');
          const strongName = document.createElement('strong');
          strongName.textContent = acc.display_name || acc.marketplace_name || acc.marketplace || 'Marketplace';
          tdName.appendChild(strongName);
          tr.appendChild(tdName);

          // TD 2: Account label
          const tdLabel = document.createElement('td');
          tdLabel.textContent = accountLabel;
          tr.appendChild(tdLabel);

          // TD 3: Portal URL
          const tdPortal = document.createElement('td');
          tdPortal.style.fontFamily = "'JetBrains Mono', monospace";
          tdPortal.style.fontSize = '11px';
          tdPortal.textContent = acc.portal_url || '—';
          tr.appendChild(tdPortal);

          // TD 4: Badge
          const tdBadge = document.createElement('td');
          const spanBadge = document.createElement('span');
          spanBadge.className = `badge ${hasPassword ? 'badge-account' : 'badge-portal'}`;
          spanBadge.style.fontSize = '10px';
          spanBadge.textContent = hasPassword ? '🔒 Vault Encrypted' : 'Configured';
          tdBadge.appendChild(spanBadge);
          tr.appendChild(tdBadge);

          // TD 5: 2FA Login Button
          const tdBtn = document.createElement('td');
          const btn = document.createElement('button');
          btn.className = 'btn btn-sm btn-secondary btn-ch-login';
          btn.setAttribute('data-channel', channelKey);
          btn.style.padding = '2px 8px';
          btn.style.fontSize = '11px';
          btn.textContent = '2FA Login';
          tdBtn.appendChild(btn);
          tr.appendChild(tdBtn);

          tbody.appendChild(tr);
        });
      }

      // Dashboard channel cards are owned exclusively by loadSessionStatusUI()
      // (real cookie vault state). Backend vault linkage is shown in the table
      // badges above, so it must not overwrite the per-channel session status.
    }
  } catch (err) {
    console.warn('Could not load marketplace accounts:', err);
  }
}

