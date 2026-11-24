// App window shell: view switching, the live status pill, and wiring between the two views.

import { renderReports } from './reports.js';
import { applySettings, hideSetup, showSetup } from './setup.js';

const $ = (id) => document.getElementById(id);
let view = null;
let status = null;

function show(next) {
  if (next !== 'reports' && next !== 'setup') next = 'reports';
  if (view === next) return;
  if (view === 'setup') hideSetup();
  view = next;
  $('view-reports').hidden = view !== 'reports';
  $('view-setup').hidden = view !== 'setup';
  for (const b of document.querySelectorAll('.tabs button')) {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  }
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view === 'reports') renderReports();
  else showSetup();
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function paintStatus() {
  if (!status) return;
  const { settings: s, lastResult: r, running } = status;
  const pill = $('now-pill');
  let cls = 'idle';
  let text;
  if (running) text = 'Checking…';
  else if (!s.baseline) {
    cls = 'warn';
    text = 'Not calibrated';
  } else if (!s.enabled) text = 'Paused';
  else if (s.pausedUntil > Date.now())
    text = `Paused until ${new Date(s.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  else if (!r) text = `First check in ${s.intervalMin} min`;
  else if (r.status === 'good') {
    cls = 'good';
    text = `Good posture · ${r.score}/100 · ${timeAgo(r.t)}`;
  } else if (r.status === 'bad') {
    cls = 'bad';
    text = `Poor posture · ${r.score}/100 · ${timeAgo(r.t)}`;
  } else if (r.status === 'away') text = `Couldn't see you · ${timeAgo(r.t)}`;
  else {
    cls = 'warn';
    text = `Camera error · ${timeAgo(r.t)}`;
  }
  pill.className = `pill ${cls}`;
  $('now-text').textContent = text;
  $('now-pill').title = r?.status === 'error' ? r.message || r.error || '' : '';
  $('check-now').disabled = running || !s.baseline;
}

async function refreshStatus() {
  status = await window.pg.getStatus();
  applySettings(status.settings, status.openAtLogin);
  paintStatus();
}

$('check-now').onclick = async () => {
  $('check-now').disabled = true;
  $('now-text').textContent = 'Checking…';
  await window.pg.checkNow();
  await refreshStatus();
};

for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => show(b.dataset.view);
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
window.pg.onNavigate((v) => show(v));
window.pg.onStatus((st) => {
  status = st;
  applySettings(st.settings, st.openAtLogin);
  paintStatus();
});
window.pg.onCheck(async () => {
  await refreshStatus();
  if (view === 'reports') renderReports();
});
setInterval(paintStatus, 30_000);

await refreshStatus();
show(location.hash.slice(1) || 'reports');
