'use strict';
// Ícone na bandeja (perto do relógio): a Ponte continua rodando com a janela
// fechada, e o menu do ícone controla a voz, as atualizações e a saída.
const { Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');

function trayIcon() {
  const file = path.join(__dirname, '..', 'renderer', 'icon.png');
  const big = nativeImage.createFromPath(file);
  if (process.platform === 'darwin') return big.resize({ width: 18, height: 18, quality: 'best' });
  // 16 px em 100% e 32 px em telas com escala 200%.
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: big.resize({ width: 16, height: 16, quality: 'best' }).toPNG() });
  img.addRepresentation({ scaleFactor: 1.5, buffer: big.resize({ width: 24, height: 24, quality: 'best' }).toPNG() });
  img.addRepresentation({ scaleFactor: 2, buffer: big.resize({ width: 32, height: 32, quality: 'best' }).toPNG() });
  return img;
}

function updateItem(u, actions) {
  switch (u.state) {
    case 'disabled':
      return { label: 'Atualização automática só no app instalado', enabled: false };
    case 'checking':
      return { label: 'Procurando atualizações…', enabled: false };
    case 'downloading':
      return { label: `Baixando a versão ${u.next}… ${u.percent}%`, enabled: false };
    case 'ready':
      return { label: `Reiniciar e atualizar para ${u.next}`, click: actions.installUpdate };
    default:
      return { label: 'Procurar atualizações', click: actions.checkUpdate };
  }
}

/**
 * actions: show, toggleWindow, command(name), checkUpdate, installUpdate, quit
 * getState(): { voice, muted, deafened, sharing, peers, update, version }
 */
function createTray({ getState, actions }) {
  const tray = new Tray(trayIcon());

  function refresh() {
    if (tray.isDestroyed()) return;
    const s = getState();
    const bits = ['Ponte'];
    if (s.voice) bits.push(s.deafened ? 'na voz · surdo' : s.muted ? 'na voz · mudo' : 'na voz');
    if (s.sharing) bits.push('transmitindo');
    if (s.peers) bits.push(`${s.peers} online`);
    if (s.update.state === 'ready') bits.push('atualização pronta');
    tray.setToolTip(bits.join(' — '));

    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Ponte ${s.version}`, enabled: false },
      { label: 'Abrir a Ponte', click: actions.show },
      { type: 'separator' },
      s.voice
        ? { label: 'Sair da voz', click: () => actions.command('leave') }
        : { label: 'Entrar na voz', click: () => actions.command('join') },
      {
        label: 'Silenciar microfone',
        type: 'checkbox',
        checked: !!(s.muted || s.deafened),
        accelerator: 'CommandOrControl+Shift+M',
        registerAccelerator: false,
        click: () => actions.command('mute'),
      },
      {
        label: 'Ensurdecer',
        type: 'checkbox',
        checked: !!s.deafened,
        accelerator: 'CommandOrControl+Shift+D',
        registerAccelerator: false,
        click: () => actions.command('deafen'),
      },
      ...(s.sharing ? [{ label: 'Parar de transmitir a tela', click: () => actions.command('stop-share') }] : []),
      { type: 'separator' },
      { label: 'Ajustes…', click: () => actions.command('settings') },
      updateItem(s.update, actions),
      { type: 'separator' },
      { label: 'Fechar a Ponte', click: actions.quit },
    ]));
  }

  // No Windows, clique esquerdo abre/esconde a janela e o direito mostra o menu.
  if (process.platform !== 'darwin') {
    tray.on('click', actions.toggleWindow);
    tray.on('double-click', actions.show);
  }

  refresh();
  return { refresh, destroy: () => { if (!tray.isDestroyed()) tray.destroy(); } };
}

module.exports = { createTray };
