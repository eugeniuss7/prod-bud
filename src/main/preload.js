'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prodbud', {
  getState: () => ipcRenderer.invoke('state:get'),
  send: (action, args = {}) => ipcRenderer.send('cmd', { action, ...args }),
  onState: (cb) => ipcRenderer.on('state', (_e, snap) => cb(snap)),
  onFocusInput: (cb) => ipcRenderer.on('focus-input', () => cb()),
});
