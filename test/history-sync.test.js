'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { historyBatches, requestMissingHistory } = require('../src/main/history-sync');
test('large valid history is split by UTF-8 bytes without dropping or reordering messages', () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}`, text: '字'.repeat(4000), reactions: Object.fromEntries(Array.from({ length: 24 }, (_, j) => [String(j), Array(6).fill('a'.repeat(64))])) }));
  const batches = [...historyBatches(messages)];
  assert.ok(batches.length > 1);
  assert.ok(batches.every(msgs => Buffer.byteLength(JSON.stringify({ t: 'history', msgs })) < 1024 * 1024));
  assert.deepEqual(batches.flat(), messages);
});
test('unchanged history requests its missing attachments after interruption, using canonical stored file IDs', () => {
  const messages = new Map([['pvt-1', { id: 'pvt-1', channel: 'privado', file: { id: 'canonical' } }], ['pub-2', { id: 'pub-2', channel: 'geral', file: { id: 'public' } }]]);
  const requested = [];
  const chat = { get: id => messages.get(id), isPrivateChannel: id => id === 'privado' };
  const media = { has: () => false, request: (peer, id) => requested.push({ peer, id }) };
  requestMissingHistory('andrews', [{ id: 'pvt-1', file: { id: 'injected' } }, { id: 'pub-2' }], true, chat, media);
  assert.deepEqual(requested, [{ peer: 'andrews', id: 'canonical' }]);
});
