'use strict';
// Só para as capturas do README (PONTE_DEMO=1): uma cena animada no lugar da
// tela de verdade, e telas/janelas de mentira no seletor, para não mostrar
// nada do computador de quem gera as imagens.

function drawDemoScene(g, w, h, t) {
  // Céu de fim de tarde
  const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#120c3a');
  sky.addColorStop(0.55, '#6b2a7a');
  sky.addColorStop(1, '#ff8a4c');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);

  // Estrelas
  g.fillStyle = 'rgba(255,255,255,.8)';
  for (let i = 0; i < 70; i++) {
    const x = (i * 197.3) % w;
    const y = (i * 71.7) % (h * 0.35);
    const r = ((i * 13) % 3) * 0.4 * (w / 1280) + 0.6;
    g.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(t / 900 + i));
    g.fillRect(x, y, r, r);
  }
  g.globalAlpha = 1;

  // Sol
  const sx = w * 0.68;
  const sy = h * 0.6;
  const sr = h * 0.2;
  const sun = g.createLinearGradient(0, sy - sr, 0, sy + sr);
  sun.addColorStop(0, '#ffe08a');
  sun.addColorStop(1, '#ff4f6d');
  g.fillStyle = sun;
  g.beginPath();
  g.arc(sx, sy, sr, Math.PI, 0);
  g.fill();

  // Montanhas em camadas
  const ridge = (base, amp, freq, speed, color) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 80) {
      const k = (x + t * speed) / w;
      const y = base - amp * (Math.sin(k * freq) * 0.6 + Math.sin(k * freq * 2.7 + 1.3) * 0.3 + Math.sin(k * freq * 6.1) * 0.1);
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.fill();
  };
  ridge(h * 0.6, h * 0.16, 5, 0.004, '#3a1d5c');
  ridge(h * 0.64, h * 0.1, 8, 0.01, '#271446');

  // Mar com reflexo
  const sea = g.createLinearGradient(0, h * 0.62, 0, h);
  sea.addColorStop(0, '#2b1650');
  sea.addColorStop(1, '#0a0820');
  g.fillStyle = sea;
  g.fillRect(0, h * 0.62, w, h * 0.38);
  for (let i = 0; i < 14; i++) {
    const y = h * 0.64 + i * i * h * 0.0018;
    const half = sr * (1 - i / 16) * (0.7 + 0.3 * Math.sin(t / 400 + i));
    g.fillStyle = `rgba(255, ${150 - i * 6}, 110, ${0.75 - i * 0.045})`;
    g.fillRect(sx - half, y, half * 2, Math.max(2, h * 0.006));
  }

  // Barquinho
  const bx = ((t * 0.06) % (w + 200)) - 100;
  const by = h * 0.7 + Math.sin(t / 500) * h * 0.006;
  const s = h / 720;
  g.fillStyle = '#0d0b1f';
  g.beginPath();
  g.moveTo(bx - 46 * s, by);
  g.lineTo(bx + 46 * s, by);
  g.lineTo(bx + 30 * s, by + 16 * s);
  g.lineTo(bx - 30 * s, by + 16 * s);
  g.fill();
  g.fillRect(bx - 2 * s, by - 70 * s, 4 * s, 70 * s);
  g.beginPath();
  g.moveTo(bx + 4 * s, by - 66 * s);
  g.lineTo(bx + 44 * s, by - 8 * s);
  g.lineTo(bx + 4 * s, by - 8 * s);
  g.fill();

  // HUD do "jogo"
  const pad = 26 * s;
  g.fillStyle = 'rgba(0,0,0,.35)';
  roundRect(g, pad, pad, 250 * s, 64 * s, 14 * s);
  g.fill();
  g.fillStyle = '#fff';
  g.font = `700 ${22 * s}px Inter, system-ui, sans-serif`;
  g.fillText('Ilha das Gaivotas', pad + 18 * s, pad + 28 * s);
  g.fillStyle = 'rgba(255,255,255,.7)';
  g.font = `600 ${15 * s}px Inter, system-ui, sans-serif`;
  g.fillText('Missão 3 · 18:42', pad + 18 * s, pad + 50 * s);
  // barra de vida
  g.fillStyle = 'rgba(0,0,0,.35)';
  roundRect(g, pad, h - pad - 22 * s, 260 * s, 22 * s, 11 * s);
  g.fill();
  g.fillStyle = '#30d158';
  roundRect(g, pad + 4 * s, h - pad - 18 * s, 190 * s, 14 * s, 7 * s);
  g.fill();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Cena animada no lugar da captura de tela. */
function demoScene(q) {
  const canvas = document.createElement('canvas');
  canvas.width = q.w;
  canvas.height = q.h;
  const g = canvas.getContext('2d');
  const start = performance.now() - 40000;
  const paint = () => drawDemoScene(g, q.w, q.h, performance.now() - start);
  paint();
  setInterval(paint, 1000 / q.fps);
  return canvas.captureStream(q.fps);
}

function thumb(draw) {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  draw(c.getContext('2d'), 320, 180);
  return c.toDataURL();
}

function fakeWindow(g, w, h, bg, bar, lines) {
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = bar;
  g.fillRect(0, 0, w, 18);
  g.fillStyle = 'rgba(255,255,255,.18)';
  for (let i = 0; i < lines; i++) {
    roundRect(g, 16, 32 + i * 18, 80 + ((i * 67) % 200), 9, 4);
    g.fill();
  }
}

/** Telas e janelas de mentira para o seletor. */
function demoSources() {
  const game = thumb((g, w, h) => drawDemoScene(g, w, h, 52000));
  return [
    { id: 'screen:1:0', name: 'Tela 1', thumb: game },
    { id: 'screen:2:0', name: 'Tela 2', thumb: thumb((g, w, h) => fakeWindow(g, w, h, '#1c1c1e', '#2c2c2e', 7)) },
    { id: 'window:1:0', name: 'Ilha das Gaivotas', thumb: game },
    { id: 'window:2:0', name: 'Navegador', thumb: thumb((g, w, h) => fakeWindow(g, w, h, '#f2f2f7', '#d1d1d6', 0)) },
    { id: 'window:3:0', name: 'Música', thumb: thumb((g, w, h) => fakeWindow(g, w, h, '#2a0f1f', '#3d1630', 5)) },
  ];
}

function demoAudioApps() {
  return [
    { hwnd: '1', pid: 4100, exe: 'Gaivotas.exe', title: 'Ilha das Gaivotas' },
    { hwnd: '2', pid: 4200, exe: 'Navegador.exe', title: 'Navegador' },
    { hwnd: '3', pid: 4300, exe: 'Musica.exe', title: 'Música' },
  ];
}
