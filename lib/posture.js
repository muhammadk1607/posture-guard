// Shared posture logic: metric extraction and evaluation (no MediaPipe import, so the service worker can use it).
// Everything runs locally; no frames ever leave the machine.

// MediaPipe pose landmark indices
const L = {
  NOSE: 0,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
};

export const DEFAULT_SETTINGS = {
  enabled: true,
  intervalMin: 2,
  sensitivity: 'medium', // low | medium | high
  deviceId: '',
  sound: true,
  baseline: null, // set by calibration
};

const SENSITIVITY_SCALE = { low: 1.5, medium: 1, high: 0.7 };

const deg = (rad) => (rad * 180) / Math.PI;

// Angle of the line a→b relative to horizontal, in degrees, folded into [-90, 90].
function lineAngle(a, b) {
  let ang = deg(Math.atan2(b.y - a.y, b.x - a.x));
  if (ang > 90) ang -= 180;
  if (ang < -90) ang += 180;
  return ang;
}

/**
 * Turns one set of landmarks into scale-independent posture metrics.
 * Returns null when the upper body is not clearly visible.
 */
export function computeMetrics(landmarks) {
  if (!landmarks) return null;
  const nose = landmarks[L.NOSE];
  const lEar = landmarks[L.LEFT_EAR];
  const rEar = landmarks[L.RIGHT_EAR];
  const lSh = landmarks[L.LEFT_SHOULDER];
  const rSh = landmarks[L.RIGHT_SHOULDER];
  const vis = (p) => (p.visibility ?? 1) > 0.5;
  if (![nose, lSh, rSh].every(vis)) return null;

  const shoulderWidth = Math.hypot(lSh.x - rSh.x, lSh.y - rSh.y);
  if (shoulderWidth < 0.05) return null;
  const shMid = { x: (lSh.x + rSh.x) / 2, y: (lSh.y + rSh.y) / 2 };

  const earsVisible = vis(lEar) && vis(rEar);
  const earMid = earsVisible ? { x: (lEar.x + rEar.x) / 2, y: (lEar.y + rEar.y) / 2 } : nose;

  return {
    // How high the head sits above the shoulders. Drops when you slouch or crane forward.
    neckRatio: (shMid.y - earMid.y) / shoulderWidth,
    // Apparent shoulder width: grows when you lean toward the screen.
    shoulderWidth,
    // Shoulder line tilt in degrees.
    shoulderTilt: lineAngle(rSh, lSh),
    // Head roll in degrees (ear line), if ears are visible.
    headTilt: earsVisible ? lineAngle(rEar, lEar) : null,
    // Horizontal head offset from the shoulder centre (side lean).
    headOffset: (nose.x - shMid.x) / shoulderWidth,
  };
}

/** Median of each metric across several samples, for robustness against jitter. */
export function medianMetrics(samples) {
  const valid = samples.filter(Boolean);
  if (valid.length === 0) return null;
  const keys = Object.keys(valid[0]);
  const out = {};
  for (const k of keys) {
    const vals = valid.map((s) => s[k]).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    out[k] = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  }
  return out;
}

/**
 * Compares current metrics to the calibrated baseline.
 * Returns { ok, score, issues: [{ code, title, fix }] }.
 */
export function evaluate(m, baseline, sensitivity = 'medium') {
  const s = SENSITIVITY_SCALE[sensitivity] ?? 1;
  const issues = [];
  // Without calibration only the angle checks are meaningful; assume an upright neutral pose.
  const b = baseline ?? { neckRatio: null, shoulderWidth: null, shoulderTilt: 0, headTilt: 0, headOffset: 0 };
  let penalty = 0;

  if (b.neckRatio) {
    const drop = (b.neckRatio - m.neckRatio) / b.neckRatio;
    if (drop > 0.15 * s) {
      issues.push({
        code: 'slouch',
        title: 'You are slouching, or your head is pushed forward',
        fix: 'Sit up tall. Pull your shoulders back and tuck your chin a little so your ears line up over your shoulders.',
      });
      penalty += Math.min(40, drop * 150);
    }
  }

  if (b.shoulderWidth) {
    const grow = (m.shoulderWidth - b.shoulderWidth) / b.shoulderWidth;
    if (grow > 0.15 * s) {
      issues.push({
        code: 'lean-in',
        title: 'You are leaning toward the screen',
        fix: 'Sit back so the chair supports your lower back, and keep about an arm\'s length from the screen.',
      });
      penalty += Math.min(30, grow * 120);
    } else if (grow < -0.22 * s) {
      issues.push({
        code: 'recline',
        title: 'You are reclining or sliding down in your chair',
        fix: 'Shift your hips to the back of the seat and sit upright with your feet flat on the floor.',
      });
      penalty += Math.min(20, -grow * 80);
    }
  }

  const tiltDiff = Math.abs(m.shoulderTilt - b.shoulderTilt);
  if (tiltDiff > 6 * s) {
    issues.push({
      code: 'shoulders',
      title: 'Your shoulders are uneven',
      fix: 'Level your shoulders. Don\'t lean on one armrest or elbow, and relax the raised shoulder.',
    });
    penalty += Math.min(25, tiltDiff * 2);
  }

  if (m.headTilt !== null && b.headTilt !== null) {
    const headDiff = Math.abs(m.headTilt - b.headTilt);
    if (headDiff > 9 * s) {
      issues.push({
        code: 'head-tilt',
        title: 'Your head is tilted to one side',
        fix: 'Straighten your neck and keep your head level. Centre the screen in front of you if it is off to the side.',
      });
      penalty += Math.min(20, headDiff * 1.5);
    }
  }

  const offDiff = Math.abs(m.headOffset - b.headOffset);
  if (offDiff > 0.18 * s) {
    issues.push({
      code: 'side-lean',
      title: 'You are leaning to one side',
      fix: 'Centre your body over your hips and face the screen squarely.',
    });
    penalty += Math.min(20, offDiff * 60);
  }

  const score = Math.max(0, Math.round(100 - penalty));
  return { ok: issues.length === 0, score, issues };
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}
