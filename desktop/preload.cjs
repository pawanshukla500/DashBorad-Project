const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ratecardAPI', {
  // Authentication & Authorization (Firebase & DB Role Gate)
  authLogin: (credentials) => ipcRenderer.invoke('auth-login', credentials),
  authGetSession: () => ipcRenderer.invoke('auth-get-session'),
  authLogout: () => ipcRenderer.invoke('auth-logout'),
  authVerifyDb: (dbUrl) => ipcRenderer.invoke('auth-verify-db', dbUrl),

  // Configuration & Marketplaces
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  testDbConnection: (dbUrl) => ipcRenderer.invoke('test-db-connection', dbUrl),
  getMarketplaces: () => ipcRenderer.invoke('get-marketplaces'),
  getMarketplaceAccounts: () => ipcRenderer.invoke('get-marketplace-accounts'),

  // Authentication & Live Browser
  runInteractiveLogin: (marketplace) => ipcRenderer.invoke('interactive-login', marketplace),
  startScrape: (options) => ipcRenderer.invoke('start-scrape', options),

  // Brand-Wise & FSN Catalog
  getBrandFsnCatalog: () => ipcRenderer.invoke('get-brand-fsn-catalog'),
  getRateCardPreview: (options) => ipcRenderer.invoke('get-ratecard-preview', options),

  // Change Detection & Database Sync
  detectBrandRateChanges: (brandRateCards) => ipcRenderer.invoke('detect-brand-rate-changes', brandRateCards),
  syncBrandRateCards: (brandRateCards, options) => ipcRenderer.invoke('sync-brand-rate-cards', brandRateCards, options),

  // Excel Export & System Launcher
  exportDesktopExcel: (outputPath) => ipcRenderer.invoke('export-desktop-excel', outputPath),
  openExcelFile: (filePath) => ipcRenderer.invoke('open-excel-file', filePath),
  exportFile: (format, data) => ipcRenderer.invoke('export-file', format, data),

  // Database Detail Download & Upload (Future-Ready Extensibility)
  downloadDatabaseDetails: (table, options = {}) => {
    const safeTable = typeof table === 'string' ? table.trim() : '';
    const safeOptions = {
      filters: options?.filters && typeof options.filters === 'object' && !Array.isArray(options.filters) ? options.filters : {},
      orderBy: typeof options?.orderBy === 'string' ? options.orderBy.trim() : 'id DESC',
      limit: Number.isInteger(options?.limit) ? Math.min(Math.max(1, options.limit), 5000) : 500
    };
    return ipcRenderer.invoke('download-database-details', safeTable, safeOptions);
  },
  uploadDatabaseDetails: (table, rows = [], keyColumns = ['id']) => {
    const safeTable = typeof table === 'string' ? table.trim() : '';
    const safeRows = Array.isArray(rows) ? rows : [];
    const safeKeys = Array.isArray(keyColumns) ? keyColumns.filter(k => typeof k === 'string') : ['id'];
    return ipcRenderer.invoke('upload-database-details', safeTable, safeRows, safeKeys);
  },
  
  // Real-time Event Listeners
  onProgress: (callback) => {
    const subscription = (event, msg) => callback(msg);
    ipcRenderer.on('scrape-progress', subscription);
    return () => ipcRenderer.removeListener('scrape-progress', subscription);
  },
  onScrapeCompleted: (callback) => {
    const subscription = (event, result) => callback(result);
    ipcRenderer.on('scrape-completed', subscription);
    return () => ipcRenderer.removeListener('scrape-completed', subscription);
  },

  // Auto-Update (GitHub Releases)
  getUpdateStatus: () => ipcRenderer.invoke('update-get-status'),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdateStatus: (callback) => {
    const subscription = (event, status) => callback(status);
    ipcRenderer.on('update-status', subscription);
    return () => ipcRenderer.removeListener('update-status', subscription);
  }
});
