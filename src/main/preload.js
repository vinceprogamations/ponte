'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('ponte', {
  init: () => ipcRenderer.invoke('init'),
  sendChat: (text) => ipcRenderer.invoke('chat:send', text),
  sendSignal: (to, data) => ipcRenderer.send('signal:send', { to, data }),
  setState: (patch) => ipcRenderer.send('state:set', patch),
  setName: (name) => ipcRenderer.invoke('name:set', name),
  addHost: (ip) => ipcRenderer.invoke('host:add', ip),
  removeHost: (ip) => ipcRenderer.invoke('host:remove', ip),
  screenSources: () => ipcRenderer.invoke('screen:sources'),
  selectScreen: (choice) => ipcRenderer.send('screen:select', choice),
  audioApps: () => ipcRenderer.invoke('audio:apps'),
  audioStart: (choice) => ipcRenderer.invoke('audio:start', choice),
  audioStop: () => ipcRenderer.send('audio:stop'),
  onAudioPcm: on('audio:pcm'),
  onAudioEnded: on('audio:ended'),
  sendMedia: (req) => ipcRenderer.invoke('media:send', req),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  onMediaProgress: on('media:progress'),
  onMediaReady: on('media:ready'),
  log: (line) => ipcRenderer.send('log', String(line)),
  onPeers: on('peers'),
  onChat: on('chat'),
  onSignal: on('signal'),
  onLog: on('log'),
  onTrayCmd: on('tray:cmd'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkUpdate: () => ipcRenderer.send('update:check'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdate: on('update:status'),
});
