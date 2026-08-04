'use strict';
/** Electron 自动化验证：真实加载页面 → 检查页面元素/console 错误/服务器状态 → 自动退出。 */
const { app, BrowserWindow } = require('electron');
const { startServer } = require('../server');

const results = [];
let pass = true;
function check(name, cond, detail = '') {
  results.push(`${cond ? '[OK]' : '[FAIL]'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) pass = false;
}

app.whenReady().then(async () => {
  try {
    const { url, port, authToken } = await startServer(0);
    check('服务器启动', typeof port === 'number' && port > 0, `port=${port}`);

    const win = new BrowserWindow({ width: 1100, height: 720, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: require('path').join(__dirname, '..', 'preload.js'), additionalArguments: [`--api-url=${url}`, `--auth-token=${authToken}`] } });
    const errors = [];
    // 兼容新旧 console-message API（Electron 43 起传 Event 对象）
    win.webContents.on('console-message', (e, level, message) => {
      let lv = level, msg = message;
      if (e && typeof e === 'object' && e.level !== undefined) { lv = e.level; msg = e.message; }
      if (lv >= 2) errors.push(`[level=${lv}] ${msg}`);
    });
    win.webContents.on('did-fail-load', (e, code, desc) => errors.push(`[did-fail-load ${code}] ${desc}`));
    win.webContents.on('render-process-gone', (e, details) => errors.push(`[render-process-gone] ${JSON.stringify(details)}`));

    await win.loadFile(require('path').join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise(r => setTimeout(r, 3000)); // 等前端 init() 完成

    const state = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // 等待配置加载（init 异步）
      let cfgLoaded = false;
      for (let i = 0; i < 20; i++) {
        if (window.__cfgLoaded) { cfgLoaded = true; break; }
        await sleep(200);
      }
      return {
        title: document.title,
        pageTitle: document.querySelector('#page-title')?.textContent,
        navCount: document.querySelectorAll('.nav-item[data-page]').length,
        logText: document.querySelector('#log-body')?.textContent || '',
        serverStatus: document.querySelector('#server-status')?.textContent || '',
        bodyChildren: document.querySelector('.content')?.children.length ?? -1,
        cfgLoaded,
      };
    })()`);

    check('页面标题', state.title === 'WebTranslator 电脑版', state.title);
    check('默认页标题', state.pageTitle === '本地文件翻译', String(state.pageTitle));
    check('4 个导航项', state.navCount === 4, String(state.navCount));
    check('内容区有卡片', state.bodyChildren >= 3, String(state.bodyChildren));
    check('服务器状态显示', /运行中/.test(state.serverStatus), state.serverStatus);
    check('前端 init 完成', state.cfgLoaded, JSON.stringify(state.logText.slice(0, 80)));
    check('无前端 JS 错误', errors.length === 0, errors.join(' | '));

    // ★ 关键回归：遮罩层真实显示状态（hidden 属性会被 CSS display 覆盖，必须查 computed style）
    const overlayState = await win.webContents.executeJavaScript(`(() => {
      const ov = document.querySelector('#progress-overlay');
      const mm = document.querySelector('#modal-mask');
      return {
        overlayDisplay: getComputedStyle(ov).display,
        overlayHiddenAttr: ov.hidden,
        modalDisplay: getComputedStyle(mm).display,
        modalHiddenAttr: mm.hidden,
      };
    })()`);
    check('进度遮罩真实隐藏', overlayState.overlayDisplay === 'none', JSON.stringify(overlayState));
    check('模态框真实隐藏', overlayState.modalDisplay === 'none', JSON.stringify(overlayState));

    // 直接调 API 验证前端跨域请求（window.apiBase / window.authToken 由 preload 注入）
    const apiTest = await win.webContents.executeJavaScript(`fetch(window.apiBase + '/api/config', { headers: { 'x-auth-token': window.authToken } }).then(r => r.json()).then(j => ({ ok: j.ok, model: j.config?.model, keySet: j.config?.api_key_set })).catch(e => ({ err: String(e) }))`);
    check('页面内 fetch API 正常', apiTest.ok === true && apiTest.model === 'deepseek-chat' && typeof apiTest.keySet === 'boolean', JSON.stringify(apiTest));

    win.destroy();
  } catch (e) {
    check('测试执行', false, String(e && e.stack || e));
  }
  console.log(results.join('\n'));
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  app.exit(pass ? 0 : 1);
});
