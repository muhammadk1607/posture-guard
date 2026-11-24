// Hidden offscreen document: opens the camera briefly, samples a few frames,
// measures posture, then closes the camera again (the camera light only blinks on during a check).

import { computeMetrics, medianMetrics } from './lib/posture.js';
import { createDetector, openCamera } from './lib/detector.js';

const video = document.getElementById('video');
let detectorPromise = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sample(deviceId) {
  detectorPromise ??= createDetector('IMAGE');
  const detector = await detectorPromise;
  const stream = await openCamera(deviceId);
  try {
    video.srcObject = stream;
    await video.play();
    await sleep(800); // let auto-exposure settle
    const samples = [];
    for (let i = 0; i < 6; i++) {
      if (video.readyState >= 2) {
        const res = detector.detect(video);
        samples.push(computeMetrics(res.landmarks?.[0]));
      }
      await sleep(200);
    }
    return medianMetrics(samples);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}

function chime() {
  const ctx = new AudioContext();
  const now = ctx.currentTime;
  [660, 880].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.18);
    osc.stop(now + i * 0.18 + 0.32);
  });
  setTimeout(() => ctx.close(), 1000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'sample') {
    sample(msg.deviceId)
      .then((metrics) => sendResponse({ metrics }))
      .catch((e) => sendResponse({ error: e.name || 'Error', message: e.message }));
    return true;
  }
  if (msg.type === 'chime') {
    chime();
  }
});
