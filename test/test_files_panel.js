'use strict';
/** 仓库文件管理面板验证：元素存在、未登录隐藏、模拟登录后交互错误处理不卡死。 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer } = require('../server');

const results = [];
let pass = true;
function check(name, cond, detail = '') {
  results.push(`${cond ? '[OK]' : '[FAIL]'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) pass = false;
}

app.whenReady().then(async () => {
  try {
    const { url, authToken } = await startServer(0);
    const win = new BrowserWindow({ width: 1100, height: 720, show: false, webPreferences: {
      contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      additionalArguments: [`--api-url=${url}`, `--auth-token=${authToken}`],
    } });
    const errors = [];
    win.webContents.on('console-message', (e, level, message) => {
      let lv = level, msg = message;
      if (e && typeof e === 'object' && e.level !== undefined) { lv = e.level; msg = e.message; }
      if (lv >= 3) errors.push(msg);
    });
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise(r => setTimeout(r, 2500));

    // 检查当前环境是否已自动登录（用户本机有真实 token 且网络可达时 checkLogin 会成功）
    const meResp = await fetch(url + '/api/github/me', { headers: { 'x-auth-token': authToken } }).then(r => r.json());
    const envLoggedIn = meResp.loggedIn === true;

    const out = await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const out = {};
      // 面板元素存在
      out.cardExists = !!document.querySelector('#gh-files-card');
      out.editorExists = !!document.querySelector('#gh-editor');
      out.pathInputExists = !!document.querySelector('#gh-editor-path');
      // 未登录：面板隐藏（真实 display）。已登录环境不适用此断言。注意：不写入假 token（避免覆盖用户真实配置）
      out.cardHiddenBeforeLogin = getComputedStyle(document.querySelector('#gh-files-card')).display === 'none';
      // 手动显示面板并填仓库（真实登录流程中 afterLogin 会显示）
      document.querySelector('#gh-files-card').hidden = false;
      const sel = document.querySelector('#gh-repo-select');
      const opt = document.createElement('option');
      opt.value = 'octocat/Hello-World'; opt.textContent = 'octocat/Hello-World'; opt.dataset.branch = 'master';
      sel.appendChild(opt); sel.value = 'octocat/Hello-World';
      // 点击「加载文件列表」→ 无 token 时提示登录 / 有 token 时请求 GitHub；都必须及时释放按钮
      const t0 = Date.now();
      document.querySelector('#btn-gh-files-load').click();
      for (let i = 0; i < 20; i++) { if (document.querySelector('#btn-gh-files-load').disabled === false) break; await sleep(300); }
      out.elapsed = Date.now() - t0;
      out.btnReleased = document.querySelector('#btn-gh-files-load').disabled === false;
      out.toast = (document.querySelector('#toast-wrap')?.textContent || '').slice(-100);
      // 新建文件按钮可用
      document.querySelector('#btn-gh-files-new').click();
      await sleep(200);
      out.newPathEditable = document.querySelector('#gh-editor-path').readOnly === false;
      out.saveEnabled = document.querySelector('#btn-gh-editor-save').disabled === false;
      return out;
    })()`);

    check('文件管理面板存在', out.cardExists === true);
    check('编辑器存在', out.editorExists === true);
    check('路径输入存在', out.pathInputExists === true);
    check('未登录时面板隐藏(未登录环境)', out.cardHiddenBeforeLogin === true || envLoggedIn, `envLoggedIn=${envLoggedIn} cardHidden=${out.cardHiddenBeforeLogin}`);
    check('加载按钮及时释放(未卡死)', out.btnReleased === true, `elapsed=${out.elapsed}ms`);
    check('新建文件路径可编辑', out.newPathEditable === true);
    check('新建时保存按钮可用', out.saveEnabled === true);
    check('无 JS 运行错误', errors.length === 0, errors.join(' | '));

    win.destroy();
  } catch (e) {
    check('测试执行', false, String(e && e.stack || e));
  }
  console.log(results.join('\n'));
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  app.exit(pass ? 0 : 1);
});
