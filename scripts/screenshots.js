'use strict';
// Gera as capturas do README em docs/img/ com dados de demonstração.
//   node scripts/screenshots.js            (todas)
//   node scripts/screenshots.js voz chat   (só algumas)
// Abre várias Ponte no mesmo computador (perfis separados, PONTE_DEMO=1) e
// salva a janela de quem está "fotografando". Nada do seu PC aparece: IPs,
// telas e janelas são de mentira.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electron = require('electron');
const outDir = path.join(root, 'docs', 'img', 'raw');
fs.mkdirSync(outDir, { recursive: true });

const PEOPLE = {
  Rafa: '0b6f3c1e-1111-4a5a-9c1e-000000000001',
  Lucas: '0b6f3c1e-2222-4a5a-9c1e-000000000002',
  Bia: '0b6f3c1e-3333-4a5a-9c1e-000000000003',
};

const today = new Date();
const at = (h, m) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).getTime();
// Anexo de exemplo (um .zip) que já está no computador de todo mundo
const ZIP = { id: '7d1e6a52-3c1f-4b8e-9a6d-2f4b8c9d0e11', name: 'mapa-da-ilha.zip', size: 2516582, mime: 'application/zip' };
const RAW = [
  ['Lucas', 'alguém on? abri a Ponte aqui', 21, 2],
  ['Rafa', 'eu! já apareceu você na lista sozinho', 21, 3, { reactions: { '🙌': ['Lucas', 'Bia'] } }],
  ['Bia', 'chegando 🙋‍♀️', 21, 3],
  ['Lucas', '@Rafa bora terminar a missão da ilha hoje?', 21, 4],
  ['Rafa', 'bora. entra na Squad que eu vou jogando', 21, 5, { replyTo: 3, edited: true }],
  ['Bia', '', 21, 5, { file: ZIP }],
  ['Bia', 'mandei o mapa aí em cima 👆', 21, 5],
  ['Lucas', 'transmito em 1080p 60 e vai só o som do jogo 😎', 21, 6, { reactions: { '🔥': ['Rafa', 'Bia'], '❤️': ['Rafa'] } }],
];
const HISTORY = RAW.map(([name, text, h, m, extra = {}], i) => {
  const msg = { id: `demo-${i}`, from: PEOPLE[name], name, text, ts: at(h, m), channel: 'geral', v: 1 };
  if (extra.reactions) msg.reactions = Object.fromEntries(Object.entries(extra.reactions).map(([e, who]) => [e, who.map((n) => PEOPLE[n])]));
  if (extra.replyTo !== undefined) {
    const [rn, rt] = RAW[extra.replyTo];
    msg.replyTo = { id: `demo-${extra.replyTo}`, name: rn, text: rt };
  }
  if (extra.edited) msg.edited = at(h, m) + 30000;
  if (extra.file) msg.file = extra.file;
  return msg;
});
const CHANNELS = [
  { id: 't-jogos', name: 'jogos', kind: 'text', ts: 1 },
  { id: 't-memes', name: 'memes', kind: 'text', ts: 1 },
  { id: 'v-squad', name: 'Squad', kind: 'voice', ts: 1 },
];

function profile(name) {
  const dir = path.join(root, `perfil-shot-${name.toLowerCase()}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    id: PEOPLE[name], name, manualHosts: name === 'Rafa' ? ['26.48.113.9'] : [], trayHintShown: true,
  }));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(HISTORY));
  fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify(CHANNELS));
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'media', ZIP.id), Buffer.alloc(16));
  fs.writeFileSync(path.join(dir, 'media', `${ZIP.id}.json`), JSON.stringify(ZIP));
  return dir;
}

function launch(name, env) {
  return spawn(electron, ['.'], {
    cwd: root,
    env: {
      ...process.env,
      PONTE_AUTOTEST: '1',
      PONTE_DEMO: '1',
      // Porta própria: as janelas de demonstração nunca acham a Ponte de ninguém de verdade.
      PONTE_DISCOVERY_PORT: '49999',
      PONTE_NAME: name,
      PONTE_PROFILE: profile(name),
      PONTE_DEMO_PLAYING: name === 'Lucas' ? 'Ilha das Gaivotas' : name === 'Bia' ? 'Minecraft' : '',
      ...env,
    },
    // Só quem tira a foto tem a saída lida; os outros não podem travar com o buffer cheio.
    stdio: ['ignore', env.PONTE_SHOT ? 'pipe' : 'ignore', 'ignore'],
  });
}

async function scene(file, shooterEnv, others = {}) {
  const procs = [];
  for (const [name, env] of Object.entries(others)) procs.push(launch(name, env));
  await new Promise((r) => setTimeout(r, 1500));
  const out = path.join(outDir, `${file}.png`);
  const shooter = launch('Rafa', { PONTE_SHOT: out, ...shooterEnv });
  procs.push(shooter);
  let log = '';
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 60000);
    shooter.stdout.on('data', (d) => {
      log += d;
      if (/captura salva/.test(log)) { clearTimeout(timer); resolve(true); }
    });
  });
  const ok = await done;
  for (const p of procs) p.kill();
  await new Promise((r) => setTimeout(r, 1500));
  console.log(ok ? `ok ${file}` : `FALHOU ${file}\n${log.slice(-2000)}`);
  return ok;
}

const SCENES = {
  chat: () => scene('chat', { PONTE_AUTOTEST_VIEW: 'chat', PONTE_SHOT_DELAY: '9000' }, { Lucas: {}, Bia: {} }),
  voz: () => scene('voz',
    { PONTE_AUTOTEST_FOCUS: '1', PONTE_SHOT_DELAY: '16000' },
    { Lucas: { PONTE_AUTOTEST_SHARE: '1', PONTE_AUTOTEST_RES: '1080', PONTE_AUTOTEST_FPS: '60' }, Bia: {} }),
  tela: () => scene('tela',
    { PONTE_AUTOTEST_DIALOG: 'screen', PONTE_SHOT_DELAY: '8000' },
    { Lucas: {}, Bia: {} }),
  ajustes: () => scene('ajustes',
    { PONTE_AUTOTEST_DIALOG: 'settings', PONTE_SHOT_DELAY: '7000' },
    { Lucas: {}, Bia: {} }),
};

(async () => {
  const wanted = process.argv.slice(2);
  let failed = 0;
  for (const [name, run] of Object.entries(SCENES)) {
    if (wanted.length && !wanted.includes(name)) continue;
    if (!(await run())) failed += 1;
  }
  for (const n of Object.keys(PEOPLE)) fs.rmSync(path.join(root, `perfil-shot-${n.toLowerCase()}`), { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
