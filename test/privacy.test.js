'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ScopedChatStore } = require('../src/main/scoped-chat');
const fileId = '11111111-1111-4111-8111-111111111111';

test('legacy history and orphan attachments stay quarantined until private activation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-scope-'));
  const old = Array.from({ length: 2101 }, (_, i) => ({ id: `old-${i}`, from: 'a', text: `secret ${i}`, channel: 'geral', ts: i + 1 }));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(old));
  fs.mkdirSync(path.join(dir, 'media'));
  fs.writeFileSync(path.join(dir, 'media', fileId), 'secret');
  const chat = new ScopedChatStore(dir);
  t.after(() => chat.close());
  assert.equal(chat.messages.length, 0);
  assert.equal(chat.listChannels().some(c => c.id === 'privado'), false);
  assert.equal(chat.canAccessFile(fileId, false), false);
  chat.activatePrivate();
  assert.equal(chat.messages.length, 2101);
  assert.equal(chat.messages.every(m => m.channel === 'privado'), true);
  assert.equal(chat.recent(300, false).length, 0);
  assert.equal(chat.canAccessFile(fileId, true), true);
  assert.equal(chat.merge([{ ...old[0], channel: 'geral', text: 'overwrite', v: 100 }], false).updated.length, 0);
  assert.equal(chat.get('old-0').text, 'secret 0');
  assert.equal(chat.merge([{ id: 'pub-bad', from: 'c', channel: 'geral', text: 'file', file: { id: fileId, name: 'secret.txt', mime: 'text/plain', size: 6 } }], false).fresh.length, 0);
  chat.close();
  const reopened = new ScopedChatStore(dir);
  t.after(() => reopened.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  reopened.activatePrivate();
  assert.equal(reopened.messages.length, 2101);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'legacy-private-archive.json'))).history, old);
});

test('public messages cannot collide with private IDs or classify private files as public', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-scope-'));
  const chat = new ScopedChatStore(dir);
  t.after(() => { chat.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  chat.activatePrivate();
  chat.merge([{ id: 'pvt-a', from: 'a', text: 'private', channel: 'privado' }], true);
  assert.equal(chat.merge([{ id: 'pvt-a', from: 'c', text: 'bad', channel: 'geral', v: 9 }], false).fresh.length, 0);
  assert.equal(chat.merge([{ id: 'pub-a', from: 'c', text: 'public', channel: 'geral' }], false).fresh.length, 1);
  assert.equal(chat.recent(300, false)[0].text, 'public');
  assert.equal(chat.recent(300, true)[0].text, 'private');
});
