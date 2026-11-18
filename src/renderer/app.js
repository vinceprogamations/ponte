'use strict';
/* global ponte */
const api = window.ponte;
const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------------ estado
let me = null;
let peers = [];
let view = 'chat';

let logLines = [];
const local = { voice: false, room: '', muted: false, deafened: false, sharing: false, quality: '', cam: false, camId: '', screenId: '' };
let micStream = null;
let screenStream = null;
let screenQuality = null;
let focusedTile = null;

/** peerId -> { pc, polite, makingOffer, ignoreOffer, queue, screenSenders } */
const conns = new Map();
/** peerId -> { audios: Map<streamId, HTMLAudioElement>, screen: MediaStream|null } */
const remotes = new Map();
/** chave -> { analyser, data } para o indicador de fala */
const meters = new Map();
const speaking = new Set();

// Resolução (altura) -> tamanho máximo e taxa de bits a 30 fps. A 60 fps a taxa sobe 60%.
const RESOLUTIONS = {
  480: { w: 848, h: 480, kbps: 1500 },
  720: { w: 1280, h: 720, kbps: 2500 },
  1080: { w: 1920, h: 1080, kbps: 4500 },
};
function qualityFor(res, fps) {
  res = RESOLUTIONS[res] ? Number(res) : 1080;
  fps = Number(fps) === 60 ? 60 : 30;
  const r = RESOLUTIONS[res];
  return {
    label: `${res}p${fps}`,
    w: r.w,
    h: r.h,
    fps,
    bitrate: Math.round(r.kbps * (fps === 60 ? 1.6 : 1) * 1000),
    // 'detail' faz o WebRTC preservar a resolução escolhida; se faltar banda, cede fps.
    hint: 'detail',
  };
}

const prefs = (() => {
  const read = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  return { read, write };
})();

const log = (line) => {
  const text = `${new Date().toLocaleTimeString()} ${line}`;
  logLines.push(text);
  logLines = logLines.slice(-200);
  if (me && me.autotest) api.log(line);
};

// ------------------------------------------------------------------ util
const COLORS = ['#ff9f0a', '#64d2ff', '#30d158', '#ff375f', '#bf5af2', '#ffd60a', '#5e5ce6', '#ff6961', '#66d4cf'];
function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}
function avatar(id, name, extraClass = '') {
  const el = document.createElement('div');
  el.className = `avatar ${extraClass}`.trim();
  el.style.background = colorFor(id);
  el.textContent = initials(name);
  el.dataset.speak = id;
  return el;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function linkify(text) {
  return escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
}
const ICON = {
  micOff: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg>',
  deaf: '<svg viewBox="0 0 24 24"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M4 4l16 16"/></svg>',
  voice: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  screen: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  photo: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
  film: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/></svg>',
  hash: '<svg viewBox="0 0 24 24"><path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/></svg>',
  reply: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/></svg>',
  smile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11" width="7" height="6" rx="1.5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  speakerOff: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m16 9 6 6M22 9l-6 6"/></svg>',
  expand: '<svg class="expand" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  shrink: '<svg class="shrink" viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
};
let toastTimer = null;
/** Aviso no topo. actions = [{ label, action }] vira botões. */
function toast(text, ms = 4000, actions = []) {
  const el = $('#toast');
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span);
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill-btn small';
    b.textContent = a.label;
    b.onclick = () => { el.hidden = true; a.action(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ------------------------------------------------------------------ sons
let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function sound(kind) {
  if (!prefs.read('sounds', true) || (me && me.autotest)) return;
  const notes = { join: [523, 784], leave: [659, 440], message: [880], online: [660, 880], mention: [988, 1319, 988] }[kind];
  if (!notes) return;
  const c = ctx();
  notes.forEach((f, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    const t = c.currentTime + i * 0.09;
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 0.2);
  });
}

// ------------------------------------------------------------------ medidor de fala
function attachMeter(key, stream) {
  detachMeter(key);
  if (!stream.getAudioTracks().length) return;
  const c = ctx();
  const src = c.createMediaStreamSource(stream);
  const analyser = c.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  meters.set(key, { analyser, src, data: new Uint8Array(analyser.fftSize) });
}
function detachMeter(key) {
  const m = meters.get(key);
  if (m) { try { m.src.disconnect(); } catch {} meters.delete(key); }
}
setInterval(() => {
  let changed = false;
  for (const [key, m] of meters) {
    m.analyser.getByteTimeDomainData(m.data);
    let sum = 0;
    for (const v of m.data) { const d = (v - 128) / 128; sum += d * d; }
    const rms = Math.sqrt(sum / m.data.length);
    const muted = key === me.id ? !micIsOpen() : peerState(key).muted;
    const on = rms > 0.02 && !muted;
    if (on !== speaking.has(key)) { on ? speaking.add(key) : speaking.delete(key); changed = true; }
  }
  for (const key of [...speaking]) if (!meters.has(key)) { speaking.delete(key); changed = true; }
  if (changed) {
    document.querySelectorAll('[data-speak]').forEach((el) => {
      el.classList.toggle('speaking', speaking.has(el.dataset.speak));
    });
    pushOverlay();
  }
}, 90);

// ------------------------------------------------------------------ pares
const peerState = (id) => (peers.find((p) => p.id === id) || {}).state || {};
const peerById = (id) => peers.find((p) => p.id === id);
/** Sala de voz de alguém ('' = fora). Versões antigas não mandam a sala: é a padrão. */
const roomOf = (state) => (state && state.voice ? (state.room || 'sala') : '');
/** Quem está na mesma sala que você. */
const voicePeers = () => (local.voice ? peers.filter((p) => roomOf(p.state) === local.room) : []);
const peersInRoom = (roomId) => peers.filter((p) => roomOf(p.state) === roomId);

function onPeers(list) {
  const before = new Map(peers.map((p) => [p.id, p]));
  peers = list;
  for (const p of peers) {
    const old = before.get(p.id);
    if (!old) { log(`${p.name} ficou online (${p.address})`); sound('online'); }
    if (local.voice && old) {
      const was = roomOf(old.state) === local.room;
      const is = roomOf(p.state) === local.room;
      if (!was && is) sound('join');
      if (was && !is) sound('leave');
    }
  }
  for (const [id, old] of before) {
    if (!peers.find((p) => p.id === id)) {
      log(`${old.name} saiu`);
      if (local.voice && roomOf(old.state) === local.room) sound('leave');
      NetQuality.forget(id);
    }
  }
  syncConnections();
  render();
}

// ------------------------------------------------------------------ WebRTC
function remoteOf(id) {
  let r = remotes.get(id);
  if (!r) { r = { audios: new Map(), videos: new Map() }; remotes.set(id, r); }
  return r;
}

/** Transmissão de tela de alguém (o vídeo que não é a câmera). */
function remoteScreen(id) {
  const r = remotes.get(id);
  const st = peerState(id);
  if (!r || !st.sharing) return null;
  return (st.screenId && r.videos.get(st.screenId)) || [...r.videos.values()].find((s) => s.id !== st.camId) || null;
}

/** Câmera de alguém. */
function remoteCam(id) {
  const r = remotes.get(id);
  const st = peerState(id);
  return (r && st.cam && st.camId && r.videos.get(st.camId)) || null;
}

function syncConnections() {
  for (const p of peers) {
    const both = local.voice && roomOf(p.state) === local.room;
    if (both && !conns.has(p.id)) openConn(p.id);
    if (!both && conns.has(p.id)) closeConn(p.id);
  }
  for (const id of [...conns.keys()]) if (!peerById(id)) closeConn(id);
}

function openConn(id) {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const c = { pc, polite: me.id > id, makingOffer: false, ignoreOffer: false, queue: Promise.resolve(), screenSenders: [], camSenders: [] };
  conns.set(id, c);
  const name = () => (peerById(id) || {}).name || id.slice(0, 6);

  if (micStream) for (const t of micStream.getAudioTracks()) pc.addTrack(t, micStream);
  if (screenStream) addScreenTo(c);
  if (camStream) addCamTo(c);

  pc.onnegotiationneeded = async () => {
    try {
      c.makingOffer = true;
      await pc.setLocalDescription();
      api.sendSignal(id, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } catch (err) {
      log(`Erro ao negociar com ${name()}: ${err.message}`);
    } finally {
      c.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) api.sendSignal(id, { candidate: candidate.toJSON() });
  };
  pc.ontrack = ({ track, streams }) => onRemoteTrack(id, track, streams[0] || new MediaStream([track]));
  pc.onconnectionstatechange = () => {
    log(`Mídia com ${name()}: ${pc.connectionState}`);
    if (pc.connectionState === 'failed') pc.restartIce();
    if (pc.connectionState === 'connected') tuneScreenSenders(c);
    else watchdog(id, c);
  };
  watchdog(id, c);
  return c;
}

/**
 * Se a mídia não conectar a tempo (ex.: uma oferta se perdeu quando a conexão
 * TCP foi trocada), descarta a conexão e começa de novo. O tempo é sorteado
 * para os dois lados não recomeçarem juntos em sequência.
 */
function watchdog(id, c) {
  clearTimeout(c.watchdog);
  c.watchdog = setTimeout(() => {
    if (conns.get(id) !== c || c.pc.connectionState === 'connected') return;
    log(`Mídia com ${(peerById(id) || {}).name || id.slice(0, 6)} não conectou; tentando de novo`);
    closeConn(id);
    syncConnections();
  }, 4000 + Math.random() * 3000);
}

function closeConn(id) {
  const c = conns.get(id);
  if (c) { clearTimeout(c.watchdog); try { c.pc.close(); } catch {} conns.delete(id); }
  const r = remotes.get(id);
  if (r) {
    for (const el of r.audios.values()) { el.srcObject = null; el.remove(); }
    remotes.delete(id);
  }
  detachMeter(id);
  if (focusedTile === `screen:${id}`) focusedTile = null;
  renderStage();
}

function onSignal({ from, data }) {
  const p = peerById(from);
  if (!local.voice || !p || roomOf(p.state) !== local.room) return;
  const c = conns.get(from) || openConn(from);
  // Processa em fila: o candidato não pode chegar antes da descrição terminar.
  c.queue = c.queue.then(async () => {
    const pc = c.pc;
    if (pc.signalingState === 'closed') return;
    try {
      if (data.description) {
        const desc = data.description;
        const collision = desc.type === 'offer' && (c.makingOffer || pc.signalingState !== 'stable');
        c.ignoreOffer = !c.polite && collision;
        if (c.ignoreOffer) return;
        await pc.setRemoteDescription({ type: desc.type, sdp: lanBitrate(desc.sdp) });
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          api.sendSignal(from, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (err) { if (!c.ignoreOffer) throw err; }
      }
    } catch (err) {
      log(`Erro de sinalização com ${p.name}: ${err.message}`);
    }
  });
}

/**
 * O WebRTC começa estimando pouca banda e leva ~20 s para chegar em 1080p.
 * Numa LAN dá para começar alto: indica 4 Mbps iniciais aos codecs de vídeo.
 */
const START_KBPS = 4000;
function lanBitrate(sdp) {
  if (!sdp) return sdp;
  // Nunca começa acima do teto da qualidade escolhida.
  const startKbps = Math.min(START_KBPS, screenQuality ? Math.round(screenQuality.bitrate / 1000) : START_KBPS);
  const lines = sdp.split('\r\n');
  const out = [];
  let inVideo = false;
  const withFmtp = new Set();
  const opus = new Set();
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const f = inVideo && /^a=fmtp:(\d+) /.exec(l);
    if (f) withFmtp.add(f[1]);
    const o = /^a=rtpmap:(\d+) opus\//i.exec(l);
    if (o) opus.add(o[1]);
  }
  inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    // Som da transmissão (jogo, música): Opus em estéreo e com mais qualidade.
    const audioFmtp = !inVideo && /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (audioFmtp && opus.has(audioFmtp[1]) && !/stereo=/.test(audioFmtp[2])) {
      out.push(`${l};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`);
      continue;
    }
    const fmtp = inVideo && /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (fmtp && !/apt=|x-google-start-bitrate/.test(fmtp[2])) {
      out.push(`${l};x-google-start-bitrate=${startKbps}`);
      continue;
    }
    out.push(l);
    const rtpmap = inVideo && /^a=rtpmap:(\d+) (VP8|VP9|H264|AV1)\//i.exec(l);
    if (rtpmap && !withFmtp.has(rtpmap[1])) out.push(`a=fmtp:${rtpmap[1]} x-google-start-bitrate=${startKbps}`);
  }
  return out.join('\r\n');
}

function onRemoteTrack(id, track, stream) {
  const r = remoteOf(id);
  if (track.kind === 'video') {
    // Tela ou câmera: quem decide é o estado da pessoa (screenId/camId).
    r.videos.set(stream.id, stream);
    const refresh = () => {
      if (!stream.getVideoTracks().some((t) => t.readyState === 'live')) r.videos.delete(stream.id);
      renderStage();
    };
    track.onended = refresh;
    stream.onremovetrack = refresh;
    applyVolumes();
    renderStage();
    wakeUi();
    return;
  }
  if (r.audios.has(stream.id)) return;
  const el = new Audio();
  el.autoplay = true;
  el.srcObject = stream;
  const sink = prefs.read('outDevice', '');
  if (sink && el.setSinkId) el.setSinkId(sink).catch(() => {});
  el.play().catch(() => {});
  document.body.append(el);
  r.audios.set(stream.id, el);
  applyVolumes();
  // Áudio que vem junto com vídeo é som da tela; o resto é microfone.
  const isScreenAudio = stream.getVideoTracks().length > 0;
  if (!isScreenAudio) attachMeter(id, stream);
  stream.onremovetrack = () => {
    if (!stream.getTracks().some((t) => t.readyState === 'live')) {
      el.srcObject = null;
      el.remove();
      r.audios.delete(stream.id);
    }
  };
}

function volumeFor(id) { return prefs.read(`vol:${id}`, 1); }
function setVolume(id, v) {
  prefs.write(`vol:${id}`, v);
  applyVolumes();
}
const streamVolume = (id) => prefs.read(`svol:${id}`, 1);
const streamMuted = (id) => prefs.read(`smute:${id}`, false);
function setStreamVolume(id, v) {
  prefs.write(`svol:${id}`, v);
  if (v > 0) prefs.write(`smute:${id}`, false);
  applyVolumes();
  renderStage();
}
function toggleStreamMute(id) {
  prefs.write(`smute:${id}`, !streamMuted(id));
  applyVolumes();
  renderStage();
}
/** Áudio que vem junto com vídeo é o som da transmissão; o resto é a voz. */
const isStreamAudio = (el) => !!(el.srcObject && el.srcObject.getVideoTracks().length);
function applyVolumes() {
  for (const [id, r] of remotes) {
    for (const el of r.audios.values()) {
      const stream = isStreamAudio(el);
      el.volume = stream ? streamVolume(id) : volumeFor(id);
      el.muted = local.deafened || (stream && streamMuted(id));
    }
  }
}

// ------------------------------------------------------------------ voz
function micConstraints() {
  const deviceId = prefs.read('micDevice', '');
  return {
    echoCancellation: true,
    noiseSuppression: !prefs.read('aiNoise', true), // com a IA ligada, ela faz esse trabalho
    autoGainControl: true,
    channelCount: 1,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

function pushState() {
  api.setState({ ...local });
}

// Apertar para falar: a tecla é observada pelo app mesmo com o jogo na frente.
const voiceMode = () => prefs.read('voiceMode', 'auto'); // 'auto' | 'ptt'
const pttKey = () => prefs.read('pttKey', { vk: 86, label: 'V' });
let pttDown = false;
/** O microfone está mandando som agora? */
const micIsOpen = () => !local.muted && !local.deafened && (voiceMode() !== 'ptt' || pttDown);

function applyPtt() {
  api.setPtt(voiceMode() === 'ptt' ? pttKey().vk : 0);
  if (voiceMode() !== 'ptt') pttDown = false;
  applyMute();
}

function onPtt(down) {
  if (voiceMode() !== 'ptt') return;
  pttDown = !!down;
  applyMute();
  document.body.classList.toggle('ptt-down', pttDown);
}

const roomName = (id) => (channels.find((c) => c.id === id) || {}).name || 'Sala de voz';

async function joinVoice(roomId = 'sala') {
  if (local.voice && local.room === roomId) { setView('voice'); return; }
  if (local.voice) leaveVoice({ quiet: true });
  let raw;
  try {
    raw = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
  } catch (err) {
    if (prefs.read('micDevice', '')) {
      prefs.write('micDevice', '');
      return joinVoice(roomId);
    }
    toast(`Não foi possível usar o microfone: ${err.message}`);
    return;
  }
  micStream = await Mic.start(raw);
  attachMeter(me.id, micStream);
  local.voice = true;
  local.room = roomId;
  applyMute();
  pushState();
  sound('join');
  setView('voice');
  syncConnections();
  render();
}

function leaveVoice({ quiet = false } = {}) {
  if (!local.voice) return;
  stopScreen(false);
  stopCam(false);
  local.voice = false;
  local.room = '';
  pushState();
  for (const id of [...conns.keys()]) closeConn(id);
  Mic.stop();
  micStream = null;
  detachMeter(me.id);
  Clips.disarm();
  if (!quiet) sound('leave');
  if (view === 'voice') setView('voice');
  render();
}

function applyMute() {
  Mic.setOpen(local.voice && micIsOpen());
  applyVolumes();
  pushOverlay();
}

function toggleMute() {
  if (local.deafened) { local.deafened = false; local.muted = false; }
  else local.muted = !local.muted;
  applyMute();
  pushState();
  render();
}

function toggleDeafen() {
  local.deafened = !local.deafened;
  applyMute();
  pushState();
  render();
}

// ------------------------------------------------------------------ câmera
let camStream = null;

async function toggleCam() {
  if (camStream) { stopCam(); return; }
  if (!local.voice) { toast('Entre numa sala de voz para ligar a câmera.'); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    });
  } catch (err) {
    toast(`Não foi possível ligar a câmera: ${err.message}`);
    return;
  }
  camStream.getVideoTracks()[0].onended = () => stopCam();
  local.cam = true;
  local.camId = camStream.id;
  pushState();
  for (const c of conns.values()) addCamTo(c);
  render();
}

function addCamTo(c) {
  for (const t of camStream.getVideoTracks()) {
    const tr = c.pc.addTransceiver(t, {
      direction: 'sendonly',
      streams: [camStream],
      sendEncodings: [{ maxBitrate: 1_500_000, maxFramerate: 30 }],
    });
    c.camSenders.push(tr.sender);
  }
}

function stopCam(push = true) {
  if (!camStream) return;
  camStream.getTracks().forEach((t) => t.stop());
  for (const c of conns.values()) {
    for (const s of c.camSenders) { try { c.pc.removeTrack(s); } catch {} }
    c.camSenders = [];
  }
  camStream = null;
  local.cam = false;
  local.camId = '';
  if (push) pushState();
  render();
}

// ------------------------------------------------------------------ tela
let sourceKind = 'screen';
let sourceList = [];
let selectedSource = null;

async function openScreenPicker() {
  if (local.sharing) { stopScreen(); return; }
  if (!local.voice) await joinVoice();
  if (!local.voice) return;
  selectedSource = null;
  $('#screen-go').disabled = true;
  $('#screen-res').value = String(prefs.read('screenRes', 1080));
  $('#screen-fps').value = String(prefs.read('screenFps', 30));
  updateQualityHint();
  audioTouched = false;
  audioApps = null;
  fillAudioOptions();
  $('#sources').innerHTML = '<p class="waiting">Carregando…</p>';
  $('#dlg-screen').showModal();
  try {
    [sourceList, audioApps] = me.demo
      ? [demoSources(), demoAudioApps()]
      : await Promise.all([api.screenSources(), api.audioApps().catch(() => null)]);
  } catch (err) {
    $('#sources').textContent = `Falha ao listar telas: ${err.message}`;
    return;
  }
  fillAudioOptions();
  renderSources();
}

// ------------------------------------------------------------------ som da transmissão
let audioApps = null; // janelas com processo, vindas do ponte-audio.exe (null = indisponível)
let audioTouched = false;

const hwndOf = (sourceId) => (/^window:(\d+):/.exec(sourceId || '') || [])[1];
function appName(a) {
  const exe = a.exe.replace(/\.exe$/i, '');
  return a.title && !a.title.toLowerCase().includes(exe.toLowerCase()) ? `${exe} — ${a.title}` : (a.title || exe);
}

/** Preenche "Som": sem som, só o app compartilhado, um app específico ou o PC todo. */
function fillAudioOptions() {
  const sel = $('#screen-audio-src');
  const keep = sel.value;
  sel.innerHTML = '';
  const add = (value, label, disabled = false) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.disabled = disabled;
    sel.append(o);
  };
  add('none', 'Sem som');
  if (audioApps) {
    const isWindow = !!hwndOf(selectedSource);
    add('shared', 'Só o app compartilhado', !isWindow);
    const seen = new Set();
    for (const a of audioApps) {
      if (seen.has(a.pid)) continue;
      seen.add(a.pid);
      add(`app:${a.pid}`, appName(a).slice(0, 70));
    }
    add('all', 'Tudo do PC (menos a Ponte)');
  }
  $('#screen-audio-row').hidden = false;
  if (audioTouched && [...sel.options].some((o) => o.value === keep && !o.disabled)) sel.value = keep;
  else sel.value = hwndOf(selectedSource) && audioApps ? 'shared' : 'none';
  updateAudioHint();
}

function updateAudioHint() {
  const v = $('#screen-audio-src').value;
  const hint = $('#screen-audio-hint');
  hint.classList.toggle('warn', v === 'all');
  hint.textContent = v === 'none'
    ? (audioApps ? 'Só a imagem vai.' : 'Só a imagem vai. Este Windows não permite separar o som por app.')
    : v === 'all'
      ? 'Inclui tudo que toca no PC, até a voz do Discord: quem estiver em chamada vai se ouvir.'
      : 'Só o som desse app vai. A voz do Discord e de outros apps fica de fora, sem retorno.';
}

/** Converte a escolha do diálogo em { mode, pid } para o ponte-audio. */
function resolveAudioChoice(value, sourceId) {
  if (!audioApps || value === 'none') return null;
  if (value === 'all') return { mode: 'all' };
  if (value === 'shared') {
    const app = audioApps.find((a) => a.hwnd === hwndOf(sourceId));
    return app ? { mode: 'app', pid: app.pid, name: appName(app) } : null;
  }
  const pid = Number(value.slice(4));
  const app = audioApps.find((a) => a.pid === pid);
  return { mode: 'app', pid, name: app ? appName(app) : '' };
}

let appAudio = null;
async function startAppAudio(choice) {
  const ctxAudio = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await ctxAudio.audioWorklet.addModule('pcm-worklet.js');
  const node = new AudioWorkletNode(ctxAudio, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = ctxAudio.createMediaStreamDestination();
  dest.channelCount = 2;
  node.connect(dest);
  const offPcm = api.onAudioPcm((u8) => {
    const ab = u8.slice().buffer;
    node.port.postMessage(ab, [ab]);
  });
  const offEnded = api.onAudioEnded(() => { if (appAudio) toast('O som da transmissão parou.'); });
  appAudio = { ctxAudio, offPcm, offEnded };
  try {
    await api.audioStart({ mode: choice.mode, pid: choice.pid });
  } catch (err) {
    stopAppAudio();
    throw err;
  }
  return dest.stream.getAudioTracks()[0];
}

function stopAppAudio() {
  if (!appAudio) return;
  const a = appAudio;
  appAudio = null;
  a.offPcm();
  a.offEnded();
  api.audioStop();
  a.ctxAudio.close().catch(() => {});
}

function renderSources() {
  const box = $('#sources');
  box.innerHTML = '';
  const list = sourceList.filter((s) => s.id.startsWith(sourceKind === 'screen' ? 'screen:' : 'window:'));
  if (!list.length) box.innerHTML = '<p class="waiting">Nada para mostrar aqui.</p>';
  for (const s of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `source${selectedSource === s.id ? ' selected' : ''}`;
    b.innerHTML = `<img alt="" src="${s.thumb}"><span></span>`;
    b.querySelector('span').textContent = s.name;
    b.onclick = () => { selectedSource = s.id; $('#screen-go').disabled = false; renderSources(); fillAudioOptions(); };
    b.ondblclick = () => { selectedSource = s.id; $('#dlg-screen').close('go'); };
    box.append(b);
  }
}

function updateQualityHint() {
  const q = qualityFor($('#screen-res').value, $('#screen-fps').value);
  const mbps = (q.bitrate / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  $('#screen-hint').textContent = `até ${mbps} Mbps${q.fps === 60 ? ' · mais fluido, bom para jogos' : ''}`;
}

async function startScreen(sourceId, quality, audioChoice) {
  screenQuality = quality;
  api.selectScreen({ id: sourceId, audio: false });
  const size = {
    width: { ideal: quality.w, max: quality.w },
    height: { ideal: quality.h, max: quality.h },
    frameRate: { ideal: quality.fps, max: quality.fps },
  };
  try {
    screenStream = me.demo
      ? demoScene(quality)
      : me.autotestCanvas
      ? testPattern(quality)
      : await navigator.mediaDevices.getDisplayMedia({ video: size, audio: false });
  } catch (err) {
    toast(`Não foi possível capturar a tela: ${err.message}`);
    return;
  }
  const vt = screenStream.getVideoTracks()[0];
  if (vt) {
    vt.contentHint = quality.hint;
    vt.onended = () => stopScreen();
    // Garante o limite mesmo se a captura ignorar as restrições iniciais.
    await vt.applyConstraints(size).catch(() => {});
    const s = vt.getSettings();
    log(`Transmitindo ${quality.label}: captura ${s.width}x${s.height} a ${Math.round(s.frameRate)} fps`);
  }
  if (audioChoice) {
    try {
      screenStream.addTrack(await startAppAudio(audioChoice));
      log(`Som da transmissão: ${audioChoice.mode === 'all' ? 'PC todo, menos a Ponte' : audioChoice.name || audioChoice.pid}`);
    } catch (err) {
      toast(`A tela vai sem som: ${err.message}`);
    }
  }
  local.sharing = true;
  local.quality = quality.label;
  local.screenId = screenStream.id;
  pushState();
  for (const c of conns.values()) addScreenTo(c);
  focusedTile = null;
  render();
}

function addScreenTo(c) {
  for (const t of screenStream.getVideoTracks()) {
    // Limites definidos já na criação, antes de o codificador começar.
    const tr = c.pc.addTransceiver(t, {
      direction: 'sendonly',
      streams: [screenStream],
      sendEncodings: [{ maxBitrate: screenQuality.bitrate, maxFramerate: screenQuality.fps }],
    });
    c.screenSenders.push(tr.sender);
  }
  for (const t of screenStream.getAudioTracks()) c.screenSenders.push(c.pc.addTrack(t, screenStream));
  tuneScreenSenders(c);
}

/** Ajusta taxa de bits e quadros depois que a negociação define os encodings. */
function tuneScreenSenders(c, attempt = 0) {
  if (!screenQuality) return;
  let pending = false;
  for (const s of c.screenSenders) {
    if (!s.track || s.track.kind !== 'video') continue;
    const params = s.getParameters();
    if (!params.encodings || !params.encodings.length) { pending = true; continue; }
    params.encodings[0].maxBitrate = screenQuality.bitrate;
    params.encodings[0].maxFramerate = screenQuality.fps;
    params.degradationPreference = 'maintain-resolution';
    s.setParameters(params).catch(() => {});
  }
  if (pending && attempt < 10) setTimeout(() => tuneScreenSenders(c, attempt + 1), 700);
}

function stopScreen(push = true) {
  if (!screenStream) return;
  stopAppAudio();
  screenStream.getTracks().forEach((t) => t.stop());
  for (const c of conns.values()) {
    for (const s of c.screenSenders) { try { c.pc.removeTrack(s); } catch {} }
    c.screenSenders = [];
  }
  screenStream = null;
  screenQuality = null;
  local.sharing = false;
  local.quality = '';
  local.screenId = '';
  if (focusedTile === `screen:${me.id}`) focusedTile = null;
  if (push) pushState();
  render();
}

// ------------------------------------------------------------------ janelinhas (menus e escolhas)
let popover = null;
let popoverOff = null;

function closePopover() {
  if (popoverOff) popoverOff();
  popoverOff = null;
  if (popover) popover.remove();
  popover = null;
}

/** Abre um balão de vidro perto de um botão (ou de um ponto x/y). */
function openPopover(anchor, content, { at = null } = {}) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.append(content);
  document.body.append(pop);
  const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y, width: 0 } : anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let top = at ? r.top : r.top - pr.height - 10;
  if (top < 48) top = r.bottom + 10;
  if (top + pr.height > innerHeight - 8) top = innerHeight - pr.height - 8;
  let left = at ? r.left : r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(left, innerWidth - pr.width - 8));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
  popover = pop;
  const outside = (e) => { if (!pop.contains(e.target) && !(anchor && anchor.contains && anchor.contains(e.target))) closePopover(); };
  const esc = (e) => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  document.addEventListener('keydown', esc);
  popoverOff = () => {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc);
  };
  return pop;
}

/** Menu de opções (botão direito). items = [{ label, danger, action }] */
function openMenu(e, items) {
  e.preventDefault();
  const list = document.createElement('div');
  list.className = 'menu';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    if (it.danger) b.classList.add('danger');
    b.onclick = () => { closePopover(); it.action(); };
    list.append(b);
  }
  openPopover(null, list, { at: { x: e.clientX, y: e.clientY } });
}

/** Pergunta um nome. Resolve com o texto ou null. */
function promptDialog({ title, value = '', ok = 'Criar', placeholder = '' }) {
  const dlg = $('#dlg-prompt');
  $('#prompt-title').textContent = title;
  $('#prompt-ok').textContent = ok;
  const input = $('#prompt-input');
  input.value = value;
  input.placeholder = placeholder;
  dlg.returnValue = '';
  dlg.showModal();
  input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      const v = dlg.returnValue === 'ok' ? input.value.trim() : '';
      dlg.returnValue = '';
      resolve(v || null);
    }, { once: true });
  });
}

// ------------------------------------------------------------------ chat
let channels = [];
let currentText = 'geral';
const allMessages = [];
const msgById = new Map();
const unreadBy = new Map();
let replyTo = null; // { id, name, text }
let editing = null; // mensagem sendo editada
let lastMsg = null;
const typingTimers = new Map(); // `${canal}|${pessoa}` -> timeout
const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '💀', '🙏', '😡', '✅'];
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/ogg']);

const textName = (id) => (channels.find((c) => c.id === id) || {}).name || id;
const nameOf = (id) => (id === me.id ? me.name
  : (peerById(id) || {}).name || (allMessages.find((m) => m.from === id) || {}).name || 'Alguém');
const preview = (m) => (m.deleted ? 'Mensagem apagada'
  : m.text || (m.file ? (m.file.mime.startsWith('image/') ? '📷 Imagem' : m.file.mime.startsWith('video/') ? '🎬 Vídeo' : `📎 ${m.file.name}`) : ''));

function storeMessage(m) {
  const cur = msgById.get(m.id);
  if (cur) {
    Object.assign(cur, m);
    for (const k of ['file', 'edited', 'deleted', 'replyTo', 'reactions']) if (!(k in m)) delete cur[k];
    return cur;
  }
  msgById.set(m.id, m);
  allMessages.push(m);
  return m;
}

function mentionsMe(m) {
  if (!m.text || m.from === me.id) return false;
  const t = m.text.toLowerCase();
  return t.includes(`@${me.name.toLowerCase()}`) || /(^|\s)@(todos|everyone|here)\b/.test(t);
}

/** Texto com links e @menções destacadas (o texto já sai escapado). */
function richText(text) {
  const names = [...new Set([me.name, ...peers.map((p) => p.name), 'todos'])]
    .filter(Boolean).sort((a, b) => b.length - a.length)
    .map((n) => escapeHtml(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(${names.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  // Só troca fora das tags, para nunca mexer dentro de um href.
  return linkify(text).split(/(<[^>]*>)/).map((part) => (part.startsWith('<') ? part
    : part.replace(re, (x) => `<span class="mention">${x}</span>`))).join('');
}

/** Mensagem nova (sua ou de alguém). */
function receiveMessage(m) {
  const msg = storeMessage(m);
  if (msg.channel === currentText) appendMessage(msg);
  if (msg.from === me.id) return;
  clearTyping(msg.channel, msg.from);
  if (msg.channel !== currentText || view !== 'chat' || !document.hasFocus()) {
    unreadBy.set(msg.channel, (unreadBy.get(msg.channel) || 0) + 1);
    renderSidebar();
  }
  sound(mentionsMe(msg) ? 'mention' : 'message');
}

/** Mensagem que mudou (editada, apagada, reação). */
function updateMessage(m) {
  if (!m) return;
  const msg = storeMessage(m);
  const row = document.querySelector(`#messages [data-id="${CSS.escape(msg.id)}"]`);
  if (!row) return;
  keepBottom(() => {
    row.querySelector('.msg-body').replaceWith(msgBody(msg));
    row.querySelector('.msg-tools')?.replaceWith(msgTools(msg));
    row.classList.toggle('mentioned', mentionsMe(msg));
  });
}

function appendMessage(m) {
  const box = $('#messages');
  box.querySelector('.empty-chat')?.remove();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const time = new Date(m.ts);
  const sameAuthor = lastMsg && lastMsg.from === m.from && m.ts - lastMsg.ts < 5 * 60 * 1000 && !m.replyTo;
  const row = document.createElement('div');
  if (sameAuthor) {
    row.className = 'msg-line';
    row.title = time.toLocaleString();
  } else {
    row.className = 'msg-group';
    row.append(avatar(m.from, m.name));
    const head = document.createElement('div');
    head.className = 'msg-head';
    head.innerHTML = '<strong></strong><time></time>';
    head.querySelector('strong').textContent = m.name;
    head.querySelector('strong').style.color = colorFor(m.from);
    const today = new Date().toDateString() === time.toDateString();
    head.querySelector('time').textContent = today
      ? `Hoje às ${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : time.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    row.append(head);
  }
  row.dataset.id = m.id;
  row.classList.toggle('mine', m.from === me.id);
  row.classList.toggle('mentioned', mentionsMe(m));
  row.append(msgBody(m), msgTools(m));
  box.append(row);
  lastMsg = m;
  if (nearBottom || m.from === me.id) box.scrollTop = box.scrollHeight;
}

function msgBody(m) {
  const body = document.createElement('div');
  body.className = 'msg-body';
  if (m.replyTo) {
    const ref = document.createElement('button');
    ref.type = 'button';
    ref.className = 'reply-ref';
    ref.innerHTML = ICON.reply;
    const who = document.createElement('strong');
    who.textContent = m.replyTo.name;
    const what = document.createElement('span');
    what.textContent = m.replyTo.text || 'Anexo';
    ref.append(who, what);
    ref.onclick = () => jumpTo(m.replyTo.id);
    body.append(ref);
  }
  if (m.deleted) {
    const t = document.createElement('div');
    t.className = 'msg-text deleted';
    t.textContent = 'Mensagem apagada';
    body.append(t);
    return body;
  }
  if (m.file) body.append(mediaEl(m.file));
  if (m.text) {
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.innerHTML = richText(m.text);
    if (m.edited) {
      const e = document.createElement('span');
      e.className = 'edited';
      e.textContent = ' (editada)';
      e.title = new Date(m.edited).toLocaleString();
      text.append(e);
    }
    body.append(text);
  }
  const reactions = m.reactions ? Object.entries(m.reactions) : [];
  if (reactions.length) {
    const row = document.createElement('div');
    row.className = 'reactions';
    for (const [emoji, ids] of reactions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction';
      const mine = ids.includes(me.id);
      chip.classList.toggle('mine', mine);
      chip.textContent = `${emoji} ${ids.length}`;
      chip.title = ids.map(nameOf).join(', ');
      chip.onclick = async () => updateMessage(await api.reactChat(m.id, emoji, !mine));
      row.append(chip);
    }
    body.append(row);
  }
  return body;
}

/** Botões que aparecem ao passar o mouse: reagir, responder, editar, apagar. */
function msgTools(m) {
  const bar = document.createElement('div');
  bar.className = 'msg-tools';
  if (m.deleted) return bar;
  const add = (icon, title, fn, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon;
    if (cls) b.classList.add(cls);
    b.onclick = (e) => { e.stopPropagation(); fn(b); };
    bar.append(b);
  };
  add(ICON.smile, 'Reagir', (b) => openReactionPicker(b, m.id));
  add(ICON.reply, 'Responder', () => startReply(m.id));
  if (m.from === me.id) {
    if (m.text || m.file) add(ICON.edit, 'Editar', () => startEdit(m.id));
    add(ICON.trash, 'Apagar', (b) => confirmDelete(b, m.id), 'danger');
  }
  return bar;
}

function openReactionPicker(anchor, id) {
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  for (const emoji of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.onclick = async () => {
      closePopover();
      const m = msgById.get(id);
      const on = !(m && m.reactions && (m.reactions[emoji] || []).includes(me.id));
      updateMessage(await api.reactChat(id, emoji, on));
    };
    grid.append(b);
  }
  openPopover(anchor, grid);
}

function confirmDelete(btn, id) {
  if (btn.classList.contains('confirm')) {
    api.deleteChat(id).then(updateMessage);
    return;
  }
  btn.classList.add('confirm');
  btn.title = 'Clique de novo para apagar';
  setTimeout(() => { btn.classList.remove('confirm'); btn.title = 'Apagar'; }, 3000);
}

function jumpTo(id) {
  const el = document.querySelector(`#messages [data-id="${CSS.escape(id)}"]`);
  if (!el) { toast('Essa mensagem é antiga demais para aparecer aqui.'); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// --- responder e editar
function startReply(id) {
  const m = msgById.get(id);
  if (!m) return;
  if (editing) cancelCompose();
  replyTo = { id: m.id, name: m.name, text: preview(m).slice(0, 140) };
  renderComposerBar();
  $('#composer-input').focus();
}

function startEdit(id) {
  const m = msgById.get(id);
  if (!m || m.deleted || m.from !== me.id) return;
  replyTo = null;
  editing = m;
  const input = $('#composer-input');
  input.value = m.text || '';
  autosize();
  renderComposerBar();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function cancelCompose() {
  if (editing) { $('#composer-input').value = ''; autosize(); }
  editing = null;
  replyTo = null;
  renderComposerBar();
}

function renderComposerBar() {
  const bar = $('#composer-bar');
  bar.hidden = !replyTo && !editing;
  if (bar.hidden) return;
  $('#composer-bar-icon').innerHTML = editing ? ICON.edit : ICON.reply;
  $('#composer-bar-text').textContent = editing ? 'Editando mensagem' : `Respondendo a ${replyTo.name}`;
  $('#composer-bar-sub').textContent = editing ? 'Enter salva · Esc cancela' : replyTo.text;
}

async function sendChat() {
  const input = $('#composer-input');
  const text = input.value.trim();
  hideMentions();
  if (editing) {
    const { id, text: before } = editing;
    cancelCompose();
    input.value = '';
    autosize();
    if (text && text !== before) updateMessage(await api.editChat(id, text));
    return;
  }
  if (!text) return;
  input.value = '';
  autosize();
  const reply = replyTo;
  replyTo = null;
  renderComposerBar();
  const m = await api.sendChat({ text, channel: currentText, replyTo: reply });
  if (m) receiveMessage(m);
}

function autosize() {
  const t = $('#composer-input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}

// --- "digitando…"
let lastTypingSent = 0;
function onComposerInput() {
  autosize();
  updateMentions();
  const input = $('#composer-input');
  if (input.value.trim() && !editing && Date.now() - lastTypingSent > 3000) {
    lastTypingSent = Date.now();
    api.typing(currentText);
  }
}

function onTyping({ from, channel }) {
  const key = `${channel}|${from}`;
  clearTimeout(typingTimers.get(key));
  typingTimers.set(key, setTimeout(() => { typingTimers.delete(key); renderTyping(); }, 5000));
  renderTyping();
}

function clearTyping(channel, from) {
  const key = `${channel}|${from}`;
  clearTimeout(typingTimers.get(key));
  if (typingTimers.delete(key)) renderTyping();
}

function renderTyping() {
  const names = [...typingTimers.keys()].filter((k) => k.startsWith(`${currentText}|`)).map((k) => nameOf(k.split('|')[1]));
  const el = $('#typing');
  el.hidden = !names.length;
  $('#typing-text').textContent = names.length === 1 ? `${names[0]} está digitando…`
    : names.length === 2 ? `${names[0]} e ${names[1]} estão digitando…`
      : 'Várias pessoas estão digitando…';
}

// --- @menções: sugestões ao digitar @
let mentionState = null; // { start, items, index }

function updateMentions() {
  const input = $('#composer-input');
  const before = input.value.slice(0, input.selectionStart);
  const m = /(^|\s)@([^\s@]{0,24})$/.exec(before);
  if (!m) return hideMentions();
  const q = m[2].toLowerCase();
  const items = [...new Set([...peers.map((p) => p.name), 'todos'])]
    .filter((n) => n.toLowerCase().startsWith(q)).slice(0, 6);
  if (!items.length) return hideMentions();
  mentionState = { start: input.selectionStart - m[2].length - 1, items, index: 0 };
  renderMentions();
}

function renderMentions() {
  const box = $('#mentions');
  box.hidden = !mentionState;
  if (!mentionState) return;
  box.textContent = '';
  mentionState.items.forEach((name, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = i === mentionState.index ? 'active' : '';
    const p = peers.find((x) => x.name === name);
    if (p) b.append(avatar(p.id, p.name));
    else b.insertAdjacentHTML('beforeend', '<span class="avatar all">@</span>');
    const span = document.createElement('span');
    span.textContent = name === 'todos' ? 'todos (avisa todo mundo)' : name;
    b.append(span);
    b.onmousedown = (e) => { e.preventDefault(); pickMention(i); };
    box.append(b);
  });
}

function hideMentions() {
  mentionState = null;
  $('#mentions').hidden = true;
}

function pickMention(i) {
  const input = $('#composer-input');
  const name = mentionState.items[i];
  const end = input.selectionStart;
  input.value = `${input.value.slice(0, mentionState.start)}@${name} ${input.value.slice(end)}`;
  const pos = mentionState.start + name.length + 2;
  input.setSelectionRange(pos, pos);
  hideMentions();
  autosize();
}

function onComposerKey(e) {
  if (mentionState) {
    const n = mentionState.items.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.index = (mentionState.index + 1) % n; return renderMentions(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.index = (mentionState.index + n - 1) % n; return renderMentions(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(mentionState.index); }
    if (e.key === 'Escape') { e.preventDefault(); return hideMentions(); }
  }
  if (e.key === 'Escape' && (editing || replyTo)) { e.preventDefault(); cancelCompose(); return; }
  // Seta para cima com a caixa vazia: edita sua última mensagem
  if (e.key === 'ArrowUp' && !e.target.value) {
    const mine = allMessages.filter((m) => m.channel === currentText && m.from === me.id && !m.deleted && m.text).pop();
    if (mine) { e.preventDefault(); startEdit(mine.id); }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
}

// ------------------------------------------------------------------ anexos (qualquer arquivo)
const MAX_FILE = 500 * 1024 * 1024;
const fileMeta = new Map(); // id -> anexo (com .local)

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function mediaEl(f) {
  fileMeta.set(f.id, { ...(fileMeta.get(f.id) || {}), ...f });
  const box = document.createElement('div');
  box.className = 'msg-media';
  box.dataset.fileId = f.id;
  fillMedia(box);
  return box;
}

function keepBottom(fn) {
  const list = $('#messages');
  const near = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
  fn();
  if (near) list.scrollTop = list.scrollHeight;
}

function fillMedia(box) {
  const f = fileMeta.get(box.dataset.fileId);
  const viewable = VIEWABLE.has(f.mime);
  const video = viewable && f.mime.startsWith('video/');
  box.innerHTML = '';
  box.classList.toggle('pending', !f.local);
  box.classList.toggle('file', !viewable);
  if (!f.local) {
    box.innerHTML = '<div class="media-wait"><span class="media-icon"></span><div class="media-info"><strong></strong><small></small><div class="bar"><i></i></div></div></div>';
    box.querySelector('.media-icon').innerHTML = video ? ICON.film : viewable ? ICON.photo : ICON.file;
    box.querySelector('strong').textContent = f.name;
    box.querySelector('small').textContent = `Recebendo · ${fmtSize(f.size)}`;
    return;
  }
  if (!viewable) {
    // Arquivo comum: cartão com Abrir e Mostrar na pasta
    box.innerHTML = '<div class="file-card"><span class="media-icon"></span><div class="media-info"><strong></strong><small></small></div><div class="file-actions"><button type="button" class="pill-btn small" data-act="open">Abrir</button><button type="button" class="pill-btn small" data-act="reveal">Mostrar</button></div></div>';
    box.querySelector('.media-icon').innerHTML = ICON.file;
    box.querySelector('strong').textContent = f.name;
    box.querySelector('small').textContent = fmtSize(f.size);
    box.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        try { await api.openMedia(f.id, b.dataset.act === 'reveal'); } catch (err) { toast(`Não deu para abrir: ${String(err.message || err).replace(/^.*Error: /, '')}`); }
      };
    });
  } else {
    const src = `ponte-media://file/${f.id}`;
    if (video) {
      const v = document.createElement('video');
      v.src = src;
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      v.onloadedmetadata = () => keepBottom(() => {});
      box.append(v);
    } else {
      const img = new Image();
      img.alt = f.name;
      img.title = 'Clique para ampliar';
      img.onload = () => keepBottom(() => {});
      img.onclick = () => openLightbox(src, f.name);
      img.src = src;
      box.append(img);
    }
  }
  const up = document.createElement('div');
  up.className = 'media-up';
  up.hidden = true;
  box.append(up);
}

function onMediaReady({ id }) {
  const f = fileMeta.get(id);
  if (!f) return;
  f.local = true;
  for (const m of allMessages) if (m.file && m.file.id === id) m.file.local = true;
  keepBottom(() => document.querySelectorAll(`.msg-media[data-file-id="${id}"]`).forEach(fillMedia));
}

function onMediaProgress({ id, done, size, dir }) {
  const pct = Math.min(100, Math.round((done / size) * 100));
  document.querySelectorAll(`.msg-media[data-file-id="${id}"]`).forEach((box) => {
    if (dir === 'down') {
      const bar = box.querySelector('.bar i');
      if (bar) bar.style.width = `${pct}%`;
      const small = box.querySelector('small');
      if (small) small.textContent = `Recebendo · ${pct}% de ${fmtSize(size)}`;
    } else {
      const up = box.querySelector('.media-up');
      if (!up) return;
      up.hidden = pct >= 100;
      up.textContent = `Enviando ${pct}%`;
    }
  });
}

function openLightbox(src, name) {
  const img = $('#lightbox-img');
  img.src = src;
  img.alt = name;
  $('#dlg-media').showModal();
}

async function sendFiles(list) {
  for (const file of list) {
    if (file.size > MAX_FILE) { toast(`${file.name} passa de 500 MB.`); continue; }
    const req = { name: file.name, mime: file.type, path: api.pathForFile(file), channel: currentText };
    if (replyTo) { req.replyTo = replyTo; replyTo = null; renderComposerBar(); }
    if (!req.path) {
      // Imagem colada (Ctrl+V) não tem arquivo no disco: manda os bytes.
      if (file.size > 50 * 1024 * 1024) { toast('Arquivo colado muito grande; envie pelo botão +.'); continue; }
      req.bytes = new Uint8Array(await file.arrayBuffer());
      if (!req.name) req.name = `imagem-${Date.now()}.png`;
    }
    try {
      const m = await api.sendMedia(req);
      if (m) receiveMessage(m);
    } catch (err) {
      toast(`Não deu para enviar: ${String(err.message || err).replace(/^.*Error: /, '')}`);
    }
  }
}

function bindFiles() {
  const input = $('#file-input');
  $('#btn-attach').onclick = () => input.click();
  input.onchange = () => { sendFiles([...input.files]); input.value = ''; };
  $('#composer-input').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); sendFiles(files); }
  });
  // Arrastar e soltar na conversa
  const chatView = $('#view-chat');
  const hint = $('#drop-hint');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  chatView.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth += 1; hint.hidden = false; });
  chatView.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hint.hidden = true; });
  chatView.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  chatView.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    sendFiles([...(e.dataTransfer?.files || [])]);
  });
  // Soltar fora da conversa não pode abrir o arquivo na janela
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('#dlg-media').addEventListener('click', (e) => { if (e.target.id === 'lightbox-img') $('#dlg-media').close(); });
  $('#dlg-media').addEventListener('close', () => { $('#lightbox-img').removeAttribute('src'); });
  api.onMediaReady(onMediaReady);
  api.onMediaProgress(onMediaProgress);
}

// ------------------------------------------------------------------ canais de texto
function renderHistory() {
  const box = $('#messages');
  box.innerHTML = '';
  lastMsg = null;
  const list = allMessages.filter((m) => m.channel === currentText);
  if (!list.length) {
    box.innerHTML = '<div class="empty-chat"><h2></h2><p>Tudo que for escrito aqui vai direto para os computadores da rede, sem passar por servidor nenhum.</p></div>';
    box.querySelector('h2').textContent = `Bem-vindo a #${textName(currentText)}`;
  }
  for (const m of list) appendMessage(m);
  box.scrollTop = box.scrollHeight;
  renderTyping();
}

function openText(id) {
  if (currentText !== id) {
    currentText = id;
    cancelCompose();
    hideMentions();
    renderHistory();
  }
  unreadBy.delete(id);
  setView('chat');
}

async function newChannel(kind) {
  const name = await promptDialog({
    title: kind === 'voice' ? 'Nova sala de voz' : 'Novo canal de texto',
    placeholder: kind === 'voice' ? 'Ex.: Squad' : 'Ex.: jogos',
  });
  if (!name) return;
  try {
    const before = new Set(channels.map((c) => c.id));
    channels = await api.createChannel(kind, kind === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name);
    const created = channels.find((c) => !before.has(c.id));
    if (created && kind === 'text') openText(created.id);
    else if (created) joinVoice(created.id);
    else render();
  } catch (err) {
    toast(String(err.message || err).replace(/^.*Error: /, ''));
  }
}

function channelMenu(e, c) {
  if (c.fixed) { e.preventDefault(); return; }
  openMenu(e, [
    { label: 'Renomear', action: async () => {
      const name = await promptDialog({ title: 'Renomear', value: c.name, ok: 'Salvar' });
      if (name) { try { channels = await api.renameChannel(c.id, name); render(); } catch (err) { toast(String(err.message || err).replace(/^.*Error: /, '')); } }
    } },
    { label: c.kind === 'voice' ? 'Apagar sala' : 'Apagar canal', danger: true, action: async () => {
      try { onChannels(await api.deleteChannel(c.id)); } catch (err) { toast(String(err.message || err).replace(/^.*Error: /, '')); }
    } },
  ]);
}

function onChannels(list) {
  channels = list;
  if (!channels.find((c) => c.id === currentText)) openText('geral');
  if (local.voice && !channels.find((c) => c.id === local.room)) leaveVoice();
  if (view === 'chat') setView('chat');
  render();
}

// ------------------------------------------------------------------ render
let playingMe = '';

function setView(v) {
  view = v;
  $('#view-chat').hidden = v !== 'chat';
  $('#view-voice').hidden = v !== 'voice';
  if (v === 'chat') {
    const name = textName(currentText);
    $('#view-title').textContent = `#${name}`;
    $('#view-sub').textContent = 'As mensagens ficam só nos computadores de vocês';
    $('#composer-input').placeholder = `Mensagem em #${name}`;
    unreadBy.delete(currentText);
    setTimeout(() => $('#composer-input').focus(), 0);
  } else {
    $('#view-title').textContent = local.voice ? roomName(local.room) : 'Sala de voz';
    $('#view-sub').textContent = 'Áudio e vídeo vão direto de um computador para o outro';
    wakeUi();
  }
  render();
}

function rowButton({ icon, color, name, active, badge, count }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `row${active ? ' active' : ''}`;
  b.innerHTML = `<span class="sq ${color}">${icon}</span><span class="row-label"></span>`;
  b.querySelector('.row-label').textContent = name;
  if (badge) {
    const s = document.createElement('span');
    s.className = 'badge';
    s.textContent = badge > 99 ? '99+' : String(badge);
    b.append(s);
  } else if (count) {
    const s = document.createElement('span');
    s.className = 'row-count';
    s.textContent = String(count);
    b.append(s);
  }
  b.insertAdjacentHTML('beforeend', '<svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>');
  return b;
}

/** Texto curto de status de alguém (jogo ou sala). */
function statusLine(p) {
  if (p.state.playing) return `🎮 ${p.state.playing}`;
  return '';
}

function renderSidebar() {
  const texts = $('#text-channels');
  texts.textContent = '';
  for (const c of channels.filter((x) => x.kind === 'text')) {
    const b = rowButton({ icon: ICON.hash, color: 'blue', name: c.name, active: view === 'chat' && currentText === c.id, badge: unreadBy.get(c.id) });
    b.onclick = () => openText(c.id);
    b.oncontextmenu = (e) => channelMenu(e, c);
    texts.append(b);
  }
  const rooms = $('#voice-rooms');
  rooms.textContent = '';
  for (const c of channels.filter((x) => x.kind === 'voice')) {
    const mine = local.voice && local.room === c.id;
    const members = [
      ...(mine ? [{ id: me.id, name: me.name, state: { ...local, playing: playingMe } }] : []),
      ...peersInRoom(c.id),
    ];
    const b = rowButton({ icon: ICON.voice, color: 'green', name: c.name, active: view === 'voice' && mine, count: members.length });
    b.onclick = () => (mine ? setView('voice') : joinVoice(c.id));
    b.oncontextmenu = (e) => channelMenu(e, c);
    rooms.append(b);
    if (!members.length) continue;
    const ul = document.createElement('ul');
    ul.className = 'voice-members';
    for (const p of members) {
      const li = document.createElement('li');
      li.append(avatar(p.id, p.name));
      const txt = document.createElement('div');
      txt.className = 'vm-text';
      const n = document.createElement('span');
      n.textContent = p.name;
      txt.append(n);
      const st = statusLine(p);
      if (st) {
        const small = document.createElement('small');
        small.textContent = st;
        txt.append(small);
      }
      li.append(txt);
      const flags = document.createElement('span');
      flags.className = 'flags';
      if (p.state.sharing) flags.insertAdjacentHTML('beforeend', '<span class="live-tag">AO VIVO</span>');
      if (p.state.cam) flags.insertAdjacentHTML('beforeend', ICON.cam);
      if (p.state.deafened) flags.insertAdjacentHTML('beforeend', ICON.deaf);
      else if (p.state.muted) flags.insertAdjacentHTML('beforeend', ICON.micOff);
      li.append(flags);
      ul.append(li);
    }
    rooms.append(ul);
  }
}

function render() {
  if (!me) return;
  // eu
  $('#me-name').textContent = me.name;
  $('#me-status').textContent = local.voice
    ? (local.sharing ? 'ao vivo' : (voiceMode() === 'ptt' ? `apertar ${pttKey().label} para falar` : roomName(local.room)))
    : (playingMe ? `🎮 ${playingMe}` : 'online');
  const myAv = $('#me-avatar');
  myAv.style.background = colorFor(me.id);
  myAv.textContent = initials(me.name);
  myAv.dataset.speak = me.id;
  const radmin = me.interfaces.find((i) => i.radmin);
  $('#my-ip').textContent = radmin ? `Radmin ${radmin.address}` : (me.interfaces[0]?.address || 'sem rede');

  for (const sel of ['#btn-mute', '#ctl-mute']) $(sel).classList.toggle('active', local.muted || local.deafened);
  for (const sel of ['#btn-deafen', '#ctl-deafen']) $(sel).classList.toggle('active', local.deafened);
  $('#ctl-share').classList.toggle('on', local.sharing);
  $('#ctl-share-label').textContent = local.sharing ? 'Parar transmissão' : 'Compartilhar tela';
  $('#btn-share-side').classList.toggle('on', local.sharing);
  $('#ctl-cam').classList.toggle('on', !!camStream);
  $('#ctl-cam').title = camStream ? 'Desligar câmera' : 'Ligar câmera';

  // painel de voz
  $('#voice-panel').hidden = !local.voice;
  const inVoice = voicePeers().length + (local.voice ? 1 : 0);
  $('#voice-detail').textContent = local.voice ? `${roomName(local.room)} · ${inVoice} na sala` : '';
  $('#stage-empty').hidden = local.voice;
  $('#controls').hidden = !local.voice;
  $('#stage').hidden = !local.voice;

  renderSidebar();

  // membros online
  const ml = $('#member-list');
  ml.innerHTML = '';
  const all = [{ id: me.id, name: me.name, address: 'você', state: { ...local, playing: playingMe } }, ...peers];
  for (const p of all) {
    const li = document.createElement('li');
    li.append(avatar(p.id, p.name));
    const info = document.createElement('div');
    info.className = 'member-info';
    info.innerHTML = '<strong></strong><small></small>';
    info.querySelector('strong').textContent = p.name;
    const addr = p.id === me.id ? 'você' : (me.demo ? `26.${31 + p.name.length * 7}.${p.name.charCodeAt(0)}.${45 + p.name.length}` : p.address);
    info.querySelector('small').textContent = p.state.playing ? `🎮 Jogando ${p.state.playing}` : addr;
    li.append(info);
    const flags = document.createElement('div');
    flags.className = 'member-flags';
    const tag = document.createElement('span');
    if (p.state.sharing) { tag.className = 'pill-tag live'; tag.textContent = 'Ao vivo'; }
    else if (p.state.voice) { tag.className = 'pill-tag voice'; tag.textContent = 'Na voz'; tag.title = roomName(roomOf(p.state)); }
    if (tag.textContent) flags.append(tag);
    if (p.id !== me.id) flags.append(netBars(p.id));
    li.append(flags);
    ml.append(li);
  }
  $('#online-count').textContent = String(all.length);
  $('#members-btn-count').textContent = String(all.length);
  $('#searching').hidden = peers.length > 0;

  document.querySelectorAll('[data-speak]').forEach((el) => el.classList.toggle('speaking', speaking.has(el.dataset.speak)));
  renderStage();
  pushOverlay();
}

/** Mantém os blocos do palco sem recriar os vídeos a cada atualização. */
const tiles = new Map();
function renderStage() {
  if (!me) return;
  const stage = $('#stage');
  const wanted = [];
  if (local.voice) {
    if (local.sharing && screenStream) wanted.push({ key: `screen:${me.id}`, kind: 'screen', id: me.id, name: `${me.name} (você)`, stream: screenStream, mine: true, quality: local.quality });
    for (const p of voicePeers()) {
      if (p.state.sharing) wanted.push({ key: `screen:${p.id}`, kind: 'screen', id: p.id, name: p.name, stream: remoteScreen(p.id), quality: p.state.quality });
    }
    wanted.push({ key: `user:${me.id}`, kind: 'user', id: me.id, name: me.name, state: local, mine: true, cam: camStream });
    for (const p of voicePeers()) wanted.push({ key: `user:${p.id}`, kind: 'user', id: p.id, name: p.name, state: p.state, cam: remoteCam(p.id) });
  }
  if (focusedTile && !wanted.find((w) => w.key === focusedTile)) focusedTile = null;

  const keys = new Set(wanted.map((w) => w.key));
  for (const [key, el] of tiles) if (!keys.has(key)) { el.remove(); tiles.delete(key); }

  for (const w of wanted) {
    let el = tiles.get(w.key);
    if (!el) {
      el = document.createElement('div');
      el.className = `tile ${w.kind}`;
      el.style.setProperty('--c', colorFor(w.id));
      if (w.kind === 'user') {
        el.dataset.speak = w.id;
        const cam = document.createElement('video');
        cam.className = 'cam';
        cam.autoplay = true;
        cam.muted = true;
        cam.playsInline = true;
        cam.hidden = true;
        if (w.mine) cam.classList.add('mirror');
        el.append(cam, avatar(w.id, w.name));
        if (!w.mine) {
          const vol = document.createElement('input');
          vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.05';
          vol.className = 'vol';
          vol.title = 'Volume';
          vol.value = String(volumeFor(w.id));
          vol.oninput = () => setVolume(w.id, Number(vol.value));
          el.append(vol);
        }
      } else {
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        el.append(video);
        const waiting = document.createElement('div');
        waiting.className = 'waiting';
        waiting.textContent = 'Conectando à transmissão…';
        el.append(waiting);
        el.onclick = () => {
          if (document.fullscreenElement) return;
          focusedTile = focusedTile === w.key ? null : w.key;
          renderStage();
        };
        // Botões do canto: janela flutuante e tela cheia
        const tools = document.createElement('div');
        tools.className = 'tile-tools';
        const pip = document.createElement('button');
        pip.type = 'button';
        pip.className = 'fs-btn pip-btn';
        pip.title = 'Janela flutuante (fica por cima enquanto você joga)';
        pip.setAttribute('aria-label', 'Janela flutuante');
        pip.innerHTML = ICON.pip;
        pip.onclick = (e) => { e.stopPropagation(); togglePip(video); };
        const fs = document.createElement('button');
        fs.type = 'button';
        fs.className = 'fs-btn';
        fs.title = 'Tela cheia (Esc para sair)';
        fs.setAttribute('aria-label', 'Tela cheia');
        fs.innerHTML = ICON.expand + ICON.shrink;
        fs.onclick = (e) => { e.stopPropagation(); toggleFullscreen(el); };
        tools.append(pip, fs);
        for (const ev of ['dblclick', 'pointerdown']) tools.addEventListener(ev, (e) => e.stopPropagation());
        el.append(tools);
        if (!w.mine) {
          const sv = document.createElement('div');
          sv.className = 'svol';
          sv.innerHTML = '<button type="button" class="svol-btn"></button><input type="range" min="0" max="1" step="0.05" aria-label="Volume da transmissão">';
          const btn = sv.querySelector('button');
          const range = sv.querySelector('input');
          btn.onclick = () => toggleStreamMute(w.id);
          range.oninput = () => setStreamVolume(w.id, Number(range.value));
          for (const ev of ['click', 'dblclick', 'pointerdown']) sv.addEventListener(ev, (e) => e.stopPropagation());
          el.append(sv);
        }
        el.ondblclick = () => toggleFullscreen(el);
      }
      const label = document.createElement('div');
      label.className = 'label';
      el.append(label);
      tiles.set(w.key, el);
    }
    const label = el.querySelector('.label');
    if (w.kind === 'user') {
      label.innerHTML = '';
      if (w.state.deafened) label.insertAdjacentHTML('beforeend', ICON.deaf);
      else if (w.state.muted) label.insertAdjacentHTML('beforeend', ICON.micOff);
      label.append(document.createTextNode(w.name));
      if (!w.mine) label.append(netBars(w.id));
      const cam = el.querySelector('video.cam');
      if (cam.srcObject !== (w.cam || null)) cam.srcObject = w.cam || null;
      cam.hidden = !w.cam;
      el.classList.toggle('has-cam', !!w.cam);
      el.classList.toggle('speaking', speaking.has(w.id));
    } else {
      label.innerHTML = '<span class="live-tag">AO VIVO</span>';
      label.append(document.createTextNode(` ${w.name}`));
      if (w.quality) {
        const tag = document.createElement('span');
        tag.className = 'res-tag';
        tag.textContent = w.quality;
        label.append(tag);
      }
      const video = el.querySelector('video');
      if (video.srcObject !== (w.stream || null)) video.srcObject = w.stream || null;
      el.querySelector('.waiting').hidden = !!w.stream;
      const sv = el.querySelector('.svol');
      if (sv) {
        const hasAudio = !!(w.stream && w.stream.getAudioTracks().length);
        const muted = streamMuted(w.id) || streamVolume(w.id) === 0;
        sv.classList.toggle('no-audio', !hasAudio);
        const btn = sv.querySelector('button');
        btn.innerHTML = muted || !hasAudio ? ICON.speakerOff : ICON.speaker;
        btn.title = !hasAudio ? 'Esta transmissão não tem som' : (muted ? 'Ativar som da transmissão' : 'Silenciar transmissão');
        btn.disabled = !hasAudio;
        const range = sv.querySelector('input');
        range.disabled = !hasAudio;
        if (document.activeElement !== range) range.value = String(streamMuted(w.id) ? 0 : streamVolume(w.id));
        range.title = `Volume da transmissão: ${Math.round(Number(range.value) * 100)}%`;
      }
      video.hidden = !w.stream;
      el.classList.toggle('focused', focusedTile === w.key);
    }
    stage.append(el); // garante a ordem
  }
  stage.classList.toggle('has-focus', !!focusedTile);
  stage.classList.toggle('one-screen', !focusedTile && wanted.filter((w) => w.kind === 'screen').length === 1);

  // Clipes: grava a transmissão em foco, senão a primeira de um amigo, senão a sua.
  const screens = wanted.filter((w) => w.kind === 'screen' && w.stream);
  const pick = screens.find((w) => w.key === focusedTile) || screens.find((w) => !w.mine) || screens[0];
  // Só grava com a janela visível e a opção ligada: minimizada ou na bandeja, não gasta nada.
  const canClip = local.voice && pick && prefs.read('clips', true) && document.visibilityState === 'visible';
  Clips.arm(canClip ? pick.stream : null);
  $('#ctl-clip').hidden = !Clips.armed();
}

async function togglePip(video) {
  try {
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch (err) {
    toast(`Não deu para abrir a janela flutuante: ${err.message}`);
  }
}

// Overlay por cima do jogo: só aparece com você numa sala e a Ponte fora de foco.
let overlaySent = '';
function pushOverlay() {
  if (!me) return;
  const show = local.voice && prefs.read('overlay', true) && !document.hasFocus();
  const list = local.voice ? [{ id: me.id, name: me.name, state: local }, ...voicePeers()] : [];
  const members = list.map((p) => ({
    name: p.name,
    initials: initials(p.name),
    color: colorFor(p.id),
    speaking: speaking.has(p.id),
    muted: !!p.state.muted,
    deafened: !!p.state.deafened,
    sharing: !!p.state.sharing,
  }));
  const json = JSON.stringify([show, members]);
  if (json === overlaySent) return;
  overlaySent = json;
  api.overlayUpdate({ show, members });
}

async function saveClip() {
  if (!Clips.armed()) { toast('Não tem transmissão para clipar agora.'); return; }
  toast('Salvando clipe…', 2000);
  const r = await Clips.save();
  if (!r) { toast('O clipe ainda está começando. Tente de novo em alguns segundos.'); return; }
  const name = r.file.split(/[\\/]/).pop();
  toast(`Clipe de ${r.seconds} s salvo em Vídeos\\Ponte`, 8000, [
    { label: 'Mostrar', action: () => api.revealClip(r.file) },
    { label: 'Enviar no chat', action: async () => {
      try {
        const m = await api.sendMedia({ path: r.file, name, mime: r.mime, channel: currentText });
        if (m) receiveMessage(m);
      } catch (err) { toast(`Não deu para enviar: ${String(err.message || err).replace(/^.*Error: /, '')}`); }
    } },
  ]);
}

// ------------------------------------------------------------------ soundboard
async function openSoundboard(anchor) {
  try { await Soundboard.loadCustom(); } catch {}
  const box = document.createElement('div');
  box.className = 'soundboard';
  const head = document.createElement('div');
  head.className = 'sb-head';
  head.innerHTML = '<strong>Soundboard</strong>';
  const vol = document.createElement('input');
  vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.05';
  vol.value = String(prefs.read('sbVolume', 0.7));
  vol.title = 'Volume dos sons';
  vol.oninput = () => { prefs.write('sbVolume', Number(vol.value)); Mic.setSoundboardVolume(Number(vol.value)); };
  head.append(vol);
  const grid = document.createElement('div');
  grid.className = 'sb-grid';
  const item = (emoji, name, onClick, onMenu) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sb-item';
    const e = document.createElement('span');
    e.className = 'sb-emoji';
    e.textContent = emoji;
    const n = document.createElement('span');
    n.textContent = name;
    b.append(e, n);
    b.onclick = onClick;
    if (onMenu) b.oncontextmenu = onMenu;
    grid.append(b);
    return b;
  };
  for (const s of Soundboard.builtins) item(s.emoji, s.name, () => Soundboard.play(s.id));
  for (const s of Soundboard.custom()) {
    item('🎵', s.name, () => Soundboard.play(s.id), (e) => openMenu(e, [
      { label: `Remover "${s.name}"`, danger: true, action: async () => { await Soundboard.remove(s.id); openSoundboard(anchor); } },
    ]));
  }
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'audio/*';
  file.hidden = true;
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    try { await Soundboard.add(f); openSoundboard(anchor); } catch (err) { toast(String(err.message || err).replace(/^.*Error: /, '')); }
  };
  const add = item('＋', 'Adicionar som', () => file.click());
  add.classList.add('sb-add');
  const tip = document.createElement('small');
  tip.className = 'sb-tip';
  tip.textContent = 'Todo mundo na sala ouve. Botão direito num som seu para remover.';
  box.append(head, grid, file, tip);
  openPopover(anchor, box);
}

// Com o mouse parado por 2,5 s, os controles da sala somem (como no Discord).
let idleTimer = null;
function wakeUi() {
  const view = $('#view-voice');
  view.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Não some enquanto o mouse estiver em cima de um controle.
    if (view.querySelector('.controls:hover, .svol:hover, .fs-btn:hover, .vol:hover, .tile-tools:hover') || document.querySelector('.popover')) wakeUi();
    else view.classList.add('idle');
  }, 2500);
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen().catch((err) => toast(`Não deu para abrir em tela cheia: ${err.message}`));
}

// ------------------------------------------------------------------ atualizações
let update = { state: 'idle', version: '', next: '', percent: 0, error: '' };

const UPDATE_TEXT = {
  disabled: 'Atualização automática só no app instalado.',
  idle: 'Procura sozinha ao abrir e a cada 30 minutos.',
  checking: 'Procurando atualizações…',
  latest: 'Você está na versão mais recente.',
  error: 'Não deu para procurar agora. Confira a internet.',
};

function renderUpdate() {
  const btn = $('#set-update-btn');
  if (!btn) return;
  $('#set-update-version').textContent = `Ponte ${update.version || me.version || ''}`.trim();
  let text = UPDATE_TEXT[update.state] || UPDATE_TEXT.idle;
  if (update.state === 'downloading') text = `Baixando a versão ${update.next}… ${update.percent}%`;
  if (update.state === 'ready') text = `Versão ${update.next} baixada. Instala ao reiniciar.`;
  $('#set-update-text').textContent = text;
  btn.textContent = update.state === 'ready' ? 'Reiniciar e atualizar' : 'Procurar';
  btn.classList.toggle('primary', update.state === 'ready');
  btn.disabled = ['disabled', 'checking', 'downloading'].includes(update.state);
}

function onUpdate(s) {
  const wasReady = update.state === 'ready';
  update = s;
  renderUpdate();
  if (s.state === 'ready' && !wasReady) toast(`A versão ${s.next} foi baixada. Ela se instala quando você reiniciar a Ponte (Ajustes ou ícone perto do relógio).`, 7000);
}

function onTrayCmd(cmd) {
  if (cmd === 'mute') toggleMute();
  else if (cmd === 'deafen') toggleDeafen();
  else if (cmd === 'join') { if (!local.voice) joinVoice(); }
  else if (cmd === 'leave') { if (local.voice) leaveVoice(); }
  else if (cmd === 'stop-share') { if (local.sharing) stopScreen(); }
  else if (cmd === 'settings') { if (!$('#dlg-settings').open) openSettings(); }
}

// ------------------------------------------------------------------ configurações
let pendingPtt = null; // tecla escolhida no diálogo, antes de salvar

async function openSettings() {
  renderUpdate();
  $('#set-name').value = me.name;
  $('#set-sounds').checked = prefs.read('sounds', true);
  $('#set-glass').checked = prefs.read('glass', true);
  $('#set-motion').checked = prefs.read('motion', true);
  $('#set-ai').checked = prefs.read('aiNoise', true);
  $('#set-overlay').checked = prefs.read('overlay', true);
  $('#set-clips').checked = prefs.read('clips', true);
  pendingPtt = pttKey();
  setVoiceModeUi(voiceMode());
  $('#set-ptt-key').textContent = pendingPtt.label;
  renderIps();
  $('#set-log').textContent = logLines.slice(-60).join('\n') || 'Sem eventos ainda.';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillSelect('#set-mic', devices.filter((d) => d.kind === 'audioinput'), prefs.read('micDevice', ''));
    fillSelect('#set-out', devices.filter((d) => d.kind === 'audiooutput'), prefs.read('outDevice', ''));
  } catch {}
  $('#dlg-settings').showModal();
}

function setVoiceModeUi(mode) {
  document.querySelectorAll('#set-voice-mode .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('#set-ptt-row').hidden = mode !== 'ptt';
  $('#set-voice-mode').dataset.mode = mode;
}

/** Espera a próxima tecla ou botão do mouse (lateral/meio) para o "apertar para falar". */
function capturePttKey() {
  const btn = $('#set-ptt-key');
  btn.textContent = 'Aperte uma tecla…';
  btn.classList.add('capturing');
  const done = (key) => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
    btn.classList.remove('capturing');
    if (key) pendingPtt = key;
    btn.textContent = pendingPtt.label;
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return done(null);
    const label = e.code === 'Space' ? 'Espaço' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    done({ vk: e.keyCode, label });
  };
  const onMouse = (e) => {
    const map = { 1: { vk: 4, label: 'Botão do meio' }, 3: { vk: 5, label: 'Mouse 4' }, 4: { vk: 6, label: 'Mouse 5' } };
    if (!map[e.button]) return;
    e.preventDefault();
    e.stopPropagation();
    done(map[e.button]);
  };
  setTimeout(() => {
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
  }, 0);
}

function fillSelect(sel, devices, current) {
  const s = $(sel);
  s.innerHTML = '<option value="">Padrão do sistema</option>';
  devices.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Dispositivo ${i + 1}`;
    s.append(o);
  });
  s.value = current;
  if (s.value !== current) s.value = '';
}

function renderIps() {
  const ips = $('#set-ips');
  ips.innerHTML = '';
  for (const i of me.interfaces) {
    const li = document.createElement('li');
    li.className = i.radmin ? 'radmin' : '';
    li.innerHTML = '<span></span><em></em>';
    li.querySelector('span').textContent = i.address;
    li.querySelector('em').textContent = i.radmin ? 'Radmin VPN' : i.name;
    ips.append(li);
  }
  const hosts = $('#set-hosts');
  hosts.innerHTML = '';
  for (const h of me.manualHosts) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><button type="button" title="Remover">✕</button>';
    li.querySelector('span').textContent = h;
    li.querySelector('button').onclick = async () => { me = { ...me, ...(await api.removeHost(h)) }; renderIps(); };
    hosts.append(li);
  }
}

async function addHost() {
  const input = $('#set-host');
  const ip = input.value.trim();
  if (!ip) return;
  try {
    me = { ...me, ...(await api.addHost(ip)) };
    input.value = '';
    renderIps();
    toast(`Procurando a Ponte em ${ip}…`);
  } catch {
    toast('Esse IP não parece válido. Use o formato 26.12.34.56');
  }
}

async function saveSettings() {
  const name = $('#set-name').value.trim();
  if (name && name !== me.name) me = { ...me, ...(await api.setName(name)) };
  prefs.write('sounds', $('#set-sounds').checked);
  prefs.write('glass', $('#set-glass').checked);
  prefs.write('motion', $('#set-motion').checked);
  prefs.write('overlay', $('#set-overlay').checked);
  prefs.write('clips', $('#set-clips').checked);
  prefs.write('voiceMode', $('#set-voice-mode').dataset.mode || 'auto');
  if (pendingPtt) prefs.write('pttKey', pendingPtt);
  applyGlass();
  applyPtt();
  const out = $('#set-out').value;
  prefs.write('outDevice', out);
  for (const r of remotes.values()) for (const el of r.audios.values()) if (el.setSinkId) el.setSinkId(out).catch(() => {});
  const mic = $('#set-mic').value;
  const ai = $('#set-ai').checked;
  const micChanged = mic !== prefs.read('micDevice', '');
  const aiChanged = ai !== prefs.read('aiNoise', true);
  prefs.write('micDevice', mic);
  prefs.write('aiNoise', ai);
  if (local.voice && (micChanged || aiChanged)) await switchMic();
  render();
}

/** Pega o microfone de novo (outro aparelho ou IA ligada/desligada). A sala nem percebe. */
async function switchMic() {
  try {
    const raw = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
    await Mic.setInput(raw);
    applyMute();
  } catch (err) {
    toast(`Não foi possível trocar o microfone: ${err.message}`);
  }
}

function applyGlass() {
  document.documentElement.classList.toggle('no-glass', !prefs.read('glass', true));
  document.documentElement.classList.toggle('no-motion', !prefs.read('motion', true));
}

// ------------------------------------------------------------------ eventos
function onHotkey(cmd) {
  if (cmd === 'mute') toggleMute();
  else if (cmd === 'deafen') toggleDeafen();
  else if (cmd === 'clip') saveClip();
}

function bind() {
  document.querySelectorAll('.add-btn').forEach((b) => { b.onclick = () => newChannel(b.dataset.kind); });
  $('#btn-join').onclick = () => joinVoice(local.room || 'sala');
  $('#btn-mute').onclick = toggleMute;
  $('#ctl-mute').onclick = toggleMute;
  $('#btn-deafen').onclick = toggleDeafen;
  $('#ctl-deafen').onclick = toggleDeafen;
  $('#ctl-share').onclick = openScreenPicker;
  $('#btn-share-side').onclick = openScreenPicker;
  $('#ctl-cam').onclick = toggleCam;
  $('#ctl-sound').onclick = (e) => openSoundboard(e.currentTarget);
  $('#ctl-clip').onclick = saveClip;
  $('#ctl-leave').onclick = () => leaveVoice();
  $('#btn-leave-side').onclick = () => leaveVoice();
  $('#btn-settings').onclick = openSettings;
  $('#me-name-btn').onclick = openSettings;
  $('#btn-add-ip').onclick = async () => { await openSettings(); $('#set-host').focus(); };
  $('#set-host-add').onclick = addHost;
  $('#set-ptt-key').onclick = capturePttKey;
  document.querySelectorAll('#set-voice-mode .tab').forEach((t) => { t.onclick = () => setVoiceModeUi(t.dataset.mode); });
  $('#set-update-btn').onclick = () => {
    if (update.state === 'ready') api.installUpdate();
    else { update = { ...update, state: 'checking' }; renderUpdate(); api.checkUpdate(); }
  };
  $('#set-host').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addHost(); } };
  $('#dlg-settings').addEventListener('close', () => {
    const dlg = $('#dlg-settings');
    const value = dlg.returnValue;
    dlg.returnValue = '';
    if (value === 'save') saveSettings();
  });

  document.querySelectorAll('#dlg-screen .tab').forEach((tab) => {
    tab.onclick = () => {
      sourceKind = tab.dataset.kind;
      document.querySelectorAll('#dlg-screen .tab').forEach((t) => t.classList.toggle('active', t === tab));
      renderSources();
    };
  });
  $('#dlg-screen').addEventListener('close', () => {
    const dlg = $('#dlg-screen');
    const value = dlg.returnValue;
    dlg.returnValue = '';
    if (value !== 'go' || !selectedSource) return;
    const res = Number($('#screen-res').value);
    const fps = Number($('#screen-fps').value);
    const audio = resolveAudioChoice($('#screen-audio-src').value, selectedSource);
    prefs.write('screenRes', res);
    prefs.write('screenFps', fps);
    startScreen(selectedSource, qualityFor(res, fps), audio);
  });
  $('#screen-audio-src').onchange = () => { audioTouched = true; updateAudioHint(); };
  $('#screen-res').onchange = updateQualityHint;
  $('#screen-fps').onchange = updateQualityHint;

  $('#composer').onsubmit = (e) => { e.preventDefault(); sendChat(); };
  const input = $('#composer-input');
  input.oninput = onComposerInput;
  input.onkeydown = onComposerKey;
  input.onblur = () => setTimeout(hideMentions, 150);
  $('#composer-cancel').onclick = cancelCompose;
  window.addEventListener('focus', () => {
    if (view === 'chat' && unreadBy.delete(currentText)) renderSidebar();
    pushOverlay();
  });
  window.addEventListener('blur', pushOverlay);
  document.addEventListener('visibilitychange', renderStage);
  for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown']) document.addEventListener(ev, wakeUi, { passive: true });
  document.addEventListener('fullscreenchange', wakeUi);
  window.addEventListener('beforeunload', () => { if (local.voice) api.setState({ voice: false, sharing: false, room: '' }); });

  bindFiles();
  // Janela estreita: a lista "Online" vira um painel que abre pelo botão.
  const setMembers = (open) => {
    document.body.classList.toggle('members-open', open);
    $('#btn-members').setAttribute('aria-expanded', String(open));
  };
  $('#btn-members').onclick = (e) => { e.stopPropagation(); setMembers(!document.body.classList.contains('members-open')); };
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('members-open') && !e.target.closest('#members-panel')) setMembers(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMembers(false); });
  api.onPeers(onPeers);
  api.onChat(receiveMessage);
  api.onChatUpdate(updateMessage);
  api.onTyping(onTyping);
  api.onChannels(onChannels);
  api.onSignal(onSignal);
  api.onLog((line) => log(line));
  api.onTrayCmd(onTrayCmd);
  api.onUpdate(onUpdate);
  api.onHotkey(onHotkey);
  api.onPtt(onPtt);
  api.onPresence(({ playing }) => { playingMe = playing || ''; render(); });
  api.onRtt((map) => { NetQuality.onRtt(map); refreshNet(); });
  // Qualidade da voz (perda de pacotes, ping do WebRTC) a cada 2 s
  setInterval(async () => { if (conns.size) { await NetQuality.sample(conns); refreshNet(); } }, 2000);
}

/** Atualiza só as barrinhas de sinal, sem redesenhar tudo. */
function refreshNet() {
  document.querySelectorAll('#member-list li').forEach((li, i) => {
    const p = peers[i - 1];
    const old = li.querySelector('.net');
    if (p && old) old.replaceWith(netBars(p.id));
  });
  for (const [key, el] of tiles) {
    const old = el.querySelector('.label .net');
    if (old) old.replaceWith(netBars(key.slice(key.indexOf(':') + 1)));
  }
}

// ------------------------------------------------------------------ teste automático
/** Só no autoteste: imagem sempre em movimento no lugar da tela, para medir fps reais. */
function testPattern(q) {
  const canvas = document.createElement('canvas');
  canvas.width = q.w;
  canvas.height = q.h;
  const g = canvas.getContext('2d');
  let frame = 0;
  setInterval(() => {
    frame += 1;
    g.fillStyle = `hsl(${frame % 360} 60% 30%)`;
    g.fillRect(0, 0, q.w, q.h);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `hsl(${(i * 37 + frame * 3) % 360} 80% 60%)`;
      g.fillRect((i * 97 + frame * 9) % q.w, (i * 53 + frame * 5) % q.h, q.w / 12, q.h / 12);
    }
    g.fillStyle = '#fff';
    g.font = `${Math.round(q.h / 8)}px sans-serif`;
    g.fillText(`${q.label} #${frame}`, q.w / 20, q.h / 2);
  }, 1000 / q.fps);
  return canvas.captureStream(q.fps);
}

/** Autoteste: manda uma imagem, um vídeo curto e (opcional) um arquivo do disco. */
async function autotestMedia() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const g = c.getContext('2d');
  const paint = (t) => {
    g.fillStyle = `hsl(${t % 360} 70% 45%)`; g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#fff'; g.font = 'bold 64px sans-serif'; g.fillText(`Ponte ${t}`, 40, 200);
  };
  paint(200);
  const png = await new Promise((r) => c.toBlob(r, 'image/png'));
  await sendFiles([new File([png], 'teste.png', { type: 'image/png' })]);
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
  const parts = [];
  rec.ondataavailable = (e) => parts.push(e.data);
  let t = 0;
  const timer = setInterval(() => paint((t += 6)), 33);
  rec.start();
  await new Promise((r) => setTimeout(r, 2000));
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  clearInterval(timer);
  await sendFiles([new File(parts, 'teste.webm', { type: 'video/webm' })]);
  const big = me.autotestMedia.startsWith('path:') ? me.autotestMedia.slice(5) : '';
  if (big) {
    const m = await api.sendMedia({ path: big, name: 'grande.mp4', mime: 'video/mp4' });
    if (m) appendMessage(m);
  }
  log('autoteste: arquivos enviados');
}

/** Autoteste dos recursos da v2. 'lead' faz as ações; 'follow' observa e registra. */
async function autotestFeaturesLead() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (t) => log(`feat: ${t}`);
  for (let i = 0; i < 60 && ![...conns.values()].some((c) => c.pc.connectionState === 'connected'); i++) await wait(500);
  step(`voz conectada; IA de ruído ativa=${Mic.noiseOn()}`);
  let before = new Set(channels.map((c) => c.id));
  channels = await api.createChannel('text', 'jogos');
  const jogos = channels.find((c) => !before.has(c.id));
  openText(jogos.id);
  step(`canal criado: #${jogos.name}`);
  api.typing(jogos.id);
  await wait(1500);
  const m1 = await api.sendChat({ text: '@Beto bora jogar?', channel: jogos.id });
  receiveMessage(m1);
  await wait(500);
  const m2 = await api.sendChat({ text: 'resposta', channel: jogos.id, replyTo: { id: m1.id, name: m1.name, text: m1.text } });
  receiveMessage(m2);
  updateMessage(await api.reactChat(m1.id, '🔥', true));
  updateMessage(await api.editChat(m2.id, 'resposta editada'));
  const m3 = await api.sendChat({ text: 'vou apagar', channel: jogos.id });
  receiveMessage(m3);
  await wait(300);
  updateMessage(await api.deleteChat(m3.id));
  step('menção, resposta, reação, edição e exclusão feitas');
  await sendFiles([new File(['conteudo de teste da Ponte'], 'notas.txt', { type: 'text/plain' })]);
  step('arquivo .txt enviado');
  // Soundboard com o microfone mudo: só o som deve chegar
  await wait(1500);
  prefs.write('aiNoise', false);
  await Mic.refresh();
  if (!local.muted) toggleMute();
  step('mudo; tocando soundboard');
  await wait(2500);
  step(`soundboard tocou=${await Soundboard.play('buzina')}`);
  await wait(2500);
  toggleMute();
  // Apertar para falar: sem a tecla, a porta fecha; com a tecla, abre
  prefs.write('voiceMode', 'ptt');
  applyPtt();
  step('modo apertar para falar, tecla solta');
  await wait(4000);
  onPtt(true);
  step('tecla apertada');
  await wait(4000);
  onPtt(false);
  prefs.write('voiceMode', 'auto');
  applyPtt();
  step('volta para detecção automática');
  await toggleCam();
  step(`câmera ligada=${!!camStream}`);
  await wait(4000);
  before = new Set(channels.map((c) => c.id));
  channels = await api.createChannel('voice', 'Squad');
  const squad = channels.find((c) => !before.has(c.id));
  await joinVoice(squad.id);
  step(`entrei na sala ${roomName(local.room)}`);
}

function autotestFeaturesFollow() {
  const ana = () => peers[0];
  setInterval(() => {
    const p = ana();
    if (!p) return;
    const jogos = channels.find((c) => c.name === 'jogos');
    const msgs = jogos ? allMessages.filter((m) => m.channel === jogos.id) : [];
    const desc = msgs.map((m) => `${m.deleted ? '[apagada]' : m.text}${m.edited ? '*' : ''}${m.replyTo ? '↩' : ''}${m.reactions ? JSON.stringify(m.reactions).replace(/"|\[|\]/g, '').replace(/[0-9a-f-]{36}/g, 'id') : ''}${m.file ? `[${m.file.name}${m.file.local ? ' ok' : ' ...'}]` : ''}`).join(' | ');
    log(`obs: canais=${channels.map((c) => c.name).join(',')} naoLidas=${jogos ? unreadBy.get(jogos.id) || 0 : 0} mencao=${msgs.some(mentionsMe)} digitando=${typingTimers.size} msgs=${desc} || anaSala=${roomName(roomOf(p.state))} anaMuda=${!!p.state.muted} anaFalando=${speaking.has(p.id)} camAna=${!!remoteCam(p.id)} minhaSala=${roomName(local.room)} conexoes=${[...conns.values()].map((c) => c.pc.connectionState).join(',')}`);
  }, 1000);
  const follow = setInterval(() => {
    const p = ana();
    if (p && local.voice && roomOf(p.state) && roomOf(p.state) !== 'sala' && local.room === 'sala') {
      clearInterval(follow);
      joinVoice(roomOf(p.state));
    }
  }, 1000);
}

function autotest() {
  if (me.autotestClip) {
    setTimeout(async () => {
      const r = await Clips.save();
      log(`autoteste: clipe ${r ? `${r.seconds}s ${r.mime} ${r.file.split(/[\/]/).pop()}` : 'nenhum'}`);
    }, me.autotestClip * 1000);
  }
  if (me.autotestFeatures === 'lead') setTimeout(autotestFeaturesLead, 2500);
  if (me.autotestFeatures === 'follow') autotestFeaturesFollow();
  if (me.autotestMedia) {
    api.onMediaReady(({ id }) => {
      const f = fileMeta.get(id);
      log(`autoteste: arquivo recebido ${f ? f.name : id}`);
      setTimeout(() => {
        const el = document.querySelector(`.msg-media[data-file-id="${id}"] img, .msg-media[data-file-id="${id}"] video`);
        if (!el) return log('autoteste: sem elemento de mídia');
        if (el.tagName === 'IMG') log(`autoteste: imagem ${el.naturalWidth}x${el.naturalHeight}`);
        else log(`autoteste: vídeo readyState=${el.readyState} ${el.videoWidth}x${el.videoHeight} erro=${el.error ? el.error.code : 'nenhum'}`);
      }, 1500);
    });
  }
  log('autoteste: ativo');
  if (me.autotestDialog === 'settings') {
    setTimeout(async () => { await openSettings(); if (me.demo) document.activeElement?.blur(); }, 3000);
  }
  if (me.autotestDialog === 'screen') {
    setTimeout(async () => {
      await openScreenPicker();
      if (me.demo) { $('#screen-fps').value = '60'; updateQualityHint(); }
      document.querySelector('#dlg-screen .tab[data-kind=window]').click();
      document.querySelector('#sources .source')?.click();
      if (me.demo) document.activeElement?.blur();
    }, 3000);
  }
  setTimeout(async () => {
    await joinVoice();
    if (me.autotestView === 'chat') setView('chat');
  }, 1500);
  let sharedOnce = false;
  let glassLogged = false;
  let checkedVolume = false;
  let chatted = false;
  setInterval(async () => {
    if (!chatted && peers.length && !me.demo) {
      chatted = true;
      api.sendChat(`olá de ${me.name}`);
      if (me.autotestMedia && me.autotestMedia !== 'recv') autotestMedia();
    }
    if (me.autotestShare && local.voice && !sharedOnce && [...conns.values()].some((c) => c.pc.connectionState === 'connected')) {
      sharedOnce = true;
      let audio = null;
      if (me.autotestAudio === 'self') {
        const t = new AudioContext();
        const o = t.createOscillator();
        const g = t.createGain();
        o.frequency.value = 440;
        g.gain.value = 0.03;
        o.connect(g).connect(t.destination);
        o.start();
        setTimeout(() => t.close(), 8000);
        audio = { mode: 'app', pid: me.mainPid, name: 'próprio app (teste)' };
        if (!local.deafened) toggleDeafen(); // não toca o outro lado: a captura fica só com o tom
      }
      startScreen(null, qualityFor(me.autotestRes || 480, me.autotestFps || 30), audio);
    }
    if (me.autotestFocus && !focusedTile) {
      const other = voicePeers().find((p) => p.state.sharing && remoteScreen(p.id));
      if (other) { focusedTile = `screen:${other.id}`; renderStage(); }
    }
    if (me.autotestAudio === 'check' && !checkedVolume) {
      const sharer = voicePeers().find((p) => p.state.sharing && remoteScreen(p.id)?.getAudioTracks().length);
      if (sharer) {
        checkedVolume = true;
        setStreamVolume(sharer.id, 0.3);
        const els = [...remotes.get(sharer.id).audios.values()];
        log(`autoteste: volumes stream=${els.filter(isStreamAudio).map((e) => e.volume).join(',')} voz=${els.filter((e) => !isStreamAudio(e)).map((e) => e.volume).join(',')} svol=${document.querySelectorAll('.svol').length}`);
        toggleStreamMute(sharer.id);
        log(`autoteste: mudo stream=${els.filter(isStreamAudio).map((e) => e.muted).join(',')} voz=${els.filter((e) => !isStreamAudio(e)).map((e) => e.muted).join(',')}`);
        setTimeout(() => log(`autoteste: controles escondidos=${$('#view-voice').classList.contains('idle')} opacidade=${getComputedStyle($('#controls')).opacity}`), 4000);
      }
    }
    if (!glassLogged) { glassLogged = true; log(`vidro: ${document.querySelectorAll('.liquid-on').length} painéis com refração; filtro=${getComputedStyle($('#composer')).backdropFilter}`); }
    for (const [id, c] of conns) {
      const stats = await c.pc.getStats();
      let audioIn = 0;
      let framesIn = 0;
      let video = '';
      const audios = [];
      let pair = '';
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          audioIn += s.bytesReceived || 0;
          audios.push(`${(s.audioLevel || 0).toFixed(3)}`);
        }
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          framesIn += s.framesDecoded || 0;
          video = ` recebendo=${s.frameWidth}x${s.frameHeight}@${s.framesPerSecond || 0}fps`;
        }
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          const src = [...stats.values()].find((x) => x.type === 'media-source' && x.kind === 'video');
          video += ` enviando=${s.frameWidth}x${s.frameHeight}@${s.framesPerSecond || 0}fps fonte=${src ? `${src.width}x${src.height}@${src.framesPerSecond}` : '?'} limite=${s.qualityLimitationReason} enc=${s.encoderImplementation} kbps=${Math.round((s.targetBitrate || 0) / 1000)}`;
        }
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
          const l = stats.get(s.localCandidateId);
          const r = stats.get(s.remoteCandidateId);
          pair = `${l && l.address} -> ${r && r.address}`;
        }
      });
      const name = (peerById(id) || {}).name;
      log(`autoteste: ${name} estado=${c.pc.connectionState} audioBytes=${audioIn} videoFrames=${framesIn}${video} audios=[${audios.join(',')}] rota=${pair} chat=${document.querySelectorAll('.msg-text').length}`);
    }
  }, 3000);
}

// ------------------------------------------------------------------ início
(async () => {
  applyGlass();
  bind();
  const init = await api.init();
  me = init.me;
  if (me.update) update = me.update;
  me.autotestShare = me.autotestShare || /compartilha/i.test(me.name);
  peers = init.peers;
  channels = init.channels || [];
  playingMe = init.playing || '';
  for (const m of init.history) storeMessage(m);
  renderHistory();
  setView('chat');
  applyPtt();
  log(`Ponte pronta em ${me.interfaces.map((i) => i.address).join(', ')} (TCP ${me.tcpPort}, UDP ${me.discoveryPort})`);
  if (me.autotest) autotest();
})();
