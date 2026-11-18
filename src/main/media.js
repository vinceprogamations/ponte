'use strict';
// Imagens e vídeos do chat: guarda no computador, manda para os amigos em
// pedaços pela conexão da Ponte e serve para a interface pelo protocolo
// ponte-media:// (com suporte a Range, para dar para avançar nos vídeos).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

const MAX_BYTES = 500 * 1024 * 1024;
const CHUNK = 192 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/ogg',
]);
const BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg',
};

function guessMime(name, mime) {
  if (MIMES.has(mime)) return mime;
  const ext = String(name || '').split('.').pop().toLowerCase();
  return BY_EXT[ext] || '';
}

/** Valida e limpa os dados de um anexo vindos de outro computador. */
function cleanFile(f) {
  if (!f || !ID.test(String(f.id))) return null;
  const mime = guessMime(f.name, String(f.mime || ''));
  const size = Number(f.size);
  if (!mime || !Number.isFinite(size) || size <= 0 || size > MAX_BYTES) return null;
  return { id: String(f.id), name: String(f.name || 'arquivo').slice(0, 120), size, mime };
}

class MediaStore extends EventEmitter {
  constructor(dir, node) {
    super();
    this.dir = dir;
    this.node = node;
    this.incoming = new Map(); // id -> { stream, received, meta, peerId, tmp }
    this.queues = new Map(); // peerId -> Promise (envios em fila, um por vez)
    this.requested = new Map(); // id -> momento do último pedido
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) { return path.join(this.dir, id); }
  metaFile(id) { return path.join(this.dir, `${id}.json`); }
  has(id) { return ID.test(id) && fs.existsSync(this.file(id)) && fs.existsSync(this.metaFile(id)); }
  meta(id) {
    try { return JSON.parse(fs.readFileSync(this.metaFile(id), 'utf8')); } catch { return null; }
  }

  /** Copia (ou grava) um arquivo escolhido pelo usuário para o acervo. */
  async import({ srcPath, bytes, name, mime }) {
    const type = guessMime(name || srcPath, mime);
    if (!type) throw new Error('Só dá para enviar imagens e vídeos.');
    const size = srcPath ? (await fsp.stat(srcPath)).size : bytes.byteLength;
    if (size <= 0) throw new Error('Arquivo vazio.');
    if (size > MAX_BYTES) throw new Error('O arquivo passa de 500 MB.');
    const id = crypto.randomUUID();
    if (srcPath) await fsp.copyFile(srcPath, this.file(id));
    else await fsp.writeFile(this.file(id), Buffer.from(bytes));
    const meta = { id, name: String(name || path.basename(srcPath || 'imagem.png')).slice(0, 120), size, mime: type };
    await fsp.writeFile(this.metaFile(id), JSON.stringify(meta));
    return meta;
  }

  /** Põe o envio de um arquivo na fila do amigo. */
  sendTo(peerId, id) {
    const prev = this.queues.get(peerId) || Promise.resolve();
    const next = prev.then(() => this._send(peerId, id)).catch((err) => this.emit('log', `Falha ao enviar arquivo: ${err.message}`));
    this.queues.set(peerId, next);
    return next;
  }

  async _send(peerId, id) {
    const meta = this.meta(id);
    if (!meta || !this.has(id)) return;
    if (!(await this.node.sendWait(peerId, { t: 'file-start', ...meta }))) return;
    let sent = 0;
    let last = 0;
    const stream = fs.createReadStream(this.file(id), { highWaterMark: CHUNK });
    for await (const chunk of stream) {
      if (!(await this.node.sendWait(peerId, { t: 'file-data', id, data: chunk.toString('base64') }))) {
        stream.destroy();
        return;
      }
      sent += chunk.length;
      if (Date.now() - last > 250 || sent === meta.size) {
        last = Date.now();
        this.emit('progress', { id, done: sent, size: meta.size, dir: 'up' });
      }
    }
    await this.node.sendWait(peerId, { t: 'file-end', id });
  }

  /** Pede ao amigo um arquivo que ainda não temos. */
  request(peerId, id) {
    if (!ID.test(id) || this.has(id) || this.incoming.has(id)) return;
    const at = this.requested.get(id) || 0;
    if (Date.now() - at < 30000) return;
    this.requested.set(id, Date.now());
    this.node.sendTo(peerId, { t: 'file-get', id });
  }

  /** Trata as mensagens de arquivo. Devolve true se a mensagem era dele. */
  handle(peerId, msg) {
    switch (msg.t) {
      case 'file-get':
        if (ID.test(String(msg.id)) && this.has(msg.id)) this.sendTo(peerId, msg.id);
        return true;
      case 'file-start': {
        const meta = cleanFile(msg);
        if (!meta || this.has(meta.id) || this.incoming.has(meta.id)) return true;
        const tmp = path.join(this.dir, `${meta.id}.part`);
        this.incoming.set(meta.id, { stream: fs.createWriteStream(tmp), received: 0, meta, peerId, tmp, last: 0 });
        return true;
      }
      case 'file-data': {
        const inc = this.incoming.get(String(msg.id));
        if (!inc || inc.peerId !== peerId || typeof msg.data !== 'string') return true;
        const buf = Buffer.from(msg.data, 'base64');
        inc.received += buf.length;
        if (inc.received > inc.meta.size) { this._abort(inc.meta.id); return true; }
        inc.stream.write(buf);
        if (Date.now() - inc.last > 250) {
          inc.last = Date.now();
          this.emit('progress', { id: inc.meta.id, done: inc.received, size: inc.meta.size, dir: 'down' });
        }
        return true;
      }
      case 'file-end': {
        const inc = this.incoming.get(String(msg.id));
        if (!inc || inc.peerId !== peerId) return true;
        this.incoming.delete(inc.meta.id);
        inc.stream.end(async () => {
          try {
            if (inc.received !== inc.meta.size) throw new Error('arquivo incompleto');
            await fsp.rename(inc.tmp, this.file(inc.meta.id));
            await fsp.writeFile(this.metaFile(inc.meta.id), JSON.stringify(inc.meta));
            this.emit('ready', inc.meta.id);
          } catch (err) {
            fsp.rm(inc.tmp, { force: true }).catch(() => {});
            this.requested.delete(inc.meta.id);
            this.emit('log', `Arquivo descartado: ${err.message}`);
          }
        });
        return true;
      }
      default:
        return false;
    }
  }

  /** Descarta recebimentos de quem saiu da rede. */
  dropFrom(connectedIds) {
    for (const inc of [...this.incoming.values()]) {
      if (!connectedIds.has(inc.peerId)) this._abort(inc.meta.id);
    }
  }

  _abort(id) {
    const inc = this.incoming.get(id);
    if (!inc) return;
    this.incoming.delete(id);
    this.requested.delete(id);
    inc.stream.destroy();
    fsp.rm(inc.tmp, { force: true }).catch(() => {});
  }

  /** Responde ao protocolo ponte-media://file/<id>, com Range para vídeos. */
  respond(request) {
    const id = new URL(request.url).pathname.replace(/^\//, '');
    const meta = this.has(id) && this.meta(id);
    if (!meta) return new Response('não encontrado', { status: 404 });
    const file = this.file(id);
    const size = fs.statSync(file).size;
    const headers = { 'Content-Type': meta.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
    if (range && (range[1] !== '' || range[2] !== '')) {
      let start;
      let end;
      if (range[1] === '') { start = Math.max(0, size - Number(range[2])); end = size - 1; }
      else { start = Number(range[1]); end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1); }
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      status: 200, headers: { ...headers, 'Content-Length': String(size) },
    });
  }
}

module.exports = { MediaStore, cleanFile, MAX_BYTES };
