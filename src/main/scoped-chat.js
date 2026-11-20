'use strict';
// Legacy data never enters the public store. Unknown existing attachments are private.
const fs = require('node:fs');
const path = require('node:path');
const { ChatStore } = require('./chat');
const PRIVATE_TEXT = 'privado';
const PRIVATE_VOICE = 'voz-privada';
const isPrivateChannel = id => id === PRIVATE_TEXT || id === PRIVATE_VOICE;
function read(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8')); // Fail closed on corrupt migration data.
}
function atomic(file, data) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}
class ScopedChatStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const archiveFile = path.join(dir, 'legacy-private-archive.json');
    if (!fs.existsSync(archiveFile)) {
      atomic(archiveFile, { version: 1, history: read(path.join(dir, 'history.json'), []), channels: read(path.join(dir, 'channels.json'), []) });
    }
    this.archive = read(archiveFile, null);
    if (!this.archive || !Array.isArray(this.archive.history)) throw new Error('Arquivo de migração inválido. O histórico foi preservado; a rede não será iniciada.');
    this.public = new ChatStore(path.join(dir, 'public-v2'));
    this.public.channels.get('sala').name = 'Call geral';
    this.private = new ChatStore(path.join(dir, 'private-v2'), { maxHistory: Infinity, defaults: [
      { id: PRIVATE_TEXT, name: 'Privado 🔒', kind: 'text', fixed: true, ts: 0 },
      { id: PRIVATE_VOICE, name: 'Call privada 🔒', kind: 'voice', fixed: true, ts: 0 },
    ] });
    this.active = false;
    this.filesFile = path.join(dir, 'file-scopes-v2.json');
    this.files = new Map(Object.entries(read(this.filesFile, {})));
    const mediaDir = path.join(dir, 'media');
    if (fs.existsSync(mediaDir)) {
      for (const id of fs.readdirSync(mediaDir)) if (/^[0-9a-f-]{36}$/.test(id) && !this.files.has(id)) this.files.set(id, 'private');
    }
    for (const m of [...this.archive.history, ...this.private.messages]) if (m.file?.id) this.files.set(m.file.id, 'private');
    this.saveFiles();
  }
  saveFiles() { atomic(this.filesFile, Object.fromEntries(this.files)); }
  activatePrivate() {
    this.active = true;
    this.private.merge(this.archive.history.map(m => ({ ...m, legacyChannel: m.channel || 'geral', channel: PRIVATE_TEXT })));
    this.private.close();
  }
  get messages() { return [...this.public.messages, ...(this.active ? this.private.messages : [])].sort((a, b) => a.ts - b.ts); }
  recent(n = 300, privateTransport = false) { return (privateTransport ? this.private : this.public).recent(n); }
  get(id) { return this.public.get(id) || (this.active ? this.private.get(id) : undefined); }
  isPrivateChannel(id) { return isPrivateChannel(id); }
  isPrivateMessage(id) { return !!this.private.get(id) || !String(id).startsWith('pub-'); }
  registerFile(id, privateTransport) {
    const scope = privateTransport ? 'private' : 'public';
    if (this.files.has(id) && this.files.get(id) !== scope) throw new Error('O anexo pertence a outra conversa.');
    this.files.set(id, scope);
    this.saveFiles();
  }
  canAccessFile(id, privateTransport) { return privateTransport ? this.active && this.files.get(id) !== 'public' : this.files.get(id) === 'public'; }
  merge(list, privateTransport = undefined) {
    const out = { fresh: [], updated: [] };
    for (const m of list) {
      if (!m || typeof m.id !== 'string') continue;
      const priv = isPrivateChannel(m.channel);
      if (priv && !this.active) continue;
      if (privateTransport !== undefined && priv !== privateTransport) continue;
      if (!priv && !m.id.startsWith('pub-')) continue;
      const store = priv ? this.private : this.public;
      const other = priv ? this.public : this.private;
      if (other.get(m.id)) continue;
      if (m.file?.id) {
        const scope = priv ? 'private' : 'public';
        if (this.files.has(m.file.id) && this.files.get(m.file.id) !== scope) continue;
      }
      const result = store.merge([m]);
      if ((result.fresh.length || result.updated.length) && m.file?.id) this.registerFile(m.file.id, priv);
      out.fresh.push(...result.fresh);
      out.updated.push(...result.updated);
    }
    return out;
  }
  apply(op, by, scope = undefined) {
    const priv = this.isPrivateMessage(op?.id);
    if ((scope !== undefined && scope !== priv) || (priv && !this.active)) return null;
    return (priv ? this.private : this.public).apply(op, by);
  }
  listChannels() { return [...this.public.listChannels(), ...(this.active ? this.private.listChannels() : [])]; }
  allChannels() { return this.public.allChannels(); }
  mergeChannels(list) { return this.public.mergeChannels((Array.isArray(list) ? list : []).filter(c => c?.id?.startsWith('pub-'))); }
  createChannel(kind, name) {
    const c = this.public.createChannel(kind, name);
    this.public.channels.delete(c.id);
    c.id = `pub-${c.id}`;
    this.public.channels.set(c.id, c);
    return c;
  }
  renameChannel(id, name) { return this.public.renameChannel(id, name); }
  removeChannel(id) { return this.public.removeChannel(id); }
  close() { this.public.close(); this.private.close(); }
}
module.exports = { ScopedChatStore, isPrivateChannel, PRIVATE_TEXT, PRIVATE_VOICE };
