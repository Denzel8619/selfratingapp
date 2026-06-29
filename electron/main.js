const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const HOSTS_FILE = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const BLOCK_MARKER = '# behavior-tracker';

function blockSites(sites) {
  try {
    const entries = sites.flatMap(s => [
      `127.0.0.1 ${s} ${BLOCK_MARKER}`,
      `127.0.0.1 www.${s} ${BLOCK_MARKER}`,
    ]);
    const existing = fs.readFileSync(HOSTS_FILE, 'utf8');
    const toAdd = entries.filter(e => !existing.includes(e));
    if (toAdd.length > 0) {
      fs.appendFileSync(HOSTS_FILE, '\n' + toAdd.join('\n') + '\n', 'utf8');
    }
    try { execSync('ipconfig /flushdns', { stdio: 'ignore' }); } catch {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function unblockSites() {
  try {
    const content = fs.readFileSync(HOSTS_FILE, 'utf8');
    const cleaned = content
      .split('\n')
      .filter(line => !line.includes(BLOCK_MARKER))
      .join('\n');
    fs.writeFileSync(HOSTS_FILE, cleaned, 'utf8');
    try { execSync('ipconfig /flushdns', { stdio: 'ignore' }); } catch {}
  } catch (e) {
    console.error('unblockSites error:', e.message);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Behavior Tracker',
    autoHideMenuBar: true,
  });

  win.loadURL('https://self-rating-app-b3b2b.web.app');
}

app.whenReady().then(() => {
  ipcMain.handle('block-sites',   (_e, sites) => blockSites(sites));
  ipcMain.handle('unblock-sites', ()           => unblockSites());
  createWindow();
});

// Always clean up blocked sites when the app closes.
app.on('window-all-closed', () => {
  unblockSites();
  app.quit();
});
