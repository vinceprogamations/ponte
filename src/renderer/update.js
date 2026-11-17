'use strict';
// Janelinha de abertura: o processo principal chama window.paint(status).
const TEXT = {
  idle: 'Procurando atualizações…',
  checking: 'Procurando atualizações…',
  latest: 'Abrindo…',
  error: 'Abrindo…',
  ready: 'Instalando a atualização…',
};

window.paint = (s) => {
  const bar = document.getElementById('bar');
  const fill = document.getElementById('fill');
  let text = TEXT[s.state] || TEXT.idle;
  if (s.state === 'downloading') text = `Baixando a versão ${s.next}… ${s.percent}%`;
  document.getElementById('text').textContent = text;
  document.getElementById('version').textContent = `v${s.version}`;
  bar.hidden = !['checking', 'downloading', 'ready'].includes(s.state);
  bar.classList.toggle('busy', s.state === 'checking' || s.state === 'ready');
  fill.style.width = s.state === 'downloading' ? `${s.percent}%` : '';
};
