// Pose detector + camera helpers (renderer pages only: the app window and the hidden worker window).
// Paths resolve against this file, served from the app:// protocol registered in the main process.

import { FilesetResolver, PoseLandmarker } from '../../vendor/vision_bundle.mjs';

const asset = (p) => new URL(`../../${p}`, import.meta.url).href;

export async function createDetector(runningMode = 'IMAGE') {
  const fileset = await FilesetResolver.forVisionTasks(asset('vendor/wasm'));
  const options = {
    baseOptions: { modelAssetPath: asset('models/pose_landmarker_lite.task') },
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

