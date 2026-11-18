'use strict';
// Camada de rede da Ponte: descoberta automática por UDP (broadcast em todas
// as interfaces, inclusive a do Radmin VPN) + canal TCP por par para chat,
// estado e sinalização WebRTC. Não depende do Electron, então dá para testar
// com Node puro.

const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const PROTO = 'ponte-hello';
const VERSION = 1;
const BEACON_MS = 2000;
const PEER_TIMEOUT_MS = 10000;
const MAX_LINE = 8 * 1024 * 1024;

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

/** Endereços IPv4 locais com o broadcast dirigido de cada rede. */
function localInterfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (info.internal) continue;
      const ip = ipToInt(info.address);
      const mask = ipToInt(info.netmask);
      out.push({
        name,
        address: info.address,
        netmask: info.netmask,
        broadcast: intToIp((ip | ~mask) >>> 0),
        radmin: /radmin/i.test(name) || info.address.startsWith('26.'),
      });
    }
  }
  return out;
}

class LanNode extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.id         id estável deste computador
   * @param {string} opts.name       nome exibido
   * @param {number} [opts.discoveryPort]
   * @param {number} [opts.tcpPort]  porta inicial; tenta as seguintes se ocupada
   * @param {string[]} [opts.manualHosts] IPs para sondar diretamente
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.name = opts.name;
    this.discoveryPort = opts.discoveryPort || 47820;
    this.tcpPortStart = opts.tcpPort || 47821;
    this.tcpPort = null;
    this.manualHosts = new Set(opts.manualHosts || []);
    this.state = {};
    /** @type {Map<string, any>} */
    this.peers = new Map();
    this.udp = null;
    this.server = null;
    this.timers = [];
    this.stopped = false;
  }

  async start() {
    await this._startTcp();
    await this._startUdp();
    this._beacon();
    this.timers.push(setInterval(() => this._beacon(), BEACON_MS));
    this.timers.push(setInterval(() => this._tick(), 1000));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const p of this.peers.values()) if (p.conn) p.conn.socket.destroy();
    try { this.udp && this.udp.close(); } catch {}
    try { this.server && this.server.close(); } catch {}
  }

  setName(name) {
    this.name = name;
    this.broadcast({ t: 'name', name });
    this._beacon();
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.broadcast({ t: 'state', state: this.state });
  }

  addManualHost(ip) {
    this.manualHosts.add(ip);
    this._beacon();
  }

  removeManualHost(ip) {
    this.manualHosts.delete(ip);
  }

  /** Pares com canal TCP aberto, no formato que a interface usa. */
  listPeers() {
    const out = [];
    for (const p of this.peers.values()) {
      if (!p.conn || !p.conn.ready) continue;
      out.push({
        id: p.id,
        name: p.name,
        address: p.conn.socket.remoteAddress?.replace(/^::ffff:/, '') || p.address,
        state: p.state || {},
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  sendTo(peerId, msg) {
    const p = this.peers.get(peerId);
    if (!p || !p.conn || !p.conn.ready) return false;
    p.conn.socket.write(JSON.stringify(msg) + '\n');
    return true;
  }

  /**
   * Como sendTo, mas espera o buffer do socket esvaziar quando ele enche.
   * Usado para arquivos grandes, para não acumular tudo na memória e deixar
   * as mensagens de voz e chat passarem no meio.
   */
  sendWait(peerId, msg) {
    const p = this.peers.get(peerId);
    if (!p || !p.conn || !p.conn.ready) return Promise.resolve(false);
    const socket = p.conn.socket;
    if (socket.write(JSON.stringify(msg) + '\n')) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => {
        socket.off('drain', onDrain);
        socket.off('close', onClose);
        resolve(ok);
      };
      const onDrain = () => done(true);
      const onClose = () => done(false);
      socket.on('drain', onDrain);
      socket.on('close', onClose);
    });
  }

  broadcast(msg) {
    const line = JSON.stringify(msg) + '\n';
    for (const p of this.peers.values()) if (p.conn && p.conn.ready) p.conn.socket.write(line);
  }

  // ---------------------------------------------------------------- UDP

  _startUdp() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (err) => {
        this.emit('log', `UDP erro: ${err.message}`);
      });
      sock.on('message', (buf, rinfo) => this._onDatagram(buf, rinfo));
      sock.once('listening', () => {
        sock.setBroadcast(true);
        this.udp = sock;
        resolve();
      });
      try {
        sock.bind(this.discoveryPort);
      } catch (err) {
        reject(err);
      }
    });
  }

  _hello(reply) {
    return Buffer.from(JSON.stringify({
      t: PROTO, v: VERSION, id: this.id, name: this.name, tcpPort: this.tcpPort, reply: !!reply,
    }));
  }

  _send(buf, ip) {
    if (!this.udp || this.stopped) return;
    this.udp.send(buf, this.discoveryPort, ip, () => {});
  }

  _beacon() {
    const buf = this._hello(false);
    const targets = new Set(['255.255.255.255']);
    for (const i of localInterfaces()) targets.add(i.broadcast);
    for (const h of this.manualHosts) targets.add(h);
    // Pares conhecidos recebem também por unicast: funciona mesmo se o
    // broadcast for bloqueado em algum ponto do caminho.
    for (const p of this.peers.values()) for (const a of p.addresses) targets.add(a);
    for (const ip of targets) this._send(buf, ip);
  }

  _onDatagram(buf, rinfo) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!msg || msg.t !== PROTO || typeof msg.id !== 'string' || msg.id === this.id) return;
    if (typeof msg.tcpPort !== 'number') return;
    const isNew = !this.peers.has(msg.id);
    const p = this._peer(msg.id);
    p.name = String(msg.name || 'Sem nome').slice(0, 40);
    p.tcpPort = msg.tcpPort;
    p.lastSeen = Date.now();
    p.addresses.delete(rinfo.address);
    p.addresses.add(rinfo.address); // o mais recente fica por último
    p.address = rinfo.address;
    if (!msg.reply && (isNew || !p.conn)) this._send(this._hello(true), rinfo.address);
    if (isNew) this.emit('log', `Encontrado ${p.name} em ${rinfo.address}`);
    this._maybeConnect(p);
  }

  // ---------------------------------------------------------------- TCP

  _startTcp() {
    return new Promise((resolve, reject) => {
      let port = this.tcpPortStart;
      const tryListen = () => {
        const server = net.createServer((s) => this._attach(s, null));
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && port < this.tcpPortStart + 20) {
            port += 1;
            tryListen();
          } else reject(err);
        });
        server.listen(port, '0.0.0.0', () => {
          this.server = server;
          this.tcpPort = port;
          resolve();
        });
      };
      tryListen();
    });
  }

  _peer(id) {
    let p = this.peers.get(id);
    if (!p) {
      p = { id, name: 'Sem nome', addresses: new Set(), address: null, tcpPort: null,
        lastSeen: 0, conn: null, connecting: false, firstSeen: Date.now(), state: {} };
      this.peers.set(id, p);
    }
    return p;
  }

  _maybeConnect(p) {
    if (this.stopped || p.conn || p.connecting || !p.tcpPort || p.addresses.size === 0) return;
    // Quem tem o id menor liga. Se o outro lado não ligar em 5 s (ex.: ele
    // não recebe nossos pacotes), ligamos nós mesmos.
    const iLead = this.id < p.id;
    if (!iLead && Date.now() - p.firstSeen < 5000) return;
    p.connecting = true;
    const addrs = [...p.addresses].reverse();
    const attempt = (i) => {
      if (i >= addrs.length || this.stopped) { p.connecting = false; return; }
      const s = net.connect({ host: addrs[i], port: p.tcpPort });
      s.setTimeout(4000);
      s.once('timeout', () => s.destroy(new Error('timeout')));
      s.once('connect', () => {
        s.setTimeout(0);
        p.connecting = false;
        this._attach(s, this.id);
      });
      s.once('error', () => { if (!s.ponteAttached) attempt(i + 1); });
    };
    attempt(0);
  }

  /** Liga um socket a um par depois do handshake 'auth'. */
  _attach(socket, initiator) {
    socket.ponteAttached = true;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    const conn = { socket, initiator, ready: false, peerId: null };
    let buf = '';
    socket.write(JSON.stringify({ t: 'auth', id: this.id, name: this.name, state: this.state }) + '\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE) { socket.destroy(); return; }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this._onTcp(conn, msg);
      }
    });
    const onGone = () => {
      if (!conn.peerId) return;
      const p = this.peers.get(conn.peerId);
      if (p && p.conn === conn) {
        p.conn = null;
        this.emit('log', `Conexão com ${p.name} encerrada`);
        this.emit('peers');
      }
    };
    socket.on('close', onGone);
    socket.on('error', () => {});
  }

  _onTcp(conn, msg) {
    if (!conn.ready) {
      if (msg.t !== 'auth' || typeof msg.id !== 'string' || msg.id === this.id) {
        conn.socket.destroy();
        return;
      }
      const p = this._peer(msg.id);
      p.name = String(msg.name || p.name).slice(0, 40);
      p.state = msg.state || {};
      p.lastSeen = Date.now();
      const remote = conn.socket.remoteAddress?.replace(/^::ffff:/, '');
      if (remote) p.addresses.add(remote);
      conn.initiator = conn.initiator || msg.id;
      conn.peerId = msg.id;
      if (p.conn && p.conn !== conn && p.conn.ready) {
        // Duas conexões com o mesmo par: os dois lados mantêm a mesma, a
        // iniciada pelo id menor.
        const preferred = this.id < msg.id ? this.id : msg.id;
        if (p.conn.initiator === preferred && conn.initiator !== preferred) {
          conn.socket.destroy();
          return;
        }
        const old = p.conn;
        p.conn = null;
        old.socket.destroy();
      }
      conn.ready = true;
      p.conn = conn;
      this.emit('log', `Conectado a ${p.name}`);
      this.emit('connected', p.id);
      this.emit('peers');
      return;
    }
    const p = this.peers.get(conn.peerId);
    if (!p || p.conn !== conn) return;
    p.lastSeen = Date.now();
    switch (msg.t) {
      case 'ping':
        return;
      case 'name':
        p.name = String(msg.name || p.name).slice(0, 40);
        this.emit('peers');
        return;
      case 'state':
        p.state = msg.state || {};
        this.emit('peers');
        return;
      default:
        this.emit('message', p.id, msg);
    }
  }

  _tick() {
    const now = Date.now();
    for (const p of this.peers.values()) {
      if (p.conn && p.conn.ready) p.conn.socket.write('{"t":"ping"}\n');
      else if (now - p.lastSeen < PEER_TIMEOUT_MS) this._maybeConnect(p);
      else if (!p.conn && !p.connecting) {
        p.firstSeen = now; // reinicia a janela de 5 s quando ele voltar
      }
    }
  }
}

module.exports = { LanNode, localInterfaces };
