'use strict';
// Atalhos que funcionam com qualquer janela na frente (inclusive o jogo):
//   Ctrl+Shift+M  silenciar      Ctrl+Shift+D  ensurdecer
//   Ctrl+Shift+X  salvar clipe   + a tecla de "apertar para falar"
//
// Os atalhos usam o globalShortcut do Electron. O "apertar para falar"
// precisa saber quando a tecla é SOLTA, o que o globalShortcut não informa,
// então usa o ponte-audio.exe no modo "keys" (lê o estado das teclas, sem
// gancho de teclado).

const { globalShortcut } = require('electron');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const SHORTCUTS = {
  'CommandOrControl+Shift+M': 'mute',
  'CommandOrControl+Shift+D': 'deafen',
  'CommandOrControl+Shift+X': 'clip',
};

function createHotkeys({ helper, onCommand, onPtt, log }) {
  for (const [accel, cmd] of Object.entries(SHORTCUTS)) {
    try {
      if (!globalShortcut.register(accel, () => onCommand(cmd))) log(`Atalho ${accel} já está em uso por outro programa`);
    } catch (err) {
      log(`Atalho ${accel} indisponível: ${err.message}`);
    }
  }

  let proc = null;
  let vk = 0;
  let restartTimer = null;

  function start() {
    if (proc || !helper || !vk) return;
    proc = spawn(helper, ['keys'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const me = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      const m = /^(down|up) (\d+)/.exec(line);
      if (m && Number(m[2]) === vk) onPtt(m[1] === 'down');
    });
    proc.on('exit', () => {
      if (proc !== me) return;
      proc = null;
      onPtt(false);
      if (vk) restartTimer = setTimeout(start, 1000); // caiu sozinho: volta
    });
    proc.stdin.on('error', () => {});
    proc.stdin.write(`watch ${vk}\n`);
  }

  function stop() {
    clearTimeout(restartTimer);
    if (proc) {
      const p = proc;
      proc = null;
      p.kill();
    }
  }

  return {
    /** Liga o "apertar para falar" com o código virtual da tecla (0 desliga). */
    setPtt(code) {
      const next = Number(code) > 0 && Number(code) < 256 ? Number(code) : 0;
      if (next === vk) return;
      vk = next;
      if (!vk) { stop(); onPtt(false); return; }
      if (proc) proc.stdin.write(`watch ${vk}\n`);
      else start();
    },
    dispose() {
      vk = 0;
      stop();
      globalShortcut.unregisterAll();
    },
  };
}

module.exports = { createHotkeys };
