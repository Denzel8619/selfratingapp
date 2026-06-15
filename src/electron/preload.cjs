const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isAdmin:      ()      => ipcRenderer.invoke('focus:isAdmin'),
  blockSites:   (sites) => ipcRenderer.invoke('focus:block', sites),
  unblockSites: ()      => ipcRenderer.invoke('focus:unblock'),
});
