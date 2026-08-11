const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const http = require('http');
const net  = require('net');
const { exec } = require('child_process');

const isDev = !app.isPackaged;

let proxyServer   = null;
let proxyPort     = null;
let blockedDomains = [];

// ── Proxy helpers ─────────────────────────────────────────────────────
function domainBlocked(host) {
  const h = host.split(':')[0].toLowerCase();
  return blockedDomains.some(d => h === d || h.endsWith('.' + d));
}

function startProxy() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const host = (req.headers.host || '').split(':')[0];
      if (domainBlocked(host)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Blocked by Focus Mode');
        return;
      }
      try {
        const parsed = new URL(req.url.startsWith('http') ? req.url : `http://${host}${req.url}`);
        const opts = {
          hostname: parsed.hostname,
          port:     parsed.port || 80,
          path:     parsed.pathname + parsed.search,
          method:   req.method,
          headers:  req.headers,
        };
        const upstream = http.request(opts, (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        });
        upstream.on('error', () => { try { res.end(); } catch {} });
        req.pipe(upstream);
      } catch { res.end(); }
    });

    server.on('connect', (req, socket) => {
      const [host, portStr] = req.url.split(':');
      if (domainBlocked(host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      const remote = net.connect(parseInt(portStr) || 443, host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        remote.pipe(socket);
        socket.pipe(remote);
      });
      remote.on('error', () => { try { socket.destroy(); } catch {} });
      socket.on('error', () => { try { remote.destroy(); } catch {} });
    });

    server.listen(0, '127.0.0.1', () => {
      proxyPort  = server.address().port;
      proxyServer = server;
      resolve(proxyPort);
    });
    server.on('error', reject);
  });
}

function stopProxy() {
  return new Promise((resolve) => {
    if (!proxyServer) { resolve(); return; }
    proxyServer.close(() => { proxyServer = null; proxyPort = null; resolve(); });
  });
}

function setSystemProxy(port) {
  return new Promise((resolve) => {
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    exec(
      `reg add "${base}" /v ProxyEnable /t REG_DWORD /d 1 /f && ` +
      `reg add "${base}" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`,
      resolve
    );
  });
}

function clearSystemProxy() {
  return new Promise((resolve) => {
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    exec(`reg add "${base}" /v ProxyEnable /t REG_DWORD /d 0 /f`, resolve);
  });
}

// ── Window ────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width:  430,
    height: 820,
    minWidth: 380,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Behavior Tracker',
    backgroundColor: '#0a0c0f',
  });

  // Bypass the system proxy for Electron's own window so Firebase still works
  win.webContents.session.setProxy({ mode: 'direct' });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  clearSystemProxy().catch(() => {}); // clean up if we crashed last time
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (blockedDomains.length === 0) return;
  event.preventDefault();
  Promise.all([clearSystemProxy(), stopProxy()])
    .catch(() => {})
    .finally(() => { blockedDomains = []; app.quit(); });
});

// ── IPC handlers ──────────────────────────────────────────────────────
ipcMain.handle('focus:isAdmin', () => true); // proxy needs no admin

ipcMain.handle('focus:block', async (_, sites) => {
  try {
    const domains = [];
    for (const raw of sites) {
      const d = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase();
      if (!d) continue;
      domains.push(d);
      if (!d.startsWith('www.')) domains.push(`www.${d}`);
    }
    blockedDomains = domains;
    const port = await startProxy();
    await setSystemProxy(port);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('focus:unblock', async () => {
  try {
    await clearSystemProxy();
    await stopProxy();
    blockedDomains = [];
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:notify', (_, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
  return { ok: true };
});
