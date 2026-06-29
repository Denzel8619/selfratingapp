const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  blockSites:   (sites) => ipcRenderer.invoke('block-sites', sites),
  unblockSites: ()      => ipcRenderer.invoke('unblock-sites'),
});
