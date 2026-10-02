'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage } = require('electron');
const { PrintService, findSoffice } = require('./lib/printService');

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const ICON_DIR = path.join(__dirname, 'build');

let mainWindow = null;
let tray = null;
let service = null;
let quitting = false;
let config = {
  port: 8081,
  token: '',
  sofficePath: '',
  autoStart: false,
};

// ---------- 配置读写 ----------
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE())) {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')) };
    }
  } catch (_) {
    /* 使用默认配置 */
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2), 'utf8');
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

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 560,
    minHeight: 480,
    title: 'WebPrint 打印助手',
    icon: path.join(ICON_DIR, 'icon.png'),
    autoHideMenuBar: true,
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
function trayImage() {
  const p = path.join(ICON_DIR, 'tray.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createFromPath(path.join(ICON_DIR, 'icon.png')) : img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('WebPrint 打印助手');
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const running = service && service.running;
  tray.setToolTip(`WebPrint 打印助手 - ${running ? '服务运行中' : '服务已停止'}`);
  const menu = Menu.buildFromTemplate([
    { label: `状态：${running ? '运行中' : '已停止'}`, enabled: false },
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
    logs: service ? service.logs.slice(-50) : [],
  };
}

async function applyAutoStart() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!config.autoStart, path: process.execPath });
  } catch (_) {
    /* ignore */
  }
}

async function shutdown() {
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
    await applyAutoStart();
    // 端口/令牌/路径变化时重建服务
    if (service) await service.stop().catch(() => {});
    service = buildService();
    if (wasRunning) await service.start().catch(() => {});
    updateTrayMenu();
    return { ok: true, state: publicState() };
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
    await applyAutoStart();
    registerIpc();
    createWindow();
    createTray();
    // 启动后自动运行本地打印服务
    try {
      await (await ensureService()).start();
    } catch (err) {
      dialog.showErrorBox('打印服务启动失败', `${err.message}\n\n请在界面中修改端口或令牌后重试。`);
    }
    updateTrayMenu();
  });

  app.on('window-all-closed', () => {
    // 常驻托盘，不随窗口关闭退出
  });

  app.on('before-quit', () => {
    quitting = true;
  });
}
