'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, net } = require('electron');
const { PrintService, findSoffice } = require('./lib/printService');
const { CloudflaredManager, findCloudflared } = require('./lib/cloudflared');

const CLOUDFLARED_DOWNLOAD = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

let mainWindow = null;
let tray = null;
let service = null;
let cloudflared = null;
let quitting = false;

let config = {
  port: 8081,
  token: '',
  sofficePath: '',
  autoStart: false,
  cloudflare: {
    mode: 'quick',
    url: 'http://127.0.0.1:3000',
    token: '',
    cloudflaredPath: '',
    autoStart: false,
  },
};

// ---------- 路径（兼容便携版）----------
function dataDir() {
  // 便携版：配置与数据保存在 exe 同目录，随程序携带
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  return app.getPath('userData');
}

function configFile() {
  return path.join(dataDir(), 'webprint-config.json');
}

function autoStartExecPath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function buildResource(name) {
  const candidates = [
    path.join(__dirname, 'build', name),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'build', name),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* ignore */
    }
  }
  return candidates[0];
}

// ---------- 配置读写 ----------
function loadConfig() {
  try {
    if (fs.existsSync(configFile())) {
      const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
      config = {
        ...config,
        ...parsed,
        cloudflare: { ...config.cloudflare, ...(parsed.cloudflare || {}) },
      };
    }
  } catch (_) {
    /* 使用默认配置 */
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(config, null, 2), 'utf8');
  } catch (_) {
    /* ignore */
  }
}

// ---------- 打印服务 ----------
function buildService() {
  return new PrintService({
    host: '127.0.0.1',
    port: config.port,
    token: config.token,
    sofficePath: config.sofficePath || findSoffice(),
  });
}

async function ensureService() {
  if (!service) service = buildService();
  return service;
}

// ---------- 云隧道 ----------
function buildCloudflared() {
  const mgr = new CloudflaredManager({ onChange: broadcastState });
  mgr.setConfig(config.cloudflare);
  return mgr;
}

async function ensureCloudflared() {
  if (!cloudflared) cloudflared = buildCloudflared();
  return cloudflared;
}

function downloadFile(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    request.on('response', (response) => {
      const code = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && response.headers.location && redirects > 0) {
        const next = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
        response.resume();
        resolve(downloadFile(next, dest, redirects - 1));
        return;
      }
      if (code !== 200) {
        response.resume();
        reject(new Error(`下载失败，HTTP ${code}`));
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: 'WebPrint 打印助手',
    icon: buildResource('icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
  updateTrayMenu();
}

// ---------- 托盘 ----------
function createTray() {
  let image = nativeImage.createFromPath(buildResource('tray.png'));
  if (image.isEmpty()) image = nativeImage.createFromPath(buildResource('icon.png'));
  tray = new Tray(image);
  tray.setToolTip('WebPrint 打印助手');
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const running = !!(service && service.running);
  const tunnel = cloudflared ? cloudflared.state() : { running: false };
  tray.setToolTip(`WebPrint 打印助手 - 服务${running ? '运行中' : '已停止'} / 隧道${tunnel.running ? '运行中' : '已停止'}`);
  const menu = Menu.buildFromTemplate([
    { label: `打印服务：${running ? '运行中' : '已停止'}`, enabled: false },
    { label: `Cloudflare 隧道：${tunnel.running ? '运行中' : '已停止'}`, enabled: false },
    { type: 'separator' },
    { label: '显示主界面', click: showWindow },
    {
      label: running ? '停止打印服务' : '启动打印服务',
      click: async () => {
        if (running) await service.stop();
        else await (await ensureService()).start();
        updateTrayMenu();
        broadcastState();
      },
    },
    {
      label: tunnel.running ? '停止 Cloudflare 隧道' : '启动 Cloudflare 隧道',
      click: async () => {
        const mgr = await ensureCloudflared();
        if (tunnel.running) mgr.stop();
        else mgr.start();
        updateTrayMenu();
        broadcastState();
      },
    },
    { label: '打开 Web 打印界面', click: () => shell.openExternal('http://127.0.0.1:3000') },
    { type: 'separator' },
    {
      label: '退出',
      click: async () => {
        quitting = true;
        await shutdown();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-changed', publicState());
  }
}

// ---------- 状态 ----------
function publicState() {
  return {
    running: !!(service && service.running),
    host: '127.0.0.1',
    port: config.port,
    token: config.token,
    sofficePath: config.sofficePath || findSoffice(),
    autoStart: config.autoStart,
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
    dataDir: dataDir(),
    logs: service ? service.logs.slice(-60) : [],
    cloudflare: cloudflared ? cloudflared.state() : null,
  };
}

function applyAutoStart() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!config.autoStart, path: autoStartExecPath() });
  } catch (_) {
    /* ignore */
  }
}

async function shutdown() {
  if (cloudflared) cloudflared.dispose();
  if (service && service.running) {
    await service.stop().catch(() => {});
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('state:get', () => publicState());

  ipcMain.handle('service:start', async () => {
    try {
      await (await ensureService()).start();
    } catch (err) {
      return { ok: false, error: `启动失败：${err.message}` };
    }
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });

  ipcMain.handle('service:stop', async () => {
    if (service) await service.stop();
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });

  ipcMain.handle('service:printers', async () => {
    try {
      const printers = await (await ensureService()).listPrinters();
      return { ok: true, printers };
    } catch (err) {
      return { ok: false, error: err.message, printers: [] };
    }
  });

  ipcMain.handle('config:save', async (event, patch) => {
    const wasRunning = service && service.running;
    if (patch.port !== undefined) config.port = Number.parseInt(patch.port, 10) || 8081;
    if (patch.token !== undefined) config.token = String(patch.token || '');
    if (patch.sofficePath !== undefined) config.sofficePath = String(patch.sofficePath || '');
    if (patch.autoStart !== undefined) config.autoStart = !!patch.autoStart;
    saveConfig();
    applyAutoStart();
    if (service) await service.stop().catch(() => {});
    service = buildService();
    if (wasRunning) await service.start().catch(() => {});
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });

  ipcMain.handle('cloudflare:save', async (event, patch) => {
    config.cloudflare = { ...config.cloudflare, ...(patch || {}) };
    saveConfig();
    if (!cloudflared) cloudflared = buildCloudflared();
    const wasRunning = cloudflared.running;
    if (wasRunning) {
      cloudflared.stop();
      cloudflared.setConfig(config.cloudflare);
      cloudflared.start();
    } else {
      cloudflared.setConfig(config.cloudflare);
    }
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });

  ipcMain.handle('cloudflare:start', async () => {
    const mgr = await ensureCloudflared();
    mgr.setConfig(config.cloudflare);
    mgr.start();
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });

  ipcMain.handle('cloudflare:stop', async () => {
    if (cloudflared) cloudflared.stop();
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });

  ipcMain.handle('cloudflare:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 cloudflared.exe',
      properties: ['openFile'],
      filters: [{ name: 'cloudflared', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('cloudflare:download', async () => {
    try {
      const dest = path.join(dataDir(), 'cloudflared.exe');
      await downloadFile(CLOUDFLARED_DOWNLOAD, dest);
      config.cloudflare.cloudflaredPath = dest;
      saveConfig();
      if (cloudflared) cloudflared.setConfig(config.cloudflare);
      return { ok: true, path: dest, state: publicState() };
    } catch (err) {
      return { ok: false, error: `下载 cloudflared 失败：${err.message}` };
    }
  });

  ipcMain.handle('cloudflare:open-download', async () => {
    await shell.openExternal('https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  });

  ipcMain.handle('dialog:pick-soffice', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 soffice.exe',
      properties: ['openFile'],
      filters: [{ name: 'LibreOffice', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('app:open-web', async () => {
    await shell.openExternal('http://127.0.0.1:3000');
  });

  ipcMain.handle('app:open-external', async (event, url) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  ipcMain.handle('app:hide', () => {
    if (mainWindow) mainWindow.hide();
  });

  ipcMain.handle('app:quit', async () => {
    quitting = true;
    await shutdown();
    app.quit();
  });
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    loadConfig();
    applyAutoStart();
    cloudflared = buildCloudflared();
    registerIpc();
    createWindow();
    createTray();

    try {
      await (await ensureService()).start();
    } catch (err) {
      dialog.showErrorBox('打印服务启动失败', `${err.message}\n\n请在界面中修改端口或令牌后重试。`);
    }

    if (config.cloudflare.autoStart) {
      cloudflared.start();
    }

    updateTrayMenu();
  });

  app.on('window-all-closed', () => {
    // 常驻托盘
  });

  app.on('before-quit', () => {
    quitting = true;
  });
}
