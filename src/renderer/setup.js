// Settings & calibration view: live camera preview with skeleton overlay, calibration, settings form.
// The camera only runs while this view is open and the preview is on.

import { computeMetrics, medianMetrics, evaluate } from '../shared/posture.js';
import { createDetector, openCamera } from '../shared/detector.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

let settings = null;
let stream = null;
let detector = null;
let latestMetrics = null;
let latestEval = null;
let calibrating = null; // array of samples while calibrating
let rafId = null;
let lastRender = 0;

const PREVIEW_KEY = 'pg.previewWanted';
const previewWanted = () => {
  try {
    return localStorage.getItem(PREVIEW_KEY) === '1';
  } catch {
    return false;
  }
};
const setPreviewWanted = (v) => {
  try {
    localStorage.setItem(PREVIEW_KEY, v ? '1' : '0');
  } catch {
    // ignore
  }
};

// ---------- settings form ----------

export function applySettings(s, openAtLogin) {
  settings = s;
  $('enabled').checked = s.enabled;
  $('interval').value = String(s.intervalMin);
  $('sensitivity').value = s.sensitivity;
  $('sound').checked = s.sound;
  $('cooldown').value = String(s.notifyCooldownMin ?? 0);
  $('login').checked = !!openAtLogin;
  showCalStatus();
}

async function save(patch) {
  settings = await window.pg.setSettings(patch);
}

$('enabled').onchange = (e) => save({ enabled: e.target.checked, pausedUntil: 0 });
$('interval').onchange = (e) => save({ intervalMin: Number(e.target.value) });
$('sensitivity').onchange = (e) => save({ sensitivity: e.target.value });
$('sound').onchange = (e) => save({ sound: e.target.checked });
$('cooldown').onchange = (e) => save({ notifyCooldownMin: Number(e.target.value) });
$('login').onchange = (e) => save({ openAtLogin: e.target.checked });

function showCalStatus() {
  $('cal-status').textContent = settings?.baseline
    ? `Calibrated ${new Date(settings.baseline.at).toLocaleString()}`
    : 'Not calibrated yet';
}

// ---------- camera ----------

async function startCamera() {
  stopCamera();
  if (!(await window.pg.ensureCameraAccess())) {
    throw Object.assign(new Error('Camera access is turned off for Posture Guard in System Settings.'), {
      name: 'NotAllowedError',
    });
  }
  stream = await openCamera(settings.deviceId);
  video.srcObject = stream;
  await video.play();
  window.pg.setPreviewActive(true);
  $('permission-card').hidden = true;
  $('live-card').hidden = false;
  await populateCameras();
  loop();
}

function stopCamera() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  window.pg.setPreviewActive(false);
}

async function populateCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const activeId = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  const sel = $('camera');
  sel.innerHTML = '';
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i + 1}`;
    sel.appendChild(opt);
  });
  sel.value = activeId || settings.deviceId || devices[0]?.deviceId || '';
}

$('camera').onchange = async (e) => {
  await save({ deviceId: e.target.value });
  await startCamera();
};

async function tryStart() {
  $('perm-error').hidden = true;
  try {
    await startCamera();
    setPreviewWanted(true);
  } catch (e) {
    $('permission-card').hidden = false;
    $('live-card').hidden = true;
    $('perm-error').hidden = false;
    $('perm-error').textContent =
      e.name === 'NotAllowedError'
        ? `Camera access was blocked. ${
            window.pg.platform === 'darwin'
              ? 'Open System Settings → Privacy & Security → Camera, allow Posture Guard, then try again.'
              : 'Check that no privacy switch or other setting is blocking the camera, then try again.'
          }`
        : e.name === 'NotFoundError'
          ? 'No camera found. Plug one in and try again.'
          : e.name === 'NotReadableError'
            ? 'The camera is busy in another app. Close it and try again.'
            : `Could not start camera: ${e.message}`;
  }
}

$('grant').onclick = tryStart;
$('stop-preview').onclick = () => {
  setPreviewWanted(false);
  stopCamera();
  $('live-card').hidden = true;
  $('permission-card').hidden = false;
};

// ---------- live detection loop ----------

const CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [0, 7], [0, 8], [7, 11], [8, 12],
];

async function loop() {
  detector ??= await createDetector('VIDEO');
  let lastTs = -1;
  const tick = () => {
    if (!stream) return;
    if (video.readyState >= 2) {
      const ts = performance.now();
      if (ts > lastTs) {
        lastTs = ts;
        const res = detector.detectForVideo(video, ts);
        const lm = res.landmarks?.[0];
        draw(lm);
        latestMetrics = computeMetrics(lm);
        if (calibrating && latestMetrics) calibrating.push(latestMetrics);
        renderFeedback();
      }
    }
    rafId = requestAnimationFrame(tick);
  };
  tick();
}

function draw(lm) {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!lm) return;
  const ok = latestEval?.ok ?? true;
  ctx.lineWidth = 4;
  ctx.strokeStyle = ok ? '#22c55e' : '#ef4444';
  ctx.fillStyle = '#fff';
  for (const [a, b] of CONNECTIONS) {
    if ((lm[a].visibility ?? 1) < 0.5 || (lm[b].visibility ?? 1) < 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(lm[a].x * canvas.width, lm[a].y * canvas.height);
    ctx.lineTo(lm[b].x * canvas.width, lm[b].y * canvas.height);
    ctx.stroke();
  }
  for (const i of [0, 7, 8, 11, 12]) {
    if ((lm[i].visibility ?? 1) < 0.5) continue;
    ctx.beginPath();
    ctx.arc(lm[i].x * canvas.width, lm[i].y * canvas.height, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderFeedback() {
  const now = performance.now();
  if (now - lastRender < 300) return; // keep the text readable
  lastRender = now;
  const el = $('live-feedback');
  if (calibrating) return;
  if (!latestMetrics) {
    latestEval = null;
    el.className = 'feedback warn';
    el.textContent = "Can't see you clearly. Make sure your head and both shoulders are in view.";
    return;
  }
  if (!settings.baseline) {
    latestEval = null;
    el.className = 'feedback';
    el.textContent = 'Sit up straight, then click Calibrate.';
    return;
  }
  latestEval = evaluate(latestMetrics, settings.baseline, settings.sensitivity);
  if (latestEval.ok) {
    el.className = 'feedback good';
    el.textContent = `Good posture: ${latestEval.score}/100`;
  } else {
    el.className = 'feedback bad';
    el.replaceChildren();
    const b = document.createElement('b');
    b.textContent = `${latestEval.score}/100`;
    const ul = document.createElement('ul');
    for (const i of latestEval.issues) {
      const li = document.createElement('li');
      const t = document.createElement('b');
      t.textContent = `${i.title}. `;
      li.append(t, i.fix);
      ul.append(li);
    }
    el.append(b, ul);
  }
}

// ---------- calibration ----------

$('calibrate').onclick = async () => {
  const btn = $('calibrate');
  const cd = $('countdown');
  btn.disabled = true;
  cd.hidden = false;
  for (const n of [3, 2, 1]) {
    cd.textContent = n;
    await new Promise((r) => setTimeout(r, 1000));
  }
  cd.textContent = 'Hold still…';
  calibrating = [];
  await new Promise((r) => setTimeout(r, 3000));
  const samples = calibrating;
  calibrating = null;
  cd.hidden = true;
  btn.disabled = false;

  if (samples.length < 10) {
    $('live-feedback').className = 'feedback warn';
    $('live-feedback').textContent =
      "Calibration failed: couldn't see your head and shoulders. Adjust the camera and try again.";
    return;
  }
  const baseline = { ...medianMetrics(samples), at: Date.now() };
  await save({ baseline });
  showCalStatus();
  $('live-feedback').className = 'feedback good';
  $('live-feedback').textContent = 'Calibrated. Posture Guard will now warn you when you drift from this posture.';
  lastRender = performance.now() + 1500; // keep the message up briefly
};

// ---------- view lifecycle ----------

export function showSetup() {
  // Auto-start the preview if the user had it on, or on first run (not yet calibrated).
  if (!stream && (previewWanted() || !settings?.baseline)) tryStart();
}

export function hideSetup() {
  stopCamera();
}

window.addEventListener('pagehide', stopCamera);
