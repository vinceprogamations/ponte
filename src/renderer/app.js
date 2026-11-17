'use strict';
/* global ponte */
const api = window.ponte;
const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------------ estado
let me = null;
let peers = [];
let view = 'chat';
let unread = 0;
let logLines = [];
const local = { voice: false, muted: false, deafened: false, sharing: false, quality: '' };
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
  expand: '<svg class="expand" viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  shrink: '<svg class="shrink" viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
};
let toastTimer = null;
function toast(text, ms = 4000) {
  const el = $('#toast');
  el.textContent = text;
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
  const notes = { join: [523, 784], leave: [659, 440], message: [880], online: [660, 880] }[kind];
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
    const muted = key === me.id ? local.muted || local.deafened : peerState(key).muted;
    const on = rms > 0.02 && !muted;
    if (on !== speaking.has(key)) { on ? speaking.add(key) : speaking.delete(key); changed = true; }
  }
  for (const key of [...speaking]) if (!meters.has(key)) { speaking.delete(key); changed = true; }
  if (changed) {
    document.querySelectorAll('[data-speak]').forEach((el) => {
      el.classList.toggle('speaking', speaking.has(el.dataset.speak));
    });
  }
}, 90);

// ------------------------------------------------------------------ pares
const peerState = (id) => (peers.find((p) => p.id === id) || {}).state || {};
const peerById = (id) => peers.find((p) => p.id === id);
const voicePeers = () => peers.filter((p) => p.state.voice);

function onPeers(list) {
  const before = new Map(peers.map((p) => [p.id, p]));
  peers = list;
  for (const p of peers) {
    const old = before.get(p.id);
    if (!old) { log(`${p.name} ficou online (${p.address})`); sound('online'); }
    if (local.voice && old && !old.state.voice && p.state.voice) sound('join');
    if (local.voice && old && old.state.voice && !p.state.voice) sound('leave');
  }
  for (const [id, old] of before) {
    if (!peers.find((p) => p.id === id)) {
      log(`${old.name} saiu`);
      if (local.voice && old.state.voice) sound('leave');
    }
  }
  syncConnections();
  render();
}

// ------------------------------------------------------------------ WebRTC
function remoteOf(id) {
  let r = remotes.get(id);
  if (!r) { r = { audios: new Map(), screen: null }; remotes.set(id, r); }
  return r;
}

function syncConnections() {
  for (const p of peers) {
    const both = local.voice && p.state.voice;
    if (both && !conns.has(p.id)) openConn(p.id);
    if (!both && conns.has(p.id)) closeConn(p.id);
  }
  for (const id of [...conns.keys()]) if (!peerById(id)) closeConn(id);
}

function openConn(id) {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const c = { pc, polite: me.id > id, makingOffer: false, ignoreOffer: false, queue: Promise.resolve(), screenSenders: [] };
  conns.set(id, c);
  const name = () => (peerById(id) || {}).name || id.slice(0, 6);

  if (micStream) for (const t of micStream.getAudioTracks()) pc.addTrack(t, micStream);
  if (screenStream) addScreenTo(c);

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
  }, 8000 + Math.random() * 4000);
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
  if (!local.voice || !p || !p.state.voice) return;
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
    r.screen = stream;
    const refresh = () => {
      if (!stream.getVideoTracks().some((t) => t.readyState === 'live')) r.screen = null;
      renderStage();
    };
    track.onended = refresh;
    stream.onremovetrack = refresh;
    renderStage();
    return;
  }
  if (r.audios.has(stream.id)) return;
  const el = new Audio();
  el.autoplay = true;
  el.srcObject = stream;
  el.muted = local.deafened;
  el.volume = volumeFor(id);
  const sink = prefs.read('outDevice', '');
  if (sink && el.setSinkId) el.setSinkId(sink).catch(() => {});
  el.play().catch(() => {});
  document.body.append(el);
  r.audios.set(stream.id, el);
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
  const r = remotes.get(id);
  if (r) for (const el of r.audios.values()) el.volume = v;
}

// ------------------------------------------------------------------ voz
function micConstraints() {
  const deviceId = prefs.read('micDevice', '');
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

function pushState() {
  api.setState({ ...local });
}

async function joinVoice() {
  if (local.voice) { setView('voice'); return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
  } catch (err) {
    if (prefs.read('micDevice', '')) {
      prefs.write('micDevice', '');
      return joinVoice();
    }
    toast(`Não foi possível usar o microfone: ${err.message}`);
    return;
  }
  applyMute();
  attachMeter(me.id, micStream);
  local.voice = true;
  pushState();
  sound('join');
  setView('voice');
  syncConnections();
  render();
}

function leaveVoice() {
  if (!local.voice) return;
  stopScreen(false);
  local.voice = false;
  pushState();
  for (const id of [...conns.keys()]) closeConn(id);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  detachMeter(me.id);
  sound('leave');
  render();
}

function applyMute() {
  if (micStream) for (const t of micStream.getAudioTracks()) t.enabled = !(local.muted || local.deafened);
  for (const r of remotes.values()) for (const el of r.audios.values()) el.muted = local.deafened;
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
    [sourceList, audioApps] = await Promise.all([api.screenSources(), api.audioApps().catch(() => null)]);
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
    screenStream = me.autotestCanvas
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
  if (focusedTile === `screen:${me.id}`) focusedTile = null;
  if (push) pushState();
  render();
}

// ------------------------------------------------------------------ chat
let lastMsg = null;
function appendMessage(m, { quiet = false } = {}) {
  const box = $('#messages');
  box.querySelector('.empty-chat')?.remove();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const time = new Date(m.ts);
  const sameAuthor = lastMsg && lastMsg.from === m.from && m.ts - lastMsg.ts < 5 * 60 * 1000;
  if (sameAuthor) {
    const line = document.createElement('div');
    line.className = `msg-line${m.from === me.id ? ' mine' : ''}`;
    line.innerHTML = `<div class="msg-text">${linkify(m.text)}</div>`;
    line.title = time.toLocaleString();
    box.append(line);
  } else {
    const g = document.createElement('div');
    g.className = `msg-group${m.from === me.id ? ' mine' : ''}`;
    g.append(avatar(m.from, m.name));
    const head = document.createElement('div');
    head.className = 'msg-head';
    head.innerHTML = '<strong></strong><time></time>';
    head.querySelector('strong').textContent = m.name;
    head.querySelector('strong').style.color = colorFor(m.from);
    const today = new Date().toDateString() === time.toDateString();
    head.querySelector('time').textContent = today
      ? `Hoje às ${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : time.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    const text = document.createElement('div');
    text.className = 'msg-text';
    text.innerHTML = linkify(m.text);
    g.append(head, text);
    box.append(g);
  }
  lastMsg = m;
  if (nearBottom || m.from === me.id) box.scrollTop = box.scrollHeight;
  if (!quiet && m.from !== me.id) {
    if (view !== 'chat' || !document.hasFocus()) { unread += 1; renderUnread(); }
    sound('message');
  }
}

function renderHistory(list) {
  const box = $('#messages');
  box.innerHTML = '';
  lastMsg = null;
  if (!list.length) {
    box.innerHTML = '<div class="empty-chat"><h2>Bem-vindo à #geral</h2><p>Tudo que for escrito aqui vai direto para os computadores da rede, sem passar por servidor nenhum.</p></div>';
  }
  for (const m of list) appendMessage(m, { quiet: true });
  box.scrollTop = box.scrollHeight;
}

async function sendChat() {
  const input = $('#composer-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  const m = await api.sendChat(text);
  if (m) appendMessage(m);
}

function autosize() {
  const t = $('#composer-input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}

function renderUnread() {
  const b = $('#unread');
  b.hidden = unread === 0;
  b.textContent = unread > 99 ? '99+' : String(unread);
}

// ------------------------------------------------------------------ render
function setView(v) {
  view = v;
  $('#view-chat').hidden = v !== 'chat';
  $('#view-voice').hidden = v !== 'voice';
  $('#ch-chat').classList.toggle('active', v === 'chat');
  $('#ch-voice').classList.toggle('active', v === 'voice');
  if (v === 'chat') {
    $('#view-title').textContent = 'Conversa';
    $('#view-sub').textContent = '#geral · as mensagens ficam só nos computadores de vocês';
    unread = 0;
    renderUnread();
    setTimeout(() => $('#composer-input').focus(), 0);
  } else {
    $('#view-title').textContent = 'Sala de voz';
    $('#view-sub').textContent = 'Áudio e vídeo vão direto de um computador para o outro';
  }
  render();
}

function render() {
  if (!me) return;
  // eu
  $('#me-name').textContent = me.name;
  $('#me-status').textContent = local.voice ? (local.sharing ? 'ao vivo' : 'na voz') : 'online';
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
  $('#btn-share-side span').textContent = local.sharing ? 'Parar' : 'Tela';

  // painel de voz
  $('#voice-panel').hidden = !local.voice;
  const inVoice = voicePeers().length + (local.voice ? 1 : 0);
  $('#voice-detail').textContent = `${inVoice} na sala`;
  $('#stage-empty').hidden = local.voice;
  $('#controls').hidden = !local.voice;
  $('#stage').hidden = !local.voice;

  // membros na voz (barra lateral)
  const vm = $('#voice-members');
  vm.innerHTML = '';
  const voiceList = [
    ...(local.voice ? [{ id: me.id, name: me.name, state: local }] : []),
    ...voicePeers(),
  ];
  for (const p of voiceList) {
    const li = document.createElement('li');
    li.append(avatar(p.id, p.name));
    const n = document.createElement('span');
    n.textContent = p.name;
    li.append(n);
    const flags = document.createElement('span');
    flags.className = 'flags';
    if (p.state.sharing) flags.insertAdjacentHTML('beforeend', '<span class="live-tag">AO VIVO</span>');
    if (p.state.deafened) flags.insertAdjacentHTML('beforeend', ICON.deaf);
    else if (p.state.muted) flags.insertAdjacentHTML('beforeend', ICON.micOff);
    li.append(flags);
    vm.append(li);
  }

  // membros online
  const ml = $('#member-list');
  ml.innerHTML = '';
  const all = [{ id: me.id, name: me.name, address: 'você', state: local }, ...peers];
  for (const p of all) {
    const li = document.createElement('li');
    li.append(avatar(p.id, p.name));
    const info = document.createElement('div');
    info.className = 'member-info';
    info.innerHTML = '<strong></strong><small></small>';
    info.querySelector('strong').textContent = p.name;
    info.querySelector('small').textContent = p.id === me.id ? 'você' : (me.demo ? '26.31.200.45' : p.address);
    li.append(info);
    const flags = document.createElement('div');
    flags.className = 'member-flags';
    const tag = document.createElement('span');
    if (p.state.sharing) { tag.className = 'pill-tag live'; tag.textContent = 'Ao vivo'; }
    else if (p.state.voice) { tag.className = 'pill-tag voice'; tag.textContent = 'Na voz'; }
    if (tag.textContent) flags.append(tag);
    li.append(flags);
    ml.append(li);
  }
  $('#online-count').textContent = String(all.length);
  $('#searching').hidden = peers.length > 0;

  document.querySelectorAll('[data-speak]').forEach((el) => el.classList.toggle('speaking', speaking.has(el.dataset.speak)));
  renderStage();
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
      const r = remotes.get(p.id);
      if (p.state.sharing) wanted.push({ key: `screen:${p.id}`, kind: 'screen', id: p.id, name: p.name, stream: r && r.screen, quality: p.state.quality });
    }
    wanted.push({ key: `user:${me.id}`, kind: 'user', id: me.id, name: me.name, state: local, mine: true });
    for (const p of voicePeers()) wanted.push({ key: `user:${p.id}`, kind: 'user', id: p.id, name: p.name, state: p.state });
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
        el.append(avatar(w.id, w.name));
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
        const fs = document.createElement('button');
        fs.type = 'button';
        fs.className = 'fs-btn';
        fs.title = 'Tela cheia (Esc para sair)';
        fs.setAttribute('aria-label', 'Tela cheia');
        fs.innerHTML = ICON.expand + ICON.shrink;
        fs.onclick = (e) => { e.stopPropagation(); toggleFullscreen(el); };
        el.append(fs);
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
      video.hidden = !w.stream;
      el.classList.toggle('focused', focusedTile === w.key);
    }
    stage.append(el); // garante a ordem
  }
  stage.classList.toggle('has-focus', !!focusedTile);
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen().catch((err) => toast(`Não deu para abrir em tela cheia: ${err.message}`));
}

// ------------------------------------------------------------------ configurações
async function openSettings() {
  $('#set-name').value = me.name;
  $('#set-sounds').checked = prefs.read('sounds', true);
  $('#set-glass').checked = prefs.read('glass', true);
  renderIps();
  $('#set-log').textContent = logLines.slice(-60).join('\n') || 'Sem eventos ainda.';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillSelect('#set-mic', devices.filter((d) => d.kind === 'audioinput'), prefs.read('micDevice', ''));
    fillSelect('#set-out', devices.filter((d) => d.kind === 'audiooutput'), prefs.read('outDevice', ''));
  } catch {}
  $('#dlg-settings').showModal();
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
  applyGlass();
  const out = $('#set-out').value;
  prefs.write('outDevice', out);
  for (const r of remotes.values()) for (const el of r.audios.values()) if (el.setSinkId) el.setSinkId(out).catch(() => {});
  const mic = $('#set-mic').value;
  if (mic !== prefs.read('micDevice', '')) {
    prefs.write('micDevice', mic);
    if (local.voice) await switchMic();
  }
  render();
}

async function switchMic() {
  try {
    const next = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
    const track = next.getAudioTracks()[0];
    for (const c of conns.values()) {
      const sender = c.pc.getSenders().find((s) => s.track && micStream && micStream.getAudioTracks().includes(s.track));
      if (sender) await sender.replaceTrack(track);
    }
    micStream.getTracks().forEach((t) => t.stop());
    micStream = next;
    applyMute();
    attachMeter(me.id, micStream);
  } catch (err) {
    toast(`Não foi possível trocar o microfone: ${err.message}`);
  }
}

function applyGlass() {
  document.documentElement.classList.toggle('no-glass', !prefs.read('glass', true));
}

// ------------------------------------------------------------------ eventos
function bind() {
  $('#ch-chat').onclick = () => setView('chat');
  $('#ch-voice').onclick = () => { if (local.voice) setView('voice'); else joinVoice(); };
  $('#btn-join').onclick = joinVoice;
  $('#btn-mute').onclick = toggleMute;
  $('#ctl-mute').onclick = toggleMute;
  $('#btn-deafen').onclick = toggleDeafen;
  $('#ctl-deafen').onclick = toggleDeafen;
  $('#ctl-share').onclick = openScreenPicker;
  $('#btn-share-side').onclick = openScreenPicker;
  $('#ctl-leave').onclick = leaveVoice;
  $('#btn-leave-side').onclick = leaveVoice;
  $('#btn-settings').onclick = openSettings;
  $('#me-name-btn').onclick = openSettings;
  $('#btn-add-ip').onclick = async () => { await openSettings(); $('#set-host').focus(); };
  $('#set-host-add').onclick = addHost;
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
  input.oninput = autosize;
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  };
  window.addEventListener('focus', () => { if (view === 'chat') { unread = 0; renderUnread(); } });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyM') { e.preventDefault(); toggleMute(); }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); toggleDeafen(); }
  });
  window.addEventListener('beforeunload', () => { if (local.voice) api.setState({ voice: false, sharing: false }); });

  api.onPeers(onPeers);
  api.onChat((m) => appendMessage(m));
  api.onSignal(onSignal);
  api.onLog((line) => log(line));
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

function autotest() {
  log('autoteste: ativo');
  if (me.autotestDialog === 'settings') setTimeout(openSettings, 3000);
  if (me.autotestDialog === 'screen') setTimeout(async () => { await openScreenPicker(); document.querySelector('#dlg-screen .tab[data-kind=window]').click(); document.querySelector('#sources .source')?.click(); }, 3000);
  setTimeout(async () => {
    await joinVoice();
    if (me.autotestView === 'chat') setView('chat');
  }, 1500);
  let sharedOnce = false;
  let glassLogged = false;
  let chatted = false;
  setInterval(async () => {
    if (!chatted && peers.length && !me.demo) { chatted = true; api.sendChat(`olá de ${me.name}`); }
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
      const other = voicePeers().find((p) => p.state.sharing && remotes.get(p.id)?.screen);
      if (other) { focusedTile = `screen:${other.id}`; renderStage(); }
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
  me.autotestShare = me.autotestShare || /compartilha/i.test(me.name);
  peers = init.peers;
  renderHistory(init.history);
  setView('chat');
  log(`Ponte pronta em ${me.interfaces.map((i) => i.address).join(', ')} (TCP ${me.tcpPort}, UDP ${me.discoveryPort})`);
  if (me.autotest) autotest();
})();
