import { DEFAULT_SETTINGS, evaluate, getSettings } from './lib/posture.js';

const ALARM = 'posture-check';
const NOTIF_ID = 'posture-warning';

// ---------- scheduling ----------

async function schedule() {
  const { enabled, intervalMin } = await getSettings();
  await chrome.alarms.clear(ALARM);
  if (enabled) {
    chrome.alarms.create(ALARM, { delayInMinutes: intervalMin, periodInMinutes: intervalMin });
  }
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const current = await chrome.storage.local.get(null);
  const missing = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([k]) => !(k in current)));
  await chrome.storage.local.set(missing);
  await schedule();
  if (reason === 'install') chrome.tabs.create({ url: 'setup.html' });
});

chrome.runtime.onStartup.addListener(schedule);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled || changes.intervalMin) schedule();
  if (changes.baseline) updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runCheck();
});

// ---------- offscreen document ----------

let creating = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Briefly read webcam frames to check sitting posture, and play an alert sound.',
    })
    .finally(() => (creating = null));
  await creating;
}

// ---------- the check ----------

let running = false;

async function runCheck({ manual = false } = {}) {
  if (running) return { busy: true };
  running = true;
  try {
    const settings = await getSettings();
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'sample', deviceId: settings.deviceId });

    let result;
    if (!res || res.error) {
      result = { time: Date.now(), status: 'error', error: res?.error, message: res?.message };
      if (res?.error === 'NotAllowedError') {
        notify('Camera access needed', 'Posture Guard cannot use the camera. Click here to grant access again.', true);
      }
    } else if (!res.metrics) {
      result = { time: Date.now(), status: 'away' };
    } else {
      const ev = evaluate(res.metrics, settings.baseline, settings.sensitivity);
      result = { time: Date.now(), status: ev.ok ? 'good' : 'bad', ...ev, metrics: res.metrics };
      if (!ev.ok) {
        const body = ev.issues.map((i) => `• ${i.fix}`).join('\n');
        const title = ev.issues.length === 1 ? ev.issues[0].title : `Fix your posture (score ${ev.score}/100)`;
        notify(title, body);
        if (settings.sound) chrome.runtime.sendMessage({ target: 'offscreen', type: 'chime' }).catch(() => {});
      } else {
        chrome.notifications.clear(NOTIF_ID);
      }
    }

    await chrome.storage.local.set({ lastResult: result });
    await updateBadge(result);
    return result;
  } finally {
    running = false;
  }
}

function notify(title, message, openSetup = false) {
  chrome.notifications.clear(NOTIF_ID, () => {
    chrome.notifications.create(NOTIF_ID, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 2,
      contextMessage: openSetup ? 'Posture Guard' : 'Posture Guard · click to open settings',
    });
  });
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === NOTIF_ID) {
    chrome.tabs.create({ url: 'setup.html' });
    chrome.notifications.clear(id);
  }
});

async function updateBadge(result) {
  const { enabled, baseline, lastResult } = await chrome.storage.local.get(['enabled', 'baseline', 'lastResult']);
  const r = result ?? lastResult;
  let text = '';
  let color = '#888';
  if (!enabled) {
    text = 'off';
  } else if (!baseline) {
    text = 'cal';
    color = '#d97706';
  } else if (r?.status === 'bad') {
    text = '!';
    color = '#dc2626';
  } else if (r?.status === 'good') {
    text = '✓';
    color = '#16a34a';
  } else if (r?.status === 'away' || r?.status === 'error') {
    text = '?';
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ---------- messages from popup / setup ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  if (msg.type === 'check-now') {
    runCheck({ manual: true }).then(sendResponse);
    return true;
  }
});
