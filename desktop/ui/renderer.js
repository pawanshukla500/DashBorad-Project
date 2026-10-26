// ReconCentral RateCard Worker Desktop UI Renderer

let currentScrapedData = [];
let currentChanges = [];

document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  await loadInitialState();
  setupEventListeners();
  subscribeToEvents();
});

// ── Tab Navigation ───────────────────────────────────────────────────────────
function setupNavigation() {
  const navButtons = document.querySelectorAll('.nav-item');
  const views = document.querySelectorAll('.tab-view');
  const pageTitle = document.getElementById('page-title');
  const pageDesc = document.getElementById('page-desc');

  const titles = {
    dashboard: { title: 'Dashboard & Operations', desc: 'Automated marketplace rate card extraction, change detection, and sync' },
    scraper: { title: 'Live Scraper Worker', desc: 'Interactive browser automation, real-time logging, and rate card extraction' },
    diff: { title: 'Rate Card Change Review', desc: 'Inspect fee adjustments, rate hikes, and auto-close previous periods' },
    settings: { title: 'Worker Configuration', desc: 'Marketplace credentials, PostgreSQL connection, and automated daily schedule' }
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

    // Dashboard info
    const hourStr = String(config.scheduledHour ?? 6).padStart(2, '0');
    const minStr = String(config.scheduledMinute ?? 0).padStart(2, '0');
    document.getElementById('dash-schedule').innerText = `${hourStr}:${minStr}`;
    document.getElementById('dash-verticals-count').innerText = config.selectedVerticals?.length || 7;

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
  const terminal = document.getElementById('terminal-body');

  window.ratecardAPI.onProgress((msg) => {
    appendTerminalLine(msg);
  });
}

function appendTerminalLine(text) {
  const terminal = document.getElementById('terminal-body');
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

// ── Button & Form Event Listeners ────────────────────────────────────────────
function setupEventListeners() {
  const btnDashRun = document.getElementById('btn-dash-run');
  const btnDashLogin = document.getElementById('btn-dash-login');
  const btnStartScrape = document.getElementById('btn-start-scrape');
  const btnInteractiveLogin = document.getElementById('btn-interactive-login');
  const btnClearTerminal = document.getElementById('btn-clear-terminal');
  const btnCommitDb = document.getElementById('btn-commit-db');
  const btnExportDiff = document.getElementById('btn-export-diff');
  const btnTestDb = document.getElementById('btn-test-db');
  const btnSaveSettings = document.getElementById('btn-save-settings');

  // Clear terminal
  btnClearTerminal.addEventListener('click', () => {
    document.getElementById('terminal-body').innerHTML = '<div class="log-line info">[System] Terminal cleared.</div>';
  });

  // Switch to scraper tab and run
  btnDashRun.addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="scraper"]').click();
    btnStartScrape.click();
  });

  // Human interactive login
  const handleInteractiveLogin = async () => {
    appendTerminalLine('Opening visible browser for human login & 2FA resolution...');
    appendTerminalLine('Please log in with your credentials on the Flipkart window and complete OTP/2FA.');
    
    const result = await window.ratecardAPI.runInteractiveLogin('flipkart');
    if (result.success) {
      appendTerminalLine(`✓ Login successful! Stored ${result.cookiesCount} session cookies for headless runs.`);
      alert('Login successful! Session cookies have been saved for automated runs.');
    } else {
      appendTerminalLine(`Login cancelled or timed out: ${result.error}`);
    }
  };

  btnDashLogin.addEventListener('click', handleInteractiveLogin);
  btnInteractiveLogin.addEventListener('click', handleInteractiveLogin);

  // Start Scraper Worker
  btnStartScrape.addEventListener('click', async () => {
    btnStartScrape.disabled = true;
    btnStartScrape.innerText = '⏳ Scraping in Progress...';
    document.getElementById('engine-status').innerText = 'Scraping...';
    document.getElementById('engine-status').style.color = '#f59e0b';

    appendTerminalLine('Starting Flipkart Rate Card Scraper Worker...');

    try {
      const result = await window.ratecardAPI.startScrape({});
      if (result.success && result.data) {
        currentScrapedData = result.data;
        appendTerminalLine(`Scraping finished! ${result.data.length} rate cards captured.`);
        
        // Analyze changes
        appendTerminalLine('Comparing scraped rates against database...');
        const diffResult = await window.ratecardAPI.detectChanges(result.data);
        if (diffResult.success) {
          currentChanges = diffResult.changes || [];
          renderDiffTable(currentChanges);
          appendTerminalLine(`Comparison complete: ${currentChanges.length} rate changes / adjustments detected.`);
          
          const badge = document.getElementById('changes-badge');
          badge.innerText = currentChanges.length;
          badge.style.display = currentChanges.length > 0 ? 'inline-block' : 'none';

          // Auto switch to Diff tab if changes found
          if (currentChanges.length > 0) {
            document.querySelector('.nav-item[data-tab="diff"]').click();
          }
        }
      } else {
        appendTerminalLine(`Scraping encountered an error: ${result.error}`);
      }
    } catch (err) {
      appendTerminalLine(`Scraping execution error: ${err.message}`);
    } finally {
      btnStartScrape.disabled = false;
      btnStartScrape.innerText = '⚡ Run Scraper Worker';
      document.getElementById('engine-status').innerText = 'Ready';
      document.getElementById('engine-status').style.color = '#10b981';
    }
  });

  // Commit changes to Database
  btnCommitDb.addEventListener('click', async () => {
    if (currentScrapedData.length === 0) {
      alert('No scraped data to commit. Run the scraper first.');
      return;
    }

    if (!confirm(`Are you sure you want to commit these rate cards to the database?\n\nThis will auto-close previous rates with yesterday's end-date and activate new rates from today.`)) {
      return;
    }

    btnCommitDb.disabled = true;
    btnCommitDb.innerText = 'Committing...';

    try {
      const syncResult = await window.ratecardAPI.syncToDb(currentScrapedData);
      if (syncResult.success) {
        alert(`Successfully synced to database!\n\nPublished Version: ${syncResult.result.versionName}\nReconCentral fee engine cache has been updated.`);
        document.getElementById('changes-badge').style.display = 'none';
        renderDiffTable([]);
      } else {
        alert(`Sync failed: ${syncResult.error}`);
      }
    } catch (err) {
      alert(`Sync error: ${err.message}`);
    } finally {
      btnCommitDb.disabled = false;
      btnCommitDb.innerText = '✓ Commit & Auto-Close Previous Rates';
    }
  });

  // Export JSON
  btnExportDiff.addEventListener('click', async () => {
    if (currentScrapedData.length === 0) {
      alert('No data to export.');
      return;
    }
    const res = await window.ratecardAPI.exportFile('json', {
      scrapedAt: new Date().toISOString(),
      changes: currentChanges,
      rateCards: currentScrapedData
    });
    if (res.success) {
      alert(`File exported successfully to:\n${res.filePath}`);
    }
  });

  // Test DB Connection
  btnTestDb.addEventListener('click', async () => {
    const dbUrl = document.getElementById('cfg-db-url').value.trim();
    const resultEl = document.getElementById('db-test-result');
    resultEl.innerText = 'Testing...';
    resultEl.style.color = '#94a3b8';

    const test = await window.ratecardAPI.testDbConnection(dbUrl);
    if (test.success) {
      resultEl.innerText = `✓ Connected to database: ${test.db}`;
      resultEl.style.color = '#10b981';
    } else {
      resultEl.innerText = `✗ Connection failed: ${test.error}`;
      resultEl.style.color = '#ef4444';
    }
  });

  // Save Settings
  btnSaveSettings.addEventListener('click', async () => {
    const newConfig = {
      email: document.getElementById('cfg-email').value.trim(),
      password: document.getElementById('cfg-password').value,
      databaseUrl: document.getElementById('cfg-db-url').value.trim(),
      scheduledHour: parseInt(document.getElementById('cfg-hour').value, 10) || 6,
      scheduledMinute: parseInt(document.getElementById('cfg-minute').value, 10) || 0,
      notificationEmail: document.getElementById('cfg-alert-email').value.trim(),
      autoSyncToDb: document.getElementById('cfg-auto-sync').checked
    };

    const res = await window.ratecardAPI.saveConfig(newConfig);
    if (res.success) {
      alert('Settings saved successfully!');
      loadInitialState();
    } else {
      alert(`Failed to save settings: ${res.error}`);
    }
  });
}

// ── Render Diff Table ────────────────────────────────────────────────────────
function renderDiffTable(changes) {
  const tbody = document.getElementById('diff-tbody');
  tbody.innerHTML = '';

  if (!changes || changes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No rate changes detected. Existing database rate cards are in 100% sync with Flipkart.</td></tr>';
    return;
  }

  changes.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${c.type}</strong></td>
      <td>${c.category}</td>
      <td>${c.slab}</td>
      <td style="color: #f87171;">${c.oldRate ?? 'None'}</td>
      <td style="color: #4ade80; font-weight: 600;">${c.newRate}</td>
      <td><span class="status-badge ${c.status === 'New Slab' ? 'new' : 'mod'}">${c.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}
