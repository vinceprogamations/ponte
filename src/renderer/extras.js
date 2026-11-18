'use strict';
/* global api, toast, log, sendMediaPath */
// Clipes, qualidade da conexão e alimentação do overlay.

// ------------------------------------------------------------------ clipes
// Guarda os últimos ~30 s da transmissão que você está vendo, com UMA
// gravação só (leve). O MP4 que o Chromium grava vem em pedaços (moof+mdat)
// que começam sempre num quadro-chave; aqui guardamos o cabeçalho e só os
// pedaços dos últimos 30 s. Na hora do clipe, cabeçalho + pedaços viram um
// arquivo, e o processo principal acerta o relógio para começar do zero.
const Clips = (() => {
  const KEEP_S = 30;
  const mime = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4']
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  let target = null;
  let rec = null;
  let header = null; // ftyp + moov
  let pending = new Uint8Array(0);
  let curMoof = null;
  let frags = []; // { bytes, at }
  let queue = Promise.resolve();
  let saving = false;

  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  function reset() {
    header = null;
    pending = new Uint8Array(0);
    curMoof = null;
    frags = [];
    scales = new Map();
    videoTrack = 0;
  }

  // Relógio do vídeo: escala de tempo de cada faixa (lida do cabeçalho) e qual é a de vídeo.
  let scales = new Map();
  let videoTrack = 0;

  function walk(b, start, end, fn) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let i = start;
    while (i + 8 <= end) {
      const size = dv.getUint32(i);
      if (size < 8 || i + size > end) break;
      fn(String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]), i + 8, i + size, dv);
      i += size;
    }
  }

  /** Lê, no moov, a escala de tempo de cada faixa e qual delas é vídeo. */
  function readMoov(box) {
    scales = new Map();
    walk(box, 8, box.length, (type, s, e) => {
      if (type !== 'trak') return;
      let id = 0;
      let scale = 0;
      let vide = false;
      walk(box, s, e, (t2, s2, e2, dv) => {
        if (t2 === 'tkhd') id = dv.getUint32(s2 + (box[s2] === 1 ? 20 : 12));
        if (t2 === 'mdia') {
          walk(box, s2, e2, (t3, s3) => {
            if (t3 === 'mdhd') scale = dv.getUint32(s3 + (box[s3] === 1 ? 20 : 12));
            if (t3 === 'hdlr') vide = String.fromCharCode(box[s3 + 8], box[s3 + 9], box[s3 + 10], box[s3 + 11]) === 'vide';
          });
        }
      });
      if (id && scale) scales.set(id, scale);
      if (vide) videoTrack = id;
    });
  }

  /** Início do pedaço em segundos (pela faixa de vídeo), ou null. */
  function fragStart(moof) {
    let t = null;
    walk(moof, 8, moof.length, (type, s, e, dv) => {
      if (type !== 'traf' || t !== null) return;
      let id = 0;
      let base = null;
      walk(moof, s, e, (t2, s2) => {
        if (t2 === 'tfhd') id = dv.getUint32(s2 + 4);
        if (t2 === 'tfdt') base = moof[s2] === 1 ? Number(dv.getBigUint64(s2 + 4)) : dv.getUint32(s2 + 4);
      });
      if (base !== null && id === videoTrack && scales.get(id)) t = base / scales.get(id);
    });
    return t;
  }

  /** Separa as caixas MP4 que chegam do gravador. */
  function feed(buf) {
    pending = concat(pending, buf);
    const dv = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
    let off = 0;
    while (pending.length - off >= 8) {
      let size = dv.getUint32(off);
      const type = String.fromCharCode(pending[off + 4], pending[off + 5], pending[off + 6], pending[off + 7]);
      if (size === 1) {
        if (pending.length - off < 16) break;
        size = Number(dv.getBigUint64(off + 8));
      }
      if (size < 8) { reset(); return; } // algo inesperado: recomeça do zero
      if (pending.length - off < size) break;
      const box = pending.slice(off, off + size);
      if (type === 'ftyp' || type === 'moov') {
        header = header ? concat(header, box) : box;
        if (type === 'moov') readMoov(box);
      } else if (type === 'moof') curMoof = box;
      else if (type === 'mdat' && curMoof) {
        const t = fragStart(curMoof);
        frags.push({ bytes: concat(curMoof, box), t: t ?? (frags.length ? frags[frags.length - 1].t : 0) });
        curMoof = null;
      }
      off += size;
    }
    pending = pending.slice(off);
    // Mantém só o que cabe em ~30 s pelo relógio do próprio vídeo.
    // (o fim do último pedaço é estimado pela duração do penúltimo)
    const n = frags.length;
    const end = n > 1 ? frags[n - 1].t * 2 - frags[n - 2].t : 0;
    while (frags.length > 1 && end - frags[1].t >= KEEP_S) frags.shift();
  }

  function disarm() {
    if (rec) { rec.ondataavailable = null; try { rec.stop(); } catch {} }
    rec = null;
    target = null;
    queue = Promise.resolve();
    reset();
  }

  return {
    /** Passa a gravar este stream (ou para, com null). */
    arm(stream) {
      if (stream === target) return;
      disarm();
      if (!mime || !stream || !stream.getVideoTracks().length) return;
      try {
        rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 160_000 });
      } catch (err) {
        log(`Clipes indisponíveis: ${err.message}`);
        rec = null;
        return;
      }
      target = stream;
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        queue = queue.then(async () => feed(new Uint8Array(await e.data.arrayBuffer()))).catch(() => reset());
      };
      rec.start(1000);
    },
    armed: () => !!target,
    /** Salva o clipe. Devolve { file, seconds, mime } ou null. */
    async save() {
      if (saving || !rec) return null;
      saving = true;
      try {
        await new Promise((r) => { rec.requestData(); setTimeout(r, 300); });
        await queue;
        if (!header || !frags.length) return null;
        const data = concat(header, ...frags.map((f) => f.bytes));
        const r = await api.saveClip(data, 'mp4');
        return { file: r.file, seconds: r.seconds, mime: 'video/mp4' };
      } finally {
        saving = false;
      }
    },
    disarm,
  };
})();

// ------------------------------------------------------------------ qualidade da conexão
// Ping pela conexão da Ponte (sempre) e perda de pacotes da voz (quando na sala).
const NetQuality = (() => {
  const data = new Map(); // peerId -> { rtt, loss }
  const last = new Map(); // peerId -> { lost, recv }

  function set(id, patch) {
    data.set(id, { ...(data.get(id) || {}), ...patch });
  }

  return {
    onRtt(map) { for (const [id, ms] of Object.entries(map)) set(id, { rtt: ms }); },
    /** Lê as estatísticas do WebRTC de cada conexão. */
    async sample(conns) {
      for (const [id, c] of conns) {
        try {
          const stats = await c.pc.getStats();
          let lost = 0;
          let recv = 0;
          let rtt = null;
          stats.forEach((s) => {
            if (s.type === 'inbound-rtp' && s.kind === 'audio') { lost += s.packetsLost || 0; recv += s.packetsReceived || 0; }
            if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.currentRoundTripTime != null) rtt = s.currentRoundTripTime * 1000;
          });
          const prev = last.get(id) || { lost: 0, recv: 0 };
          const dl = lost - prev.lost;
          const dr = recv - prev.recv;
          last.set(id, { lost, recv });
          const patch = {};
          if (dl + dr > 0) patch.loss = Math.max(0, (dl / (dl + dr)) * 100);
          if (rtt != null) patch.rtt = Math.round(rtt);
          set(id, patch);
        } catch {}
      }
    },
    get: (id) => data.get(id),
    /** 'good' | 'ok' | 'bad' | '' (sem dados) */
    level(id) {
      const q = data.get(id);
      if (!q || q.rtt == null) return '';
      const loss = q.loss || 0;
      if (q.rtt < 80 && loss < 2) return 'good';
      if (q.rtt < 180 && loss < 6) return 'ok';
      return 'bad';
    },
    text(id) {
      const q = data.get(id);
      if (!q || q.rtt == null) return 'Medindo a conexão…';
      const loss = q.loss != null ? ` · perda ${q.loss.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '';
      return `Ping ${Math.round(q.rtt)} ms${loss}`;
    },
    forget(id) { data.delete(id); last.delete(id); },
  };
})();

/** Ícone de barrinhas de sinal colorido pela qualidade. */
function netBars(id) {
  const level = NetQuality.level(id);
  const el = document.createElement('span');
  el.className = `net ${level}`;
  el.title = NetQuality.text(id);
  el.innerHTML = '<i></i><i></i><i></i>';
  return el;
}
