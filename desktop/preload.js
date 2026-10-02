'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayApi', {
  getState: () => ipcRenderer.invoke('state:get'),
  start: () => ipcRenderer.invoke('service:start'),
  stop: () => ipcRenderer.invoke('service:stop'),
  getPrinters: () => ipcRenderer.invoke('service:printers'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  pickSoffice: () => ipcRenderer.invoke('dialog:pick-soffice'),
  openWeb: () => ipcRenderer.invoke('app:open-web'),
  hide: () => ipcRenderer.invoke('app:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onStateChanged: (handler) => {
    const listener = (event, state) => handler(state);
    ipcRenderer.on('state-changed', listener);
    return () => ipcRenderer.removeListener('state-changed', listener);
  },
});
