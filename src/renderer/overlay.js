'use strict';
/* global overlay */
const list = document.getElementById('list');

window.overlay.onData((members) => {
  list.textContent = '';
  for (const m of members.slice(0, 12)) {
    const li = document.createElement('li');
    li.classList.toggle('speaking', !!m.speaking);
    const av = document.createElement('span');
    av.className = 'av';
    av.style.background = m.color;
    av.textContent = m.initials;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.name;
    li.append(av, name);
    if (m.sharing) {
      const live = document.createElement('span');
      live.className = 'live';
      live.textContent = 'AO VIVO';
      li.append(live);
    }
    if (m.deafened || m.muted) {
      const f = document.createElement('span');
      f.className = 'flag';
      f.textContent = m.deafened ? '🔇' : '🎙️✕';
      li.append(f);
    }
    list.append(li);
  }
});
