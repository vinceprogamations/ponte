'use strict';
const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { LanNode, localInterfaces } = require('./lan');

// Sem isso o Chromium esconde os IPs locais atrás de nomes .local (mDNS),
// o que costuma falhar dentro do Radmin VPN.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const AUTOTEST = process.env.PONTE_AUTOTEST === '1';
const DEMO = process.env.PONTE_DEMO === '1';
if (process.env.PONTE_PROFILE) {
  app.setPath('userData', path.resolve(process.env.PONTE_PROFILE));
}
if (AUTOTEST) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

// Permite duas instâncias só no modo de teste (perfis diferentes).
if (!AUTOTEST && !process.env.PONTE_PROFILE && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let node = null;
let config = null;
let history = [];
let pendingScreen = null; // { id, audio }

const userFile = (name) => path.join(app.getPath('userData'), name);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Falha ao salvar', file, err.message);
  }
}

function loadConfig() {
  const cfg = readJson(userFile('config.json'), {});
  if (!cfg.id) cfg.id = crypto.randomUUID();
  if (!cfg.name) cfg.name = (process.env.PONTE_NAME || os.userInfo().username || 'Eu').slice(0, 40);
  if (process.env.PONTE_NAME) cfg.name = process.env.PONTE_NAME;
  if (!Array.isArray(cfg.manualHosts)) cfg.manualHosts = [];
  writeJson(userFile('config.json'), cfg);
  return cfg;
}

const saveConfig = () => writeJson(userFile('config.json'), config);

let historyTimer = null;
function saveHistorySoon() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => writeJson(userFile('history.json'), history.slice(-500)), 500);
}

function addMessages(msgs) {
  const known = new Set(history.map((m) => m.id));
  const fresh = [];
  for (const m of msgs) {
    if (!m || typeof m.id !== 'string' || known.has(m.id)) continue;
    if (typeof m.text !== 'string' || !m.text.trim()) continue;
    const clean = {
      id: m.id,
      from: String(m.from || ''),
      name: String(m.name || 'Sem nome').slice(0, 40),
      text: m.text.slice(0, 4000),
      ts: Number(m.ts) || Date.now(),
    };
    history.push(clean);
    known.add(clean.id);
    fresh.push(clean);
  }
  if (fresh.length) {
    history.sort((a, b) => a.ts - b.ts);
    history = history.slice(-500);
    saveHistorySoon();
  }
  return fresh;
}

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function me() {
  return {
    id: config.id,
    name: config.name,
    tcpPort: node.tcpPort,
    discoveryPort: node.discoveryPort,
    // PONTE_DEMO esconde os IPs reais (usado para tirar capturas de tela).
    interfaces: DEMO
      ? [{ name: 'Radmin VPN', address: '26.14.82.7', netmask: '255.0.0.0', broadcast: '26.255.255.255', radmin: true }]
      : localInterfaces(),
    demo: DEMO,
    autotestView: process.env.PONTE_AUTOTEST_VIEW || '',
    autotestRes: Number(process.env.PONTE_AUTOTEST_RES) || 0,
    autotestFps: Number(process.env.PONTE_AUTOTEST_FPS) || 0,
    autotestShare: AUTOTEST && process.env.PONTE_AUTOTEST_SHARE === '1',
    autotestFocus: AUTOTEST && process.env.PONTE_AUTOTEST_FOCUS === '1',
    autotestDialog: AUTOTEST ? process.env.PONTE_AUTOTEST_DIALOG || '' : '',
    autotestCanvas: AUTOTEST && process.env.PONTE_AUTOTEST_CANVAS === '1',
    autotestAudio: AUTOTEST ? process.env.PONTE_AUTOTEST_AUDIO || '' : '',
    mainPid: process.pid,
    manualHosts: config.manualHosts,
    autotest: AUTOTEST,
    platform: process.platform,
  };
}

async function startNetwork() {
  node = new LanNode({
    id: config.id,
    name: config.name,
    manualHosts: config.manualHosts,
    discoveryPort: Number(process.env.PONTE_DISCOVERY_PORT) || undefined,
  });
  node.on('log', (line) => {
    console.log(`[rede] ${line}`);
    send('log', line);
  });
  node.on('peers', () => send('peers', node.listPeers()));
  node.on('connected', (peerId) => {
    // Sincroniza o histórico com quem acabou de chegar.
    node.sendTo(peerId, { t: 'history', msgs: history.slice(-100) });
  });
  node.on('message', (peerId, msg) => {
    if (msg.t === 'chat') {
      const fresh = addMessages([{ ...msg.msg, from: peerId }]);
      for (const m of fresh) {
        send('chat', m);
        if (win && !win.isFocused()) {
          win.flashFrame(true);
          if (Notification.isSupported()) {
            new Notification({ title: m.name, body: m.text.slice(0, 120), silent: false }).show();
          }
        }
      }
    } else if (msg.t === 'history' && Array.isArray(msg.msgs)) {
      for (const m of addMessages(msg.msgs.slice(-100))) send('chat', m);
    } else if (msg.t === 'signal') {
      send('signal', { from: peerId, data: msg.data });
    }
  });
  await node.start();
  console.log(`[rede] Ponte ativa: id=${config.id.slice(0, 8)} nome=${config.name} tcp=${node.tcpPort} udp=${node.discoveryPort}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#000000',
    // Barra de título integrada: só os botões do Windows ficam no canto.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff', height: 40 },
    title: AUTOTEST ? `Ponte — ${config.name}` : 'Ponte',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('focus', () => win.flashFrame(false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (AUTOTEST) {
    win.webContents.on('console-message', (event) => {
      console.log(`[ui ${config.name}] ${event.message}`);
    });
    if (process.env.PONTE_AUTOTEST_FULLSCREEN === '1') {
      // Clica no botão de tela cheia como se fosse o usuário.
      setTimeout(async () => {
        await win.webContents.executeJavaScript("document.querySelector('.tile.screen .fs-btn')?.click()", true);
        setTimeout(async () => {
          const ok = await win.webContents.executeJavaScript('!!document.fullscreenElement && document.fullscreenElement.classList.contains("screen")');
          console.log(`[teste] tela cheia: ${ok ? 'sim' : 'não'} | janela em tela cheia: ${win.isFullScreen()}`);
        }, 1500);
      }, 10000);
    }
    if (process.env.PONTE_SHOT) {
      // Salva uma captura da janela; usado para as imagens do README.
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.resolve(process.env.PONTE_SHOT), img.toPNG());
        console.log('[teste] captura salva');
      }, Number(process.env.PONTE_SHOT_DELAY) || 16000);
    }
  }
}

function setupMedia() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'notifications', 'fullscreen'].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'display-capture', 'notifications', 'fullscreen'].includes(permission));
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const wanted = pendingScreen;
      pendingScreen = null;
      const source = (wanted && sources.find((s) => s.id === wanted.id)) || (AUTOTEST ? sources[0] : null);
      if (!source) return callback({});
      const grant = { video: source };
      callback(grant);
    } catch (err) {
      console.error('Falha na captura de tela:', err.message);
      callback({});
    }
  });
}

function setupIpc() {
  ipcMain.handle('init', () => ({ me: me(), peers: node.listPeers(), history }));

  ipcMain.handle('chat:send', (_e, text) => {
    text = String(text || '').trim().slice(0, 4000);
    if (!text) return null;
    const msg = { id: crypto.randomUUID(), from: config.id, name: config.name, text, ts: Date.now() };
    addMessages([msg]);
    node.broadcast({ t: 'chat', msg });
    return msg;
  });

  // Só no autoteste: descarta as primeiras N mensagens para simular perda.
  let dropSignals = AUTOTEST ? Number(process.env.PONTE_DROP_SIGNALS) || 0 : 0;
  ipcMain.on('signal:send', (_e, { to, data }) => {
    if (dropSignals > 0) { dropSignals -= 1; return; }
    node.sendTo(String(to), { t: 'signal', data });
  });

  ipcMain.on('state:set', (_e, patch) => {
    const allowed = {};
    for (const k of ['voice', 'muted', 'deafened', 'sharing']) if (k in patch) allowed[k] = !!patch[k];
    if ('quality' in patch) allowed.quality = String(patch.quality || '').replace(/[^0-9p]/g, '').slice(0, 8);
    node.setState(allowed);
  });

  ipcMain.handle('name:set', (_e, name) => {
    name = String(name || '').trim().slice(0, 40);
    if (!name) return me();
    config.name = name;
    saveConfig();
    node.setName(name);
    return me();
  });

  ipcMain.handle('host:add', (_e, ip) => {
    ip = String(ip || '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.split('.').some((n) => Number(n) > 255)) {
      throw new Error('IP inválido');
    }
    if (!config.manualHosts.includes(ip)) config.manualHosts.push(ip);
    saveConfig();
    node.addManualHost(ip);
    return me();
  });

  ipcMain.handle('host:remove', (_e, ip) => {
    config.manualHosts = config.manualHosts.filter((h) => h !== ip);
    saveConfig();
    node.removeManualHost(ip);
    return me();
  });

  ipcMain.handle('screen:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false,
    });
    return sources
      .filter((s) => !/^Ponte/.test(s.name))
      .map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
  });

  ipcMain.on('screen:select', (_e, choice) => {
    pendingScreen = choice ? { id: String(choice.id), audio: !!choice.audio } : null;
  });

  ipcMain.on('log', (_e, line) => console.log(`[ui ${config.name}] ${line}`));
  ipcMain.on('focus', () => { if (win) { win.show(); win.focus(); } });
}

app.whenReady().then(async () => {
  config = loadConfig();
  history = readJson(userFile('history.json'), []);
  if (!Array.isArray(history)) history = [];
  setupMedia();
  setupIpc();
  setupAppAudio();
  try {
    await startNetwork();
  } catch (err) {
    console.error('Falha ao iniciar a rede:', err);
  }
  createWindow();
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

// ------------------------------------------------------------------ som por aplicativo
// O Electron só captura o som do sistema inteiro. Para mandar só o som do
// jogo (sem a voz do Discord, evitando retorno), usamos o auxiliar nativo
// native/ponte-audio.exe, que usa a captura por processo do Windows.
let audioProc = null;

function audioHelper() {
  if (process.platform !== 'win32') return null;
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'ponte-audio.exe')
    : path.join(__dirname, '..', '..', 'native', 'bin', 'ponte-audio.exe');
  return fs.existsSync(file) ? file : null;
}

function stopAppAudio() {
  if (audioProc) {
    const p = audioProc;
    audioProc = null;
    p.kill();
  }
}

function setupAppAudio() {
  ipcMain.handle('audio:apps', async () => {
    const exe = audioHelper();
    if (!exe) return null;
    const out = await new Promise((resolve) => {
      execFile(exe, ['windows'], { windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' },
        (err, stdout) => resolve(err ? '' : stdout));
    });
    return out.split(/\r?\n/)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((w) => w && w.pid && w.pid !== process.pid)
      .map((w) => ({ hwnd: String(w.hwnd), pid: w.pid, exe: String(w.exe || ''), title: String(w.title || '').slice(0, 120) }));
  });

  ipcMain.handle('audio:start', (_e, choice) => {
    stopAppAudio();
    const exe = audioHelper();
    if (!exe) throw new Error('Este Windows não permite capturar o som de um app só.');
    const all = choice && choice.mode === 'all';
    // "Tudo do PC" exclui a própria Ponte (e o serviço de áudio dela), para
    // a voz da sala não voltar para quem está falando.
    const target = all ? process.pid : Number(choice && choice.pid);
    if (!Number.isInteger(target) || target <= 0) throw new Error('App inválido');
    const proc = spawn(exe, ['capture', String(target), all ? 'exclude' : 'include'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    audioProc = proc;
    let pending = null;
    proc.stdout.on('data', (chunk) => {
      pending = pending ? Buffer.concat([pending, chunk]) : chunk;
      const usable = pending.length - (pending.length % 4); // quadros inteiros (2 canais x 16 bits)
      if (!usable) return;
      send('audio:pcm', pending.subarray(0, usable));
      pending = usable === pending.length ? null : pending.subarray(usable);
    });
    proc.stderr.on('data', (d) => console.error(String(d).trim()));
    proc.on('exit', (code) => {
      if (audioProc === proc) {
        audioProc = null;
        send('audio:ended', code);
      }
    });
    return true;
  });

  ipcMain.on('audio:stop', stopAppAudio);
}

app.on('window-all-closed', () => {
  stopAppAudio();
  if (node) node.stop();
  app.quit();
});
