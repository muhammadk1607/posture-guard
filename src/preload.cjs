// Narrow bridge between the renderer pages and the main process (context isolation stays on).
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('pg', {
  platform: process.platform,

  // app window
  getStatus: () => ipcRenderer.invoke('status:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  checkNow: () => ipcRenderer.invoke('check:now'),
  setPreviewActive: (active) => ipcRenderer.send('preview:active', active),
  ensureCameraAccess: () => ipcRenderer.invoke('camera:ensure-access'),
  queryHistory: (from, to) => ipcRenderer.invoke('history:query', { from, to }),
  firstHistoryDay: () => ipcRenderer.invoke('history:first-day'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  exportHistory: () => ipcRenderer.invoke('history:export'),
  onStatus: on('status:changed'),
  onCheck: on('check:done'),
  onNavigate: on('navigate'),

  // hidden worker window
  onWorkerRequest: on('worker:request'),
  workerRespond: (res) => ipcRenderer.send('worker:response', res),
});
