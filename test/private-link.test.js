'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { PrivateLink } = require('../src/main/private-link');
const vault = { available: () => true, seal: s => Buffer.from(s).toString('base64'), open: s => Buffer.from(s, 'base64').toString() };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await wait(40); } throw new Error('timeout'); }
test('TLS enrollment requires creator approval, excludes third device and pins reconnects', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-tls-'));
  const make = (id) => new PrivateLink({ dir: path.join(dir, id), id, name: id, vault, port: 0 });
  const a = make('vince'), b = make('andrews'), c = make('third');
  t.after(() => { a.stop(); b.stop(); c.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await Promise.all([a.start(), b.start(), c.start()]);
  const invite = a.createInvite('127.0.0.1');
  await b.acceptInvite(invite);
  await until(() => a.status().pending.length === 1);
  assert.equal(a.listPeers().length, 0);
  assert.equal(b.listPeers().length, 0);
  assert.equal(a.sendTo('andrews', { t: 'chat', text: 'secret' }), false);
  await wait(11000); // Human approval must not expire after the initial socket timeout.
  assert.equal(a.status().pending.length, 1);
  assert.equal(b.status().enrolling, true);
  await a.approve(b.status().fingerprint);
  await until(() => a.listPeers().length === 1 && b.listPeers().length === 1);
  assert.equal(b.status().role, 'member');
  const got = [];
  b.on('message', (id, msg) => got.push({ id, msg }));
  a.sendTo('andrews', { t: 'chat', text: 'secret' });
  await until(() => got.length === 1);
  assert.equal(got[0].msg.text, 'secret');
  // A third certificate claiming the exact approved ID cannot acquire data.
  const attacker = tls.connect({ host: '127.0.0.1', port: a.port, key: c.identity.private, cert: c.identity.cert, rejectUnauthorized: false, minVersion: 'TLSv1.3' });
  const leaked = [];
  attacker.on('error', () => {});
  attacker.on('data', d => leaked.push(d));
  attacker.on('secureConnect', () => attacker.write(JSON.stringify({ t: 'hello', id: 'andrews' }) + '\n'));
  await until(() => attacker.destroyed);
  assert.equal(leaked.length, 0);
  assert.equal(a.listPeers()[0].id, 'andrews');
  a.setState({ voice: true, room: 'voz-privada' });
  await until(() => b.listPeers()[0].state.voice);
  assert.equal(b.listPeers()[0].state.room, 'voz-privada');
  b.socket.destroy();
  await until(() => !a.listPeers().length);
  await until(() => a.listPeers().length && b.listPeers().length);
  a.revoke();
  await until(() => !b.listPeers().length);
  assert.equal(a.status().paired, false);
  assert.equal(b.sendTo('vince', { t: 'chat' }), false);
  await assert.rejects(c.acceptInvite(invite), /convite|recus|encerr|conex/i);
});
module.exports = { vault, until };

test('a member leaving removes authorization without taking ownership from the creator', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-leave-'));
  const a = new PrivateLink({ dir: path.join(dir, 'a'), id: 'owner', name: 'Owner', vault, port: 0 });
  const b = new PrivateLink({ dir: path.join(dir, 'b'), id: 'member', name: 'Member', vault, port: 0 });
  t.after(() => { a.stop(); b.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await a.start(); await b.start();
  await b.acceptInvite(a.createInvite('127.0.0.1'));
  await a.approve(b.pin);
  await until(() => b.listPeers().length);
  b.revoke();
  await until(() => !a.listPeers().length);
  assert.equal(a.status().role, 'owner');
  assert.equal(a.status().paired, false);
  assert.equal(b.status().role, 'none');
});

test('both device identities and authorization survive a full restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-restart-'));
  const links = [];
  const make = (id, port = 0) => {
    const link = new PrivateLink({ dir: path.join(dir, id), id, name: id, vault, port });
    links.push(link); return link;
  };
  t.after(() => { for (const link of links) link.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const a = make('owner'), b = make('member');
  await a.start(); await b.start();
  await b.acceptInvite(a.createInvite('127.0.0.1'));
  await a.approve(b.pin);
  await until(() => b.listPeers().length);
  const port = a.port, ownerPin = a.pin, memberPin = b.pin;
  const closed = Promise.all([a,b].map(link => new Promise(resolve => link.server.once('close', resolve))));
  a.stop(); b.stop(); await closed;
  const a2 = make('owner', port), b2 = make('member');
  await a2.start(); await b2.start();
  await until(() => a2.listPeers().length && b2.listPeers().length);
  assert.equal(a2.pin, ownerPin); assert.equal(b2.pin, memberPin);
  assert.equal(a2.status().role, 'owner'); assert.equal(b2.status().role, 'member');
});
