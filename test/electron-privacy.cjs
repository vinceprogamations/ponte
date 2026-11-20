'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const electron = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-electron-'));
const children = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await wait(150); }
  throw new Error(`Timeout: ${label}`);
}
function profile(name) {
  const profileDir = path.join(dir, name);
  fs.mkdirSync(path.join(profileDir, 'media'), { recursive: true });
  const oldFile = { id: '22222222-2222-4222-8222-222222222222', name: 'old.txt', mime: 'text/plain', size: 10 };
  fs.writeFileSync(path.join(profileDir, 'history.json'), JSON.stringify([{ id: 'legacy-private', from: 'old-owner', name: 'Old owner', text: 'LEGACY PRIVATE SECRET', channel: 'geral', ts: 1, file: oldFile }]));
  fs.writeFileSync(path.join(profileDir, 'media', oldFile.id), 'old secret');
  fs.writeFileSync(path.join(profileDir, 'media', `${oldFile.id}.json`), JSON.stringify(oldFile));
  const env = { ...process.env, PONTE_PROFILE: profileDir, PONTE_AUTOTEST: '1', PONTE_NAME: name, PONTE_DISCOVERY_PORT: '50820', PONTE_WINDOW_SIZE: '1000x760' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(__dirname, 'electron-profile.cjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  children.push(child);
  let sequence = 0;
  const requests = new Map();
  const log = fs.createWriteStream(path.join(dir, `${name}.log`));
  child.stdout.pipe(log); child.stderr.pipe(log);
  child.on('error', error => { for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(error); } requests.clear(); });
  child.on('message', message => {
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);
  });
  return { child, dir: profileDir, eval(expression) {
    return new Promise((resolve, reject) => {
      if (!child.connected) { reject(new Error('Electron process exited')); return; }
      const id = ++sequence;
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('Renderer request timeout')); }, 15000);
      requests.set(id, { resolve, reject, timer });
      const command = typeof expression === 'object' ? { ...expression, id } : { id, expression };
      child.send(command, error => { if (error) { clearTimeout(timer); requests.delete(id); reject(error); } });
    });
  } };
}
(async () => {
  const a = profile('Privacy A'), b = profile('Privacy B'), c = profile('Privacy C');
  for (const p of [a,b,c]) await until(() => p.eval('!!me && channels.length > 0'), 'renderer initialized');
  await until(() => a.eval('peers.length === 2'), 'three peers discovered');
  assert.equal(await c.eval('allMessages.some(m => m.id === "legacy-private")'), false);
  await assert.rejects(c.eval('api.openMedia("22222222-2222-4222-8222-222222222222", false)'), /autoriz|acesso/);
  assert.equal(await c.eval('(async()=>{try{return (await fetch("ponte-media://file/22222222-2222-4222-8222-222222222222")).status===404;}catch{return true;}})()'), true);
  await until(() => a.eval('[...conns.values()].some(c => c.pc.connectionState === "connected")'), 'public voice');
  console.log('ok real Electron public call connected');
  const code = await a.eval('api.createPrivateInvite()');
  assert.equal(await a.eval('allMessages.some(m => m.id === "legacy-private" && m.channel === "privado")'), true);
  await b.eval(`api.acceptPrivateInvite(${JSON.stringify(code)})`);
  await until(() => a.eval('me.privacy.pending.length === 1'), 'pending device');
  await a.eval('api.approvePrivateDevice(me.privacy.pending[0].fingerprint)');
  await until(() => b.eval('me.privacy.paired && me.privacy.online'), 'paired device');
  await a.eval('joinVoice("voz-privada")');
  await b.eval('joinVoice("voz-privada")');
  await until(() => a.eval('[...conns.values()].length === 1 && [...conns.values()][0].pc.connectionState === "connected"'), 'private voice');
  assert.equal(await c.eval('channels.some(c => c.id === "privado" || c.id === "voz-privada")'), false);
  const privateId = await a.eval('(async()=> (await api.sendChat({ channel: "privado", text: "PRIVATE E2E SECRET" })).id)()');
  await until(() => b.eval(`msgById.has(${JSON.stringify(privateId)})`), 'private chat received');
  assert.equal(await c.eval('allMessages.some(m => m.text.includes("PRIVATE E2E SECRET"))'), false);
  console.log('ok private call and chat isolated from third renderer');
  const fileId = await a.eval('(async()=>{ const m = await api.sendMedia({ channel: "privado", name: "private.txt", mime: "text/plain", bytes: new TextEncoder().encode("PRIVATE FILE SECRET") }); return m.file.id; })()');
  await until(() => b.eval(`allMessages.some(m => m.file?.id === ${JSON.stringify(fileId)} && m.file.local)`), 'private attachment');
  assert.equal(fs.existsSync(path.join(c.dir, 'media', fileId)), false);
  console.log('ok private attachment received only by authorized device');
  await b.eval({ action: 'pause-private' });
  const largeId = await a.eval('(async()=>{const bytes=new Uint8Array(12*1024*1024).fill(37);const m=await api.sendMedia({channel:"privado",name:"resume.bin",mime:"application/octet-stream",bytes});return m.file.id;})()');
  await until(() => fs.readdirSync(path.join(b.dir, 'media')).some(name => name.startsWith(largeId) && name.endsWith('.part')), 'partial attachment');
  await b.eval({ action: 'cut-private' });
  await until(() => fs.existsSync(path.join(b.dir, 'media', largeId)), 'interrupted attachment resumed', 35000);
  assert.equal(fs.readFileSync(path.join(b.dir, 'media', largeId)).equals(fs.readFileSync(path.join(a.dir, 'media', largeId))), true);
  assert.equal(fs.existsSync(path.join(c.dir, 'media', largeId)), false);
  console.log('ok interrupted 12 MiB private attachment resumes after TLS reconnect');
  await a.eval('joinVoice("voz-privada")');
  await b.eval('joinVoice("voz-privada")');
  await until(() => a.eval('[...conns.values()].some(c=>c.pc.connectionState==="connected")'), 'private call after reconnect');
  await a.eval('startScreen(null, qualityFor(1080, 60), null)');
  await until(() => b.eval('[...remotes.values()].some(r => r.videos?.size > 0)'), 'private screen track');
  const settings = await a.eval('screenStream.getVideoTracks()[0].getSettings()');
  assert.equal(settings.height, 1080);
  assert.equal(await a.eval('screenQuality.bitrate'), 7200000);
  await until(() => b.eval('(async()=>{for(const c of conns.values()){const stats=[...(await c.pc.getStats()).values()];if(stats.some(x=>x.type==="inbound-rtp"&&x.kind==="video"&&x.framesDecoded>0)&&stats.some(x=>x.type==="inbound-rtp"&&x.kind==="audio"&&x.bytesReceived>1000))return true;}return false;})()'), 'screen frames and sustained audio received');
  const media = await b.eval('(async()=>{const out=[];for(const c of conns.values()){const stats=await c.pc.getStats(); for(const x of stats.values())if(x.type==="inbound-rtp")out.push({kind:x.kind,bytes:x.bytesReceived,frames:x.framesDecoded,width:x.frameWidth,height:x.frameHeight});}return out;})()');
  assert.ok(media.some(s => s.kind === 'audio' && s.bytes > 0));
  assert.ok(media.some(s => s.kind === 'video' && s.frames > 0));
  assert.equal(await c.eval('[...remotes.values()].some(r => r.videos?.size > 0)'), false);
  console.log('ok private screen 1080p60 configured at 7.2 Mbps, received frames and audio:', JSON.stringify({ settings, media }));
  await a.eval('api.revokePrivateDevice()');
  await until(() => a.eval('!local.voice && conns.size === 0'), 'owner media stopped on revoke');
  await until(() => b.eval('!local.voice && conns.size === 0'), 'member media stopped on revoke');
  await a.eval('joinVoice("sala")');
  await until(() => a.eval('[...conns.values()].some(c => c.pc.connectionState === "connected")'), 'public voice after revoke');
  console.log('ok revocation closes private media and public call reconnects');
  await a.eval('openSettings()');
  assert.equal(await a.eval('document.querySelector("#dlg-settings").open'), true);
  await wait(500);
  await a.eval({ action: 'screenshot', path: path.join(dir, 'privacy-settings.png') });
  const shot = await a.eval('(async()=>{return {codeLabel:!!document.querySelector("label[for=private-code]"),status:document.querySelector("#private-status").textContent};})()');
  assert.equal(shot.codeLabel, true);
  console.log('ok privacy settings:', shot.status);
  console.log('Electron privacy integration PASSED. Logs:', dir);
})().catch(error => { console.error(error); console.error('Logs:', dir); process.exitCode = 1; }).finally(async () => {
  for (const child of children) if (child.connected) child.send({ quit: true });
  await wait(1500);
  for (const child of children) if (child.exitCode === null) child.kill();
});
