// Pose detector + camera helpers (page contexts only: setup page and offscreen document).

import { FilesetResolver, PoseLandmarker } from '../vendor/vision_bundle.mjs';

export async function createDetector(runningMode = 'IMAGE') {
  const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/wasm'));
  const options = {
    baseOptions: { modelAssetPath: chrome.runtime.getURL('models/pose_landmarker_lite.task') },
    runningMode,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
  };
  try {
    return await PoseLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'GPU' },
    });
  } catch {
    return PoseLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    });
  }
}

/** Opens the camera, honouring a chosen deviceId but falling back to any camera. */
export async function openCamera(deviceId) {
  const base = { width: { ideal: 640 }, height: { ideal: 480 } };
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: deviceId } } });
    } catch (e) {
      if (e.name === 'NotAllowedError') throw e;
      // Chosen camera unplugged: fall through to default.
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: base });
}

