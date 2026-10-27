const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ratecardAPI', {
  // Authentication & Authorization (Firebase & DB Role Gate)
  authLogin: (credentials) => ipcRenderer.invoke('auth-login', credentials),
  authGetSession: () => ipcRenderer.invoke('auth-get-session'),
  authLogout: () => ipcRenderer.invoke('auth-logout'),
  authVerifyDb: (dbUrl) => ipcRenderer.invoke('auth-verify-db', dbUrl),

  // Configuration
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  testDbConnection: (dbUrl) => ipcRenderer.invoke('test-db-connection', dbUrl),

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
  }
});
