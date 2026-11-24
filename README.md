# Posture Guard

A Chrome/Edge/Brave extension that checks your sitting posture through your webcam every few minutes and warns you, with a desktop notification, a sound and a badge on the toolbar icon, when you need to adjust.

Everything runs locally with MediaPipe Pose. No images are saved or sent anywhere, and the camera is only on for about 2 seconds per check.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. The setup page opens. Click **Allow camera**, sit up straight, then click **Calibrate**.

## How it works

| Piece | Role |
| --- | --- |
| `background.js` | Service worker. Runs a `chrome.alarms` timer, triggers checks, sends notifications, sets the badge. |
| `offscreen.html/js` | Hidden page that opens the camera, samples 6 frames, runs pose detection, then closes the camera. |
| `setup.html/js` | Camera permission, camera picker, live skeleton preview with feedback, calibration, settings. |
| `popup.html/js` | Toolbar popup: last result, *Check now*, *Pause/Resume*. |
| `lib/posture.js` | Turns landmarks into metrics and compares them to your calibrated baseline. |
| `lib/detector.js` | MediaPipe setup and camera opening. |

### What it detects (compared to your calibrated posture)

- **Slouching / forward head**: the head drops relative to the shoulders.
- **Leaning toward the screen**: the shoulders appear wider (closer to the camera).
- **Reclining / sliding down**: the shoulders appear narrower.
- **Uneven shoulders**: the shoulder line tilts.
- **Head tilted**: the ear line tilts.
- **Leaning sideways**: the head moves off-centre from the shoulders.

Sensitivity (low, medium or high) scales all thresholds. If nobody is in view, the check is skipped quietly and the badge shows `?`.

### Badge

`✓` good · `!` needs adjustment · `?` not in view / camera error · `cal` needs calibration · `off` paused

## Tips

- Recalibrate whenever you move the camera, monitor or chair.
- A front-facing camera at roughly eye level works best. Your head and both shoulders must be in frame.

## Updating MediaPipe

```sh
npm install
cp node_modules/@mediapipe/tasks-vision/vision_bundle.mjs vendor/
cp node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.* vendor/wasm/
```

The model is `models/pose_landmarker_lite.task` from Google's MediaPipe model storage.

Chromium only: the extension relies on the `chrome.offscreen` API, which Firefox does not support.
