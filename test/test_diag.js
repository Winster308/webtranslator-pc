'use strict';
/** 窗口显示链路诊断：逐步记录 app ready → 窗口创建 → loadFile → finish-load → ready-to-show → visible */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer } = require('../server');

const log = (m) => console.log(`[${Date.now() % 100000}] ${m}`);

app.whenReady().then(async () => {
  log('app ready');
  const { url, port } = await startServer(0);
  log(`server on ${port}`);
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      additionalArguments: [`--api-url=${url}`],
    },
  });
  log('window created');
  win.once('ready-to-show', () => { log('ready-to-show FIRED'); win.show(); log('win.show() called'); });
  win.webContents.on('did-finish-load', () => log('did-finish-load'));
  win.webContents.on('did-fail-load', (e, code, desc) => log(`did-fail-load ${code} ${desc}`));
  win.webContents.on('render-process-gone', (e, d) => log(`render-process-gone ${JSON.stringify(d)}`));
  win.webContents.on('console-message', (e, level, message) => {
    let lv = level, msg = message;
    if (e && typeof e === 'object' && e.level !== undefined) { lv = e.level; msg = e.message; }
    if (lv >= 3) log(`console-error: ${msg}`);
  });
  log('loading file...');
  const p = win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  log('loadFile returned promise');
  try { await p; log('loadFile promise resolved'); } catch (e) { log(`loadFile REJECTED: ${e.message}`); }

  for (let i = 1; i <= 6; i++) {
    await new Promise(r => setTimeout(r, 1000));
    log(`t+${i}s visible=${win.isVisible()} loading=${win.webContents.isLoading()}`);
    if (win.isVisible()) break;
  }
  app.exit(0);
});
