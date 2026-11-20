'use strict';
// Only this TLS socket, not a claimed LAN UUID, grants private access.
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const selfsigned = require('selfsigned');
const MAX_LINE = 1024 * 1024;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const fingerprint = cert => cert?.raw ? hash(cert.raw) : '';
const validId = s => typeof s === 'string' && /^[\w-]{1,64}$/.test(s);
const validPin = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function sameSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

class PrivateLink extends EventEmitter {
  constructor({ dir, id, name, vault, port = 47841 }) {
    super();
    Object.assign(this, { dir, id, name, vault, port });
    this.state = {};
    this.trust = { role: 'none', peer: null };
    this.pending = new Map();
    this.sockets = new Set();
    this.socket = null;
    this.server = null;
    this.stopped = false;
    this.connecting = false;
    this.error = '';
  }
  _load(name) {
    const file = path.join(this.dir, `${name}.json`);
    return fs.existsSync(file) ? JSON.parse(this.vault.open(fs.readFileSync(file, 'utf8'))) : null;
  }
  _save(name, data) {
    const file = path.join(this.dir, `${name}.json`);
    fs.writeFileSync(`${file}.tmp`, this.vault.seal(JSON.stringify(data)), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  async start() {
    if (!this.vault?.available()) { this.error = 'O armazenamento seguro do sistema está indisponível. O modo privado está bloqueado.'; return; }
    fs.mkdirSync(this.dir, { recursive: true });
    this.identity = this._load('identity');
    if (!this.identity) {
      const notAfterDate = new Date();
      notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
      this.identity = await selfsigned.generate([{ name: 'commonName', value: 'Ponte device' }], { keyType: 'ec', curve: 'P-256', notAfterDate });
      this._save('identity', this.identity);
    }
    this.pin = hash(new crypto.X509Certificate(this.identity.cert).raw);
    this.trust = this._load('membership') || this.trust;
    const options = { key: this.identity.private, cert: this.identity.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: false, handshakeTimeout: 5000 };
    this.server = tls.createServer(options, socket => this._incoming(socket));
    this.server.on('tlsClientError', () => {});
    await new Promise((resolve, reject) => {
      const listen = () => {
        const onError = err => {
          if (err.code === 'EADDRINUSE' && this.port && this.port < 47861) { this.port++; this.server.once('error', onError); this.server.listen(this.port, '0.0.0.0'); }
          else reject(err);
        };
        this.server.once('error', onError);
        this.server.listen(this.port, '0.0.0.0', () => { this.server.removeListener('error', onError); this.port = this.server.address().port; resolve(); });
      };
      listen();
    });
    this.server.on('error', err => { this.error = `Modo privado: ${err.message}`; this.emit('status'); });
    this.timer = setInterval(() => {
      for (const [pin, p] of this.pending) if (Date.now() > p.expires) { p.socket.destroy(); this.pending.delete(pin); this.emit('status'); }
      if (this.trust.role === 'member' && this.trust.peer && !this.socket && !this.connecting) this._connect(this.trust.peer).catch(() => {});
    }, 2000);
    if (this.trust.role === 'member' && this.trust.peer) this._connect(this.trust.peer).catch(() => {});
  }
  _assertReady() {
    if (!this.server || this.error) throw new Error(this.error || 'Modo privado indisponível.');
  }
  status() {
    return {
      available: !!this.server && !this.error, error: this.error, role: this.trust.role,
      fingerprint: this.pin || '', active: this.trust.role === 'owner' || (this.trust.role === 'member' && !!this.trust.peer),
      paired: !!this.trust.peer, online: !!this.socket?.pvtReady,
      enrolling: !!this.enrollmentSocket && !this.enrollmentSocket.destroyed && !this.enrollmentSocket.pvtReady,
      peer: this.trust.peer ? { name: this.trust.peer.name, fingerprint: this.trust.peer.fingerprint } : null,
      pending: [...this.pending].map(([fingerprint, p]) => ({ fingerprint, name: p.name, address: p.address })),
    };
  }
  createInvite(host) {
    this._assertReady();
    if (!net.isIP(host)) throw new Error('Escolha um endereço IPv4 válido deste computador.');
    if (this.trust.role === 'member') throw new Error('Só o criador pode gerar um convite.');
    if (this.trust.peer) throw new Error('Já existe um dispositivo autorizado. Revogue o acesso antes de substituí-lo.');
    for (const p of this.pending.values()) p.socket.destroy();
    this.pending.clear();
    const token = crypto.randomBytes(32).toString('hex');
    this.trust = { role: 'owner', peer: null, invitation: { hash: hash(token), expires: Date.now() + 15 * 60 * 1000 } };
    this._save('membership', this.trust);
    this.emit('status');
    return `ponte-private:${Buffer.from(JSON.stringify({ v: 1, host, port: this.port, fingerprint: this.pin, token, expires: this.trust.invitation.expires })).toString('base64url')}`;
  }
  async acceptInvite(code) {
    this._assertReady();
    if (this.trust.role !== 'none') throw new Error('Este dispositivo já tem um espaço privado. Revogue ou desconecte o atual primeiro.');
    let invite;
    try {
      if (typeof code !== 'string' || code.length > 2500 || !code.startsWith('ponte-private:')) throw new Error();
      invite = JSON.parse(Buffer.from(code.slice(14), 'base64url').toString());
      if (invite.v !== 1 || !net.isIP(invite.host) || !Number.isInteger(invite.port) || invite.port < 1 || invite.port > 65535 || !validPin(invite.fingerprint) || !validPin(invite.token) || !Number.isFinite(invite.expires) || Date.now() > invite.expires) throw new Error();
    } catch { throw new Error('Convite inválido ou expirado. Peça um novo convite ao criador.'); }
    await this._connect(invite, invite);
  }
  async _connect(peer, invite = null) {
    if (this.stopped || this.connecting || this.socket) throw new Error('Já há uma conexão privada em andamento.');
    this.connecting = true;
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: peer.host, port: peer.port, key: this.identity.private, cert: this.identity.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: false });
      this.sockets.add(socket);
      if (invite) this.enrollmentSocket = socket;
      let settled = false;
      const fail = () => { this.connecting = false; if (!settled) { settled = true; reject(new Error('Conexão privada recusada ou encerrada. Confira o convite e o IP.')); } };
      socket.once('error', fail);
      socket.once('close', fail);
      socket.setTimeout(10000, () => socket.destroy());
      socket.once('secureConnect', () => {
        // With a private CA-less certificate, run the pin check explicitly.
        const pin = fingerprint(socket.getPeerCertificate());
        if (!pin || pin !== peer.fingerprint) { socket.destroy(); return; }
        this._attach(socket, pin, (msg) => {
          if (!msg || !validId(msg.id) || typeof msg.name !== 'string') { socket.destroy(); return; }
          if (msg.t === 'awaiting' && invite) {
            socket.setTimeout(Math.min(5 * 60 * 1000, invite.expires - Date.now()), () => socket.destroy());
            this.connecting = false;
            if (!settled) { settled = true; resolve(); }
            this.emit('status');
          } else if (msg.t === 'granted' && (invite || this.trust.peer?.fingerprint === pin)) {
            if (!invite && msg.id !== this.trust.peer.id) { socket.destroy(); return; }
            this.trust = { role: 'member', peer: { fingerprint: pin, id: msg.id, name: msg.name.slice(0, 40), host: peer.host, port: peer.port } };
            this._save('membership', this.trust);
            this._promote(socket, pin, msg.id, msg.name);
            if (!settled) { settled = true; resolve(); }
          } else socket.destroy();
        });
        socket.write(JSON.stringify({ t: invite ? 'enroll' : 'hello', id: this.id, name: this.name, ...(invite ? { token: invite.token } : {}) }) + '\n');
      });
    });
  }
  _incoming(socket) {
    if (this.stopped || this.sockets.size >= 12) { socket.destroy(); return; }
    const pin = fingerprint(socket.getPeerCertificate());
    if (!pin || this.trust.role !== 'owner' || (this.trust.peer && pin !== this.trust.peer.fingerprint)) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.setTimeout(10000, () => socket.destroy());
    this._attach(socket, pin, msg => {
      if (!msg || !validId(msg.id) || typeof msg.name !== 'string' || msg.id === this.id) { socket.destroy(); return; }
      if (msg.t === 'hello' && this.trust.peer?.fingerprint === pin && this.trust.peer.id === msg.id) {
        socket.write(JSON.stringify({ t: 'granted', id: this.id, name: this.name }) + '\n');
        this._promote(socket, pin, msg.id, msg.name);
      } else if (msg.t === 'enroll' && !this.trust.peer && this.trust.invitation && Date.now() < this.trust.invitation.expires && validPin(msg.token) && sameSecret(hash(msg.token), this.trust.invitation.hash)) {
        if (this.pending.size >= 4 || this.pending.has(pin)) { socket.destroy(); return; }
        this.pending.set(pin, { socket, id: msg.id, name: msg.name.slice(0, 40), address: socket.remoteAddress?.replace(/^::ffff:/, ''), expires: Date.now() + 5 * 60 * 1000 });
        socket.setTimeout(5 * 60 * 1000, () => socket.destroy());
        socket.write(JSON.stringify({ t: 'awaiting', id: this.id, name: this.name }) + '\n');
        this.emit('status');
      } else socket.destroy();
    });
  }
  _attach(socket, pin, handshake) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        if (idx > MAX_LINE) { socket.destroy(); return; }
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { socket.destroy(); return; }
        if (socket.pvtReady && this.socket === socket && this.trust.peer?.fingerprint === pin) {
          if (msg.t === 'private-state') { socket.pvtPeer.state = msg.state && typeof msg.state === 'object' ? msg.state : {}; this.emit('peers'); }
          else if (msg.t === 'revoked') { this.trust = { role: this.trust.role === 'owner' ? 'owner' : 'none', peer: null }; this._save('membership', this.trust); socket.destroy(); this.emit('status'); }
          else this.emit('message', socket.pvtPeer.id, msg);
        } else if (!socket.pvtReady) handshake(msg);
      }
      if (buf.length > MAX_LINE) socket.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (this.pending.get(pin)?.socket === socket) this.pending.delete(pin);
      if (this.socket === socket) { this.socket = null; this.emit('peers'); this.emit('disconnected'); }
      this.emit('status');
    });
  }
  _promote(socket, pin, id, name) {
    if (this.socket && this.socket !== socket) this.socket.destroy();
    socket.setTimeout(0);
    socket.pvtReady = true;
    socket.pvtPeer = { id, name: name.slice(0, 40), fingerprint: pin, address: socket.remoteAddress?.replace(/^::ffff:/, ''), state: {} };
    this.socket = socket;
    this.connecting = false;
    this.emit('status');
    this.emit('connected', id);
    this.setState(this.state);
    this.emit('peers');
  }
  async approve(pin) {
    this._assertReady();
    const pending = this.pending.get(pin);
    if (this.trust.role !== 'owner' || this.trust.peer || !pending || pending.socket.destroyed || Date.now() > pending.expires || Date.now() > (this.trust.invitation?.expires || 0)) throw new Error('Pedido expirado ou dispositivo já autorizado.');
    this.trust = { role: 'owner', peer: { fingerprint: pin, id: pending.id, name: pending.name } };
    this._save('membership', this.trust);
    this.pending.delete(pin);
    for (const other of this.pending.values()) other.socket.destroy();
    this.pending.clear();
    pending.socket.write(JSON.stringify({ t: 'granted', id: this.id, name: this.name }) + '\n');
    this._promote(pending.socket, pin, pending.id, pending.name);
  }
  revoke() {
    this._assertReady();
    if (this.socket?.pvtReady) this.socket.write(JSON.stringify({ t: 'revoked' }) + '\n');
    const owner = this.trust.role === 'owner';
    this.trust = { role: owner ? 'owner' : 'none', peer: null };
    this._save('membership', this.trust);
    for (const s of this.sockets) { s.end(() => s.destroy()); const timer = setTimeout(() => s.destroy(), 1000); timer.unref(); }
    this.pending.clear();
    this.socket = null;
    this.state = {};
    this.emit('peers');
    this.emit('disconnected');
    this.emit('status');
  }
  listPeers() { return this.socket?.pvtReady && !this.socket.destroyed && this.trust.peer ? [{ ...this.socket.pvtPeer }] : []; }
  sendTo(id, msg) {
    const socket = this.socket;
    if (!socket?.pvtReady || socket.destroyed || socket.pvtPeer.id !== id || socket.pvtPeer.fingerprint !== this.trust.peer?.fingerprint) return false;
    socket.write(JSON.stringify(msg) + '\n');
    return true;
  }
  async sendWait(id, msg) {
    const socket = this.socket;
    if (!this.sendTo(id, msg)) return false;
    if (!socket.writableNeedDrain) return true;
    return new Promise(resolve => {
      const done = result => { socket.off('drain', drain); socket.off('close', close); resolve(result); };
      const drain = () => done(this.socket === socket && !!this.trust.peer);
      const close = () => done(false);
      socket.once('drain', drain); socket.once('close', close);
    });
  }
  broadcast(msg) { for (const p of this.listPeers()) this.sendTo(p.id, msg); }
  setState(state) { this.state = { ...state }; this.broadcast({ t: 'private-state', state: this.state }); }
  stop() { this.stopped = true; clearInterval(this.timer); for (const s of this.sockets) s.destroy(); this.server?.close(); }
}
module.exports = { PrivateLink };
