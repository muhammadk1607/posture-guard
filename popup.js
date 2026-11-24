import { getSettings } from './lib/posture.js';

const $ = (id) => document.getElementById(id);

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleTimeString();
}

async function render() {
  const settings = await getSettings();
  const { lastResult: r } = await chrome.storage.local.get('lastResult');
  const head = $('headline');
  const status = $('status');
  const issues = $('issues');
  issues.innerHTML = '';
  status.className = 'status';

  $('toggle').textContent = settings.enabled ? 'Pause' : 'Resume';

  if (!settings.baseline) {
    head.textContent = 'Not calibrated';
    $('when').textContent = 'Open settings to calibrate your good posture.';
    status.classList.add('warn');
    return;
  }
  if (!r) {
    head.textContent = settings.enabled ? 'Waiting for first check' : 'Paused';
    $('when').textContent = settings.enabled ? `Checks run every ${settings.intervalMin} min` : '';
    return;
  }
  $('when').textContent = `Last check ${timeAgo(r.time)}${settings.enabled ? '' : ' · paused'}`;
  if (r.status === 'good') {
    head.textContent = `Good posture · ${r.score}/100`;
    status.classList.add('good');
  } else if (r.status === 'bad') {
    head.textContent = `Adjust your posture · ${r.score}/100`;
    status.classList.add('bad');
    for (const i of r.issues) {
      const li = document.createElement('li');
      li.innerHTML = `<b></b><span></span>`;
      li.querySelector('b').textContent = i.title;
      li.querySelector('span').textContent = i.fix;
      issues.appendChild(li);
    }
  } else if (r.status === 'away') {
    head.textContent = 'Couldn\'t see you';
    $('when').textContent += ' · head and shoulders not in view';
  } else {
    head.textContent = 'Camera error';
    $('when').textContent = r.message || r.error || '';
    status.classList.add('warn');
  }
}

$('check').onclick = async () => {
  const btn = $('check');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  await chrome.runtime.sendMessage({ target: 'background', type: 'check-now' });
  btn.disabled = false;
  btn.textContent = 'Check now';
  render();
};

$('toggle').onclick = async () => {
  const { enabled } = await getSettings();
  await chrome.storage.local.set({ enabled: !enabled });
  render();
};

$('open-setup').onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
};

render();
