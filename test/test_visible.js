'use strict';
/** 可见窗口诊断：真实显示窗口，监控加载事件 + 5 秒后截图，验证用户看到的画面。 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../server');

app.whenReady().then(async () => {
  const { url, port } = await startServer(0);
  const win = new BrowserWindow({
    width: 1100, height: 720, show: true,
    backgroundColor: '#0d1117',
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, '..', 'preload.js'), additionalArguments: [`--api-url=${url}`] },
  });
  const events = [];
  win.webContents.on('did-start-loading', () => events.push(`start-loading ${Date.now()}`));
  win.webContents.on('did-stop-loading', () => events.push(`stop-loading ${Date.now()}`));
  win.webContents.on('did-finish-load', () => events.push(`finish-load ${Date.now()}`));
  win.webContents.on('did-fail-load', (e, code, desc) => events.push(`fail-load ${code} ${desc}`));
  win.webContents.on('console-message', (e, level, message) => {
    let lv = level, msg = message;
    if (e && typeof e === 'object' && e.level !== undefined) { lv = e.level; msg = e.message; }
    if (lv >= 3) events.push(`console-error: ${msg}`);
  });

  const t0 = Date.now();
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 5000));

  const state = await win.webContents.executeJavaScript(`({
    title: document.title,
    ready: document.readyState,
    pageTitle: document.querySelector('#page-title')?.textContent || null,
    log: (document.querySelector('#log-body')?.textContent || '').slice(0, 100),
  })`).catch(e => ({ err: String(e) }));

  // 截图保存
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '..', 'test_visible_shot.png'), img.toPNG());
  } catch (e) { events.push(`screenshot-error: ${e.message}`); }

  console.log('加载事件:', JSON.stringify(events, null, 1));
  console.log('页面状态:', JSON.stringify(state, null, 1));
  console.log('耗时:', Date.now() - t0, 'ms; 端口:', port);
  app.exit(0);
});
