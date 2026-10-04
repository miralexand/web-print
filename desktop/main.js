'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, net } = require('electron');
const { PrintService } = require('./lib/printService');
const { CloudflaredManager, findCloudflared } = require('./lib/cloudflared');

const REPO_URL = 'https://github.com/miralexand/web-print';
const LICENSE_NAME = 'MulanPSL-2.0';
const CLOUDFLARED_DOWNLOAD = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

let mainWindow = null;
let tray = null;
let service = null;
let webModule = null;
let webConfig = null;
let webRunning = false;
let cloudflared = null;
let quitting = false;

let config = {
  port: 8081,
  webPort: 3000,
  allowLan: true,
  token: '',
  agentBasePath: '',
  webUser: 'admin',
  webPass: 'admin123',
  sessionSecret: '',
  autoStart: false,
  disclaimerDontRemind: false,
  cloudflare: {
    mode: 'quick',
    url: 'http://127.0.0.1:3000',
    token: '',
    cloudflaredPath: '',
    autoStart: false,
  },
};

// ---------- 路径（兼容便携/绿色版）----------
function dataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  try {
    const exeDir = path.dirname(process.execPath);
    if (fs.existsSync(path.join(exeDir, 'portable.flag'))) return exeDir;
  } catch (_) {
    /* ignore */
  }
  return app.getPath('userData');
}

function configFile() {
  return path.join(dataDir(), 'webprint-config.json');
}

function logLine(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(path.join(dataDir(), 'desktop.log'), line + '\n', 'utf8');
  } catch (_) {
    /* ignore */
  }
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
  if (!config.sessionSecret) {
    config.sessionSecret = crypto.randomBytes(24).toString('hex');
    saveConfig();
  }
  if (!config.cloudflare.url || config.cloudflare.url === 'http://127.0.0.1:3000') {
    config.cloudflare.url = `http://127.0.0.1:${config.webPort}`;
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

// ---------- 打印服务（Agent）----------
function buildService() {
  return new PrintService({
    host: '127.0.0.1',
    port: config.port,
    token: config.token,
    basePath: config.agentBasePath,
  });
}

async function ensureService() {
  if (!service) service = buildService();
  return service;
}

// ---------- 内嵌 Web 服务 ----------
function setupWebEnv() {
  const base = path.join(dataDir(), 'web');
  process.env.PORT = String(config.webPort);
  process.env.HOST_PRINT_API = `http://127.0.0.1:${config.port}`;
  process.env.HOST_PRINT_TOKEN = config.token || '';
  process.env.DATA_FOLDER = path.join(base, 'data');
  process.env.LOG_FOLDER = path.join(base, 'logs');
  process.env.TMP_FOLDER = path.join(base, 'tmp');
  process.env.AUTH_USER = config.webUser || 'admin';
  process.env.AUTH_PASS = config.webPass || 'admin123';
  process.env.SESSION_SECRET = config.sessionSecret;
  process.env.TRUST_PROXY = '1';
}

function ensureWebModule() {
  if (!webModule) {
    setupWebEnv();
    // eslint-disable-next-line global-require
    webModule = require('./server/app');
    // eslint-disable-next-line global-require
    webConfig = require('./server/config');
  }
  return webModule;
}

async function startWeb() {
  const mod = ensureWebModule();
  // 打印服务端口/令牌变化时同步给 Web 服务
  if (webConfig) {
    webConfig.hostPrintApi = `http://127.0.0.1:${config.port}`;
    webConfig.hostPrintToken = config.token || '';
  }
  const host = config.allowLan ? '0.0.0.0' : '127.0.0.1';
  await mod.start({ port: config.webPort, host });
  webRunning = true;
  if (config.allowLan) ensureFirewallRule(config.webPort);
}

/** 尽力而为地为端口放行防火墙（需要管理员权限，失败不影响运行） */
function ensureFirewallRule(port) {
  try {
    execFile(
      'netsh',
      ['advfirewall', 'firewall', 'add', 'rule', `name=WebPrint Web ${port}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`],
      { windowsHide: true, timeout: 10000 },
      (err) => {
        if (err) logLine(`防火墙放行未成功（可在具有管理员权限时手动放行端口 ${port}）：${err.message}`);
        else logLine(`已为端口 ${port} 添加防火墙放行规则`);
      }
    );
  } catch (_) {
    /* ignore */
  }
}

function lanAddresses() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address);
    }
  }
  return result;
}

async function stopWeb() {
  if (webModule) {
    await webModule.stop().catch(() => {});
  }
  webRunning = false;
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
    width: 980,
    height: 740,
    minWidth: 780,
    minHeight: 580,
    title: 'WebPrint 打印助手',
    icon: buildResource('icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f7',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f5f5f7', symbolColor: '#1d1d1f', height: 52 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (level >= 3) logLine('渲染层错误:', message);
  });

  if (process.env.WEBPRINT_DEBUG === '1') {
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const info = await mainWindow.webContents.executeJavaScript(
          "Array.from(document.querySelectorAll('main section')).map(s => ({ title: (s.querySelector('h1')||{}).textContent || '?', len: s.innerHTML.length, shown: getComputedStyle(s).display }))"
        );
        logLine('渲染诊断:', JSON.stringify(info));
      } catch (err) {
        logLine('渲染诊断失败:', err.message);
      }
    });
  }

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
  const agentOn = !!(service && service.running);
  const tunnelOn = cloudflared ? cloudflared.state().running : false;
  tray.setToolTip(`WebPrint - Web${webRunning ? '开' : '关'} / 打印${agentOn ? '开' : '关'} / 隧道${tunnelOn ? '开' : '关'}`);
  const menu = Menu.buildFromTemplate([
    { label: `Web 服务：${webRunning ? '运行中' : '已停止'}`, enabled: false },
    { label: `打印服务：${agentOn ? '运行中' : '已停止'}`, enabled: false },
    { label: `Cloudflare 隧道：${tunnelOn ? '运行中' : '已停止'}`, enabled: false },
    { type: 'separator' },
    { label: '显示主界面', click: showWindow },
    {
      label: webRunning ? '停止 Web 服务' : '启动 Web 服务',
      click: async () => {
        if (webRunning) await stopWeb();
        else await startWeb().catch(() => {});
        updateTrayMenu();
        broadcastState();
      },
    },
    {
      label: agentOn ? '停止打印服务' : '启动打印服务',
      click: async () => {
        if (agentOn) await service.stop();
        else await (await ensureService()).start();
        updateTrayMenu();
        broadcastState();
      },
    },
    {
      label: tunnelOn ? '停止 Cloudflare 隧道' : '启动 Cloudflare 隧道',
      click: async () => {
        const mgr = await ensureCloudflared();
        if (tunnelOn) mgr.stop();
        else await mgr.start();
        updateTrayMenu();
        broadcastState();
      },
    },
    {
      label: '重建快速隧道',
      visible: config.cloudflare.mode === 'quick' && tunnelOn,
      click: async () => {
        const mgr = await ensureCloudflared();
        await mgr.restart();
        updateTrayMenu();
        broadcastState();
      },
    },
    { label: '打开 Web 打印界面', click: () => shell.openExternal(webUrl()) },
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

function webUrl() {
  return `http://127.0.0.1:${config.webPort}`;
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
    basePath: config.agentBasePath || '',
    converter: 'WPS 优先，Microsoft Office 兜底',
    autoStart: config.autoStart,
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
    dataDir: dataDir(),
    logs: service ? service.logs.slice(-60) : [],
    web: {
      running: webRunning,
      host: config.allowLan ? '0.0.0.0' : '127.0.0.1',
      port: config.webPort,
      url: webUrl(),
      allowLan: !!config.allowLan,
      lanUrls: (config.allowLan ? lanAddresses() : []).map((ip) => `http://${ip}:${config.webPort}`),
      adminUser: config.webUser,
    },
    cloudflare: cloudflared
      ? { ...cloudflared.state(), disclaimerDontRemind: !!config.disclaimerDontRemind }
      : { disclaimerDontRemind: !!config.disclaimerDontRemind },
    about: {
      name: 'WebPrint 打印助手',
      productName: 'WebPrintTray',
      version: app.getVersion(),
      repo: REPO_URL,
      license: LICENSE_NAME,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
    },
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
  await stopWeb();
  if (service && service.running) await service.stop().catch(() => {});
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('state:get', () => publicState());

  // 打印服务
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
      return { ok: true, printers: await (await ensureService()).listPrinters() };
    } catch (err) {
      return { ok: false, error: err.message, printers: [] };
    }
  });

  // Web 服务
  ipcMain.handle('web:start', async () => {
    try {
      await startWeb();
    } catch (err) {
      return { ok: false, error: `Web 服务启动失败：${err.message}` };
    }
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });
  ipcMain.handle('web:stop', async () => {
    await stopWeb();
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });

  // 配置
  ipcMain.handle('config:save', async (event, patch) => {
    const wasAgent = service && service.running;
    const wasWeb = webRunning;
    if (patch.port !== undefined) config.port = Number.parseInt(patch.port, 10) || 8081;
    if (patch.webPort !== undefined) config.webPort = Number.parseInt(patch.webPort, 10) || 3000;
    if (patch.allowLan !== undefined) config.allowLan = !!patch.allowLan;
    if (patch.token !== undefined) config.token = String(patch.token || '');
    if (patch.agentBasePath !== undefined) config.agentBasePath = String(patch.agentBasePath || '').trim();
    if (patch.autoStart !== undefined) config.autoStart = !!patch.autoStart;
    saveConfig();
    applyAutoStart();

    if (service) await service.stop().catch(() => {});
    service = buildService();
    if (wasAgent) await service.start().catch(() => {});

    if (webConfig) {
      webConfig.hostPrintApi = `http://127.0.0.1:${config.port}`;
      webConfig.hostPrintToken = config.token || '';
    }
    if (wasWeb) {
      await stopWeb();
      await startWeb().catch(() => {});
    }
    if (cloudflared) {
      config.cloudflare.url = config.cloudflare.url || `http://127.0.0.1:${config.webPort}`;
      cloudflared.setConfig(config.cloudflare);
    }
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });

  // Cloudflare 隧道
  ipcMain.handle('cloudflare:save', async (event, patch) => {
    config.cloudflare = { ...config.cloudflare, ...(patch || {}) };
    saveConfig();
    if (!cloudflared) cloudflared = buildCloudflared();
    const wasRunning = cloudflared.running;
    if (wasRunning) {
      cloudflared.stop();
      cloudflared.setConfig(config.cloudflare);
      await cloudflared.start();
    } else {
      cloudflared.setConfig(config.cloudflare);
    }
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });
  ipcMain.handle('cloudflare:start', async () => {
    const mgr = await ensureCloudflared();
    mgr.setConfig(config.cloudflare);
    await mgr.start();
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });
  ipcMain.handle('cloudflare:stop', async () => {
    if (cloudflared) cloudflared.stop();
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });
  ipcMain.handle('cloudflare:restart', async () => {
    const mgr = await ensureCloudflared();
    mgr.setConfig(config.cloudflare);
    await mgr.restart();
    updateTrayMenu();
    return { ok: true, state: publicState() };
  });
  ipcMain.handle('cloudflare:accept-disclaimer', async () => {
    config.disclaimerDontRemind = true;
    saveConfig();
    return { ok: true, state: publicState() };
  });
  ipcMain.handle('cloudflare:service-install', async () => {
    const mgr = await ensureCloudflared();
    mgr.setConfig(config.cloudflare);
    const result = await mgr.installService();
    updateTrayMenu();
    return { ...result, state: publicState() };
  });
  ipcMain.handle('cloudflare:service-uninstall', async () => {
    const mgr = await ensureCloudflared();
    const result = await mgr.uninstallService();
    updateTrayMenu();
    return { ...result, state: publicState() };
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

  ipcMain.handle('app:open-web', async () => shell.openExternal(webUrl()));
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

    // 一体化启动：打印服务 + Web 服务
    try {
      await (await ensureService()).start();
    } catch (err) {
      logLine('打印服务启动失败:', err && err.stack ? err.stack : err);
      dialog.showErrorBox('打印服务启动失败', `${err.message}\n\n请在界面中修改端口或令牌后重试。`);
    }
    try {
      await startWeb();
      logLine(`Web 服务已启动：${config.allowLan ? '0.0.0.0' : '127.0.0.1'}:${config.webPort}${config.allowLan ? '（局域网可访问）' : ''}`);
    } catch (err) {
      logLine('Web 服务启动失败:', err && err.stack ? err.stack : err);
      dialog.showErrorBox('Web 服务启动失败', `${(err && err.message) || err}\n\n请在界面中修改 Web 端口后重试。`);
    }
    if (config.cloudflare.autoStart) cloudflared.start().catch(() => {});
    updateTrayMenu();
  });

  app.on('window-all-closed', () => {
    // 常驻托盘
  });

  app.on('before-quit', () => {
    quitting = true;
  });
}
