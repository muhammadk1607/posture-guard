// "Start at login" for all three platforms. macOS and Windows use Electron's login-item API;
// Linux uses an XDG autostart .desktop file, which every mainstream desktop honours.

import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HIDDEN_FLAG = '--hidden';

const linuxFile = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'posture-guard.desktop');

function linuxExec() {
  const q = (s) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
  // AppImage: point at the .AppImage itself, not the temporary mount path.
  if (process.env.APPIMAGE) return `${q(process.env.APPIMAGE)} ${HIDDEN_FLAG}`;
  // Running from source (`npm start`): the binary is electron, so pass the app folder too.
  if (!app.isPackaged) return `${q(process.execPath)} ${q(app.getAppPath())} ${HIDDEN_FLAG}`;
  return `${q(process.execPath)} ${HIDDEN_FLAG}`;
}

export function setOpenAtLogin(enabled) {
  if (process.platform === 'linux') {
    const file = linuxFile();
    if (enabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Posture Guard',
          'Comment=Checks your sitting posture through your webcam',
          `Exec=${linuxExec()}`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          '',
        ].join('\n'),
      );
    } else {
      fs.rmSync(file, { force: true });
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
}

export function getOpenAtLogin() {
  if (process.platform === 'linux') return fs.existsSync(linuxFile());
  return app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin;
}

/** True when the OS launched us at login, so we should start quietly in the tray. */
export function launchedHidden() {
  if (process.argv.includes(HIDDEN_FLAG)) return true;
  if (process.platform === 'darwin') return app.getLoginItemSettings().wasOpenedAtLogin === true;
  return false;
}
