'use strict';
/* global prefs, toast, log */
// Áudio que sai do seu computador para a sala:
//
//   microfone ─▶ [IA de ruído (RNNoise)] ─▶ porta (mudo / apertar para falar) ─┐
//   soundboard ─────────────────────────────────────────────────────────────────┼─▶ sala
//                                       └─▶ seus fones (você ouve o som que tocou)
//
// A porta controla o volume em vez de desligar a trilha, então o soundboard
// continua funcionando mesmo com o microfone fechado.

const Mic = (() => {
  const RNNOISE = '@sapphi-red/web-noise-suppressor/rnnoise';
  let ctx = null;
  let raw = null;
  let src = null;
  let ns = null;
  let gate = null;
  let dest = null;
  let sb = null;
  let workletReady = null;
  let wasm = null;

  async function loadNoise() {
    if (!workletReady) {
      workletReady = (async () => {
        await ctx.audioWorklet.addModule('vendor/rnnoise/rnnoise-worklet.js');
        // Versão com SIMD quando o processador suporta (mais leve).
        const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
        wasm = await (await fetch(`vendor/rnnoise/${simd ? 'rnnoise_simd' : 'rnnoise'}.wasm`)).arrayBuffer();
      })();
    }
    await workletReady;
  }

  async function rewire() {
    if (!ctx || !raw) return;
    try { src && src.disconnect(); } catch {}
    if (ns) { try { ns.disconnect(); ns.port.postMessage('destroy'); } catch {} ns = null; }
    src = ctx.createMediaStreamSource(raw);
    if (prefs.read('aiNoise', true)) {
      try {
        await loadNoise();
        ns = new AudioWorkletNode(ctx, RNNOISE, { processorOptions: { maxChannels: 1, wasmBinary: wasm.slice(0) } });
        src.connect(ns);
        ns.connect(gate);
        return;
      } catch (err) {
        log(`IA de ruído indisponível: ${err.message}`);
      }
    }
    src.connect(gate);
  }

  return {
    /** Monta o caminho do áudio e devolve o stream que vai para a sala. */
    async start(rawStream) {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      gate = ctx.createGain();
      gate.gain.value = 0;
      dest = ctx.createMediaStreamDestination();
      gate.connect(dest);
      sb = ctx.createGain();
      sb.gain.value = prefs.read('sbVolume', 0.7);
      sb.connect(dest);
      const monitor = ctx.createGain();
      monitor.gain.value = 0.8;
      sb.connect(monitor).connect(ctx.destination);
      raw = rawStream;
      await rewire();
      return dest.stream;
    },
    /** Troca o microfone (novo dispositivo) sem mexer no que já foi para a sala. */
    async setInput(rawStream) {
      if (raw && raw !== rawStream) raw.getTracks().forEach((t) => t.stop());
      raw = rawStream;
      await rewire();
    },
    /** Liga/desliga a IA de ruído na hora. */
    refresh: () => rewire(),
    /** Abre ou fecha a porta do microfone (suave, sem estalo). */
    setOpen(open) {
      if (gate) gate.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, 0.012);
    },
    setSoundboardVolume(v) { if (sb) sb.gain.value = v; },
    play(buffer) {
      if (!ctx || !buffer) return false;
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.connect(sb);
      s.start();
      s.stop(ctx.currentTime + Math.min(buffer.duration, 10));
      return true;
    },
    context: () => ctx,
    active: () => !!ctx,
    noiseOn: () => !!ns,
    stop() {
      if (raw) raw.getTracks().forEach((t) => t.stop());
      if (ctx) ctx.close().catch(() => {});
      ctx = raw = src = ns = gate = dest = sb = null;
      workletReady = null;
    },
  };
})();

// ------------------------------------------------------------------ soundboard
// Sons sintetizados aqui mesmo (nada de arquivo de terceiros).
const SOUNDS = [
  { id: 'aplausos', name: 'Aplausos', emoji: '👏', dur: 2.2, build: applause },
  { id: 'badumtss', name: 'Ba-dum-tss', emoji: '🥁', dur: 1.6, build: rimshot },
  { id: 'boing', name: 'Boing', emoji: '🌀', dur: 0.8, build: boing },
  { id: 'triste', name: 'Trombone triste', emoji: '🎺', dur: 2.6, build: sadTrombone },
  { id: 'vitoria', name: 'Vitória', emoji: '🏆', dur: 1.6, build: victory },
  { id: 'buzina', name: 'Buzina', emoji: '📯', dur: 1.3, build: horn },
];

function noiseBuffer(c, dur) {
  const b = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function applause(c) {
  const n = noiseBuffer(c, 2.2);
  for (let i = 0; i < 140; i++) {
    const t = Math.random() * 1.7;
    const s = c.createBufferSource();
    s.buffer = n;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900 + Math.random() * 2600;
    f.Q.value = 1.2;
    const g = c.createGain();
    env(g, t, 0.002, 0.25 + Math.random() * 0.25, 0.05);
    s.connect(f).connect(g).connect(c.destination);
    s.start(t, Math.random(), 0.08);
  }
}
function tom(c, t, from, to) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + 0.18);
  env(g, t, 0.003, 0.7, 0.25);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + 0.3);
}
function rimshot(c) {
  tom(c, 0, 220, 110);
  tom(c, 0.24, 170, 85);
  const s = c.createBufferSource();
  s.buffer = noiseBuffer(c, 1.2);
  const f = c.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 6000;
  const g = c.createGain();
  env(g, 0.5, 0.002, 0.5, 1.0);
  s.connect(f).connect(g).connect(c.destination);
  s.start(0.5);
}
function boing(c) {
  const o = c.createOscillator();
  const g = c.createGain();
  const lfo = c.createOscillator();
  const depth = c.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(160, 0);
  o.frequency.exponentialRampToValueAtTime(620, 0.55);
  lfo.frequency.value = 18;
  depth.gain.value = 40;
  lfo.connect(depth).connect(o.frequency);
  env(g, 0, 0.01, 0.6, 0.7);
  o.connect(g).connect(c.destination);
  o.start(0);
  lfo.start(0);
  o.stop(0.8);
  lfo.stop(0.8);
}
function brass(c, t, freq, len, vib = false) {
  const o = c.createOscillator();
  const f = c.createBiquadFilter();
  const g = c.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(freq, t);
  if (vib) {
    const lfo = c.createOscillator();
    const d = c.createGain();
    lfo.frequency.value = 6;
    d.gain.value = 7;
    lfo.connect(d).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + len);
  }
  f.type = 'lowpass';
  f.frequency.value = 1400;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.04);
  g.gain.setValueAtTime(0.35, t + len - 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(f).connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + len);
}
function sadTrombone(c) {
  brass(c, 0, 196, 0.42);
  brass(c, 0.45, 185, 0.42);
  brass(c, 0.9, 175, 0.42);
  brass(c, 1.35, 164.8, 1.2, true);
}
function victory(c) {
  [523.3, 659.3, 784, 1046.5].forEach((f, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = f;
    const t = i * 0.11;
    const len = i === 3 ? 0.9 : 0.12;
    env(g, t, 0.005, 0.18, len);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + len + 0.05);
  });
}
function horn(c) {
  for (const f of [440, 554.4, 659.3]) {
    const o = c.createOscillator();
    const flt = c.createBiquadFilter();
    const g = c.createGain();
    o.type = 'sawtooth';
    o.frequency.value = f;
    flt.type = 'lowpass';
    flt.frequency.value = 2500;
    g.gain.setValueAtTime(0.0001, 0);
    g.gain.exponentialRampToValueAtTime(0.22, 0.03);
    g.gain.setValueAtTime(0.22, 1.1);
    g.gain.exponentialRampToValueAtTime(0.0001, 1.3);
    o.connect(flt).connect(g).connect(c.destination);
    o.start(0);
    o.stop(1.3);
  }
}

const Soundboard = (() => {
  const buffers = new Map(); // id -> AudioBuffer
  let custom = [];

  async function render(sound) {
    const c = new OfflineAudioContext(1, Math.ceil(48000 * sound.dur), 48000);
    sound.build(c);
    return c.startRendering();
  }

  async function bufferFor(id) {
    if (buffers.has(id)) return buffers.get(id);
    let buf = null;
    const builtin = SOUNDS.find((s) => s.id === id);
    if (builtin) buf = await render(builtin);
    else {
      const bytes = await window.ponte.soundsGet(id);
      const ctx = Mic.context();
      if (bytes && ctx) buf = await ctx.decodeAudioData(bytes.slice().buffer);
    }
    if (buf) buffers.set(id, buf);
    return buf;
  }

  return {
    builtins: SOUNDS,
    custom: () => custom,
    async loadCustom() { custom = (await window.ponte.soundsList()) || []; return custom; },
    async add(file) {
      if (file.size > 2 * 1024 * 1024) throw new Error('Use um som de até 2 MB.');
      custom = await window.ponte.soundsAdd(file.name, new Uint8Array(await file.arrayBuffer()));
      return custom;
    },
    async remove(id) { buffers.delete(id); custom = await window.ponte.soundsRemove(id); return custom; },
    async play(id) {
      if (!Mic.active()) { toast('Entre numa sala de voz para tocar sons.'); return false; }
      const buf = await bufferFor(id);
      return Mic.play(buf);
    },
  };
})();
