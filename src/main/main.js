// Posture Guard desktop app: main process.
// Lives in the system tray, runs a posture check on a timer in a hidden window, raises desktop
// notifications, and records every check to local history for the reports page.

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, ISSUES } from '../shared/posture.js';
import { DAY, formatDuration, startOfDay, summarize, toCsv } from '../shared/analytics.js';
import { HistoryStore, SettingsStore } from './store.js';
import { getOpenAtLogin, launchedHidden, setOpenAtLogin } from './autostart.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEME = 'app';
const APP_ORIGIN = `${SCHEME}://pg`;
const pageUrl = (p) => `${APP_ORIGIN}/${p}`;
const asset = (p) => path.join(ROOT, p);
const HISTORY_KEEP_DAYS = 400;

// ---------- single instance + early setup ----------

// Development aid: keep test data away from your real history (PG_USER_DATA=/tmp/x npm start).
if (process.env.PG_USER_DATA) app.setPath('userData', process.env.PG_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setName('Posture Guard');
if (process.platform === 'win32') app.setAppUserModelId('com.postureguard.app');

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let settings; // SettingsStore
let history; // HistoryStore
let tray = null;
let mainWindow = null;
let worker = null;
let quitting = false;

let lastResult = null;
let nextCheckAt = null;
let timer = null;
let running = false;
let previewActive = false; // the setup page has the live camera open
let lastWarnAt = 0;
let currentNotification = null;

// ---------- app:// protocol (serves our files so ES modules, fetch and WASM work) ----------

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.task': 'application/octet-stream',
};

function registerProtocol() {
  protocol.handle(SCHEME, async (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!file.startsWith(ROOT + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      // fs is asar-aware, so this works in the packaged app too.
      const body = await fsp.readFile(file);
      return new Response(body, {
        headers: {
          'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------- camera permission ----------

function setupPermissions() {
  const ours = (url) => typeof url === 'string' && url.startsWith(APP_ORIGIN);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const videoOnly = !details.mediaTypes?.length || details.mediaTypes.every((t) => t === 'video');
    cb(permission === 'media' && videoOnly && ours(details.requestingUrl ?? wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    return permission === 'media' && ours(origin);
  });
}

async function ensureMacCameraAccess() {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'granted') return true;
  if (status === 'not-determined') return systemPreferences.askForMediaAccess('camera');
  return false;
}

// ---------- hidden worker window: camera sampling + chime ----------

const pending = new Map();
let reqId = 0;

function createWorker() {
  worker = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(ROOT, 'src/preload.cjs'),
      backgroundThrottling: false, // timers must keep running while the window is hidden
    },
  });
  worker.loadURL(pageUrl('src/renderer/worker.html'));
  worker.on('closed', () => {
    worker = null;
    for (const { reject } of pending.values()) reject(new Error('Worker closed'));
    pending.clear();
  });
  worker.webContents.on('render-process-gone', () => {
    if (!quitting) {
      worker?.destroy();
      createWorker();
    }
  });
}

function askWorker(type, payload = {}, timeoutMs = 30_000) {
  if (!worker) createWorker();
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('The camera check timed out'), { name: 'TimeoutError' }));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => (clearTimeout(t), resolve(v)),
      reject: (e) => (clearTimeout(t), reject(e)),
    });
    const send = () => worker.webContents.send('worker:request', { id, type, ...payload });
    if (worker.webContents.isLoading()) worker.webContents.once('did-finish-load', send);
    else send();
  });
}

ipcMain.on('worker:response', (_e, { id, ...res }) => {
  pending.get(id)?.resolve(res);
  pending.delete(id);
});

// ---------- scheduling ----------

function schedule() {
  clearTimeout(timer);
  timer = null;
  nextCheckAt = null;
  const s = settings.get();
  if (s.enabled) {
    const now = Date.now();
    let delay = s.intervalMin * 60_000;
    if (s.pausedUntil > now) delay = s.pausedUntil - now + 1000;
    nextCheckAt = now + delay;
    timer = setTimeout(tick, delay);
  }
  refreshTray();
  broadcast('status:changed', statusPayload());
}

async function tick() {
  timer = null;
  const s = settings.get();
  if (s.pausedUntil && s.pausedUntil <= Date.now()) settings.set({ pausedUntil: 0 });
  const locked = powerMonitor.getSystemIdleState(1) === 'locked';
  // Skip quietly (and record nothing) while the screen is locked or the setup preview is open.
  if (s.enabled && s.baseline && !locked && !previewActive) {
    await runCheck({ manual: false }).catch((e) => console.error('check failed', e));
  }
  schedule();
}

// ---------- the check ----------

async function runCheck({ manual }) {
  if (running) return { busy: true };
  running = true;
  refreshTray();
  try {
    const s = settings.get();
    let res;
    if (!(await ensureMacCameraAccess())) {
      res = { error: 'NotAllowedError', message: 'Camera access is turned off for Posture Guard in System Settings.' };
    } else {
      res = await askWorker('sample', { deviceId: s.deviceId }).catch((e) => ({ error: e.name, message: e.message }));
    }

    const time = Date.now();
    const dur = manual ? 0 : s.intervalMin * 60;
    let result;
    if (!res || res.error) {
      result = { t: time, status: 'error', error: res?.error, message: res?.message, dur };
      if (res?.error === 'NotAllowedError') {
        notify('Camera access needed', 'Posture Guard cannot use the camera. Click to open settings.');
      }
    } else if (!res.metrics) {
      result = { t: time, status: 'away', dur };
    } else {
      const ev = evaluate(res.metrics, s.baseline, s.sensitivity);
      result = { t: time, status: ev.ok ? 'good' : 'bad', score: ev.score, issues: ev.issues.map((i) => i.code), dur };
      if (!ev.ok) {
        const cooledDown = time - lastWarnAt >= (s.notifyCooldownMin || 0) * 60_000;
        if (manual || cooledDown) {
          const title = ev.issues.length === 1 ? ev.issues[0].title : `Fix your posture (score ${ev.score}/100)`;
          notify(title, ev.issues.map((i) => `• ${i.fix}`).join('\n'));
          if (s.sound) askWorker('chime').catch(() => {});
          lastWarnAt = time;
          result.warned = true;
        }
      } else {
        currentNotification?.close();
        currentNotification = null;
      }
    }
    if (manual) result.manual = true;

    // Errors are not posture data; keep them out of history except as "away" time.
    history.append(result.status === 'error' ? { t: time, status: 'away', dur, manual: result.manual } : result);
    await refreshTodaySummary().catch(() => {});
    lastResult = result;
    broadcast('check:done', result);
    return result;
  } finally {
    running = false;
    refreshTray();
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  currentNotification?.close();
  const n = new Notification({
    title,
    body,
    icon: asset('icons/icon128.png'),
    silent: true, // we play our own chime when sound is on
    urgency: 'normal',
  });
  n.on('click', () => openWindow('setup'));
  n.show();
  currentNotification = n;
}

// ---------- status, tray ----------

function statusPayload() {
  return { settings: settings.get(), lastResult, nextCheckAt, running, openAtLogin: getOpenAtLogin() };
}

function trayState() {
  const s = settings.get();
  if (!s.enabled || s.pausedUntil > Date.now()) return 'paused';
  if (!s.baseline) return 'calibrate';
  return lastResult?.status ?? 'idle';
}

const DOT = {
  good: [12, 163, 12],
  bad: [208, 59, 59],
  calibrate: [250, 178, 25],
  error: [250, 178, 25],
  away: [138, 138, 133],
  paused: [138, 138, 133],
};

const trayIconCache = {};
function trayIcon(state) {
  if (trayIconCache[state]) return trayIconCache[state];
  const size = process.platform === 'win32' ? 16 : process.platform === 'darwin' ? 18 : 32;
  const base = nativeImage.createFromPath(asset('icons/icon48.png')).resize({ width: size, height: size, quality: 'best' });
  const rgb = DOT[state];
  let img = base;
  if (rgb) {
    // Paint a status dot with a light ring in the bottom-right corner. Bitmaps are BGRA, premultiplied.
    const buf = Buffer.from(base.toBitmap());
    const r = size * 0.26;
    const ring = Math.max(1, size / 16);
    const cx = size - r - ring;
    const cy = size - r - ring;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const outer = Math.min(1, Math.max(0, r + ring - d + 0.5));
        if (outer <= 0) continue;
        const inner = Math.min(1, Math.max(0, r - d + 0.5));
        const col = [0, 1, 2].map((c) => 255 * (1 - inner) + rgb[c] * inner); // ring is white
        const i = (y * size + x) * 4;
        const a = buf[i + 3] / 255;
        const outA = outer + a * (1 - outer);
        // over-composite in premultiplied space: dst = src*αs + dst*(1-αs)
        buf[i + 2] = Math.round(col[0] * outer + buf[i + 2] * (1 - outer));
        buf[i + 1] = Math.round(col[1] * outer + buf[i + 1] * (1 - outer));
        buf[i + 0] = Math.round(col[2] * outer + buf[i + 0] * (1 - outer));
        buf[i + 3] = Math.round(outA * 255);
      }
    }
    img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  }
  trayIconCache[state] = img;
  return img;
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusLine() {
  const s = settings.get();
  const r = lastResult;
  if (running) return 'Checking…';
  if (!s.baseline) return 'Not calibrated: open Settings';
  if (!s.enabled) return 'Paused';
  if (s.pausedUntil > Date.now()) {
    return `Paused until ${new Date(s.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (!r) return 'Waiting for first check';
  const when = timeAgo(r.t);
  if (r.status === 'good') return `Good posture · ${r.score}/100 · ${when}`;
  if (r.status === 'bad') return `Adjust your posture · ${r.score}/100 · ${when}`;
  if (r.status === 'away') return `Couldn't see you · ${when}`;
  return `Camera error · ${when}`;
}

let todaySummary = '';
async function refreshTodaySummary() {
  const from = startOfDay(Date.now());
  const sum = summarize(await history.query(from, from + DAY), { from, to: from + DAY, bucket: 'day' }).totals;
  todaySummary = `Today: ${formatDuration(sum.goodSec)} good · ${sum.warnings} warning${sum.warnings === 1 ? '' : 's'}`;
}

function refreshTray() {
  if (!tray) return;
  const s = settings.get();
  const paused = !s.enabled || s.pausedUntil > Date.now();
  const pauseFor = (min) => () => {
    settings.set({ enabled: true, pausedUntil: Date.now() + min * 60_000 });
    schedule();
  };
  const menu = Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    { label: todaySummary || 'Today: no data yet', enabled: false },
    { type: 'separator' },
    { label: 'Check now', enabled: !running && !!s.baseline, click: () => runCheck({ manual: true }).then(schedule) },
    paused
      ? {
          label: 'Resume checks',
          click: () => {
            settings.set({ enabled: true, pausedUntil: 0 });
            schedule();
          },
        }
      : {
          label: 'Pause',
          submenu: [
            { label: 'For 30 minutes', click: pauseFor(30) },
            { label: 'For 1 hour', click: pauseFor(60) },
            { label: 'For 2 hours', click: pauseFor(120) },
            {
              label: 'Until I resume',
              click: () => {
                settings.set({ enabled: false, pausedUntil: 0 });
                schedule();
              },
            },
          ],
        },
    { type: 'separator' },
    { label: 'Reports…', click: () => openWindow('reports') },
    { label: 'Settings & calibration…', click: () => openWindow('setup') },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: getOpenAtLogin(),
      click: (item) => applyOpenAtLogin(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit Posture Guard', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setImage(trayIcon(trayState()));
  tray.setToolTip(`Posture Guard: ${statusLine()}`);
}

function applyOpenAtLogin(enabled) {
  try {
    setOpenAtLogin(enabled);
    settings.set({ openAtLogin: enabled });
  } catch (e) {
    dialog.showErrorBox('Posture Guard', `Could not change the login setting: ${e.message}`);
  }
  refreshTray();
  broadcast('status:changed', statusPayload());
}

function createTray() {
  tray = new Tray(trayIcon(trayState()));
  // Linux app indicators ignore clicks and always show the menu; elsewhere a click opens the app.
  tray.on('click', () => {
    if (process.platform !== 'linux') openWindow('reports');
  });
  refreshTray();
}

// ---------- main window ----------

function openWindow(view = 'reports') {
  if (mainWindow) {
    mainWindow.webContents.send('navigate', view);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 420,
    minHeight: 500,
    title: 'Posture Guard',
    icon: asset('icons/icon128.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161615' : '#f7f7f5',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(ROOT, 'src/preload.cjs') },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`${pageUrl('src/renderer/app.html')}#${view}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (process.platform === 'darwin') app.dock?.show();
  // External links open in the browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
  });
  // Closing the window just frees its memory; the app keeps running in the tray.
  mainWindow.on('closed', () => {
    mainWindow = null;
    previewActive = false;
    if (process.platform === 'darwin' && !quitting) app.dock?.hide();
  });
}

function broadcast(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

// ---------- IPC from the app window ----------

ipcMain.handle('status:get', () => statusPayload());

ipcMain.handle('settings:set', (_e, patch) => {
  if ('openAtLogin' in patch) {
    applyOpenAtLogin(!!patch.openAtLogin);
    delete patch.openAtLogin;
  }
  if ('intervalMin' in patch) patch.intervalMin = Math.min(120, Math.max(1, Number(patch.intervalMin) || 2));
  const s = settings.set(patch);
  if ('enabled' in patch || 'intervalMin' in patch || 'pausedUntil' in patch || 'baseline' in patch) schedule();
  else refreshTray();
  return s;
});

ipcMain.handle('check:now', () => runCheck({ manual: true }).finally(schedule));

ipcMain.on('preview:active', (_e, active) => {
  previewActive = !!active;
});

ipcMain.handle('history:query', (_e, { from, to }) => history.query(from, to));

ipcMain.handle('history:first-day', () => history.firstDay());

ipcMain.handle('history:clear', async () => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Delete history'],
    defaultId: 0,
    cancelId: 0,
    message: 'Delete all posture history?',
    detail: 'Your reports will start again from zero. Settings and calibration are kept.',
  });
  if (response !== 1) return false;
  await history.clear();
  await refreshTodaySummary();
  refreshTray();
  return true;
});

ipcMain.handle('history:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export posture history',
    defaultPath: path.join(app.getPath('documents'), `posture-history-${new Date().toISOString().slice(0, 10)}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return null;
  const first = (await history.firstDay()) ?? Date.now();
  const rows = await history.query(first, Date.now() + DAY);
  const names = Object.fromEntries(Object.entries(ISSUES).map(([k, v]) => [k, v.short]));
  await fsp.writeFile(filePath, toCsv(rows, names));
  shell.showItemInFolder(filePath);
  return filePath;
});

ipcMain.handle('camera:ensure-access', () => ensureMacCameraAccess());

// ---------- lifecycle ----------

app.on('second-instance', () => openWindow('reports'));

// Stay alive in the tray when every window is closed.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
});

app.on('activate', () => openWindow('reports')); // macOS dock click

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  settings = new SettingsStore(userData);
  history = new HistoryStore(userData);
  history.prune(HISTORY_KEEP_DAYS).catch(() => {});

  registerProtocol();
  setupPermissions();
  if (process.platform === 'darwin') app.dock?.hide();

  // Keep the OS login item in sync with the stored preference (e.g. after the app was moved).
  const s = settings.get();
  if (s.openAtLogin !== getOpenAtLogin()) {
    try {
      setOpenAtLogin(s.openAtLogin);
    } catch {
      // not fatal
    }
  }

  // The last check survives a restart so the tray isn't blank.
  const recent = await history.query(Date.now() - DAY, Date.now() + 1);
  lastResult = recent.sort((a, b) => a.t - b.t).at(-1) ?? null;
  await refreshTodaySummary();

  createTray();
  createWorker();
  schedule();

  // Keep the tray text ("5 min ago", today's totals) fresh.
  setInterval(() => refreshTodaySummary().then(refreshTray), 60_000);
  powerMonitor.on('suspend', () => {
    clearTimeout(timer);
    timer = null;
  });
  powerMonitor.on('resume', schedule);

  if (settings.isFirstRun || !s.baseline) openWindow('setup');
  else if (!launchedHidden()) openWindow('reports');
});
