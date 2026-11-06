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
    clearMarketplaceSession: (marketplace) => fetch(`${API_BASE}/api/clear-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketplace }) }).then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.success === false) {
        throw new Error(data.error || data.message || `HTTP ${r.status}`);
      }
      return data;
    }),
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
    writeClientLog: () => Promise.resolve({ success: false, error: 'Persistent logs are available in the installed desktop app.' }),
    openDiagnostics: () => Promise.resolve({ success: false, error: 'Diagnostics folders are available in the installed desktop app.' }),
    // Auto-update exists only in the installed Electron app; the standalone
    // Chrome mode runs from local files, so these are honest no-ops.
    getUpdateStatus: () => Promise.resolve({ success: true, status: { status: 'unsupported' } }),
    checkForUpdates: () => Promise.resolve({ success: false, error: 'Updates are only available in the installed desktop app.' }),
    installUpdate: () => Promise.resolve({ success: false, error: 'Updates are only available in the installed desktop app.' }),
    downloadUpdate: () => Promise.resolve({ success: false, error: 'Updates are only available in the installed desktop app.' }),
    onUpdateStatus: () => () => {},
    // Browser Monitor methods in standalone Chrome mode
    getBrowserMonitorState: () => fetch(`${API_BASE}/api/browser/state`, {
      headers: currentUserSession?.idToken ? { 'Authorization': `Bearer ${currentUserSession.idToken}` } : {}
    }).then(r => r.json()).catch(() => ({
      success: true,
      state: { active: false, status: 'unsupported', engine: 'external', title: 'Standalone Browser' }
    })),
    captureBrowserScreenshot: () => fetch(`${API_BASE}/api/browser/screenshot`, {
      headers: currentUserSession?.idToken ? { 'Authorization': `Bearer ${currentUserSession.idToken}` } : {}
    }).then(r => r.json()).catch(() => ({
      success: false,
      error: 'Screenshot capture is only supported in the installed desktop app.'
    })),
    setBrowserVisibility: () => Promise.resolve({ success: true }),
    setBrowserEngine: () => Promise.resolve({ success: true }),
    setMonitorDockBounds: () => Promise.resolve({ success: true }),
    onBrowserMonitorUpdate: () => () => {},
    onBrowserMonitorPromptLogin: () => () => {}
  };
}

let currentCatalog = [];
let currentRateCards = [];
let currentChanges = [];
let currentComparisonAvailable = false;
let activeDiffFilter = 'all';
let activeStatusFilter = 'all'; // 'all' | 'changed' | 'unchanged'
let currentEffectiveDate = '';
let currentDiffSummary = {};
let currentUserSession = null;
let currentCanSync = false;
let isPublishingToDatabase = false;
let isAutoSyncInFlight = false;
let lastAutoSyncedFingerprint = null;

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

// ── Auto-Update Banner & Settings Controls ────────────────────────────────────
let currentAppVersion = '';
let updateBannerHideTimer = null;
let pendingUpdateDownloaded = ''; // raw version whose update is downloaded and awaiting restart
let latestAvailableVersion = ''; // raw version from the last update-available event
let deferredUpdateVersion = ''; // raw version the user postponed with Later (re-prompt on new version only)

async function initAppVersion() {
  try {
    const res = await window.ratecardAPI?.getAppVersion?.();
    if (res?.version) {
      currentAppVersion = res.version;
      const sidebarVer = document.getElementById('app-sidebar-version');
      if (sidebarVer) sidebarVer.textContent = 'RateCard v' + res.version;
      const modalVer = document.getElementById('app-update-current-ver');
      if (modalVer) modalVer.textContent = res.version;
      const settingsVer = document.getElementById('settings-app-version');
      if (settingsVer) settingsVer.textContent = 'v' + res.version;
    }
  } catch (err) {
    console.warn('Could not read app version:', err);
  }
}

function showAppUpdateModal(version, isDownloaded = false) {
  const modal = document.getElementById('app-update-modal');
  if (!modal) return;
  const newVerEl = document.getElementById('app-update-new-ver');
  if (newVerEl && version) newVerEl.textContent = 'v' + version;
  const btnNow = document.getElementById('btn-app-update-now');
  const btnRestart = document.getElementById('btn-app-update-restart');
  const prog = document.getElementById('app-update-progress-container');
  if (isDownloaded) {
    if (btnNow) btnNow.style.display = 'none';
    if (btnRestart) btnRestart.style.display = 'inline-flex';
    if (prog) prog.style.display = 'none';
  } else {
    if (btnNow) btnNow.style.display = 'inline-flex';
    if (btnRestart) btnRestart.style.display = 'none';
  }

  modal.style.display = 'flex';
}

function hideAppUpdateModal() {
  const modal = document.getElementById('app-update-modal');
  if (modal) modal.style.display = 'none';
}

function updateAppProgress(percent) {
  const prog = document.getElementById('app-update-progress-container');
  const pct = document.getElementById('app-update-progress-percent');
  const bar = document.getElementById('app-update-progress-bar');
  if (prog) prog.style.display = 'block';
  if (pct) pct.textContent = (percent || 0) + '%';
  if (bar) bar.style.width = (percent || 0) + '%';
}

function updateSettingsUpdateUI(status) {
  const settingsMsg = document.getElementById('settings-update-status-msg');
  const settingsCheckBtn = document.getElementById('btn-settings-check-update');
  const settingsDlBtn = document.getElementById('btn-settings-download-update');
  const settingsRestartBtn = document.getElementById('btn-settings-restart-update');
  const settingsLastChecked = document.getElementById('settings-update-last-checked');

  const kind = status?.status;
  const rawVersion = status?.version || '';
  const isManual = Boolean(status?.manual);
  const checkedTimeStr = status?.checkedAt ? new Date(status.checkedAt).toLocaleTimeString() : new Date().toLocaleTimeString();

  if (settingsLastChecked && status?.checkedAt) {
    settingsLastChecked.textContent = checkedTimeStr;
  }

  if (kind === 'checking') {
    if (settingsMsg) settingsMsg.textContent = '🔄 Checking GitHub Releases for updates...';
    if (settingsCheckBtn) {
      settingsCheckBtn.disabled = true;
      settingsCheckBtn.textContent = 'Checking...';
    }
  } else if (kind === 'not-available') {
    if (settingsMsg) settingsMsg.textContent = '✓ You are running the latest version (' + (currentAppVersion ? 'v' + currentAppVersion : 'v1.8.20') + ').';
    if (settingsCheckBtn) {
      settingsCheckBtn.disabled = false;
      settingsCheckBtn.textContent = '🔄 Check for Updates';
    }
    if (settingsDlBtn) settingsDlBtn.style.display = 'none';
    if (settingsRestartBtn) settingsRestartBtn.style.display = 'none';
    if (isManual) {
      alert('✓ You are running the latest release (' + (currentAppVersion ? 'v' + currentAppVersion : 'v1.8.20') + '). No update is required.');
    }
  } else if (kind === 'available') {
    if (settingsCheckBtn) {
      settingsCheckBtn.disabled = false;
      settingsCheckBtn.textContent = '🔄 Check for Updates';
    }
    if (pendingUpdateDownloaded && pendingUpdateDownloaded === rawVersion) {
      if (settingsMsg) settingsMsg.textContent = '✅ Update v' + rawVersion + ' is ready! Restart the worker to apply.';
      if (settingsDlBtn) settingsDlBtn.style.display = 'none';
      if (settingsRestartBtn) {
        settingsRestartBtn.style.display = 'inline-flex';
        settingsRestartBtn.disabled = false;
      }
    } else {
      if (settingsMsg) settingsMsg.textContent = '⚡ Update available: v' + rawVersion + '! Ready to download.';
      if (settingsDlBtn) {
        settingsDlBtn.style.display = 'inline-flex';
        settingsDlBtn.disabled = false;
        settingsDlBtn.textContent = '⬇️ Download v' + rawVersion;
      }
      if (settingsRestartBtn) settingsRestartBtn.style.display = 'none';
    }
  } else if (kind === 'downloading') {
    const pct = status?.percent || 0;
    if (settingsMsg) settingsMsg.textContent = '⬇️ Downloading update v' + rawVersion + ' (' + pct + '%)...';
    if (settingsDlBtn) {
      settingsDlBtn.disabled = true;
      settingsDlBtn.textContent = 'Downloading (' + pct + '%)...';
    }
  } else if (kind === 'downloaded') {
    if (settingsMsg) settingsMsg.textContent = '✅ Update v' + rawVersion + ' is ready! Restart the worker to apply.';
    if (settingsDlBtn) settingsDlBtn.style.display = 'none';
    if (settingsRestartBtn) {
      settingsRestartBtn.style.display = 'inline-flex';
      settingsRestartBtn.disabled = false;
    }
  } else if (kind === 'error') {
    if (settingsMsg) settingsMsg.textContent = '⚠ Update check error: ' + (status?.message || 'Network error');
    if (settingsCheckBtn) {
      settingsCheckBtn.disabled = false;
      settingsCheckBtn.textContent = '🔄 Check for Updates';
    }
  }
}

function applyUpdateBanner(status) {
  updateSettingsUpdateUI(status);

  const banner = document.getElementById('update-banner');
  const text = document.getElementById('update-banner-text');
  const restartBtn = document.getElementById('btn-update-restart');
  const downloadBtn = document.getElementById('btn-update-download');
  const laterBtn = document.getElementById('btn-update-later');
  if (!banner || !text || !restartBtn || !downloadBtn || !laterBtn) return;

  if (updateBannerHideTimer) {
    clearTimeout(updateBannerHideTimer);
    updateBannerHideTimer = null;
  }

  const show = (message, actions) => {
    text.textContent = message;
    restartBtn.style.display = actions?.restart ? '' : 'none';
    downloadBtn.style.display = actions?.download ? '' : 'none';
    laterBtn.style.display = actions ? '' : 'none';
    banner.style.display = 'flex';
  };
  const hide = () => {
    banner.style.display = 'none';
    downloadBtn.style.display = 'none';
    restartBtn.style.display = 'none';
    laterBtn.style.display = 'none';
  };

  const kind = status?.status;
  const rawVersion = status?.version || '';
  const version = rawVersion ? (' v' + rawVersion) : '';
  if (kind === 'downloaded') {
    pendingUpdateDownloaded = rawVersion;
    if (deferredUpdateVersion !== rawVersion) showAppUpdateModal(rawVersion, true);
  }
  if (kind === 'available') {
    latestAvailableVersion = rawVersion;
    if (deferredUpdateVersion !== rawVersion) showAppUpdateModal(rawVersion, false);
  }
  if (kind === 'downloading') updateAppProgress(status?.percent);
  if (kind === 'error') {
    show('⚠ Update check failed — will retry automatically.');
    updateBannerHideTimer = setTimeout(hide, 30 * 1000);
    return;
  }

  if (deferredUpdateVersion && (deferredUpdateVersion === rawVersion || (!rawVersion && deferredUpdateVersion === pendingUpdateDownloaded))) {
    hide();
    return;
  }
  if (pendingUpdateDownloaded) {
    show('✅ App update v' + pendingUpdateDownloaded + ' is ready to install. Restart when ready — an active scrape blocks restart.', { restart: true });
    return;
  }

  if (kind === 'available') {
    show('⬇ New app version' + version + ' is available.', { download: true });
  } else if (kind === 'downloading') {
    const percent = Number.isFinite(status?.percent) ? (' (' + status.percent + '%)') : '';
    show('⬇ Downloading app update' + version + percent + '…');
  } else {
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
  const downloadBtn = document.getElementById('btn-update-download');
  downloadBtn?.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    try {
      const res = await window.ratecardAPI.downloadUpdate();
      if (!res?.success) {
        downloadBtn.disabled = false;
        alert(res?.error || 'The update could not be downloaded.');
      }
    } catch (err) {
      downloadBtn.disabled = false;
      console.warn('Download update failed:', err);
    }
  });
  const laterBtn = document.getElementById('btn-update-later');
  laterBtn?.addEventListener('click', () => {
    deferredUpdateVersion = pendingUpdateDownloaded || latestAvailableVersion;
    const banner = document.getElementById('update-banner');
    if (banner) banner.style.display = 'none';
  });
  window.ratecardAPI.onUpdateStatus((status) => applyUpdateBanner(status));

  // Settings view update controls
  document.getElementById('btn-settings-check-update')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-settings-check-update');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
    const settingsMsg = document.getElementById('settings-update-status-msg');
    if (settingsMsg) settingsMsg.textContent = '🔄 Checking GitHub Releases for updates...';
    try {
      const res = await window.ratecardAPI.checkForUpdates({ manual: true });
      if (!res?.success) {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Check for Updates'; }
        if (settingsMsg) settingsMsg.textContent = '⚠ Update check failed: ' + (res?.error || 'Unknown error');
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Check for Updates'; }
      if (settingsMsg) settingsMsg.textContent = '⚠ Update check failed: ' + err.message;
    }
  });

  document.getElementById('btn-settings-download-update')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-settings-download-update');
    if (btn) { btn.disabled = true; btn.textContent = 'Downloading...'; }
    try {
      const res = await window.ratecardAPI.downloadUpdate();
      if (!res?.success) {
        if (btn) { btn.disabled = false; btn.textContent = '⬇️ Download Update'; }
        alert(res?.error || 'The update could not be downloaded.');
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '⬇️ Download Update'; }
      alert('Download failed: ' + err.message);
    }
  });

  document.getElementById('btn-settings-restart-update')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-settings-restart-update');
    if (btn) { btn.disabled = true; btn.textContent = 'Restarting...'; }
    try {
      const res = await window.ratecardAPI.installUpdate();
      if (!res?.success) {
        if (btn) { btn.disabled = false; btn.textContent = '🚀 Restart to Apply'; }
        alert(res?.error || 'The update could not be installed.');
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '🚀 Restart to Apply'; }
      alert('Install failed: ' + err.message);
    }
  });
}

// ── Light/Dark Theme (light default, persisted in app config) ────────────────
function applyTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalized;
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.textContent = normalized === 'dark' ? '☀ Light' : '🌙 Dark';
}

async function initTheme() {
  try {
    const config = await window.ratecardAPI.getConfig();
    applyTheme(config?.uiTheme === 'dark' ? 'dark' : 'light');
  } catch {
    applyTheme('light');
  }
  document.getElementById('btn-theme-toggle')?.addEventListener('click', async () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      await window.ratecardAPI.saveConfig({ uiTheme: next });
    } catch (err) {
      console.warn('Could not persist theme:', err);
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupEventListeners();
  subscribeToEvents();
  await initAppVersion();
  initUpdateBanner();
  initTheme();
  initBrowserMonitorListeners();

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
    monitor: {
      title: 'Live Browser & Automation Viewport',
      desc: 'Manual Seller Hub sign-in, persistent Chrome session, and real-time worker status'
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

      if (tabId === 'monitor') {
        syncMonitorDockBounds();
        refreshBrowserMonitorState();
      }
      if (tabId === 'dashboard') {
        loadSessionStatusUI();
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

// ── Live Browser Monitor UI ──────────────────────────────────────────────────
let lastDockBounds = '';
function syncMonitorDockBounds() {
  const dock = document.getElementById('browser-view-dock');
  if (dock && window.ratecardAPI && typeof window.ratecardAPI.setMonitorDockBounds === 'function') {
    const rect = dock.getBoundingClientRect();
    const clip = document.querySelector('.views-wrapper').getBoundingClientRect();
    const x = Math.max(0, rect.left, clip.left), y = Math.max(0, rect.top, clip.top);
    const next = { x, y,
      width: Math.max(0, Math.min(innerWidth, rect.right, clip.right) - x),
      height: Math.max(0, Math.min(innerHeight, rect.bottom, clip.bottom) - y) };
    if (!dock.getClientRects().length) next.width = next.height = 0;
    const signature = JSON.stringify(next);
    if (signature === lastDockBounds) return;
    lastDockBounds = signature;
    window.ratecardAPI.setMonitorDockBounds(next).catch(err => console.warn('Browser layout failed:', err.message));
  }
}

async function refreshBrowserMonitorState() {
  try {
    const res = await window.ratecardAPI.getBrowserMonitorState();
    if (res?.success && res.state) {
      updateBrowserMonitorUI(res.state);
    }
  } catch (err) {
    console.warn('Could not refresh browser monitor state:', err);
  }
}

function updateBrowserMonitorUI(state) {
  if (!state) return;
  const liveBadge = document.getElementById('browser-live-badge');
  const engineText = document.getElementById('monitor-engine-text');
  const statePill = document.getElementById('monitor-state-pill');
  const channelTag = document.getElementById('monitor-channel-tag');
  const currentUrl = document.getElementById('monitor-current-url');
  const viewTitle = document.getElementById('monitor-view-title');
  const syncTime = document.getElementById('monitor-sync-timestamp');
  const authAlert = document.getElementById('monitor-auth-alert');
  const screenshotImg = document.getElementById('browser-screenshot-img');
  const placeholder = document.getElementById('browser-view-placeholder');
  const statusDot = document.getElementById('monitor-status-dot');

  if (liveBadge) liveBadge.style.display = state.active ? 'inline-block' : 'none';
  if (engineText) engineText.textContent = state.engine === 'manual-login-window'
    ? 'Seller Hub Sign-in Window'
    : (state.engine === 'embedded' ? 'Embedded Chromium' : 'External Chrome');
  if (statePill) {
    statePill.textContent = (state.status || 'idle').toUpperCase();
    if (state.status === 'extracting' || state.status === 'navigating') {
      statePill.style.background = 'rgba(16, 185, 129, 0.2)';
      statePill.style.borderColor = 'var(--success)';
      statePill.style.color = 'var(--success-strong)';
    } else if (state.status === 'login_prompt') {
      statePill.style.background = 'rgba(245, 158, 11, 0.2)';
      statePill.style.borderColor = 'var(--warning)';
      statePill.style.color = 'var(--warning-strong)';
    } else if (state.status === 'unsupported') {
      statePill.style.background = 'rgba(239, 68, 68, 0.2)';
      statePill.style.borderColor = 'var(--danger)';
      statePill.style.color = 'var(--danger-strong)';
    } else {
      statePill.style.background = 'var(--primary-container)';
      statePill.style.borderColor = 'var(--primary)';
      statePill.style.color = 'var(--on-primary-container)';
    }
  }
  if (statusDot) {
    statusDot.className = state.active ? 'status-dot active' : 'status-dot';
  }
  if (channelTag) channelTag.textContent = state.marketplace || 'Flipkart & Shopsy';
  if (currentUrl) currentUrl.textContent = state.url || 'about:blank';
  if (viewTitle) viewTitle.textContent = state.title ? `Live View: ${state.title}` : 'Live Browser Viewport';
  if (syncTime) syncTime.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
  if (authAlert) {
    const wasVisible = authAlert.style.display === 'flex';
    const nowVisible = state.status === 'login_prompt';
    authAlert.style.display = nowVisible ? 'flex' : 'none';
    if (wasVisible !== nowVisible) {
      requestAnimationFrame(syncMonitorDockBounds);
    }
  }

  if (state.lastScreenshot) {
    if (screenshotImg) {
      screenshotImg.src = state.lastScreenshot;
      screenshotImg.style.display = 'block';
    }
    if (placeholder) placeholder.style.display = 'none';
  } else {
    if (screenshotImg) screenshotImg.style.display = 'none';
    if (placeholder) placeholder.style.display = 'block';
    const heading = placeholder?.querySelector('h4');
    const description = placeholder?.querySelector('p');
    if (state.engine === 'external') {
      const loginRequired = state.status === 'login_prompt';
      const working = state.status === 'extracting' || state.status === 'navigating';
      if (heading) heading.textContent = loginRequired
        ? 'Seller Hub sign-in is open in external Chrome'
        : (working ? 'Seller Hub activity is in progress' : (state.active ? 'Seller Hub browser is active' : 'External Chrome is ready'));
      if (description) description.textContent = loginRequired
        ? 'The public Seller Hub page is open in Chrome. Click Login and finish sign-in; the worker confirms the dashboard before saving the session.'
        : (working
          ? 'The worker is using this persistent Seller Hub session. Wait for the current page interaction to finish.'
          : 'The rate-card worker uses the persistent Seller Hub session in external Chrome. Open Seller Hub Sign-in if the portal asks you to log in again.');
    } else if (state.engine === 'manual-login-window') {
      if (heading) heading.textContent = state.active ? 'Seller Hub sign-in is open in a separate window' : 'Seller Hub sign-in is ready';
      if (description) description.textContent = 'Click Login on the public Seller Hub page and complete sign-in manually. The persistent session is saved after the dashboard is verified.';
    } else {
      if (heading) heading.textContent = 'Live Viewport Ready';
      if (description) description.textContent = 'When an automated scrape runs, the embedded Chromium view attaches natively into this window.';
    }
  }
}

function triggerInteractiveLogin(marketplaceId = 'flipkart_shopsy') {
  const selectMp = document.getElementById('select-marketplace');
  if (selectMp && marketplaceId) {
    selectMp.value = marketplaceId;
    const headerMp = document.getElementById('header-select-marketplace');
    if (headerMp) headerMp.value = marketplaceId;
  }
  const monitorTab = document.querySelector('.nav-item[data-tab="monitor"]');
  if (monitorTab && !monitorTab.classList.contains('active')) {
    monitorTab.click();
  }
  setTimeout(() => {
    syncMonitorDockBounds();
    const btn = document.getElementById('btn-interactive-login');
    btn?.click();
  }, 60);
}

function initBrowserMonitorListeners() {
  let pending = false;
  const syncLayout = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; syncMonitorDockBounds(); }); };
  window.addEventListener('resize', syncLayout);
  // The manual Seller Hub window can finish sign-in while this window is
  // unfocused. Refresh the vault when the user returns to the desktop app.
  window.addEventListener('focus', () => { loadSessionStatusUI(); });
  document.addEventListener('scroll', syncLayout, true);
  const dock = document.getElementById('browser-view-dock');
  if (dock) new ResizeObserver(syncLayout).observe(dock);

  window.ratecardAPI?.onBrowserMonitorPromptLogin?.((payload) => {
    const tabBtn = document.querySelector('[data-tab="monitor"]');
    tabBtn?.click();
  });

  const engineSelect = document.getElementById('select-monitor-engine');
  engineSelect?.addEventListener('change', async (e) => {
    const engine = e.target.value;
    await window.ratecardAPI.setBrowserEngine(engine);
    refreshBrowserMonitorState();
  });

  const btnScreenshot = document.getElementById('btn-monitor-screenshot');
  btnScreenshot?.addEventListener('click', async () => {
    btnScreenshot.disabled = true;
    btnScreenshot.textContent = '📸 Capturing…';
    try {
      const res = await window.ratecardAPI.captureBrowserScreenshot();
      if (res?.success && res.screenshot) {
        updateBrowserMonitorUI({ lastScreenshot: res.screenshot, active: true });
      } else if (res?.error) {
        alert(res.error);
      }
    } catch (err) {
      console.warn('Screenshot capture failed:', err);
      alert('Screenshot capture failed: ' + (err.message || String(err)));
    } finally {
      btnScreenshot.disabled = false;
      btnScreenshot.textContent = '📸 Capture Frame';
    }
  });

  const btnLogin = document.getElementById('btn-monitor-login');
  btnLogin?.addEventListener('click', () => {
    triggerInteractiveLogin('flipkart_shopsy');
  });

  const btnTestOpen = document.getElementById('btn-monitor-test-open');
  btnTestOpen?.addEventListener('click', () => {
    triggerInteractiveLogin('flipkart_shopsy');
  });

  const btnStartRun = document.getElementById('btn-monitor-start-run');
  btnStartRun?.addEventListener('click', () => {
    const runBtn = document.getElementById('btn-start-scrape');
    runBtn?.click();
  });

  window.ratecardAPI.onBrowserMonitorUpdate((state) => {
    updateBrowserMonitorUI(state);
  });
}

// ── Initial State Loading ────────────────────────────────────────────────────
async function loadInitialState() {
  try {
    const config = await window.ratecardAPI.getConfig();
    
    // Populate Settings form
    // An analyst-provisioned read-only URL is not usable by privileged roles:
    // show the honest empty state instead of a URL their writes would fail on.
    document.getElementById('cfg-db-url').value = config.databaseUrlRole === 'analyst' ? '' : (config.databaseUrl || '');
    document.getElementById('cfg-hour').value = config.scheduledHour ?? 6;
    document.getElementById('cfg-minute').value = config.scheduledMinute ?? 0;
    document.getElementById('cfg-alert-email').value = config.notificationEmail || '';

    // Test API connection silently for dashboard status
    const dbStatusEl = document.getElementById('dash-db-status');
    const dbSubEl = document.getElementById('dash-db-sub');
    let apiCheck = { success: false };
    if (window.ratecardAPI?.testDbConnection) {
      apiCheck = await window.ratecardAPI.testDbConnection().catch(() => ({ success: false }));
    } else {
      apiCheck = await fetch('/api/health')
        .then(r => r.json())
        .then(d => ({ success: d.status === 'ok', db: 'ReconCentral Cloud API' }))
        .catch(() => ({ success: false }));
    }
    if (apiCheck.success) {
      dbStatusEl.innerText = 'Connected';
      dbStatusEl.style.color = 'var(--success-strong)';
      if (dbSubEl) dbSubEl.innerText = apiCheck.db || 'ReconCentral Cloud API';
    } else {
      dbStatusEl.innerText = 'Offline';
      dbStatusEl.style.color = 'var(--danger-strong)';
      if (dbSubEl) dbSubEl.innerText = 'API Offline';
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
      if (mp.profileState === 'signed_out') {
        el.innerText = 'Signed Out — Sign In';
        el.style.color = 'var(--warning-strong)';
      } else if (mp.hasCookies) {
        el.innerText = `Session Saved (${mp.cookieCount ?? '?'} cookies)`;
        el.style.color = 'var(--success-strong)';
      } else if (mp.profileState === 'authenticated') {
        el.innerText = 'Saved Browser Profile — Recheck';
        el.style.color = 'var(--warning-strong)';
      } else {
        el.innerText = channelId === 'flipkart_shopsy' ? 'No Seller Hub Session — Sign in' : 'No Session — 2FA Login';
        el.style.color = 'var(--warning-strong)';
      }
    }

    // KPI card reflects the vault for the selected scraper channel
    const selectEl = document.getElementById('select-marketplace');
    const channel = selectEl?.value || 'flipkart_shopsy';
    const current = marketplaces.find(m => m.id === channel) || marketplaces.find(m => m.id === 'flipkart_shopsy');
    if (statusEl && subEl) {
      if (current?.profileState === 'signed_out') {
        statusEl.innerText = 'Signed Out';
        statusEl.style.color = 'var(--warning-strong)';
        subEl.innerText = `Seller Hub confirmed sign-out for ${current.name || channel}; sign in again to continue`;
      } else if (current?.hasCookies) {
        statusEl.innerText = 'Session Saved';
        statusEl.style.color = 'var(--success-strong)';
        const savedAt = current.lastSavedAt ? new Date(current.lastSavedAt).toLocaleString() : '';
        subEl.innerText = `${current.cookieCount ?? 0} cookies for ${current.name || channel}${savedAt ? ' · saved ' + savedAt : ''}`;
      } else if (current?.profileState === 'authenticated') {
        statusEl.innerText = 'Saved Browser Profile';
        statusEl.style.color = 'var(--warning-strong)';
        subEl.innerText = `Last confirmed signed in for ${current.name || channel}; open Seller Hub to verify the session is still active`;
      } else {
        statusEl.innerText = 'No Session';
        statusEl.style.color = 'var(--warning-strong)';
        const signInAction = channel === 'flipkart_shopsy' ? 'Open Seller Hub Sign-in' : 'Run 2FA Login';
        subEl.innerText = `${signInAction} to store marketplace cookies for ${current?.name || channel}`;
      }
    }
  } catch (err) {
    for (const elementId of Object.values(CHANNEL_CARD_IDS)) {
      const el = document.getElementById(elementId);
      if (el) {
        el.innerText = 'Status Unknown';
        el.style.color = 'var(--text-muted)';
      }
    }
    if (statusEl) {
      statusEl.innerText = 'Status Unknown';
      statusEl.style.color = 'var(--text-muted)';
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
  const message = String(text ?? '').slice(0, 2000);
  const lower = message.toLowerCase();
  const level = /error|failed|failure|exception/.test(lower) ? 'error' : /warning|retry|recover/.test(lower) ? 'warn' : 'info';
  try { Promise.resolve(window.ratecardAPI?.writeClientLog?.({ level, message })).catch(() => {}); } catch {}
  const line = document.createElement('div');
  line.className = 'log-line';

  if (window.rateCardReviewHelpers?.isSuccessfulMessage(message)) {
    line.classList.add('success');
  } else if (level === 'warn' || message.includes('⏰')) {
    line.classList.add('warning');
  } else if (level === 'error') {
    line.classList.add('error');
  } else {
    line.classList.add('info');
  }

  const timestamp = new Date().toLocaleTimeString();
  line.innerText = '[' + timestamp + '] ' + message;
  terminal.appendChild(line);
  while (terminal.children.length > 600) terminal.firstElementChild?.remove();
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
    if (!res || !res.success) {
      setBrandsKpi('API Error', res?.error || 'Failed to reach ReconCentral catalog API', 'var(--danger-strong)');
      appendTerminalLine(`! Catalog fetch failed: ${res?.error || 'Unknown error'}`);
      return;
    }
    if (res.catalog?.length > 0) {
      currentCatalog = res.catalog;
      renderCatalogTable(currentCatalog);
      const brands = [...new Set(currentCatalog.map(item => item.brand).filter(Boolean))];
      if (brands.length > 0) {
        setBrandsKpi(`${brands.length} Brand${brands.length === 1 ? '' : 's'} Ready`, brands.join(', '), 'var(--success-strong)');
      } else {
        setBrandsKpi('Catalog Ready', `${currentCatalog.length} vertical samples`, 'var(--success-strong)');
      }
      appendTerminalLine(`✓ Loaded ${currentCatalog.length} brand catalog items from ReconCentral API.`);
    } else {
      setBrandsKpi('0 Brands Configured', 'No brand entries found in API catalog', 'var(--text-muted)');
      appendTerminalLine(`! No brand catalog items returned by API.`);
    }
  } catch (err) {
    setBrandsKpi('API Offline', `Catalog load error: ${err.message}`, 'var(--danger-strong)');
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
      <td style="font-family: \'JetBrains Mono\', monospace; color: var(--info);">${escapeHtml(item.sample_fsn || '—')}</td>
      <td style="font-family: \'JetBrains Mono\', monospace; color: var(--text-muted);">${escapeHtml(item.sample_sku || '—')}</td>
      <td><span style="font-weight: 600; color: var(--success-strong);">${escapeHtml(Number(item.order_count || 0).toLocaleString())}</span></td>
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
  tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Generating brand-wise rate cards and comparing with PostgreSQL database...</td></tr>';

  try {
    const selectedChannel = document.getElementById('select-review-marketplace')?.value || 'flipkart';
    // Reset BEFORE any await: while the preview request is in flight, staged cards
    // from a previous channel must not stay commit-enabled.
    currentCanSync = false;
    currentRateCards = [];
    currentChanges = [];
    currentComparisonAvailable = false;
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
      currentEffectiveDate = diffRes.effectiveDate || '';
      currentDiffSummary = diffRes.summary || {};
      currentComparisonAvailable = diffRes.dbAvailable !== false;
      // Keep the local extraction visible when the PostgreSQL comparison is
      // unavailable, but never leave publication enabled without that review.
      currentCanSync = Boolean(res.canSync) && currentComparisonAvailable && diffRes.publishable !== false;
      const missingFsnCategories = Array.isArray(res.missingFsnCategories) ? res.missingFsnCategories : [];
      const uncoveredCategories = Array.isArray(res.uncoveredCategories) ? res.uncoveredCategories : [];
      const omittedCategories = uncoveredCategories.filter(category => !missingFsnCategories.includes(category));
      if (!currentComparisonAvailable) {
        appendTerminalLine(`⚠️ Local extraction is available, but PostgreSQL comparison failed: ${diffRes.comparisonError || 'the backend comparison is unavailable'}. Publication is disabled.`);
      }
      if (currentComparisonAvailable && diffRes.publishable === false) {
        appendTerminalLine(`⚠️ PostgreSQL diffs are visible, but the backend did not return a review fingerprint. Publication is disabled until the backend review update is available.`);
      }
      if (missingFsnCategories.length) {
        appendTerminalLine(`⚠️ ${selectedChannel} skipped configured categories without database FSNs (${missingFsnCategories.join(', ')}). Review covers categories with real FSNs only.`);
      }
      if (omittedCategories.length) {
        appendTerminalLine(`⚠️ ${selectedChannel} extraction omitted configured categories (${omittedCategories.join(', ')}). Run all configured categories before publishing.`);
      }
      if (res.coverageKnown === false) {
        appendTerminalLine(`⚠️ ${selectedChannel} extraction coverage is unknown. Run a fresh extraction with the current app before publishing.`);
      }
      if (commitBtn) {
        commitBtn.disabled = !currentCanSync;
        commitBtn.title = !currentComparisonAvailable
          ? `PostgreSQL comparison unavailable: ${diffRes.comparisonError || 'check the backend connection or version'}. Publication is disabled.`
          : (diffRes.publishable === false
            ? 'Publication is disabled because the backend did not return a review fingerprint.'
            : (omittedCategories.length
              ? `Publication blocked because this extraction omitted configured categories: ${omittedCategories.join(', ')}`
            : (res.coverageKnown === false
              ? 'Publication blocked because extraction coverage is unknown. Run a fresh extraction with the current app.'
              : (currentCanSync ? '' : 'Showing generated templates. Run a successful extraction to enable sync.'))));
      }

      // Update badges & anomaly banner
      const badge = document.getElementById('changes-badge');
      const anomaliesBadge = document.getElementById('anomalies-badge');
      const anomalyAlert = document.getElementById('diff-anomaly-alert');
      const anomalyText = document.getElementById('diff-anomaly-text');
      const tabFilterAnomalies = document.getElementById('tab-filter-anomalies');
      const filterAnomalyCount = document.getElementById('filter-anomaly-count');

      const anomalies = currentChanges.filter(c => c.anomaly);
      const anomaliesCount = anomalies.length;

      if (currentChanges.length > 0) {
        if (badge) {
          badge.innerText = currentChanges.length;
          badge.style.display = 'inline-block';
        }
      } else {
        if (badge) badge.style.display = 'none';
      }

      const resetAnomaliesFilterIfActive = () => {
        if (activeDiffFilter === 'anomalies') {
          activeDiffFilter = 'all';
          document.querySelectorAll('.filter-tab').forEach(t => {
            if (t.getAttribute('data-filter') === 'all') {
              t.classList.add('active');
            } else {
              t.classList.remove('active');
            }
          });
        }
      };

      if (anomaliesCount > 0) {
        if (anomaliesBadge) {
          anomaliesBadge.innerText = `⚠️ ${anomaliesCount}`;
          anomaliesBadge.style.display = 'inline-block';
        }
        if (anomalyAlert) {
          anomalyAlert.style.display = 'flex';
          if (anomalyText) anomalyText.innerText = anomalyGuidance(currentChanges, anomaliesCount);
        }
        if (tabFilterAnomalies) {
          tabFilterAnomalies.style.display = 'inline-block';
          if (filterAnomalyCount) filterAnomalyCount.innerText = anomaliesCount;
        }
      } else {
        if (anomaliesBadge) anomaliesBadge.style.display = 'none';
        if (anomalyAlert) anomalyAlert.style.display = 'none';
        if (tabFilterAnomalies) tabFilterAnomalies.style.display = 'none';
        resetAnomaliesFilterIfActive();
      }

      renderDiffTable();
      appendTerminalLine(`✓ Loaded ${currentRateCards.length} rate cards for channel: ${selectedChannel} (${currentComparisonAvailable ? `${currentChanges.length} diffs detected, ${anomaliesCount} anomalies` : 'PostgreSQL comparison unavailable — staged values shown, publication disabled'}).`);
      triggerAutonomousSyncCheck(diffRes);
    } else {
      currentRateCards = [];
      currentChanges = [];
      currentComparisonAvailable = false;
      const badge = document.getElementById('changes-badge');
      if (badge) badge.style.display = 'none';
      const anomaliesBadge = document.getElementById('anomalies-badge');
      if (anomaliesBadge) anomaliesBadge.style.display = 'none';
      const anomalyAlert = document.getElementById('diff-anomaly-alert');
      if (anomalyAlert) anomalyAlert.style.display = 'none';
      const tabFilterAnomalies = document.getElementById('tab-filter-anomalies');
      if (tabFilterAnomalies) tabFilterAnomalies.style.display = 'none';
      if (activeDiffFilter === 'anomalies') {
        activeDiffFilter = 'all';
        document.querySelectorAll('.filter-tab').forEach(t => {
          if (t.getAttribute('data-filter') === 'all') {
            t.classList.add('active');
          } else {
            t.classList.remove('active');
          }
        });
      }
      setTableMessage(tbody, 10, res.error ? 'Failed to load preview: ' + res.error : 'No active rate cards configured for ' + selectedChannel + '. Automated scraping active for Flipkart & Shopsy.');
    }
  } catch (err) {
    // A stale request's failure belongs to a selection nobody is looking at
    // anymore: do not clobber the newer preview's state or table.
    if (requestId !== previewRequestSeq) return;
    currentCanSync = false;
    currentRateCards = [];
    currentChanges = [];
    currentComparisonAvailable = false;
    const commitBtn = document.getElementById('btn-commit-db');
    if (commitBtn) commitBtn.disabled = true;
    const anomaliesBadge = document.getElementById('anomalies-badge');
    if (anomaliesBadge) anomaliesBadge.style.display = 'none';
    const anomalyAlert = document.getElementById('diff-anomaly-alert');
    if (anomalyAlert) anomalyAlert.style.display = 'none';
    const tabFilterAnomalies = document.getElementById('tab-filter-anomalies');
    if (tabFilterAnomalies) tabFilterAnomalies.style.display = 'none';
    if (activeDiffFilter === 'anomalies') {
      activeDiffFilter = 'all';
      document.querySelectorAll('.filter-tab').forEach(t => {
        if (t.getAttribute('data-filter') === 'all') {
          t.classList.add('active');
        } else {
          t.classList.remove('active');
        }
      });
    }
    setTableMessage(tbody, 10, `Error loading rates: ${err.message}`, true);
  }
}

// Plain-language impact guidance for flagged rate changes.
function anomalyGuidance(changes, anomaliesCount) {
  const added = changes.filter(c => c.changeType === 'ADDED').length;
  const removed = changes.filter(c => c.changeType === 'REMOVED').length;
  const modified = changes.filter(c => c.changeType === 'MODIFIED').length;
  const parts = [];
  if (added) parts.push(`${added} new fee${added === 1 ? '' : 's'} (adds cost where none existed)`);
  if (modified) parts.push(`${modified} changed rate${modified === 1 ? '' : 's'} (review margin impact before publishing)`);
  if (removed) parts.push(`${removed} removed fee${removed === 1 ? '' : 's'} (cost eliminated)`);
  return `${anomaliesCount} flagged rate change${anomaliesCount === 1 ? '' : 's'} (>=50% move or >=5pp commission): ` +
    (parts.length ? parts.join('; ') + '. Approve only after reviewing impact.' : 'review before publishing.');
}

/**
 * Formats a single rate card row or diff record into a human-readable summary string.
 *
 * @param {string} table - Table name or component type (e.g. 'rc_commission', 'pick_pack').
 * @param {object} row - Rate record or change object.
 * @returns {string} Formatted display string.
 */
function describeRateRecord(table, row) {
  if (!row) return '—';
  const t = String(table || '').toLowerCase().replace(/^rc_/, '');
  if (t === 'commission') {
    return (Number(row.rate ?? 0) * 100).toFixed(4) + '%';
  }
  if (t === 'fixed_fee' || t === 'fixed') {
    return (row.fulfilment_type ? row.fulfilment_type + ': ' : '') + '₹' + (row.rate ?? 0);
  }
  if (t === 'collection_fee' || t === 'collection') {
    return 'Prepaid ' + (row.prepaid ?? '—') + ' (' + (row.prepaid_type || 'flat') + '), postpaid ' + (row.postpaid ?? '—') + ' (' + (row.postpaid_type || 'flat') + ')';
  }
  const base = [row.local_fee ?? row.rate ?? 0, row.zonal_fee ?? row.rate ?? 0, row.national_fee ?? row.rate ?? 0].join('/');
  const extra = [row.local_additional_fee ?? 0, row.zonal_additional_fee ?? 0, row.national_additional_fee ?? 0].join('/');
  if (t === 'pick_pack' || t === 'pickpack') {
    return `${row.fulfilment_type || 'FBF'} ${row.weight_min ?? 0}-${row.weight_max ?? '—'}kg; base L/Z/N ₹${base}; above ${row.base_weight ?? 0}kg add L/Z/N ₹${extra} per ${row.increment_weight ?? 0}kg` +
      (row.price_scope === 'all' ? '; all prices' : `; ₹${row.price_min ?? 0}-${row.price_max ?? '—'}`);
  }
  return (row.weight_slab || ((row.weight_min ?? 0) + '–' + (row.weight_max ?? '—') + 'kg')) + '; L/Z/N ₹' + base +
    '; above ' + (row.base_weight ?? 0) + 'kg add L/Z/N ₹' + extra + ' per ' + (row.increment_weight ?? 0) + 'kg' +
    (row.price_scope === 'all' ? '; all prices' : '');
}

/**
 * Renders the rate comparison diff table across all active rate cards and fee components,
 * mapping detected changes, calculating summary KPIs, and applying active component filters.
 *
 * @returns {void}
 */
function renderDiffTable() {
  const tbody = document.getElementById('diff-tbody');
  if (!tbody) return;
  const rows = [];

  const matchedChanges = new Set();

  for (const card of currentRateCards) {
    const marketplace = card.marketplace;
    const category = card.category || card.vertical || 'All';
    const brand = card.brand;
    const { commissions = [], fixedFees = [], reverseShipping = [], collectionFees = [], pickPackFees = [] } = card;

    // 1. Commission rows
    if (activeDiffFilter === 'all' || activeDiffFilter === 'commission' || activeDiffFilter === 'anomalies') {
      for (const c of commissions) {
        const matchesCommissionSlab = (ch) => {
          if (!ch) return false;
          const chMp = String(ch.marketplace || '').toLowerCase();
          const cardMp = String(marketplace || '').toLowerCase();
          if (chMp !== cardMp) return false;
          const chCat = String(ch.category || '').toLowerCase();
          const cardCat = String(category || '').toLowerCase();
          const cardVert = String(card.vertical || '').toLowerCase();
          if (chCat !== cardCat && chCat !== cardVert) return false;
          if (ch.table !== 'rc_commission' && ch.type !== 'commission') return false;
          if (ch.priceMin == null) return false;
          const minMatches = Math.abs(ch.priceMin - c.price_min) < 0.01;
          const maxMatches = Math.abs(ch.priceMax - c.price_max) < 1.0 || (ch.priceMax >= 999990 && c.price_max >= 999990);
          return minMatches && maxMatches;
        };
        const change = currentChanges.find(ch => matchesCommissionSlab(ch) && String(ch.brand || ch.brand_name || '').toLowerCase() === String(brand || '').toLowerCase()) ||
          currentChanges.find(ch => matchesCommissionSlab(ch) && (!ch.brand || ch.brand === 'All' || ch.brand === 'General' || ch.brand_name === 'General'));
        if (change) matchedChanges.add(change);
        const oldRateStr = change?.oldRate != null ? (Number(change.oldRate) * 100).toFixed(4) + '%' : (change ? '—' : (currentComparisonAvailable ? 'Active / Matched' : 'Uncompared'));
        const newRateStr = (Number(c.rate) * 100).toFixed(4) + '%';
        const isChanged = Boolean(change && change.changeType !== 'UNCHANGED');
        rows.push({
          type: 'Commission',
          marketplace: marketplace.toUpperCase(),
          category,
          brand,
          slab: c.price_max >= 999990 ? '≥ ₹' + c.price_min : '₹' + c.price_min + ' - ₹' + c.price_max,
          oldRate: oldRateStr,
          newRate: newRateStr,
          difference: change?.difference || (isChanged ? ((c.rate - (change?.oldRate || 0)) * 100).toFixed(4) + '%' : '0.00%'),
          effectiveDate: change?.effectiveDate || currentEffectiveDate || 'Immediate',
          status: change ? (change.reason || change.changeType || 'Modified') : (currentComparisonAvailable ? 'Active' : 'Uncompared'),
          financialImpact: change?.financialImpact || 'neutral',
          recommendation: change?.recommendation || '',
          anomaly: Boolean(change?.anomaly),
          anomalySeverity: change?.anomalySeverity,
          isChanged
        });
      }
    }

    // 2. Fixed Fee rows
    if (activeDiffFilter === 'all' || activeDiffFilter === 'fixed' || activeDiffFilter === 'anomalies') {
      for (const f of fixedFees) {
        const matchesFixedFeeSlab = (ch) => {
          if (!ch) return false;
          const chMp = String(ch.marketplace || '').toLowerCase();
          const cardMp = String(marketplace || '').toLowerCase();
          if (chMp !== cardMp) return false;
          const chCat = String(ch.category || '').toLowerCase();
          const cardCat = String(category || '').toLowerCase();
          const cardVert = String(card.vertical || '').toLowerCase();
          if (chCat !== cardCat && chCat !== cardVert) return false;
          if (ch.table !== 'rc_fixed_fee' && ch.type !== 'fixed_fee') return false;
          if (ch.priceMin == null) return false;
          const minMatches = Math.abs(ch.priceMin - f.price_min) < 0.01;
          const maxMatches = Math.abs(ch.priceMax - f.price_max) < 1.0 || (ch.priceMax >= 999990 && f.price_max >= 999990);
          const fulMatches = ch.fulfilmentType == null || String(ch.fulfilmentType).toUpperCase() === String(f.fulfilment_type).toUpperCase();
          return minMatches && maxMatches && fulMatches;
        };
        const change = currentChanges.find(matchesFixedFeeSlab);
        if (change) matchedChanges.add(change);
        const isChanged = Boolean(change && change.changeType !== 'UNCHANGED');
        rows.push({
          type: 'Fixed Fee',
          marketplace: marketplace.toUpperCase(),
          category,
          brand: 'All / Tier',
          slab: f.fulfilment_type + ' (₹' + f.price_min + ' - ₹' + f.price_max + ')',
          oldRate: change?.oldRate != null ? '₹' + change.oldRate : (change ? '—' : (currentComparisonAvailable ? '₹' + f.rate : 'Uncompared')),
          newRate: '₹' + f.rate,
          difference: change?.difference || (isChanged ? '₹' + (f.rate - (change?.oldRate || 0)) : '₹0.00'),
          effectiveDate: change?.effectiveDate || currentEffectiveDate || 'Immediate',
          status: change ? (change.reason || change.changeType || 'Modified') : (currentComparisonAvailable ? 'Active' : 'Uncompared'),
          financialImpact: change?.financialImpact || 'neutral',
          recommendation: change?.recommendation || '',
          anomaly: Boolean(change?.anomaly),
          anomalySeverity: change?.anomalySeverity,
          isChanged
        });
      }
    }

    // 3. Collection Fee rows
    if (activeDiffFilter === 'all' || activeDiffFilter === 'collection' || activeDiffFilter === 'anomalies') {
      const fmtColl = (value, type) => (type === 'pct' ? (Number(value) * 100).toFixed(2) + '%' : '₹' + value);
      for (const cf of collectionFees) {
        const matchesCollectionFeeSlab = (ch) => {
          if (!ch) return false;
          const chMp = String(ch.marketplace || '').toLowerCase();
          const cardMp = String(marketplace || '').toLowerCase();
          if (chMp !== cardMp) return false;
          const chCat = String(ch.category || '').toLowerCase();
          const cardCat = String(category || '').toLowerCase();
          const cardVert = String(card.vertical || '').toLowerCase();
          if (ch.category && ch.category !== 'All' && chCat !== cardCat && chCat !== cardVert) return false;
          if (ch.table !== 'rc_collection_fee' && ch.type !== 'collection_fee') return false;
          if (ch.priceMin != null) {
            return Math.abs(ch.priceMin - cf.price_min) < 0.01 && (Math.abs(ch.priceMax - cf.price_max) < 1.0 || (ch.priceMax >= 999990 && cf.price_max >= 999990));
          }
          return true;
        };
        const change = currentChanges.find(matchesCollectionFeeSlab);
        if (change) matchedChanges.add(change);
        const isChanged = Boolean(change && change.changeType !== 'UNCHANGED');
        rows.push({
          type: 'Collection Fee',
          marketplace: marketplace.toUpperCase(),
          category,
          brand: 'All',
          slab: cf.price_max >= 999990 ? '≥ ₹' + cf.price_min : '₹' + cf.price_min + ' - ₹' + cf.price_max,
          oldRate: change?.oldRate != null ? change.oldRate : (change ? '—' : (currentComparisonAvailable ? 'Active / Matched' : 'Uncompared')),
          newRate: change?.newRate != null ? change.newRate : 'Prepaid ' + fmtColl(cf.prepaid, cf.prepaid_type) + ' / Postpaid ' + fmtColl(cf.postpaid, cf.postpaid_type),
          difference: change?.difference || (isChanged ? 'Modified' : '—'),
          effectiveDate: change?.effectiveDate || currentEffectiveDate || 'Immediate',
          status: change ? (change.reason || change.changeType || 'Modified') : (currentComparisonAvailable ? 'Active' : 'Uncompared'),
          financialImpact: change?.financialImpact || 'neutral',
          recommendation: change?.recommendation || '',
          anomaly: Boolean(change?.anomaly),
          anomalySeverity: change?.anomalySeverity,
          isChanged
        });
      }
    }

    // 4. Reverse Shipping rows
    if (activeDiffFilter === 'all' || activeDiffFilter === 'reverse' || activeDiffFilter === 'anomalies') {
      for (const r of reverseShipping) {
        const matchesReverseShippingSlab = (ch) => {
          if (!ch) return false;
          const chMp = String(ch.marketplace || '').toLowerCase();
          const cardMp = String(marketplace || '').toLowerCase();
          if (chMp !== cardMp) return false;
          const chCat = String(ch.category || '').toLowerCase();
          const cardCat = String(category || '').toLowerCase();
          const cardVert = String(card.vertical || '').toLowerCase();
          if (ch.category && ch.category !== 'All' && chCat !== cardCat && chCat !== cardVert) return false;
          if (ch.table !== 'rc_reverse_shipping' && ch.type !== 'reverse_shipping') return false;
          if (ch.weightSlab && r.weight_slab && ch.weightSlab === r.weight_slab) return true;
          if (ch.weightMin != null && r.weight_min != null) {
            return Math.abs(ch.weightMin - r.weight_min) < 0.01 && Math.abs(ch.weightMax - r.weight_max) < 0.01;
          }
          return false;
        };
        const change = currentChanges.find(matchesReverseShippingSlab);
        if (change) matchedChanges.add(change);
        const isChanged = Boolean(change && change.changeType !== 'UNCHANGED');
        rows.push({
          type: 'Reverse Shipping',
          marketplace: marketplace.toUpperCase(),
          category,
          brand: 'Standard',
          slab: r.weight_slab + ' (₹' + r.price_min + ' - ₹' + r.price_max + ')',
          oldRate: change?.oldRate != null ? change.oldRate : (change ? '—' : (currentComparisonAvailable ? 'L: ₹' + r.local_fee + ', Z: ₹' + r.zonal_fee + ', N: ₹' + r.national_fee : 'Uncompared')),
          newRate: 'L: ₹' + r.local_fee + ', Z: ₹' + r.zonal_fee + ', N: ₹' + r.national_fee + '; above ' + r.base_weight + 'kg add L/Z/N ₹' + r.local_additional_fee + '/₹' + r.zonal_additional_fee + '/₹' + r.national_additional_fee + ' per ' + r.increment_weight + 'kg',
          difference: change?.difference || (isChanged ? 'Modified' : '—'),
          effectiveDate: change?.effectiveDate || currentEffectiveDate || 'Immediate',
          status: change ? (change.reason || change.changeType || 'Modified') : (currentComparisonAvailable ? 'Active' : 'Uncompared'),
          financialImpact: change?.financialImpact || 'neutral',
          recommendation: change?.recommendation || '',
          anomaly: Boolean(change?.anomaly),
          anomalySeverity: change?.anomalySeverity,
          isChanged
        });
      }
    }

    // 5. FBF pick-and-pack
    if (activeDiffFilter === 'all' || activeDiffFilter === 'fixed' || activeDiffFilter === 'pickpack' || activeDiffFilter === 'anomalies') {
      for (const fee of pickPackFees) {
        const matchesPickPackSlab = (ch) => {
          if (!ch) return false;
          const chMp = String(ch.marketplace || '').toLowerCase();
          const cardMp = String(marketplace || '').toLowerCase();
          if (chMp !== cardMp) return false;
          const chCat = String(ch.category || '').toLowerCase();
          const cardCat = String(category || '').toLowerCase();
          const cardVert = String(card.vertical || '').toLowerCase();
          if (ch.category && ch.category !== 'All' && chCat !== cardCat && chCat !== cardVert) return false;
          if (ch.table !== 'rc_pick_pack' && ch.type !== 'pick_pack') return false;
          const chFul = ch.fulfilmentType ? String(ch.fulfilmentType).toUpperCase() : null;
          const feeFul = fee.fulfilment_type ? String(fee.fulfilment_type).toUpperCase() : 'FBF';
          if (chFul && chFul !== feeFul) return false;
          if (ch.weightMin != null && fee.weight_min != null) {
            return Math.abs(ch.weightMin - fee.weight_min) < 0.01;
          }
          if (ch.priceMin != null && fee.price_min != null) {
            return Math.abs(ch.priceMin - fee.price_min) < 1.0;
          }
          return false;
        };
        const change = currentChanges.find(matchesPickPackSlab);
        if (change) matchedChanges.add(change);
        const isChanged = Boolean(change && change.changeType !== 'UNCHANGED');
        rows.push({
          type: 'FBF Pick & Pack',
          marketplace: marketplace.toUpperCase(),
          category,
          brand: 'All',
          slab: fee.fulfilment_type + ' · ' + (fee.weight_min ?? 0) + '-' + (fee.weight_max ?? '-') + 'kg · ' + (fee.price_scope === 'all' ? 'all prices' : '₹' + fee.price_min + '-₹' + fee.price_max),
          oldRate: change ? (change.oldRow ? describeRateRecord('rc_pick_pack', change.oldRow) : '—') : (currentComparisonAvailable ? 'Active / Matched' : 'Uncompared'),
          newRate: describeRateRecord('rc_pick_pack', fee),
          difference: change?.difference || (isChanged ? 'Modified' : '₹0.00'),
          effectiveDate: change?.effectiveDate || currentEffectiveDate || 'Immediate',
          status: change ? (change.reason || change.changeType || 'Modified') : (currentComparisonAvailable ? 'Active' : 'Uncompared'),
          financialImpact: change?.financialImpact || 'neutral',
          recommendation: change?.recommendation || '',
          anomaly: Boolean(change?.anomaly),
          anomalySeverity: change?.anomalySeverity,
          isChanged
        });
      }
    }
  }

  // Include explicit change records (e.g. removed or separate component changes)
  const changeFilterByTable = {
    rc_commission: 'commission', commission: 'commission',
    rc_fixed_fee: 'fixed', fixed_fee: 'fixed', rc_pick_pack: 'pickpack', pick_pack: 'pickpack',
    rc_collection_fee: 'collection', collection_fee: 'collection',
    rc_reverse_shipping: 'reverse', reverse_shipping: 'reverse'
  };
  for (const change of currentChanges) {
    if (matchedChanges.has(change)) continue;
    if (!window.rateCardReviewHelpers?.shouldRenderChangeDetail(change)) continue;
    if (activeDiffFilter !== 'all' && activeDiffFilter !== 'anomalies' &&
        changeFilterByTable[change.table] !== activeDiffFilter &&
        changeFilterByTable[change.type] !== activeDiffFilter &&
        !(activeDiffFilter === 'fixed' && (change.table === 'rc_pick_pack' || change.type === 'pick_pack'))) continue;

    matchedChanges.add(change);

    let oldRateDisplay = change.oldRow ? describeRateRecord(change.table, change.oldRow) : '—';
    if (oldRateDisplay === '—' && change.oldRate != null) {
      oldRateDisplay = change.table === 'rc_commission' || change.type === 'commission'
        ? (Number(change.oldRate) * 100).toFixed(4) + '%'
        : '₹' + change.oldRate;
    }
    let newRateDisplay = change.newRow ? describeRateRecord(change.table, change.newRow) : (change.changeType === 'REMOVED' ? 'Removed' : '—');
    if (newRateDisplay === '—' && change.newRate != null) {
      newRateDisplay = change.table === 'rc_commission' || change.type === 'commission'
        ? (Number(change.newRate) * 100).toFixed(4) + '%'
        : '₹' + change.newRate;
    }

    rows.push({
      type: change.table === 'rc_pick_pack' ? 'FBF Pick & Pack' : (change.type ? change.type.replace('_', ' ') : 'Change detail'),
      marketplace: (change.marketplace || 'FLIPKART').toUpperCase(),
      category: change.category,
      brand: change.brand || 'All',
      slab: change.slab || '—',
      oldRate: oldRateDisplay,
      newRate: newRateDisplay,
      difference: change.difference || '—',
      effectiveDate: change.effectiveDate || currentEffectiveDate || 'Immediate',
      status: change.reason || change.changeType || 'Modified',
      financialImpact: change.financialImpact || 'neutral',
      recommendation: change.recommendation || '',
      anomaly: Boolean(change.anomaly),
      anomalySeverity: change.anomalySeverity,
      isChanged: true
    });
  }

  // Ensure all flagged anomalies are included in rows under all circumstances
  for (const anom of currentChanges.filter(c => c.anomaly)) {
    if (matchedChanges.has(anom)) continue;
    matchedChanges.add(anom);
    const oldRateDisplay = anom.oldRow ? describeRateRecord(anom.table, anom.oldRow) : (anom.oldRate != null ? ((anom.table === 'rc_commission' || anom.type === 'commission') ? (Number(anom.oldRate) * 100).toFixed(4) + '%' : '₹' + anom.oldRate) : '—');
    const newRateDisplay = anom.newRow ? describeRateRecord(anom.table, anom.newRow) : (anom.newRate != null ? ((anom.table === 'rc_commission' || anom.type === 'commission') ? (Number(anom.newRate) * 100).toFixed(4) + '%' : '₹' + anom.newRate) : '—');
    rows.push({
      type: (anom.table === 'rc_pick_pack' || anom.type === 'pick_pack') ? 'FBF Pick & Pack' : (anom.type ? anom.type.replace('_', ' ') : 'Commission'),
      marketplace: (anom.marketplace || 'FLIPKART').toUpperCase(),
      category: anom.category || 'All',
      brand: anom.brand || anom.brand_name || 'All',
      slab: anom.slab || 'General',
      oldRate: oldRateDisplay,
      newRate: newRateDisplay,
      difference: anom.difference || '—',
      effectiveDate: anom.effectiveDate || currentEffectiveDate || 'Immediate',
      status: anom.reason || anom.changeType || 'Anomaly Flagged',
      financialImpact: anom.financialImpact || 'cost_increase',
      recommendation: anom.recommendation || 'Significant rate anomaly',
      anomaly: true,
      anomalySeverity: anom.anomalySeverity || 'high',
      isChanged: true
    });
  }

  // Update Summary KPI Strip
  const totalCount = rows.length;
  const unchangedCount = rows.filter(r => !r.isChanged).length;
  const changedRows = rows.filter(r => r.isChanged);
  const modifiedCount = changedRows.filter(r => String(r.status).toLowerCase().includes('mod') || r.financialImpact !== 'neutral').length;
  const addedCount = changedRows.filter(r => String(r.status).toLowerCase().includes('add') || String(r.status).toLowerCase().includes('new')).length;
  const removedCount = changedRows.filter(r => String(r.status).toLowerCase().includes('rem') || r.newRate === 'Removed').length;
  const anomalyCount = Math.max(
    currentChanges.filter(c => c.anomaly).length,
    rows.filter(r => r.anomaly).length
  );

  const setKpi = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setKpi('kpi-diff-total', totalCount);
  setKpi('kpi-diff-unchanged', unchangedCount);
  setKpi('kpi-diff-modified', modifiedCount);
  setKpi('kpi-diff-added', addedCount);
  setKpi('kpi-diff-removed', removedCount);
  setKpi('kpi-diff-anomalies', anomalyCount);

  // In-Sync Banner & Commit Button State
  const inSyncBanner = document.getElementById('diff-in-sync-banner');
  const commitBtn = document.getElementById('btn-commit-db');
  if (currentComparisonAvailable && currentChanges.length === 0) {
    if (inSyncBanner) inSyncBanner.style.display = 'flex';
    if (commitBtn) {
      commitBtn.disabled = true;
      commitBtn.innerText = '✓ Database In Sync (0 Changes)';
      commitBtn.title = 'All scraped rate parameters match active PostgreSQL records 100%.';
    }
  } else {
    if (inSyncBanner) inSyncBanner.style.display = 'none';
    if (commitBtn) {
      commitBtn.innerText = '✓ Publish Reviewed Rates';
    }
  }

  // Filter by status (all / changed / unchanged)
  let statusFiltered = rows;
  if (activeStatusFilter === 'changed') {
    statusFiltered = rows.filter(r => r.isChanged);
  } else if (activeStatusFilter === 'unchanged') {
    statusFiltered = rows.filter(r => !r.isChanged);
  }

  const isCostIncrease = (impact) => impact === 'cost_increase' || impact === 'increase' || impact === 'new_fee_introduced';
  const isCostDecrease = (impact) => impact === 'cost_decrease' || impact === 'decrease' || impact === 'fee_removed';

  // Filter for anomalies if requested
  const filteredRows = activeDiffFilter === 'anomalies' ? rows.filter(r => r.anomaly) : statusFiltered;

  if (filteredRows.length === 0) {
    const emptyMsg = activeDiffFilter === 'anomalies'
      ? '✓ No rate anomalies detected. All rate shifts are within expected thresholds.'
      : (activeStatusFilter === 'changed' ? '✓ No changes detected — all fees match active PostgreSQL rates.' : 'No fee entries for the selected filter.');
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">' + emptyMsg + '</td></tr>';
    return;
  }

  tbody.innerHTML = filteredRows.map(r => {
    let diffColor = 'inherit';
    if (isCostIncrease(r.financialImpact)) diffColor = 'var(--danger-strong)';
    else if (isCostDecrease(r.financialImpact)) diffColor = 'var(--success-strong)';

    let statusHtml = '';
    if (r.anomaly) {
      statusHtml = '<span class="status-badge" style="background: #fef3c7; color: #92400e; border: 1px solid #f59e0b; font-weight: 700; font-size: 11px; padding: 2px 6px; border-radius: 4px;" title="' + escapeHtml(r.recommendation || 'Significant rate anomaly') + '">⚠️ ' + escapeHtml(r.status) + '</span>';
    } else if (isCostIncrease(r.financialImpact)) {
      statusHtml = '<span class="status-badge badge-increase" style="font-size: 11px; padding: 2px 6px; border-radius: 4px;" title="' + escapeHtml(r.recommendation || 'Cost increase') + '">🔺 Cost Increase</span>';
    } else if (isCostDecrease(r.financialImpact)) {
      statusHtml = '<span class="status-badge badge-decrease" style="font-size: 11px; padding: 2px 6px; border-radius: 4px;" title="' + escapeHtml(r.recommendation || 'Seller savings') + '">🔻 Cost Decrease</span>';
    } else if (String(r.status).includes('Active') || !r.isChanged) {
      statusHtml = '<span class="status-badge badge-active" style="font-size: 11px; padding: 2px 6px; border-radius: 4px;">Active</span>';
    } else {
      statusHtml = '<span class="status-badge badge-modified" style="font-size: 11px; padding: 2px 6px; border-radius: 4px;">' + escapeHtml(r.status) + '</span>';
    }

    return '<tr class="' + (r.anomaly ? 'row-anomaly' : '') + '" style="' + (r.anomaly ? 'background: rgba(245, 158, 11, 0.08);' : '') + '">' +
      '<td><span class="badge ' + (r.type === 'Commission' ? 'badge-portal' : 'badge-account') + '">' + escapeHtml(r.type) + '</span></td>' +
      '<td><strong>' + escapeHtml(r.marketplace) + '</strong></td>' +
      '<td>' + escapeHtml(r.category) + '</td>' +
      '<td>' + escapeHtml(r.brand) + '</td>' +
      '<td style="font-family: \'JetBrains Mono\', monospace; font-size: 12px;">' + escapeHtml(r.slab) + '</td>' +
      '<td style="color: var(--text-muted);">' + escapeHtml(r.oldRate) + '</td>' +
      '<td style="color: var(--info); font-weight: 600;">' + escapeHtml(r.newRate) + '</td>' +
      '<td style="font-family: \'JetBrains Mono\', monospace; font-weight: 600; color: ' + diffColor + ';">' + escapeHtml(r.difference) + '</td>' +
      '<td style="font-size: 12px; color: var(--text-muted);">' + escapeHtml(r.effectiveDate) + '</td>' +
      '<td>' + statusHtml + '</td>' +
    '</tr>';
  }).join('');
}

// ── Interactive Rate Change Approval Modal Logic ──────────────────────────────
function showRateChangeApprovalModal() {
  const modal = document.getElementById('rate-change-approval-modal');
  if (!modal) return;

  const reviewMarketplace = document.getElementById('select-review-marketplace')?.value || 'flipkart';
  const channelBadge = document.getElementById('modal-approval-channel-badge');
  if (channelBadge) channelBadge.textContent = reviewMarketplace.toUpperCase();

  const isCostIncrease = (impact) => impact === 'cost_increase' || impact === 'increase' || impact === 'new_fee_introduced';
  const isCostDecrease = (impact) => impact === 'cost_decrease' || impact === 'decrease' || impact === 'fee_removed';

  const totalShifts = currentChanges.length;
  const anomalies = currentChanges.filter(c => c.anomaly);
  const increases = currentChanges.filter(c => isCostIncrease(c.financialImpact));
  const decreases = currentChanges.filter(c => isCostDecrease(c.financialImpact));

  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  setVal('modal-kpi-total', totalShifts);
  setVal('modal-kpi-increases', increases.length);
  setVal('modal-kpi-decreases', decreases.length);
  setVal('modal-kpi-anomalies', anomalies.length);

  // Impact alert banner
  const impactBanner = document.getElementById('modal-impact-banner');
  const impactTitle = document.getElementById('modal-impact-title');
  const impactDesc = document.getElementById('modal-impact-desc');
  const impactEffective = document.getElementById('modal-impact-effective');

  if (anomalies.length > 0) {
    if (impactBanner) {
      impactBanner.style.background = 'rgba(239, 68, 68, 0.12)';
      impactBanner.style.borderColor = 'var(--danger)';
    }
    if (impactTitle) {
      impactTitle.textContent = '⚠️ CAUTION: ' + anomalies.length + ' Rate Anomalies Detected!';
      impactTitle.style.color = 'var(--danger-strong)';
    }
    if (impactDesc) impactDesc.textContent = anomalyGuidance(currentChanges, anomalies.length);
  } else if (increases.length > 0) {
    if (impactBanner) {
      impactBanner.style.background = 'rgba(245, 158, 11, 0.1)';
      impactBanner.style.borderColor = 'var(--warning)';
    }
    if (impactTitle) {
      impactTitle.textContent = 'Financial Impact Warning: ' + increases.length + ' Fee Increase(s)';
      impactTitle.style.color = 'var(--warning-strong)';
    }
    if (impactDesc) impactDesc.textContent = 'Higher marketplace deductions detected. Review margin impact before publishing.';
  } else {
    if (impactBanner) {
      impactBanner.style.background = 'rgba(16, 185, 129, 0.1)';
      impactBanner.style.borderColor = 'var(--success)';
    }
    if (impactTitle) {
      impactTitle.textContent = 'Safe Rate Card Update';
      impactTitle.style.color = 'var(--success-strong)';
    }
    if (impactDesc) impactDesc.textContent = totalShifts > 0 ? totalShifts + ' fee adjustments ready for publication.' : 'No fee increases detected.';
  }

  if (impactEffective) {
    impactEffective.textContent = 'Effective Date: ' + (currentEffectiveDate || 'Immediate') + ' • Prior applicable rates auto-close cleanly the day before.';
  }

  // Populate preview table (top 15 shifts)
  const tbody = document.getElementById('modal-shifts-tbody');
  if (tbody) {
    if (currentChanges.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">✓ All rate parameters match PostgreSQL active records 100%. Database is up-to-date.</td></tr>';
    } else {
      const sortedChanges = [...currentChanges].sort((a, b) => {
        if (a.anomaly && !b.anomaly) return -1;
        if (!a.anomaly && b.anomaly) return 1;
        if (isCostIncrease(a.financialImpact) && !isCostIncrease(b.financialImpact)) return -1;
        if (!isCostIncrease(a.financialImpact) && isCostIncrease(b.financialImpact)) return 1;
        return 0;
      }).slice(0, 15);

      tbody.innerHTML = sortedChanges.map(ch => {
        const component = (ch.table === 'rc_pick_pack' || ch.type === 'pick_pack') ? 'FBF Pick & Pack' : (ch.type ? ch.type.replace('_', ' ') : 'Fee');
        const scope = (ch.category || 'All') + (ch.brand && ch.brand !== 'All' ? ' (' + ch.brand + ')' : '') + ' · ' + (ch.slab || ch.fulfilmentType || 'All slabs');
        let oldR = '—';
        if (ch.oldRow) oldR = describeRateRecord(ch.table, ch.oldRow);
        if (oldR === '—' && ch.oldRate != null) {
          oldR = (ch.table === 'rc_commission' || ch.type === 'commission') ? (Number(ch.oldRate) * 100).toFixed(4) + '%' : '₹' + ch.oldRate;
        }

        let newR = '—';
        if (ch.newRow) newR = describeRateRecord(ch.table, ch.newRow);
        if (newR === '—' && ch.newRate != null) {
          newR = (ch.table === 'rc_commission' || ch.type === 'commission') ? (Number(ch.newRate) * 100).toFixed(4) + '%' : '₹' + ch.newRate;
        }

        let diff = ch.difference || '—';
        if (diff === '—' && ch.oldRate != null && ch.newRate != null) {
          if (ch.table === 'rc_commission' || ch.type === 'commission') {
            const delta = (Number(ch.newRate) - Number(ch.oldRate)) * 100;
            diff = (delta > 0 ? '+' : '') + delta.toFixed(2) + ' pp';
          } else {
            const delta = Number(ch.newRate) - Number(ch.oldRate);
            diff = (delta > 0 ? '+' : '') + '₹' + delta.toFixed(2);
          }
        } else if (diff === '—' && ch.oldRate == null && ch.newRate != null) {
          if (ch.table === 'rc_commission' || ch.type === 'commission') {
            diff = '+' + (Number(ch.newRate) * 100).toFixed(2) + '% (New)';
          } else {
            diff = '+₹' + Number(ch.newRate).toFixed(2) + ' (New)';
          }
        }
        const impact = ch.recommendation || (isCostIncrease(ch.financialImpact) ? 'Higher cost' : (isCostDecrease(ch.financialImpact) ? 'Cost saving' : 'Neutral'));

        return '<tr>' +
          '<td><strong>' + escapeHtml(component) + '</strong></td>' +
          '<td style="font-size: 12px;">' + escapeHtml(scope) + '</td>' +
          '<td style="color: var(--text-muted); font-size: 12px;">' + escapeHtml(oldR) + '</td>' +
          '<td style="color: var(--info); font-weight: 600; font-size: 12px;">' + escapeHtml(newR) + '</td>' +
          '<td style="font-family: \'JetBrains Mono\', monospace; font-weight: 600; color: ' + (isCostIncrease(ch.financialImpact) ? 'var(--danger-strong)' : (isCostDecrease(ch.financialImpact) ? 'var(--success-strong)' : 'inherit')) + '; font-size: 12px;">' + escapeHtml(diff) + '</td>' +
          '<td style="font-size: 11px; color: ' + (ch.anomaly ? 'var(--warning-strong)' : 'var(--text-muted)') + ';">' + (ch.anomaly ? '⚠️ ' : '') + escapeHtml(impact) + '</td>' +
        '</tr>';
      }).join('');
    }
  }

  const btnApprovePublish = document.getElementById('btn-modal-approve-publish');
  if (btnApprovePublish) {
    if (currentChanges.length === 0) {
      btnApprovePublish.disabled = true;
      btnApprovePublish.textContent = '✓ Rates In Sync (0 Changes)';
      btnApprovePublish.title = 'All rate parameters match PostgreSQL active records 100%.';
    } else {
      btnApprovePublish.disabled = !currentCanSync;
      btnApprovePublish.textContent = '✅ Approve & Publish to Database';
      btnApprovePublish.title = currentCanSync
        ? 'Commit reviewed rates to PostgreSQL'
        : 'Publication is disabled: Run a full extraction covering all categories or check comparison status.';
    }
  }
  if (!currentCanSync && impactTitle) {
    impactTitle.textContent = (anomalies.length > 0 ? '⚠️ CAUTION: ' + anomalies.length + ' Anomalies' : 'Rate Changes Preview') + ' (Publication Disabled)';
  }
  modal.style.display = 'flex';
}

function hideRateChangeApprovalModal() {
  const modal = document.getElementById('rate-change-approval-modal');
  if (modal) modal.style.display = 'none';
}

function triggerRateChangeNotification(changesCount, increasesCount) {
  if (typeof Notification === 'undefined') return;
  const title = increasesCount > 0 
    ? '⚠️ Rate Card Changes: ' + changesCount + ' fee shifts (' + increasesCount + ' cost increases)'
    : 'Rate Card Changes: ' + changesCount + ' fee shifts detected';
  const body = 'User approval is required before publishing to PostgreSQL database. Click to review.';

  const createNotice = () => {
    try {
      const n = new Notification(title, { body, icon: 'icon.png' });
      n.onclick = () => {
        window.focus();
        document.querySelector('.nav-item[data-tab="diff"]')?.click();
        showRateChangeApprovalModal();
      };
    } catch (_) {}
  };

  if (Notification.permission === 'granted') {
    createNotice();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(perm => {
      if (perm === 'granted') createNotice();
    });
  }
}

/**
 * Triggers an autonomous synchronization check when auto-sync is enabled.
 * If verified differences exist and no anomalies are flagged, commits changes to PostgreSQL.
 * If parameters match 100%, confirms the in-sync state.
 * Guards against concurrent publication and repeated attempts for the same review fingerprint.
 *
 * @param {object} [diffRes={}] - Result from detectBrandRateChanges.
 * @returns {void}
 */
function triggerAutonomousSyncCheck(diffRes = {}) {
  const isAutoSync = document.getElementById('cfg-auto-sync-db')?.checked ||
    document.getElementById('dash-auto-sync-toggle')?.checked ||
    localStorage.getItem('reconcentral_auto_sync') === 'true';

  if (isAutoSync && currentComparisonAvailable) {
    const fingerprint = diffRes.reviewFingerprint || `${currentRateCards.length}:${currentChanges.length}:${currentEffectiveDate}`;
    if (currentChanges.length > 0 && currentCanSync && diffRes.publishable !== false) {
      if (isAutoSyncInFlight || lastAutoSyncedFingerprint === fingerprint) {
        return;
      }
      const hasAnomalies = currentChanges.some(c => c.anomaly);
      if (hasAnomalies) {
        appendTerminalLine(`⚠️ [Autonomous Auto-Sync] Skipped: ${currentChanges.filter(c => c.anomaly).length} anomalies flagged. Manual operator review required.`);
        return;
      }
      isAutoSyncInFlight = true;
      lastAutoSyncedFingerprint = fingerprint;
      appendTerminalLine(`⚡ Autonomous Auto-Sync: Committing ${currentChanges.length} verified rate adjustments to PostgreSQL...`);
      executePublishToDatabase({ autonomous: true }).finally(() => {
        isAutoSyncInFlight = false;
      });
    } else if (currentChanges.length === 0) {
      appendTerminalLine('✓ Autonomous Rate Check: All parameters match PostgreSQL 100%. Database is up-to-date.');
    }
  }
}

// Commit to Database
/**
 * Commits staged rate card changes to PostgreSQL with version snapshot and auto-closure.
 * Enforces mutual exclusion so manual and autonomous operations cannot overlap.
 *
 * @param {object} [options={}] - Execution options.
 * @param {boolean} [options.autonomous=false] - True if triggered by autonomous auto-sync.
 * @returns {Promise<void>}
 */
async function executePublishToDatabase(options = {}) {
  if (isPublishingToDatabase) {
    appendTerminalLine('⚠️ Database publication is already in progress. Skipping duplicate request.');
    return;
  }
  isPublishingToDatabase = true;

  const isAutonomous = options.autonomous === true;
  const btnCommitDb = document.getElementById('btn-commit-db');

  if (currentRateCards.length === 0 || !currentCanSync) {
    const reason = !currentComparisonAvailable
      ? 'PostgreSQL comparison is unavailable. Please check database connectivity.'
      : 'Publication requires a complete, verified extraction covering all configured categories before committing live rates to PostgreSQL.';
    if (!isAutonomous) alert('Cannot publish to database: ' + reason);
    else appendTerminalLine(`⚠️ [Autonomous Auto-Sync Skipped] ${reason}`);
    isPublishingToDatabase = false;
    return;
  }

  const btnApprovePublish = document.getElementById('btn-modal-approve-publish');
  if (btnApprovePublish) {
    btnApprovePublish.disabled = true;
    btnApprovePublish.textContent = '⏳ Publishing to Database...';
  }
  if (btnCommitDb) {
    btnCommitDb.disabled = true;
    btnCommitDb.innerText = '⏳ Syncing...';
  }

  appendTerminalLine('Committing brand-wise rate cards to PostgreSQL database...');

  try {
    const session = await window.ratecardAPI.authGetSession?.().catch(() => null);
    const syncOptions = {
      forceUpdate: true,
      actor: session?.user?.email || session?.user?.name || (isAutonomous ? 'autonomous-auto-sync' : 'desktop-operator'),
      runMetadata: { source: isAutonomous ? 'autonomous-worker' : 'desktop-worker-ui', uiVersion: '1.8.0' }
    };
    const res = await window.ratecardAPI.syncBrandRateCards(currentRateCards, syncOptions);
    if (res.success && res.result?.updated) {
      appendTerminalLine('✓ ' + res.result.message);
      appendTerminalLine('✓ Version snapshot: ' + res.result.versionName);
      if (res.result?.anomaliesCount > 0) {
        appendTerminalLine('⚠️ Note: ' + res.result.anomaliesCount + ' anomalies recorded in version audit snapshot.');
      }
      hideRateChangeApprovalModal();
      if (isAutonomous) {
        if (typeof Notification !== 'undefined') {
          try {
            new Notification('Rate Cards Auto-Updated', {
              body: `${res.result.message} (Version: ${res.result.versionName})`,
              icon: 'icon.png'
            });
          } catch (_) {}
        }
        appendTerminalLine(`ℹ️ [Notification] Auto-sync version ${res.result.versionName} recorded. No email sent directly from desktop client.`);
      } else {
        alert('Database synchronization completed successfully!\n\n' + res.result.message + '\nAudit Version: ' + res.result.versionName);
      }
      await loadRateCardPreview();
    } else if (res.success) {
      const message = res.result?.message || 'Database is already in sync.';
      appendTerminalLine('Database sync result: ' + message);
      hideRateChangeApprovalModal();
      if (!isAutonomous) alert(message);
      await loadRateCardPreview();
    } else {
      const message = res.error || res.result?.message || 'Database synchronization failed.';
      appendTerminalLine('Database sync failed: ' + message);
      if (!isAutonomous) alert(message);
    }
  } catch (err) {
    appendTerminalLine('Database sync failed: ' + err.message);
    if (!isAutonomous) alert('Database sync failed: ' + err.message);
  } finally {
    btnCommitDb.disabled = !currentCanSync;
    if (btnCommitDb) {
      if (currentChanges.length === 0 && currentComparisonAvailable) {
        btnCommitDb.innerText = '✓ Database In Sync (0 Changes)';
        btnCommitDb.disabled = true;
      } else {
        btnCommitDb.innerText = '✓ Commit & Auto-Close in Database';
      }
    }
    isPublishingToDatabase = false;
    if (btnApprovePublish) {
      btnApprovePublish.disabled = false;
      btnApprovePublish.textContent = '✅ Approve & Publish to Database';
    }
  }
}

function setupEventListeners() {
  const btnDashRun = document.getElementById('btn-dash-run');
  const btnDashTour = document.getElementById('btn-dash-tour');
  const btnDashCatalog = document.getElementById('btn-dash-catalog');
  const btnStartScrape = document.getElementById('btn-start-scrape');
  const btnInteractiveLogin = document.getElementById('btn-interactive-login');
  const btnClearSession = document.getElementById('btn-clear-session');
  const btnClearTerminal = document.getElementById('btn-clear-terminal');
  const btnOpenDiagnostics = document.getElementById('btn-open-diagnostics');
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
  btnOpenDiagnostics?.addEventListener('click', async () => {
    const result = await window.ratecardAPI.openDiagnostics?.();
    if (!result?.success) appendTerminalLine('Could not open diagnostics folder: ' + (result?.error || 'Unknown error'));
    else appendTerminalLine('Opened diagnostics folder: ' + result.path);
  });

  // Navigation shortcuts
  btnDashCatalog?.addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="catalog"]').click();
  });

  btnDashRun?.addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="monitor"]').click();
    setTimeout(() => {
      syncMonitorDockBounds();
      btnStartScrape?.click();
    }, 60);
  });

  btnDashTour?.addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="monitor"]').click();
    document.getElementById('select-mode').value = 'visible';
    setTimeout(() => {
      syncMonitorDockBounds();
      btnStartScrape?.click();
    }, 60);
  });

  // Filter Tabs for Diff Review
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetFilter = tab.getAttribute('data-filter');
      document.querySelectorAll('.filter-tab').forEach(t => {
        if (t.getAttribute('data-filter') === targetFilter) {
          t.classList.add('active');
        } else {
          t.classList.remove('active');
        }
      });
      activeDiffFilter = targetFilter;
      renderDiffTable();
    });
  });

  // Filter Status Toggles (All Slabs / Changes Only / Unchanged Only)
  const btnStatusAll = document.getElementById('btn-status-all');
  const btnStatusChanged = document.getElementById('btn-status-changed');
  const btnStatusUnchanged = document.getElementById('btn-status-unchanged');

  const setStatusFilter = (status) => {
    activeStatusFilter = status;
    [btnStatusAll, btnStatusChanged, btnStatusUnchanged].forEach(btn => {
      if (!btn) return;
      if (btn.getAttribute('data-status') === status) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
    renderDiffTable();
  };

  btnStatusAll?.addEventListener('click', () => setStatusFilter('all'));
  btnStatusChanged?.addEventListener('click', () => setStatusFilter('changed'));
  btnStatusUnchanged?.addEventListener('click', () => setStatusFilter('unchanged'));

  // Rate Change Approval Modal Buttons
  document.getElementById('btn-modal-close-x')?.addEventListener('click', hideRateChangeApprovalModal);
  document.getElementById('btn-modal-cancel')?.addEventListener('click', hideRateChangeApprovalModal);
  document.getElementById('btn-modal-review-changes')?.addEventListener('click', () => {
    hideRateChangeApprovalModal();
    document.querySelector('.nav-item[data-tab="diff"]')?.click();
    setStatusFilter('changed');
  });
  document.getElementById('btn-modal-approve-publish')?.addEventListener('click', executePublishToDatabase);

  // App Update Modal Buttons
  document.getElementById('btn-app-update-later')?.addEventListener('click', () => {
    deferredUpdateVersion = pendingUpdateDownloaded || latestAvailableVersion;
    hideAppUpdateModal();
    const banner = document.getElementById('update-banner');
    if (banner) banner.style.display = 'none';
  });
  document.getElementById('btn-app-update-now')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-app-update-now');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Downloading...';
    }
    const progContainer = document.getElementById('app-update-progress-container');
    if (progContainer) progContainer.style.display = 'block';
    try {
      const res = await window.ratecardAPI.downloadUpdate();
      if (!res?.success) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '⚡ Update Now';
        }
        alert(res?.error || 'The update could not be downloaded.');
      }
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚡ Update Now';
      }
      console.warn('Download update failed:', err);
    }
  });
  document.getElementById('btn-app-update-restart')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-app-update-restart');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Restarting...';
    }
    try {
      const res = await window.ratecardAPI.installUpdate();
      if (!res?.success) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🔄 Restart to Apply';
        }
        alert(res?.error || 'The update could not be installed.');
      }
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Restart to Apply';
      }
      console.warn('Install update failed:', err);
    }
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
  });
  scraperSelectMp?.addEventListener('change', (e) => {
    syncMarketplaceSelection(e.target.value);
  });
  document.getElementById('select-review-marketplace')?.addEventListener('change', loadRateCardPreview);

  // Manual marketplace sign-in buttons (Dashboard & Settings)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-ch-login');
    if (!btn) return;
    const channel = btn.getAttribute('data-channel');
    if (!channel) return;

    syncMarketplaceSelection(channel);
    // Switch to Live Browser so the user can follow the separate sign-in window.
    document.querySelector('.nav-item[data-tab="monitor"]')?.click();
    setTimeout(() => {
      syncMonitorDockBounds();
      triggerInteractiveLogin(channel);
    }, 60);
  });

  // Human interactive login; the marketplace may request an OTP or other challenge.
  btnInteractiveLogin?.addEventListener('click', async () => {
    const selectEl = document.getElementById('select-marketplace');
    const selectedVal = selectEl?.value || 'flipkart_shopsy';
    const selectedOption = selectEl?.selectedOptions?.[0] || (selectEl && Array.from(selectEl.options).find(o => o.value === selectedVal));
    const portalUrl = selectedOption?.getAttribute('data-portal') || 'https://seller.flipkart.com/';
    const channelName = selectedOption?.innerText || selectedVal;

    const isSellerHub = ['flipkart_shopsy', 'flipkart', 'shopsy', 'both'].includes(selectedVal);
    if (isSellerHub) {
      appendTerminalLine(`Opening the ${channelName} public page. Flipkart sign-in is two steps: click Login, enter the seller ID/email/phone, click Next, then enter the password and click Login in the modal.`);
      appendTerminalLine('Leave the Seller Hub Chrome window open until the authenticated dashboard is confirmed. Complete any verification prompt manually.');
    } else {
      appendTerminalLine(`Opening the ${channelName} sign-in page. Complete sign-in manually and leave the browser open until authentication is confirmed.`);
    }
    appendTerminalLine(`Sign-in starts at: ${portalUrl}`);

    try {
      const result = await window.ratecardAPI.runInteractiveLogin({
        marketplace: selectedVal,
        portal_url: portalUrl,
        display_name: channelName
      });
      if (result.success) {
        if (result.cookiesCount) {
          appendTerminalLine(`✓ Seller Hub session saved (${result.cookiesCount} encrypted cookies plus the persistent browser profile).`);
        } else {
          appendTerminalLine(`✓ Sign-in window opened. Complete login manually; the worker will retain and reuse the session.`);
        }
      } else if (result.waitingForManualLogin) {
        appendTerminalLine('Sign-in is still waiting. Complete login in the open Seller Hub window; the worker will save the session automatically.');
      } else {
        appendTerminalLine(`Launch error: ${result.error}`);
      }
    } catch (err) {
      appendTerminalLine(`Execution error: ${err.message}`);
      await loadRateCardPreview();
    } finally {
      await loadSessionStatusUI();
    }
  });

  // Reset session cookies
  btnClearSession?.addEventListener('click', async () => {
    const selectEl = document.getElementById('select-marketplace');
    const selectedVal = selectEl?.value || 'flipkart_shopsy';
    appendTerminalLine(`Purging saved session cookies for ${selectedVal}...`);
    try {
      if (window.ratecardAPI?.clearMarketplaceSession) {
        const res = await window.ratecardAPI.clearMarketplaceSession(selectedVal);
        if (res && res.success === false) {
          throw new Error(res.error || res.message || 'Failed to clear session cookies');
        }
      }
      appendTerminalLine(`✓ Saved cookies purged for ${selectedVal}. Fresh login will be used.`);
    } catch (err) {
      appendTerminalLine(`❌ Reset error: ${err.message}`);
    } finally {
      await loadSessionStatusUI();
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
        // Switch to Review & DB Sync tab so user can inspect diffs and commit
        document.querySelector('.nav-item[data-tab="diff"]')?.click();
        if (currentChanges.length > 0) {
          const incCount = currentChanges.filter(c => c.financialImpact === 'cost_increase' || c.financialImpact === 'increase' || c.financialImpact === 'new_fee_introduced').length;
          triggerRateChangeNotification(currentChanges.length, incCount);
          showRateChangeApprovalModal();
        }
      } else {
        appendTerminalLine('Scraping failed' + (result.errorCode ? ' [' + result.errorCode + ']' : '') + ': ' + result.error);
        if (result.diagnostic?.screenshot) appendTerminalLine('Failure screenshot saved: ' + result.diagnostic.screenshot);
        await loadRateCardPreview();
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

  btnCommitDb?.addEventListener('click', () => {
    if (currentRateCards.length === 0) {
      alert('No staged rate cards available. Run an extraction first.');
      return;
    }
    if (currentChanges.length === 0 && currentComparisonAvailable) {
      alert('✓ Database is fully in sync with active PostgreSQL records (0 changes). No updates required.');
      return;
    }
    showRateChangeApprovalModal();
  });

  // Excel Actions
  /**
   * Generates a multi-sheet Excel workbook from published rate cards.
   *
   * @param {object} [opts={}] - Options (silent: boolean to suppress alert).
   * @returns {Promise<object>} Export result.
   */
  const handleGenerateExcel = async (opts = {}) => {
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
        if (!opts.silent) {
          alert(`Excel file successfully created on Desktop!\n\nLocation: ${res.filePath}`);
        }
        return res;
      } else {
        appendTerminalLine(`Excel export failed: ${res.error}`);
        if (!opts.silent) alert(`Excel export failed: ${res.error}`);
        return res;
      }
    } catch (err) {
      appendTerminalLine(`Excel error: ${err.message}`);
      if (!opts.silent) alert(`Excel error: ${err.message}`);
      return { success: false, error: err.message };
    }
  };

  /**
   * Launches the desktop rate card Excel workbook in Microsoft Excel,
   * auto-generating it if the file is not yet present on disk.
   *
   * @returns {Promise<void>}
   */
  const handleOpenExcel = async () => {
    appendTerminalLine('Launching Desktop Excel file in Microsoft Excel...');
    let res = await window.ratecardAPI.openExcelFile();
    if (!res.success && String(res.error).toLowerCase().includes('not found')) {
      appendTerminalLine('Excel workbook not found on disk. Generating workbook now...');
      await handleGenerateExcel({ silent: true });
      res = await window.ratecardAPI.openExcelFile();
    }
    if (res.success) {
      appendTerminalLine(`✓ Opened: ${res.filePath}`);
      const excelPathEl = document.getElementById('excel-path-display');
      if (excelPathEl && res.filePath) excelPathEl.innerText = res.filePath;
    } else {
      appendTerminalLine(`Could not open Excel file: ${res.error}`);
      alert(`Could not open Excel file: ${res.error}`);
    }
  };

  btnQuickExcel?.addEventListener('click', () => handleGenerateExcel());
  btnGenerateExcel?.addEventListener('click', () => handleGenerateExcel());
  btnQuickOpenExcel?.addEventListener('click', handleOpenExcel);
  btnLaunchExcel?.addEventListener('click', handleOpenExcel);

  // Auto-Sync Toggle Synchronization
  const dashAutoSyncToggle = document.getElementById('dash-auto-sync-toggle');
  const cfgAutoSyncDb = document.getElementById('cfg-auto-sync-db');
  const savedAutoSync = localStorage.getItem('reconcentral_auto_sync') === 'true';
  if (dashAutoSyncToggle) dashAutoSyncToggle.checked = savedAutoSync;
  if (cfgAutoSyncDb) cfgAutoSyncDb.checked = savedAutoSync;

  const onAutoSyncToggled = (enabled) => {
    localStorage.setItem('reconcentral_auto_sync', enabled ? 'true' : 'false');
    if (dashAutoSyncToggle) dashAutoSyncToggle.checked = enabled;
    if (cfgAutoSyncDb) cfgAutoSyncDb.checked = enabled;
    appendTerminalLine(`Autonomous Auto-Sync ${enabled ? 'ENABLED' : 'DISABLED'}.`);
  };
  dashAutoSyncToggle?.addEventListener('change', (e) => onAutoSyncToggled(e.target.checked));
  cfgAutoSyncDb?.addEventListener('change', (e) => onAutoSyncToggled(e.target.checked));

  // Settings DB Test
  btnTestDb?.addEventListener('click', async () => {
    const dbUrl = document.getElementById('cfg-db-url').value;
    const resultSpan = document.getElementById('db-test-result');
    resultSpan.innerText = 'Testing connection...';
    resultSpan.style.color = 'var(--text-muted)';

    const res = await window.ratecardAPI.testDbConnection(dbUrl);
    if (res.success) {
      resultSpan.innerText = `✓ Connected to database: ${res.db}`;
      resultSpan.style.color = 'var(--success-strong)';
    } else {
      resultSpan.innerText = `✗ Connection failed: ${res.error}`;
      resultSpan.style.color = 'var(--danger-strong)';
    }
  });

  // Save Settings
  btnSaveSettings?.addEventListener('click', async () => {
    const newConfig = {
      databaseUrl: document.getElementById('cfg-db-url').value,
      scheduledHour: parseInt(document.getElementById('cfg-hour').value) || 6,
      scheduledMinute: parseInt(document.getElementById('cfg-minute').value) || 0,
      notificationEmail: document.getElementById('cfg-alert-email').value
    };

    const res = await window.ratecardAPI.saveConfig(newConfig);
    if (res.success) {
      alert('Settings saved successfully!');
      appendTerminalLine('✓ Worker configuration updated.');
      await loadInitialState();
      await loadCatalogData();
      await loadRateCardPreview();
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
        sessionStatusEl.style.color = 'var(--text-muted)';
      }
      if (sessionSubEl) sessionSubEl.innerText = 'Sign in again to check marketplace sessions';
      if (dbStatusEl) {
        dbStatusEl.innerText = 'Signed Out';
        dbStatusEl.style.color = 'var(--text-muted)';
      }
      if (engineStatusEl) engineStatusEl.innerText = 'Idle';
    }
  });

  btnAuthTestDb?.addEventListener('click', async () => {
    const dbUrl = authDbInput?.value;
    if (authDbPingStatus) {
      authDbPingStatus.innerText = 'Pinging DB...';
      authDbPingStatus.style.color = 'var(--text-muted)';
    }
    try {
      const res = await window.ratecardAPI.authVerifyDb(dbUrl);
      if (res && res.success) {
        authDbPingStatus.innerText = `✓ Connected (${res.latencyMs}ms, ${res.dbName})`;
        authDbPingStatus.style.color = 'var(--success-strong)';
      } else {
        authDbPingStatus.innerText = `✗ Failed: ${res?.error || 'Unknown'}`;
        authDbPingStatus.style.color = 'var(--danger-strong)';
      }
    } catch (err) {
      authDbPingStatus.innerText = `✗ Error: ${err.message}`;
      authDbPingStatus.style.color = 'var(--danger-strong)';
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
function renderAccountsUnavailable(message) {
  const tbody = document.getElementById('tbody-marketplace-accounts');
  if (!tbody) return;
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = 5;
  td.className = 'empty-state';
  td.textContent = message;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

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
          tdPortal.style.fontFamily = "\'JetBrains Mono\', monospace";
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

          // TD 5: Manual session sign-in Button
          const tdBtn = document.createElement('td');
          const btn = document.createElement('button');
          btn.className = 'btn btn-sm btn-secondary btn-ch-login';
          btn.setAttribute('data-channel', channelKey);
          btn.style.padding = '2px 8px';
          btn.style.fontSize = '11px';
          btn.textContent = channelKey === 'flipkart_shopsy' ? 'Seller Hub Sign-in' : '2FA Login';
          tdBtn.appendChild(btn);
          tr.appendChild(tdBtn);

          tbody.appendChild(tr);
        });
      }

      // Dashboard channel cards are owned exclusively by loadSessionStatusUI()
      // (real cookie vault state). Backend vault linkage is shown in the table
      // badges above, so it must not overwrite the per-channel session status.
    } else {
      // Never leave the hard-coded placeholder rows in place: without verified
      // account data the vault must read as unverified, not active.
      renderAccountsUnavailable('No marketplace accounts were returned — vault status is unverified.');
    }
  } catch (err) {
    renderAccountsUnavailable('Vault status unknown — the accounts service did not respond. Sign-in state is unverified.');
    console.warn('Could not load marketplace accounts:', err);
  }
}

