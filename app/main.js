// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Electron shell. All it owns is the window and the local host server
// (server.js) that serves the renderer and proxies daemon traffic with tokens
// injected — the renderer is plain web code with no Node access.
'use strict';

const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const { start } = require('./server');
const host = require('./host');
const flavor = require('./flavor');

async function createWindow() {
  const port = await start(0);
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    // The traffic lights float over the sidebar; the sidebar is the window
    // chrome. Position read from Cursor's own main process
    // (getWindowButtonPosition) so the lights share the 35px titlebar
    // row's centerline with the strip icons.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 11, y: 10 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#f3f3f3',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/?host=electron`);
}

// A packaged build takes its icon from the bundle; `npm start` runs inside
// Electron's own bundle and would otherwise show Electron's. Which icon is the
// flavor's: from source that is the development one, and seeing it in the Dock
// is how you know this window is not the app holding your work.
if (!app.isPackaged && process.platform === 'darwin') {
  app.whenReady().then(() => app.dock.setIcon(path.join(__dirname, flavor.icon)));
}

app.whenReady().then(createWindow);
// The forwards are child processes of this app; they go with it.
app.on('will-quit', () => host.shutdown());
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
