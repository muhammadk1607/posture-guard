// Renders build/icon.svg to build/icon.png (1024px) for electron-builder. Run: npm run icons
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const root = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE, webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8');
  await win.loadURL('data:text/html,<body style="margin:0">');
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = ${SIZE};
    c.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE});
    return c.toDataURL('image/png');
  })()`);
  fs.writeFileSync(path.join(root, 'build/icon.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote build/icon.png');
  app.quit();
});
