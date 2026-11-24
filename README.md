# Posture Guard

A desktop app for Linux, Windows and macOS that checks your sitting posture through your webcam every few minutes. It runs in the background from the system tray, warns you with a desktop notification (and an optional sound) when you need to adjust, and keeps a local history so you can see how your posture changes over time.

Everything runs on your computer with MediaPipe Pose. No images are saved or sent anywhere. The camera is only on for about 2 seconds per check.

## Run from source

```sh
npm install
npm start
```

The first launch opens **Settings & calibration**: turn on the camera preview, sit up straight, then click **Calibrate**. After that you can close the window and Posture Guard keeps running in the tray.

> If `npm install` skips Electron's download step (install scripts disabled), run `node node_modules/electron/install.js` once.

## Build installers

```sh
npm run dist:linux   # AppImage + .deb
npm run dist:win     # NSIS installer (build on Windows)
npm run dist:mac     # .dmg (build on macOS)
```

Output goes to `dist/`. Each platform's installer is best built on that platform.

## Tray

The tray icon carries a status dot: green = good, red = adjust your posture, amber = needs calibration or camera problem, grey = paused or not in view. The tray menu has:

- current status and today's totals (good-posture time, warnings)
- **Check now**
- **Pause** for 30 min / 1 h / 2 h / until resumed
- **Reports…** and **Settings & calibration…**
- **Start at login**
- **Quit**

Closing the window only closes the window. Use **Quit** in the tray to stop the app. Checks are skipped while the screen is locked, while the computer sleeps, and while the calibration preview is open.

## Reports

Pick Today, 7, 30 or 90 days:

- **Summary**: hours in good posture, hours in poor posture, share of time in good posture, number of warnings, average score, longest good streak.
- **Time in good vs poor posture**: per hour (today) or per day.
- **Most common posture problems**, plus how to fix your top three.
- **Average posture score** over time.
- **When poor posture happens**: share of poor checks by hour of day.
- **Recent warnings** with time, score and problems.

Every chart has a **Show as table** view. **Export CSV** saves the full raw history.

### How time is counted

Each automatic check stands for one check interval. With a 2-minute interval, a good check adds 2 minutes of good posture and a poor check adds 2 minutes of poor posture. Checks where you are not in view count as "away". Manual **Check now** results show up in scores and warnings but add no time.

## What it detects (compared to your calibrated posture)

- **Slouching / forward head**: the head drops relative to the shoulders.
- **Leaning toward the screen**: the shoulders appear wider (closer to the camera).
- **Reclining / sliding down**: the shoulders appear narrower.
- **Uneven shoulders**: the shoulder line tilts.
- **Head tilted**: the ear line tilts.
- **Leaning sideways**: the head moves off-centre from the shoulders.

Sensitivity (low, medium or high) scales all thresholds. **Warn me** can limit notifications to at most one every 5–30 minutes. Poor-posture checks are recorded either way.

## Where data lives

The app's user-data folder (`~/.config/Posture Guard` on Linux, `%APPDATA%\Posture Guard` on Windows, `~/Library/Application Support/Posture Guard` on macOS):

- `settings.json`: settings and calibration
- `history/YYYY-MM-DD.jsonl`: one line per check. Kept for 400 days.

For development, `PG_USER_DATA=/some/dir npm start` uses a separate folder. `node scripts/seed-demo.mjs /some/dir` fills it with 30 days of fake history so you can preview the reports.

## Project layout

| Path | Role |
| --- | --- |
| `src/main/main.js` | Main process: tray, scheduler, notifications, `app://` file protocol, camera permission, IPC. |
| `src/main/store.js` | Settings file and daily history files. |
| `src/main/autostart.js` | Start at login (login items on macOS/Windows, XDG autostart on Linux). |
| `src/preload.cjs` | Narrow `window.pg` bridge for the pages. |
| `src/renderer/worker.*` | Hidden window that opens the camera, samples 6 frames, runs pose detection, plays the chime. |
| `src/renderer/app.*`, `reports.js`, `setup.js` | The Reports and Settings & calibration window. |
| `src/shared/posture.js` | Turns landmarks into metrics and compares them to your baseline. |
| `src/shared/analytics.js` | Turns history into report data (tested in `test/`). |
| `src/shared/detector.js` | MediaPipe setup and camera opening. |

```sh
npm test               # analytics + evaluation tests
npm run icons          # re-render build/icon.png from build/icon.svg
npm run update-mediapipe   # copy a newer @mediapipe/tasks-vision into vendor/
```

## Platform notes

- **macOS**: asks for camera permission on first use (System Settings → Privacy & Security → Camera). The app has no Dock icon unless its window is open.
- **Linux**: the tray needs a StatusNotifier/AppIndicator host. GNOME needs the "AppIndicator and KStatusNotifierItem Support" extension. KDE, COSMIC, Cinnamon, XFCE and others have one built in.
- **Windows**: notifications appear in Action Center under "Posture Guard".

## Tips

- Recalibrate whenever you move the camera, monitor or chair.
- A front-facing camera at roughly eye level works best. Your head and both shoulders must be in frame.
