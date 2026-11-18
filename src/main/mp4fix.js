'use strict';
// O gravador do Chromium gera MP4 "fragmentado": o vídeo vem em pedaços
// (moof/mdat) e o cabeçalho diz duração 0. Os players tocam, mas mostram
// 0:00 e às vezes não deixam avançar. Aqui somamos a duração real dos
// pedaços e gravamos no cabeçalho (mvhd, tkhd, mdhd) e numa caixa mehd,
// que é o jeito padrão de informar a duração de um MP4 fragmentado.
//
// Inserir a mehd desloca o resto do arquivo; isso só é seguro porque os
// pedaços apontam para os dados relativos ao próprio moof (base-is-moof).
// Se não for o caso, só os campos de tamanho fixo são atualizados.

function boxes(b, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = b.readUInt32BE(i);
    const type = b.toString('ascii', i + 4, i + 8);
    let header = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(i + 8)); header = 16; }
    if (size === 0) size = end - i;
    if (size < header || i + size > end) break;
    out.push({ start: i, size, type, body: i + header });
    i += size;
  }
  return out;
}
const child = (b, box, type) => boxes(b, box.body, box.start + box.size).find((x) => x.type === type);

/** Duração de cada faixa (em unidades da própria faixa), somando os pedaços. */
function trackDurations(b, top, trex) {
  const sums = new Map();
  let safe = true;
  for (const moof of top.filter((x) => x.type === 'moof')) {
    for (const traf of boxes(b, moof.body, moof.start + moof.size).filter((x) => x.type === 'traf')) {
      const tfhd = child(b, traf, 'tfhd');
      if (!tfhd) continue;
      const flags = b.readUInt32BE(tfhd.body) & 0xffffff;
      if (!(flags & 0x20000) || (flags & 0x1)) safe = false;
      const trackId = b.readUInt32BE(tfhd.body + 4);
      let o = tfhd.body + 8;
      if (flags & 0x1) o += 8;
      if (flags & 0x2) o += 4;
      let defDur = trex.get(trackId) || 0;
      if (flags & 0x8) defDur = b.readUInt32BE(o);
      let total = sums.get(trackId) || 0;
      for (const trun of boxes(b, traf.body, traf.start + traf.size).filter((x) => x.type === 'trun')) {
        const tf = b.readUInt32BE(trun.body) & 0xffffff;
        const count = b.readUInt32BE(trun.body + 4);
        let p = trun.body + 8;
        if (tf & 0x1) p += 4;
        if (tf & 0x4) p += 4;
        const per = ['0x100', '0x200', '0x400', '0x800'].reduce((n, bit) => n + (tf & Number(bit) ? 4 : 0), 0);
        for (let s = 0; s < count; s++) {
          total += tf & 0x100 ? b.readUInt32BE(p) : defDur;
          p += per;
        }
      }
      sums.set(trackId, total);
    }
  }
  return { sums, safe };
}

function writeDur(b, at, version, value, wide) {
  if (version === 1 || wide) b.writeBigUInt64BE(BigInt(Math.round(value)), at);
  else b.writeUInt32BE(Math.min(0xffffffff, Math.round(value)), at);
}

/**
 * Um clipe começa no meio da gravação: os pedaços trazem o relógio absoluto
 * (tfdt). Subtrai o menor valor de cada faixa para o vídeo começar em 0.
 */
function rebaseTimeline(b, top) {
  const spots = []; // { at, version, trackId, value }
  for (const moof of top.filter((x) => x.type === 'moof')) {
    for (const traf of boxes(b, moof.body, moof.start + moof.size).filter((x) => x.type === 'traf')) {
      const tfhd = child(b, traf, 'tfhd');
      const tfdt = child(b, traf, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const version = b[tfdt.body];
      const at = tfdt.body + 4;
      const value = version === 1 ? b.readBigUInt64BE(at) : BigInt(b.readUInt32BE(at));
      spots.push({ at, version, trackId: b.readUInt32BE(tfhd.body + 4), value });
    }
  }
  const min = new Map();
  for (const s of spots) if (!min.has(s.trackId) || s.value < min.get(s.trackId)) min.set(s.trackId, s.value);
  for (const s of spots) {
    const v = s.value - min.get(s.trackId);
    if (s.version === 1) b.writeBigUInt64BE(v, s.at);
    else b.writeUInt32BE(Number(v), s.at);
  }
}

/** Duração (s) gravada no cabeçalho de um MP4. */
function durationOf(b) {
  const moov = boxes(b, 0, b.length).find((x) => x.type === 'moov');
  const mvhd = moov && child(b, moov, 'mvhd');
  if (!mvhd) return 0;
  const v = b[mvhd.body];
  const scale = b.readUInt32BE(mvhd.body + (v === 1 ? 20 : 12));
  const dur = v === 1 ? Number(b.readBigUInt64BE(mvhd.body + 24)) : b.readUInt32BE(mvhd.body + 16);
  return scale ? dur / scale : 0;
}

/** Clipe pronto para salvar: relógio zerado e duração no cabeçalho. */
function prepareClip(input) {
  try {
    const b = Buffer.from(input);
    rebaseTimeline(b, boxes(b, 0, b.length));
    const out = fixMp4Duration(b);
    return { data: out, seconds: Math.round(durationOf(out)) };
  } catch {
    return { data: Buffer.from(input), seconds: 0 };
  }
}

/** Devolve o MP4 com a duração preenchida (ou o original, se algo não bater). */
function fixMp4Duration(input) {
  try {
    const b = Buffer.from(input);
    const top = boxes(b, 0, b.length);
    const moov = top.find((x) => x.type === 'moov');
    if (!moov) return input;
    const mvhd = child(b, moov, 'mvhd');
    const mvex = child(b, moov, 'mvex');
    if (!mvhd || !mvex) return input;
    const mv = b[mvhd.body];
    const movieScale = b.readUInt32BE(mvhd.body + (mv === 1 ? 20 : 12));

    const trex = new Map();
    for (const t of boxes(b, mvex.body, mvex.start + mvex.size).filter((x) => x.type === 'trex')) {
      trex.set(b.readUInt32BE(t.body + 4), b.readUInt32BE(t.body + 12));
    }
    const { sums, safe } = trackDurations(b, top, trex);

    let movieDur = 0;
    for (const trak of boxes(b, moov.body, moov.start + moov.size).filter((x) => x.type === 'trak')) {
      const tkhd = child(b, trak, 'tkhd');
      const mdia = child(b, trak, 'mdia');
      const mdhd = mdia && child(b, mdia, 'mdhd');
      if (!tkhd || !mdhd) continue;
      const tv = b[tkhd.body];
      const trackId = b.readUInt32BE(tkhd.body + (tv === 1 ? 20 : 12));
      const hv = b[mdhd.body];
      const trackScale = b.readUInt32BE(mdhd.body + (hv === 1 ? 20 : 12));
      const units = sums.get(trackId) || 0;
      if (!units || !trackScale) continue;
      writeDur(b, mdhd.body + (hv === 1 ? 24 : 16), hv, units);
      const inMovie = (units / trackScale) * movieScale;
      writeDur(b, tkhd.body + (tv === 1 ? 28 : 20), tv, inMovie);
      movieDur = Math.max(movieDur, inMovie);
    }
    if (!movieDur) return input;
    writeDur(b, mvhd.body + (mv === 1 ? 24 : 16), mv, movieDur);

    const existing = child(b, mvex, 'mehd');
    if (existing) {
      writeDur(b, existing.body + 4, b[existing.body], movieDur);
      return b;
    }
    if (!safe) return b;
    // mehd (versão 0): tamanho 16 = cabeçalho 8 + versão/flags 4 + duração 4
    const mehd = Buffer.alloc(16);
    mehd.writeUInt32BE(16, 0);
    mehd.write('mehd', 4, 'ascii');
    mehd.writeUInt32BE(Math.min(0xffffffff, Math.round(movieDur)), 12);
    const at = mvex.body;
    const out = Buffer.concat([b.subarray(0, at), mehd, b.subarray(at)]);
    out.writeUInt32BE(moov.size + 16, moov.start);
    out.writeUInt32BE(mvex.size + 16, mvex.start);
    return out;
  } catch {
    return input;
  }
}

module.exports = { fixMp4Duration, prepareClip };
