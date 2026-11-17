'use strict';
// Gera as imagens do README a partir dos modelos HTML desta pasta.
//   npx electron scripts/readme/render.js
// Antes, rode `node scripts/screenshots.js` para ter as capturas em docs/img/raw/.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const here = __dirname;
const root = path.join(here, '..', '..');
const out = (name) => path.join(root, 'docs', 'img', name);
const SCALE = 2;

const JOBS = [
  { file: 'baixar.html', out: 'baixar.png', w: 300, h: 80, fit: true },
  { file: 'hero.html', out: 'hero.png', w: 1200, h: 700, scale: 1.5 },
  { file: 'recursos.html', out: 'recursos.png', w: 1200, h: 520, fit: true, scale: 1.5 },
  { file: 'frame.html', query: { shot: 'voz' }, out: 'voz.png', w: 1376, h: 904, scale: 1.3 },
  { file: 'frame.html', query: { shot: 'chat' }, out: 'chat.png', w: 1376, h: 904, scale: 1.3 },
  { file: 'frame.html', query: { shot: 'tela' }, out: 'tela.png', w: 1376, h: 904, scale: 1.3 },
  { file: 'frame.html', query: { shot: 'ajustes' }, out: 'ajustes.png', w: 1376, h: 904, scale: 1.3 },
  { file: 'atualizacao.html', out: 'atualizacao.png', w: 1000, h: 560, scale: 1.6 },
  { file: 'bandeja.html', out: 'bandeja.png', w: 1000, h: 560, scale: 1.6 },
];

async function capture(win, w, h) {
  await win.webContents.executeJavaScript(`Promise.all([document.fonts.ready,
    ...[...document.images].map((i) => i.decode().catch(() => {}))]).then(() => new Promise((r) => setTimeout(r, 300)))`, true);
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  return img;
}

function open(w, h, scale) {
  const win = new BrowserWindow({
    width: Math.ceil(w * scale),
    height: Math.ceil(h * scale),
    show: false,
    frame: false,
    transparent: true,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, sandbox: true },
  });
  win.webContents.setFrameRate(1);
  return win;
}

async function splash() {
  // A janelinha de atualização de verdade, parada em 64%.
  const win = open(300, 340, SCALE);
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(SCALE));
  await win.loadFile(path.join(root, 'src', 'renderer', 'update.html'));
  win.webContents.setZoomFactor(SCALE);
  await win.webContents.executeJavaScript(`paint({ state: 'downloading', version: '1.4.0', next: '1.5.0', percent: 64 });
    document.querySelector('.logo').style.animation = 'none';`, true);
  const img = await capture(win, 300 * SCALE, 340 * SCALE);
  fs.writeFileSync(path.join(root, 'docs', 'img', 'raw', 'splash.png'), img.toPNG());
  win.destroy();
  console.log('ok raw/splash.png');
}

async function render(job) {
  const scale = job.scale || SCALE;
  const win = open(job.w, job.fit ? 2000 : job.h, scale);
  await win.loadFile(path.join(here, job.file), job.query ? { query: job.query } : undefined);
  win.webContents.setZoomFactor(scale);
  let { w, h } = job;
  if (job.fit) {
    await new Promise((r) => setTimeout(r, 200));
    const size = await win.webContents.executeJavaScript('(() => { const r = document.body.getBoundingClientRect(); return [Math.ceil(r.width), Math.ceil(r.height)]; })()');
    [w, h] = size;
  }
  const img = await capture(win, Math.ceil(w * scale), Math.ceil(h * scale));
  fs.writeFileSync(out(job.out), img.toPNG());
  const s = img.getSize();
  console.log(`ok ${job.out} ${s.width}x${s.height} ${(fs.statSync(out(job.out)).size / 1024).toFixed(0)} KB`);
  win.destroy();
}

app.on('window-all-closed', () => {}); // entre uma imagem e outra não sobra janela aberta

app.whenReady().then(async () => {
  try {
    await splash();
    const only = process.argv.slice(2).filter((a) => a.endsWith('.png'));
    for (const job of JOBS) if (!only.length || only.includes(job.out)) await render(job);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
