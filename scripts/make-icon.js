'use strict';
// Gera build/icon.png (256px) e build/icon.ico (16–256px) a partir de build/icon.svg.
// Uso: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 256, height: 256, show: false, frame: false, transparent: true,
      useContentSize: true, webPreferences: { offscreen: true },
    });
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', '<svg width="256" height="256" style="display:block" ')}</body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((r) => setTimeout(r, 300));
    const full = await win.webContents.capturePage();
    win.destroy();
    const pngs = SIZES.map((size) => ({ size, data: (size === 256 ? full : full.resize({ width: size, height: size, quality: 'best' })).toPNG() }));
    const big = pngs.find((p) => p.size === 256).data;
    fs.writeFileSync(path.join(root, 'build', 'icon.png'), big);
    fs.writeFileSync(path.join(root, 'src', 'renderer', 'icon.png'), big);
    fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(pngs));
    console.log('Ícones gerados em build/ e src/renderer/icon.png');
  } catch (err) {
    console.error(err);
  }
  app.quit();
});
