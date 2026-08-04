'use strict';
/** 完全模拟 main.js 的窗口创建流程（disableHardwareAcceleration + show:false + ready-to-show + 5s 兜底 + loadFile + preload），
 *  用 capturePage（不依赖屏幕抓取）验证内容是否真正渲染。 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../server');

app.disableHardwareAcceleration(); // 与 main.js 一致

app.whenReady().then(async () => {
  const { url, port } = await startServer(0);
  console.log(`server port=${port}`);
  const win = new BrowserWindow({
    width: 1200, height: 820, show: false, backgroundColor: '#0d1117',
    webPreferences: {
      contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      additionalArguments: [`--api-url=${url}`],
    },
  });
  let rts = false;
  win.once('ready-to-show', () => { rts = true; win.show(); });
  setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 5000);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 8000));

  const visible = win.isVisible();
  // 页面内部状态
  const page = await win.webContents.executeJavaScript(`({
    title: document.title,
    pageTitle: document.querySelector('#page-title')?.textContent || null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    sidebarBg: getComputedStyle(document.querySelector('.sidebar')).backgroundColor,
  })`).catch(e => ({ err: String(e) }));
  // capturePage 内部截图
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(path.join(__dirname, '..', 'test_capture.png'), png);
  // 分析截图颜色：采样中心
  const { nativeImage } = require('electron');
  const ni = nativeImage.createFromBuffer(png);
  const size = ni.getSize();
  const bmp = ni.toBitmap(); // BGRA
  const bpp = 4;
  const px = (x, y) => {
    const i = (y * size.width + x) * bpp;
    return [bmp[i + 2], bmp[i + 1], bmp[i]]; // RGB
  };
  const samples = [[0.3, 0.5], [0.5, 0.5], [0.7, 0.5], [0.5, 0.2]].map(([fx, fy]) => {
    const c = px(Math.floor(size.width * fx), Math.floor(size.height * fy));
    return `(${fx},${fy})=${c.join(',')}`;
  });
  console.log('ready-to-show:', rts, 'visible:', visible);
  console.log('页面状态:', JSON.stringify(page));
  console.log(`capturePage 尺寸: ${size.width}x${size.height}, 采样: ${samples.join(' ')}`);
  app.exit(0);
});
