import { computeMetrics, medianMetrics, evaluate, getSettings } from './lib/posture.js';
import { createDetector, openCamera } from './lib/detector.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

let settings = await getSettings();
let stream = null;
let detector = null;
let latestMetrics = null;
let calibrating = null; // array of samples while calibrating

// ---------- settings form ----------

$('enabled').checked = settings.enabled;
$('interval').value = String(settings.intervalMin);
$('sensitivity').value = settings.sensitivity;
$('sound').checked = settings.sound;

$('enabled').onchange = (e) => save({ enabled: e.target.checked });
$('interval').onchange = (e) => save({ intervalMin: Number(e.target.value) });
$('sensitivity').onchange = (e) => save({ sensitivity: e.target.value });
$('sound').onchange = (e) => save({ sound: e.target.checked });

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set(patch);
}

function showCalStatus() {
  $('cal-status').textContent = settings.baseline
    ? `Calibrated ${new Date(settings.baseline.at).toLocaleString()}`
    : 'Not calibrated yet';
}
showCalStatus();

// ---------- camera ----------

async function hasPermission() {
  try {
    const p = await navigator.permissions.query({ name: 'camera' });
    return p.state === 'granted';
  } catch {
    return false;
  }
}

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await openCamera(settings.deviceId);
  video.srcObject = stream;
  await video.play();
  $('permission-card').hidden = true;
  $('live-card').hidden = false;
  await populateCameras();
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

$('grant').onclick = async () => {
  $('perm-error').hidden = true;
  try {
    await startCamera();
    loop();
  } catch (e) {
    $('perm-error').hidden = false;
    $('perm-error').textContent =
      e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Click the camera icon in the address bar (or open chrome://settings/content/camera), allow this extension, then try again.'
        : e.name === 'NotFoundError'
          ? 'No camera found. Plug one in and try again.'
          : `Could not start camera: ${e.message}`;
  }
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
    requestAnimationFrame(tick);
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

let latestEval = null;
let lastRender = 0;
function renderFeedback() {
  const now = performance.now();
  if (now - lastRender < 300) return; // keep the text readable
  lastRender = now;
  const el = $('live-feedback');
  if (calibrating) return;
  if (!latestMetrics) {
    latestEval = null;
    el.className = 'feedback warn';
    el.textContent = 'Can\'t see you clearly. Make sure your head and both shoulders are in view.';
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
    el.innerHTML = `<b>${latestEval.score}/100</b><ul>${latestEval.issues
      .map((i) => `<li><b>${i.title}.</b> ${i.fix}</li>`)
      .join('')}</ul>`;
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
    $('live-feedback').textContent = 'Calibration failed: couldn\'t see your head and shoulders. Adjust the camera and try again.';
    return;
  }
  const baseline = { ...medianMetrics(samples), at: Date.now() };
  await save({ baseline });
  showCalStatus();
  $('live-feedback').className = 'feedback good';
  $('live-feedback').textContent = 'Calibrated. Posture Guard will now warn you when you drift from this posture.';
  lastRender = performance.now() + 1500; // keep the message up briefly
};

// ---------- boot ----------

if (await hasPermission()) {
  $('grant').click();
}

window.addEventListener('pagehide', () => stream?.getTracks().forEach((t) => t.stop()));
