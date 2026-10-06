'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prodbud', {
  getState: () => ipcRenderer.invoke('state:get'),
  send: (action, args = {}) => ipcRenderer.send('cmd', { action, ...args }),
  onState: (cb) => ipcRenderer.on('state', (_e, snap) => cb(snap)),
  onFocusInput: (cb) => ipcRenderer.on('focus-input', () => cb()),
  // Exercise window
  exercise: (channel, args = {}) => ipcRenderer.invoke(`ex:${channel}`, args),
  onExercise: (cb) => ipcRenderer.on('exercise', (_e, payload) => cb(payload)),
});
