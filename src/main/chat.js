'use strict';
// Histórico do chat e lista de canais/salas.
//
// Cada mensagem tem um contador de versão (v) que sobe a cada edição,
// exclusão ou reação. Ao sincronizar com quem chega, fica a versão mais nova.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanFile } = require('./media');

const MAX_HISTORY = 2000;
const CHANNEL_ID = /^[a-z0-9-]{1,40}$/;
const DEFAULT_CHANNELS = [
  { id: 'geral', name: 'geral', kind: 'text', ts: 0, fixed: true },
  { id: 'sala', name: 'Sala de voz', kind: 'voice', ts: 0, fixed: true },
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function cleanReactions(r) {
  const out = {};
  if (!r || typeof r !== 'object') return out;
  for (const [emoji, ids] of Object.entries(r).slice(0, 24)) {
    if (typeof emoji !== 'string' || !emoji || emoji.length > 16 || !Array.isArray(ids)) continue;
    const list = [...new Set(ids.filter((x) => typeof x === 'string' && x.length <= 64))].slice(0, 50);
    if (list.length) out[emoji] = list;
  }
  return out;
}

/** Valida e limpa uma mensagem vinda de qualquer lugar. */
function cleanMessage(m) {
  if (!m || typeof m.id !== 'string' || m.id.length > 64) return null;
  const deleted = !!m.deleted;
  const file = !deleted && m.file ? cleanFile(m.file) : null;
  const text = deleted ? '' : (typeof m.text === 'string' ? m.text.slice(0, 4000) : '');
  if (!deleted && !text.trim() && !file) return null;
  const clean = {
    id: m.id,
    from: String(m.from || '').slice(0, 64),
    name: String(m.name || 'Sem nome').slice(0, 40),
    text,
    ts: Number(m.ts) || Date.now(),
    channel: CHANNEL_ID.test(m.channel) ? m.channel : 'geral',
    v: Number(m.v) || 0,
  };
  if (file) clean.file = file;
  if (deleted) clean.deleted = true;
  if (Number(m.edited)) clean.edited = Number(m.edited);
  if (m.replyTo && typeof m.replyTo.id === 'string') {
    clean.replyTo = {
      id: m.replyTo.id.slice(0, 64),
      name: String(m.replyTo.name || '').slice(0, 40),
      text: String(m.replyTo.text || '').slice(0, 140),
    };
  }
  const reactions = cleanReactions(m.reactions);
  if (Object.keys(reactions).length) clean.reactions = reactions;
  return clean;
}

function cleanChannel(c) {
  if (!c || !CHANNEL_ID.test(c.id)) return null;
  const kind = c.kind === 'voice' ? 'voice' : 'text';
  const name = String(c.name || '').replace(/\s+/g, ' ').trim().slice(0, 32);
  if (!name && !c.deleted) return null;
  return { id: c.id, name: name || c.id, kind, ts: Number(c.ts) || 0, ...(c.deleted ? { deleted: true } : {}) };
}

class ChatStore {
  constructor(dir) {
    this.historyFile = path.join(dir, 'history.json');
    this.channelsFile = path.join(dir, 'channels.json');
    const saved = readJson(this.historyFile, []);
    this.messages = (Array.isArray(saved) ? saved : []).map(cleanMessage).filter(Boolean);
    this.byId = new Map(this.messages.map((m) => [m.id, m]));
    const ch = readJson(this.channelsFile, []);
    this.channels = new Map(DEFAULT_CHANNELS.map((c) => [c.id, { ...c }]));
    for (const c of (Array.isArray(ch) ? ch : []).map(cleanChannel).filter(Boolean)) {
      if (!this.channels.get(c.id)?.fixed) this.channels.set(c.id, c);
    }
    this.timer = null;
  }

  saveSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        fs.writeFileSync(this.historyFile, JSON.stringify(this.messages.slice(-MAX_HISTORY)));
        fs.writeFileSync(this.channelsFile, JSON.stringify([...this.channels.values()].filter((c) => !c.fixed)));
      } catch (err) {
        console.error('Falha ao salvar o chat:', err.message);
      }
    }, 400);
  }

  /** Últimas mensagens (para mandar a quem chega). */
  recent(n = 300) { return this.messages.slice(-n); }

  get(id) { return this.byId.get(id); }

  /**
   * Junta mensagens recebidas. Devolve { fresh, updated }: as novas e as que
   * já existiam mas chegaram numa versão mais nova (editadas, apagadas...).
   */
  merge(list) {
    const fresh = [];
    const updated = [];
    for (const raw of list) {
      const m = cleanMessage(raw);
      if (!m) continue;
      const cur = this.byId.get(m.id);
      if (!cur) {
        this.messages.push(m);
        this.byId.set(m.id, m);
        fresh.push(m);
      } else if (m.v > cur.v) {
        Object.assign(cur, m);
        for (const k of ['file', 'edited', 'deleted', 'replyTo', 'reactions']) if (!(k in m)) delete cur[k];
        updated.push(cur);
      }
    }
    if (fresh.length) {
      this.messages.sort((a, b) => a.ts - b.ts);
      if (this.messages.length > MAX_HISTORY) {
        for (const old of this.messages.splice(0, this.messages.length - MAX_HISTORY)) this.byId.delete(old.id);
      }
    }
    if (fresh.length || updated.length) this.saveSoon();
    return { fresh, updated };
  }

  /** Edição, exclusão ou reação. by = quem fez. Devolve a mensagem alterada. */
  apply(op, by) {
    const m = this.byId.get(String(op && op.id));
    if (!m) return null;
    if (op.op === 'edit' || op.op === 'delete') {
      if (m.from !== by || m.deleted) return null; // só quem escreveu
      if (op.op === 'edit') {
        const text = String(op.text || '').slice(0, 4000);
        if (!text.trim() && !m.file) return null;
        m.text = text;
        m.edited = Date.now();
      } else {
        m.deleted = true;
        m.text = '';
        delete m.file;
        delete m.reactions;
        delete m.edited;
      }
    } else if (op.op === 'react') {
      const emoji = String(op.emoji || '');
      if (!emoji || emoji.length > 16 || m.deleted) return null;
      const reactions = m.reactions || {};
      const list = new Set(reactions[emoji] || []);
      if (op.on) list.add(by); else list.delete(by);
      if (list.size) reactions[emoji] = [...list]; else delete reactions[emoji];
      if (Object.keys(reactions).length) m.reactions = reactions; else delete m.reactions;
    } else {
      return null;
    }
    m.v = Math.max(m.v + 1, Number(op.v) || 0);
    this.saveSoon();
    return m;
  }

  // ---------------------------------------------------------------- canais
  listChannels() {
    return [...this.channels.values()].filter((c) => !c.deleted)
      .map(({ id, name, kind, fixed }) => ({ id, name, kind, fixed: !!fixed }));
  }

  allChannels() { return [...this.channels.values()].filter((c) => !c.fixed); }

  /** Junta canais de outro computador. Devolve true se algo mudou. */
  mergeChannels(list) {
    let changed = false;
    for (const c of (Array.isArray(list) ? list : []).map(cleanChannel).filter(Boolean)) {
      const cur = this.channels.get(c.id);
      if (cur && cur.fixed) continue;
      if (!cur || c.ts > cur.ts) {
        this.channels.set(c.id, c);
        changed = true;
      }
    }
    if (changed) this.saveSoon();
    return changed;
  }

  createChannel(kind, name) {
    const id = `${kind === 'voice' ? 'v' : 't'}-${crypto.randomBytes(4).toString('hex')}`;
    const c = cleanChannel({ id, kind, name, ts: Date.now() });
    if (!c) throw new Error('Nome inválido');
    this.channels.set(id, c);
    this.saveSoon();
    return c;
  }

  renameChannel(id, name) {
    const cur = this.channels.get(id);
    if (!cur || cur.fixed || cur.deleted) throw new Error('Esse canal não pode ser renomeado');
    const c = cleanChannel({ ...cur, name, ts: Date.now() });
    if (!c) throw new Error('Nome inválido');
    this.channels.set(id, c);
    this.saveSoon();
    return c;
  }

  removeChannel(id) {
    const cur = this.channels.get(id);
    if (!cur || cur.fixed) throw new Error('Esse canal não pode ser apagado');
    const c = { ...cur, deleted: true, ts: Date.now() };
    this.channels.set(id, c);
    this.saveSoon();
    return c;
  }
}

module.exports = { ChatStore, cleanMessage };
