'use strict';
// Test runner only: drives the real renderer/preload/main boundary in isolated profiles.
const { app, BrowserWindow } = require('electron');
app.on('browser-window-created', (_event, window) => window.hide());
require('../src/main/main');
process.on('message', async message => {
  if (message.quit) { app.quit(); return; }
  try {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html'));
    if (!window) throw new Error('window not ready');
    if (message.action === 'pause-private') {
      const socket = process._getActiveHandles().find(handle => handle.pvtReady && !handle.destroyed);
      if (!socket) throw new Error('private socket not ready');
      let buffered = '';
      const pauseAfterStart = chunk => {
        buffered += chunk;
        let end;
        while ((end = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          try { if (JSON.parse(line).t === 'file-start') { socket.pause(); socket.off('data', pauseAfterStart); return; } } catch {}
        }
      };
      socket.on('data', pauseAfterStart);
      process.send({ id: message.id, value: true }); return;
    }
    if (message.action === 'cut-private') {
      for (const handle of process._getActiveHandles()) if (handle.pvtReady) handle.destroy();
      process.send({ id: message.id, value: true }); return;
    }
    if (message.action === 'screenshot') {
      require('node:fs').writeFileSync(message.path, (await window.webContents.capturePage()).toPNG());
      process.send({ id: message.id, value: true }); return;
    }
    const value = await window.webContents.executeJavaScript(message.expression, true);
    process.send({ id: message.id, value });
  } catch (err) { process.send({ id: message.id, error: err.message }); }
});
