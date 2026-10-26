const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ratecardAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  testDbConnection: (dbUrl) => ipcRenderer.invoke('test-db-connection', dbUrl),
  runInteractiveLogin: (marketplace) => ipcRenderer.invoke('interactive-login', marketplace),
  startScrape: (options) => ipcRenderer.invoke('start-scrape', options),
  detectChanges: (scrapedData) => ipcRenderer.invoke('detect-changes', scrapedData),
  syncToDb: (scrapedData) => ipcRenderer.invoke('sync-to-db', scrapedData),
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
