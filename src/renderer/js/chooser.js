'use strict';

document.getElementById('go-studio').addEventListener('click', () => {
  window.api.settings.set({ mode: 'studio' });
  location.href = 'studio.html';
});

document.getElementById('go-sender').addEventListener('click', () => {
  window.api.settings.set({ mode: 'sender' });
  location.href = 'sender.html';
});

window.api.info().then((info) => {
  document.getElementById('env').textContent =
    `${info.platform}/${info.arch} · Electron ${info.versions.electron} · Chromium ${info.versions.chrome}`;
});
