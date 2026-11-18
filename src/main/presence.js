'use strict';
// Status "Jogando ..." automático.
//
// A cada poucos segundos pergunta ao ponte-audio.exe qual janela está na
// frente. Se for um jogo (conhecido, instalado numa biblioteca de jogos ou um
// programa em tela cheia que não é navegador/ferramenta), vira o status. O
// status fica enquanto o jogo estiver aberto, mesmo dando Alt+Tab.

const { execFile } = require('node:child_process');
const path = require('node:path');

const KNOWN = {
  'robloxplayerbeta.exe': 'Roblox',
  'minecraft.windows.exe': 'Minecraft',
  'valorant-win64-shipping.exe': 'VALORANT',
  'league of legends.exe': 'League of Legends',
  'fortniteclient-win64-shipping.exe': 'Fortnite',
  'cs2.exe': 'Counter-Strike 2',
  'overwatch.exe': 'Overwatch 2',
  'forzahorizon5.exe': 'Forza Horizon 5',
  'forzahorizon4.exe': 'Forza Horizon 4',
  'factorygame-win64-shipping.exe': 'Satisfactory',
  'factorygamesteam-win64-shipping.exe': 'Satisfactory',
  'osu!.exe': 'osu!',
  'gta5.exe': 'GTA V',
  'gta5_enhanced.exe': 'GTA V',
  'rocketleague.exe': 'Rocket League',
  'pavlov-win64-shipping.exe': 'Pavlov',
  'r5apex.exe': 'Apex Legends',
  'r5apex_dx12.exe': 'Apex Legends',
  'eldenring.exe': 'Elden Ring',
  'dota2.exe': 'Dota 2',
  'rainbowsix.exe': 'Rainbow Six Siege',
  'eurotrucks2.exe': 'Euro Truck Simulator 2',
  'terraria.exe': 'Terraria',
  'stardew valley.exe': 'Stardew Valley',
  'among us.exe': 'Among Us',
  'beat saber.exe': 'Beat Saber',
  'lethal company.exe': 'Lethal Company',
  'repo.exe': 'R.E.P.O.',
  'peak.exe': 'PEAK',
};

// Programas que não são jogo mesmo em tela cheia
const NOT_GAMES = new Set([
  'explorer.exe', 'brave.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'operagx.exe',
  'discord.exe', 'ponte.exe', 'electron.exe', 'code.exe', 'cursor.exe', 'claude.exe', 'chatgpt.exe',
  'notion.exe', 'spotify.exe', 'vlc.exe', 'mpc-hc64.exe', 'obs64.exe', 'steam.exe', 'steamwebhelper.exe',
  'epicgameslauncher.exe', 'riotclientux.exe', 'riotclientservices.exe', 'battle.net.exe', 'applicationframehost.exe',
  'searchhost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'lockapp.exe', 'textinputhost.exe',
  'powershell.exe', 'windowsterminal.exe', 'cmd.exe', 'taskmgr.exe', 'whatsapp.exe', 'whatsapp.root.exe',
  'teams.exe', 'ms-teams.exe', 'zoom.exe', 'idea64.exe', 'devenv.exe', 'unity.exe', 'blender.exe',
  'photoshop.exe', 'fl64.exe', 'lunar client.exe', 'modrinth app.exe', 'curseforge.exe', 'gemini.exe',
  'geminiapplauncher.exe', 'rave.exe', 'blitz.exe', 'parsecd.exe', 'anydesk.exe', 'rvrvpngui.exe',
]);

const LIBRARY = /\\(steamapps\\common|epic games|riot games|xboxgames|gog games|ubisoft game launcher\\games|ea games)\\/i;

function cleanTitle(t) {
  return String(t || '').replace(/\s+[-–|].*$/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** Decide se a janela da frente é um jogo e qual o nome dele. */
function gameName(fg) {
  if (!fg || !fg.path) return '';
  const exe = path.basename(fg.path).toLowerCase();
  if (exe === 'javaw.exe' || exe === 'java.exe') return /minecraft|lunar|badlion/i.test(fg.title) ? 'Minecraft' : '';
  if (KNOWN[exe]) return KNOWN[exe];
  if (NOT_GAMES.has(exe) || /^c:\\windows\\/i.test(fg.path)) return '';
  const name = cleanTitle(fg.title) || exe.replace(/\.exe$/, '');
  if (LIBRARY.test(fg.path)) return name;
  if (fg.fullscreen) return name;
  return '';
}

function createPresence({ helper, onChange, intervalMs = 4000 }) {
  let current = null; // { pid, name }
  let fullscreenGame = false;
  let busy = false;

  function set(next, full) {
    const before = current ? current.name : '';
    current = next;
    fullscreenGame = full;
    const now = current ? current.name : '';
    if (now !== before) onChange({ playing: now });
  }

  function poll() {
    if (busy || !helper) return;
    busy = true;
    execFile(helper, ['foreground'], { windowsHide: true, timeout: 3000, encoding: 'utf8' }, (err, out) => {
      busy = false;
      let fg = null;
      try { fg = JSON.parse(String(out || '').trim()); } catch {}
      if (err || !fg) return;
      // Jogo atual continua aberto (mesmo em segundo plano): mantém.
      if (current && alive(current.pid) && fg.pid !== current.pid) { set(current, false); return; }
      const name = gameName(fg);
      if (name) set({ pid: fg.pid, name }, !!fg.fullscreen);
      else if (!current || !alive(current.pid)) set(null, false);
      else set(current, false);
    });
  }

  const timer = setInterval(poll, intervalMs);
  poll();
  return {
    playing: () => (current ? current.name : ''),
    /** true quando o jogo está na frente em tela cheia (para avisar só menções). */
    inFullscreenGame: () => fullscreenGame,
    dispose: () => clearInterval(timer),
  };
}

module.exports = { createPresence, gameName };
