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
const local = { voice: false, muted: false, deafened: false, sharing: false };
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

const QUALITY = {
  light: { w: 1280, h: 720, fps: 15, bitrate: 1_500_000, hint: 'detail' },
  standard: { w: 1920, h: 1080, fps: 30, bitrate: 4_000_000, hint: 'detail' },
  smooth: { w: 1920, h: 1080, fps: 60, bitrate: 8_000_000, hint: 'motion' },
};

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
const COLORS = ['#f0a050', '#7cc6fe', '#b8e986', '#f78fb3', '#c9a7ff', '#ffd166', '#5ee6c5', '#ff9a8b'];
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
        await pc.setRemoteDescription(desc);
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
  $('#screen-quality').value = prefs.read('quality', 'standard');
  $('#screen-audio').checked = prefs.read('screenAudio', false);
  $('#screen-audio').closest('label').hidden = me.platform !== 'win32';
  $('#sources').innerHTML = '<p class="waiting">Carregando…</p>';
  $('#dlg-screen').showModal();
  try {
    sourceList = await api.screenSources();
  } catch (err) {
    $('#sources').textContent = `Falha ao listar telas: ${err.message}`;
    return;
  }
  renderSources();
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
    b.onclick = () => { selectedSource = s.id; $('#screen-go').disabled = false; renderSources(); };
    b.ondblclick = () => { selectedSource = s.id; $('#dlg-screen').close('go'); };
    box.append(b);
  }
}

async function startScreen(sourceId, qualityKey, withAudio) {
  screenQuality = QUALITY[qualityKey] || QUALITY.standard;
  api.selectScreen({ id: sourceId, audio: withAudio });
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: screenQuality.w },
        height: { ideal: screenQuality.h },
        frameRate: { ideal: screenQuality.fps, max: screenQuality.fps },
      },
      audio: withAudio,
    });
  } catch (err) {
    toast(`Não foi possível capturar a tela: ${err.message}`);
    return;
  }
  const vt = screenStream.getVideoTracks()[0];
  if (vt) {
    vt.contentHint = screenQuality.hint;
    vt.onended = () => stopScreen();
  }
  local.sharing = true;
  pushState();
  for (const c of conns.values()) addScreenTo(c);
  focusedTile = null;
  render();
}

function addScreenTo(c) {
  for (const t of [...screenStream.getVideoTracks(), ...screenStream.getAudioTracks()]) {
    c.screenSenders.push(c.pc.addTrack(t, screenStream));
  }
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
    params.degradationPreference = screenQuality.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    s.setParameters(params).catch(() => {});
  }
  if (pending && attempt < 10) setTimeout(() => tuneScreenSenders(c, attempt + 1), 700);
}

function stopScreen(push = true) {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  for (const c of conns.values()) {
    for (const s of c.screenSenders) { try { c.pc.removeTrack(s); } catch {} }
    c.screenSenders = [];
  }
  screenStream = null;
  screenQuality = null;
  local.sharing = false;
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
    line.className = 'msg-line';
    line.innerHTML = `<div class="msg-text">${linkify(m.text)}</div>`;
    line.title = time.toLocaleString();
    box.append(line);
  } else {
    const g = document.createElement('div');
    g.className = 'msg-group';
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
    $('#view-title').innerHTML = '<span class="hash">#</span> geral';
    $('#view-sub').textContent = 'Mensagens ficam salvas só nos computadores de vocês';
    unread = 0;
    renderUnread();
    setTimeout(() => $('#composer-input').focus(), 0);
  } else {
    $('#view-title').innerHTML = `${ICON.voice} Sala de voz`;
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
    if (p.state.sharing) flags.insertAdjacentHTML('beforeend', ICON.screen);
    else if (p.state.voice) flags.insertAdjacentHTML('beforeend', ICON.voice);
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
    if (local.sharing && screenStream) wanted.push({ key: `screen:${me.id}`, kind: 'screen', id: me.id, name: `${me.name} (você)`, stream: screenStream, mine: true });
    for (const p of voicePeers()) {
      const r = remotes.get(p.id);
      if (p.state.sharing) wanted.push({ key: `screen:${p.id}`, kind: 'screen', id: p.id, name: p.name, stream: r && r.screen });
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
        el.onclick = () => { focusedTile = focusedTile === w.key ? null : w.key; renderStage(); };
        el.ondblclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else video.requestFullscreen().catch(() => {}); };
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

// ------------------------------------------------------------------ configurações
async function openSettings() {
  $('#set-name').value = me.name;
  $('#set-sounds').checked = prefs.read('sounds', true);
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
  $('#dlg-settings').addEventListener('close', () => { if ($('#dlg-settings').returnValue === 'save') saveSettings(); });

  document.querySelectorAll('#dlg-screen .tab').forEach((tab) => {
    tab.onclick = () => {
      sourceKind = tab.dataset.kind;
      document.querySelectorAll('#dlg-screen .tab').forEach((t) => t.classList.toggle('active', t === tab));
      renderSources();
    };
  });
  $('#dlg-screen').addEventListener('close', () => {
    if ($('#dlg-screen').returnValue !== 'go' || !selectedSource) return;
    const quality = $('#screen-quality').value;
    const audio = $('#screen-audio').checked && me.platform === 'win32';
    prefs.write('quality', quality);
    prefs.write('screenAudio', audio);
    startScreen(selectedSource, quality, audio);
  });

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
function autotest() {
  log('autoteste: ativo');
  setTimeout(async () => {
    await joinVoice();
    if (me.autotestView === 'chat') setView('chat');
  }, 1500);
  let sharedOnce = false;
  let chatted = false;
  setInterval(async () => {
    if (!chatted && peers.length && !me.demo) { chatted = true; api.sendChat(`olá de ${me.name}`); }
    if (me.autotestShare && local.voice && !sharedOnce && [...conns.values()].some((c) => c.pc.connectionState === 'connected')) {
      sharedOnce = true;
      startScreen(null, 'light', false);
    }
    for (const [id, c] of conns) {
      const stats = await c.pc.getStats();
      let audioIn = 0;
      let framesIn = 0;
      let pair = '';
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') audioIn += s.bytesReceived || 0;
        if (s.type === 'inbound-rtp' && s.kind === 'video') framesIn += s.framesDecoded || 0;
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
          const l = stats.get(s.localCandidateId);
          const r = stats.get(s.remoteCandidateId);
          pair = `${l && l.address} -> ${r && r.address}`;
        }
      });
      const name = (peerById(id) || {}).name;
      log(`autoteste: ${name} estado=${c.pc.connectionState} audioBytes=${audioIn} videoFrames=${framesIn} rota=${pair} chat=${document.querySelectorAll('.msg-text').length}`);
    }
  }, 3000);
}

// ------------------------------------------------------------------ início
(async () => {
  bind();
  const init = await api.init();
  me = init.me;
  me.autotestShare = /compartilha/i.test(me.name);
  peers = init.peers;
  renderHistory(init.history);
  setView('chat');
  log(`Ponte pronta em ${me.interfaces.map((i) => i.address).join(', ')} (TCP ${me.tcpPort}, UDP ${me.discoveryPort})`);
  if (me.autotest) autotest();
})();
