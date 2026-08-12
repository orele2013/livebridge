'use strict';

/** Utilidades compartidas por las dos pantallas. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function makeLogger(containerId, max = 300) {
  const box = document.getElementById(containerId);
  return function log(text, level = 'info') {
    if (!box) return;
    const line = document.createElement('div');
    line.className = `line ${level}`;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = new Date().toLocaleTimeString();
    line.append(ts, document.createTextNode(text));
    box.appendChild(line);
    while (box.childElementCount > max) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  };
}

function setDot(dotEl, textEl, state, text) {
  if (dotEl) dotEl.className = `dot ${state || ''}`.trim();
  if (textEl) textEl.textContent = text;
}

function fmtDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

document.addEventListener('click', (event) => {
  const back = event.target.closest('#back');
  if (back) location.href = 'index.html';
});
