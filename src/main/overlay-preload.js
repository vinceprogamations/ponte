'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onData: (fn) => ipcRenderer.on('overlay:data', (_e, members) => fn(members)),
});
