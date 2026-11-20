'use strict';
// Keeps public discovery/control and private authenticated traffic disjoint.
const { EventEmitter } = require('node:events');
const { isPrivateChannel } = require('./scoped-chat');
const ENVELOPE = 'ponte-public-v2';
const APP_TYPES = new Set(['chat', 'history', 'chat-op', 'channels', 'typing', 'signal', 'file-get', 'file-start', 'file-data', 'file-end']);
class PrivacyNetwork extends EventEmitter {
  constructor({ lan, secure, chat }) {
    super();
    Object.assign(this, { lan, secure, chat });
    this.state = {};
    lan.on('log', line => this.emit('log', line));
    lan.on('rtt', (id, ms) => this.emit('rtt', id, ms));
    lan.on('connected', id => this.emit('connected', id, false));
    secure.on('connected', id => this.emit('connected', id, true));
    for (const transport of [lan, secure]) transport.on('peers', () => this.emit('peers'));
    lan.on('message', (id, packet) => {
      if (packet?.t === ENVELOPE) this._receive(id, packet.data, false);
    });
    secure.on('message', (id, packet) => this._receive(id, packet, true));
    secure.on('disconnected', () => {
      if (isPrivateChannel(this.state.room)) {
        this.setState({ voice: false, room: '', callSession: '', sharing: false, quality: '', cam: false, camId: '', screenId: '' });
        this.emit('private-call-ended');
      }
      this.emit('private-disconnected');
    });
    secure.on('status', () => {
      const active = secure.status().active;
      if (active && !chat.active) chat.activatePrivate();
      if (!active) chat.active = false;
      this.emit('privacy-status', secure.status());
    });
  }
  get tcpPort() { return this.lan.tcpPort; }
  get discoveryPort() { return this.lan.discoveryPort; }
  async start() {
    try { await this.secure.start(); }
    catch {
      this.secure.stop();
      this.secure.error = 'Não foi possível abrir a identidade privada com segurança. A call geral continua disponível.';
    }
    if (this.secure.status().active) this.chat.activatePrivate();
    await this.lan.start();
  }
  stop() { this.lan.stop(); this.secure.stop(); }
  setName(name) { this.lan.setName(name); this.secure.name = name; }
  addManualHost(ip) { this.lan.addManualHost(ip); }
  removeManualHost(ip) { this.lan.removeManualHost(ip); }
  _publicState(state) {
    const playing = typeof state?.playing === 'string' ? state.playing.slice(0, 100) : '';
    if (isPrivateChannel(state?.room)) return playing ? { playing } : {};
    const room = this.chat.listChannels().find(c => c.id === state?.room && c.kind === 'voice' && !isPrivateChannel(c.id));
    if (!state?.voice || !room) return playing ? { playing } : {};
    return { voice: true, room: room.id, muted: !!state.muted, deafened: !!state.deafened, sharing: !!state.sharing,
      quality: String(state.quality || '').slice(0, 8), cam: !!state.cam, camId: String(state.camId || '').slice(0, 80),
      screenId: String(state.screenId || '').slice(0, 80), callSession: String(state.callSession || '').slice(0, 64), playing };
  }
  setState(patch) {
    const next = { ...this.state, ...patch };
    if (next.voice && !this.chat.listChannels().some(c => c.kind === 'voice' && c.id === next.room)) throw new Error('Você não tem acesso a essa call.');
    this.state = next;
    this.lan.state = this._publicState(next); // Auth on future TCP connections also sees only public state.
    this.lan.setState(this.lan.state);
    this.secure.setState(next);
  }
  listPeers() {
    const peers = new Map(this.lan.listPeers().map(p => [p.id, { ...p, state: this._publicState(p.state) }]));
    for (const p of this.secure.listPeers()) peers.set(p.id, { ...p, privateAuthorized: true });
    return [...peers.values()].sort((a,b) => a.name.localeCompare(b.name));
  }
  _scope(msg) {
    if (msg.t === 'chat') return isPrivateChannel(msg.msg?.channel);
    if (msg.t === 'chat-op') return this.chat.isPrivateMessage(msg.id);
    if (msg.t === 'typing') return isPrivateChannel(msg.channel);
    if (msg.t.startsWith('file-')) return this.chat.canAccessFile(msg.id, true);
    if (msg.t === 'signal') return isPrivateChannel(this.state.room);
    return false;
  }
  _allowed(msg, priv) {
    if (!msg || typeof msg !== 'object' || !APP_TYPES.has(msg.t) || (priv && !this.chat.active)) return false;
    if (msg.t === 'chat' || msg.t === 'typing') {
      const channel = msg.t === 'chat' ? msg.msg?.channel : msg.channel;
      return isPrivateChannel(channel) === priv && this.chat.listChannels().some(c => c.id === channel && c.kind === 'text');
    }
    if (msg.t === 'chat-op') return this.chat.isPrivateMessage(msg.id) === priv;
    if (msg.t === 'channels') return !priv;
    if (msg.t.startsWith('file-')) return typeof msg.id === 'string' && this.chat.canAccessFile(msg.id, priv);
    return true;
  }
  _receive(id, msg, priv) {
    if (!this._allowed(msg, priv)) return;
    if (msg.t === 'history') {
      if (!Array.isArray(msg.msgs)) return;
      msg = { ...msg, msgs: msg.msgs.slice(-100).filter(m => m && isPrivateChannel(m.channel) === priv && this.chat.listChannels().some(c => c.id === m.channel && c.kind === 'text')) };
    }
    if (msg.t === 'signal') {
      const remote = (priv ? this.secure.listPeers() : this.lan.listPeers()).find(p => p.id === id);
      if (!this.state.voice || !remote?.state?.voice || isPrivateChannel(this.state.room) !== priv || msg.room !== this.state.room || remote.state.room !== msg.room || !msg.session || msg.session !== remote.state.callSession || msg.toSession !== this.state.callSession) return;
    }
    this.emit('message', id, msg, priv);
  }
  _outgoing(id, raw, explicit) {
    if (!raw || typeof raw.t !== 'string') return null;
    const priv = explicit === undefined ? this._scope(raw) : explicit;
    let msg = raw;
    if (!this._allowed(msg, priv)) return null;
    if (msg.t === 'signal') {
      const peer = (priv ? this.secure.listPeers() : this.lan.listPeers()).find(p => p.id === id);
      if (!this.state.voice || !peer?.state?.voice || peer.state.room !== this.state.room || !this.state.callSession || !peer.state.callSession) return null;
      msg = { ...msg, room: this.state.room, session: this.state.callSession, toSession: peer.state.callSession };
    }
    return { transport: priv ? this.secure : this.lan, packet: priv ? msg : { t: ENVELOPE, data: msg } };
  }
  sendTo(id, msg, priv = undefined) {
    const out = this._outgoing(id, msg, priv);
    return out ? out.transport.sendTo(id, out.packet) : false;
  }
  sendWait(id, msg) {
    const out = this._outgoing(id, msg);
    return out ? out.transport.sendWait(id, out.packet) : Promise.resolve(false);
  }
  broadcast(msg) {
    const priv = this._scope(msg);
    const transport = priv ? this.secure : this.lan;
    for (const p of transport.listPeers()) this.sendTo(p.id, msg, priv);
  }
}
module.exports = { PrivacyNetwork };
