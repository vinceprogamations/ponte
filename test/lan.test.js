'use strict';
// Sobe dois nós na mesma máquina e verifica descoberta, conexão, estado e mensagens.
const assert = require('node:assert');
const { LanNode, localInterfaces } = require('../src/main/lan');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(100);
  }
  throw new Error(`Tempo esgotado: ${label}`);
}

(async () => {
  console.log('Interfaces:', localInterfaces().map((i) => `${i.name} ${i.address} -> ${i.broadcast}`).join(' | '));
  const port = 48820; // porta separada para não colidir com o app aberto
  const a = new LanNode({ id: 'aaaa', name: 'Alice', discoveryPort: port, tcpPort: 48821 });
  const b = new LanNode({ id: 'bbbb', name: 'Bruno', discoveryPort: port, tcpPort: 48821 });
  await a.start();
  await b.start();
  console.log(`Portas TCP: A=${a.tcpPort} B=${b.tcpPort}`);
  assert.notStrictEqual(a.tcpPort, b.tcpPort);

  await until(() => a.listPeers().length === 1 && b.listPeers().length === 1, 8000, 'descoberta + conexão');
  console.log('ok descoberta:', a.listPeers()[0].name, '<->', b.listPeers()[0].name);

  const got = [];
  b.on('message', (from, msg) => got.push({ from, msg }));
  a.sendTo('bbbb', { t: 'chat', text: 'oi' });
  await until(() => got.length === 1, 2000, 'mensagem A->B');
  assert.strictEqual(got[0].from, 'aaaa');
  assert.strictEqual(got[0].msg.text, 'oi');
  console.log('ok mensagem');

  // Mensagem grande (SDP de vídeo cabe com folga)
  a.sendTo('bbbb', { t: 'signal', data: 'x'.repeat(200000) });
  await until(() => got.length === 2, 2000, 'mensagem grande');
  assert.strictEqual(got[1].msg.data.length, 200000);
  console.log('ok mensagem grande');

  a.setState({ voice: true });
  await until(() => b.listPeers()[0].state.voice === true, 2000, 'estado');
  a.setName('Alice2');
  await until(() => b.listPeers()[0].name === 'Alice2', 2000, 'nome');
  console.log('ok estado e nome');

  // Queda e retorno
  b.stop();
  await until(() => a.listPeers().length === 0, 4000, 'queda detectada');
  const b2 = new LanNode({ id: 'bbbb', name: 'Bruno', discoveryPort: port, tcpPort: 48821 });
  await b2.start();
  await until(() => a.listPeers().length === 1 && b2.listPeers().length === 1, 12000, 'reconexão');
  console.log('ok reconexão');

  a.stop();
  b2.stop();
  console.log('TODOS OS TESTES PASSARAM');
  process.exit(0);
})().catch((err) => {
  console.error('FALHOU:', err.message);
  process.exit(1);
});
