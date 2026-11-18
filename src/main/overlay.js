'use strict';
// Overlay: janelinha transparente por cima do jogo mostrando quem está na
// sala e quem está falando. Não recebe cliques nem foco, então não atrapalha
// o jogo. Aparece só quando você está numa sala e a Ponte não está na frente.
//
// Funciona com jogos em "janela sem bordas" (o padrão da maioria hoje). Jogos
// em tela cheia exclusiva desenham por cima de tudo e escondem o overlay.

const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

const WIDTH = 250;
const ROW = 40;

function createOverlay() {
  let win = null;
  let ready = false;
  let last = null;

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    ready = false;
    win = new BrowserWindow({
      width: WIDTH,
      height: ROW + 16,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
    win.webContents.once('did-finish-load', () => {
      ready = true;
      if (last) push(last);
    });
    return win;
  }

  function push(data) {
    const w = ensure();
    const n = Math.max(1, Math.min(data.members.length, 12));
    const area = screen.getPrimaryDisplay().workArea;
    w.setBounds({ x: area.x + 16, y: area.y + 16, width: WIDTH, height: n * ROW + 16 });
    if (ready) w.webContents.send('overlay:data', data.members);
    if (!w.isVisible()) w.showInactive();
  }

  return {
    /** data = { show, members: [{ id, name, color, initials, speaking, muted, deafened, sharing }] } */
    update(data) {
      last = data && data.show ? data : null;
      if (!last) {
        if (win && !win.isDestroyed() && win.isVisible()) win.hide();
        return;
      }
      push(last);
    },
    destroy() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

module.exports = { createOverlay };
