'use strict';
// Atualização automática pelas Releases do GitHub (electron-updater).
//
// Ao abrir, como o Discord: uma janelinha procura atualização antes do app.
// Se houver, baixa, instala em silêncio e reabre a Ponte já na versão nova.
// Sem internet ou com o GitHub fora do ar, o app abre normalmente em poucos
// segundos (a Ponte funciona só com a rede local).
//
// Com o app aberto, procura de novo a cada 30 minutos. O que for baixado
// nesse meio-tempo é instalado quando a Ponte for fechada (ou na hora, se o
// usuário clicar em "Reiniciar para atualizar").
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const CHECK_TIMEOUT = 8000; // tempo máximo esperando o GitHub responder ao abrir
const DOWNLOAD_TIMEOUT = 180000; // se o download demorar mais, abre o app e termina em segundo plano
const INTERVAL = 30 * 60 * 1000;

let updater = null;
let splash = null;
let timer = null;
const listeners = new Set();
const status = { state: 'idle', version: app.getVersion(), next: '', percent: 0, error: '' };

const snapshot = () => ({ ...status });

function set(patch) {
  Object.assign(status, patch);
  const s = snapshot();
  for (const fn of listeners) fn(s);
}

/** Atualiza sozinho só na versão instalada pelo Ponte-Instalar.exe. */
const TEST = process.env.PONTE_UPDATE_TEST === '1'; // força o atualizador sem instalar (só para testar)

function supported() {
  if (TEST) return true;
  return app.isPackaged
    && process.platform === 'win32'
    && process.env.PONTE_AUTOTEST !== '1'
    && process.env.PONTE_NO_UPDATE !== '1';
}

function init() {
  if (!supported()) { set({ state: 'disabled' }); return; }
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (err) {
    console.error('electron-updater indisponível:', err.message);
    set({ state: 'disabled' });
    return;
  }
  if (TEST) {
    updater.forceDevUpdateConfig = true;
    updater.setFeedURL({ provider: 'github', owner: 'vinceprogamations', repo: 'ponte' });
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = { info() {}, warn: console.warn, error() {}, debug() {} };

  updater.on('checking-for-update', () => set({ state: 'checking', error: '' }));
  updater.on('update-available', (info) => set({ state: 'downloading', next: info.version, percent: 0 }));
  updater.on('update-not-available', () => set({ state: 'latest', next: '' }));
  updater.on('download-progress', (p) => {
    const percent = Math.floor(p.percent || 0);
    if (percent !== status.percent || status.state !== 'downloading') set({ state: 'downloading', percent });
  });
  updater.on('update-downloaded', (info) => set({ state: 'ready', next: info.version, percent: 100 }));
  updater.on('error', (err) => {
    const error = String((err && err.message) || err).split('\n')[0].slice(0, 200);
    console.error('Atualização:', error);
    // Um erro depois do download (ex.: nova checagem sem internet) não desfaz o que já está pronto.
    set(status.state === 'ready' ? { error } : { state: 'error', error });
  });

  timer = setInterval(check, INTERVAL);
}

function check() {
  if (!updater || ['checking', 'downloading', 'ready'].includes(status.state)) return;
  updater.checkForUpdates().catch(() => {}); // o erro já chega pelo evento 'error'
}

/** Fecha a Ponte, instala a versão baixada sem perguntar nada e abre de novo. */
function install() {
  if (!updater || status.state !== 'ready') return false;
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
}

function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ------------------------------------------------------------------ janela de abertura
function paintSplash() {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents
    .executeJavaScript(`window.paint && window.paint(${JSON.stringify(snapshot())})`, true)
    .catch(() => {});
}

function createSplash() {
  splash = new BrowserWindow({
    width: 300,
    height: 340,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    backgroundColor: '#000000',
    title: 'Ponte',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.loadFile(path.join(__dirname, '..', 'renderer', 'update.html'));
  splash.webContents.on('did-finish-load', paintSplash);
  splash.once('ready-to-show', () => splash && !splash.isDestroyed() && splash.show());
}

/**
 * Procura atualização antes de abrir o app. Resolve quando o app pode abrir;
 * se uma atualização for instalada, a Ponte fecha e reabre sozinha e a
 * promessa nunca resolve. Chame closeSplash() depois de criar a janela principal.
 */
function startup() {
  if (!updater) return Promise.resolve();
  createSplash();
  return new Promise((resolve) => {
    let deadline = null;
    let downloading = false;
    const arm = (ms) => { clearTimeout(deadline); deadline = setTimeout(done, ms); };
    const off = onStatus((s) => {
      paintSplash();
      if (s.state === 'downloading' && !downloading) { downloading = true; arm(DOWNLOAD_TIMEOUT); }
      if (s.state === 'ready') { clearTimeout(deadline); off(); setTimeout(install, 700); }
      if (s.state === 'latest' || s.state === 'error') done();
    });
    function done() {
      clearTimeout(deadline);
      off();
      resolve();
    }
    arm(CHECK_TIMEOUT);
    check();
  });
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

function stop() {
  clearInterval(timer);
}

module.exports = { init, startup, closeSplash, check, install, onStatus, status: snapshot, supported, stop };
