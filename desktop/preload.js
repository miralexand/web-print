'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayApi', {
  getState: () => ipcRenderer.invoke('state:get'),

  start: () => ipcRenderer.invoke('service:start'),
  stop: () => ipcRenderer.invoke('service:stop'),
  getPrinters: () => ipcRenderer.invoke('service:printers'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  pickSoffice: () => ipcRenderer.invoke('dialog:pick-soffice'),

  webStart: () => ipcRenderer.invoke('web:start'),
  webStop: () => ipcRenderer.invoke('web:stop'),

  tunnelStart: () => ipcRenderer.invoke('cloudflare:start'),
  tunnelStop: () => ipcRenderer.invoke('cloudflare:stop'),
  tunnelSave: (patch) => ipcRenderer.invoke('cloudflare:save', patch),
  tunnelPick: () => ipcRenderer.invoke('cloudflare:pick'),
  tunnelDownload: () => ipcRenderer.invoke('cloudflare:download'),
  tunnelOpenDownload: () => ipcRenderer.invoke('cloudflare:open-download'),
  tunnelServiceInstall: () => ipcRenderer.invoke('cloudflare:service-install'),
  tunnelServiceUninstall: () => ipcRenderer.invoke('cloudflare:service-uninstall'),

  openWeb: () => ipcRenderer.invoke('app:open-web'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  hide: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),

  onStateChanged: (handler) => {
    const listener = (event, state) => handler(state);
    ipcRenderer.on('state-changed', listener);
    return () => ipcRenderer.removeListener('state-changed', listener);
  },
});
