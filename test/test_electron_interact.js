'use strict';
/** 交互测试：模拟用户真实操作（设置弹窗/保存/切页/仓库查询超时兜底/进度层释放）。 */
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
    const { url, authToken } = await startServer(0);
    // 读取当前真实配置：测试不得覆盖用户已保存的 API Key
    const beforeCfg = await (await fetch(url + '/api/config', { headers: { 'x-auth-token': authToken } })).json();
    const hadKey = !!beforeCfg.config.api_key_set;
    const win = new BrowserWindow({ width: 1100, height: 720, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: require('path').join(__dirname, '..', 'preload.js'), additionalArguments: [`--api-url=${url}`, `--auth-token=${authToken}`] } });
    const errors = [];
    win.webContents.on('console-message', (e, level, message) => {
      let lv = level, msg = message;
      if (e && typeof e === 'object' && e.level !== undefined) { lv = e.level; msg = e.message; }
      if (lv >= 3) errors.push(msg);
    });
    await win.loadFile(require('path').join(__dirname, '..', 'renderer', 'index.html'));
    await new Promise(r => setTimeout(r, 2500));

    const out = await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const out = {};
      const hdr = { 'x-auth-token': window.authToken };
      // 1. 打开设置弹窗
      document.querySelector('#btn-settings').click();
      await sleep(300);
      out.modalShown = !document.querySelector('#modal-mask').hidden &&
        getComputedStyle(document.querySelector('#modal-mask')).display !== 'none';
      // 已有 Key 时显示掩码，否则为空（都不会破坏用户配置）
      out.apiKeyShown = ['', '********'].includes(document.querySelector('#set-apikey').value);
      // 2. 保存设置（已有 Key 则提交掩码表示保留，未设置才写入测试值）
      document.querySelector('#set-apikey').value = ${hadKey ? "'********'" : "'sk-test-e2e'"};
      document.querySelector('#set-model').value = 'deepseek-chat';
      document.querySelector('#modal-save').click();
      await sleep(600);
      out.modalClosed = document.querySelector('#modal-mask').hidden &&
        getComputedStyle(document.querySelector('#modal-mask')).display === 'none';
      // 进度遮罩必须真实隐藏（曾经 display:flex 覆盖 hidden 导致永远转圈）
      out.overlayGone = getComputedStyle(document.querySelector('#progress-overlay')).display === 'none';
      const cfg = await fetch(window.apiBase + '/api/config', { headers: hdr }).then(r => r.json());
      out.apiKeySaved = cfg.config.api_key_set === true;
      out.noPlainKey = cfg.config.api_key === undefined;
      // 3. 切换页面
      document.querySelector('.nav-item[data-page="repo"]').click();
      await sleep(200);
      out.repoPageTitle = document.querySelector('#page-title').textContent;
      // 4. 仓库查询（GitHub 不可达环境 → 不应卡死，应报错并释放进度层）
      const t0 = Date.now();
      document.querySelector('#repo-url').value = 'https://github.com/octocat/Hello-World';
      document.querySelector('#btn-repo-query').click();
      await sleep(400);
      out.progressShown = !document.querySelector('#progress-overlay').hidden;
      // 最多等 30s（服务器 github 超时 12s + 前端超时 25s）
      for (let i = 0; i < 60; i++) {
        if (document.querySelector('#progress-overlay').hidden) break;
        await sleep(500);
      }
      out.elapsed = Date.now() - t0;
      out.progressReleased = document.querySelector('#progress-overlay').hidden;
      out.toastText = (document.querySelector('#toast-wrap')?.textContent || '').slice(0, 120);
      out.logTail = (document.querySelector('#log-body')?.textContent || '').slice(-160);
      out.repoInfoText = (document.querySelector('#repo-info')?.textContent || '').slice(0, 60);
      return out;
    })()`);

    check('设置弹窗打开', out.modalShown === true);
    check('API Key 显示掩码/为空', out.apiKeyShown === true);
    check('保存后弹窗关闭(真实隐藏)', out.modalClosed === true);
    check('进度遮罩始终真实隐藏', out.overlayGone === true);
    check('API Key 已持久化', out.apiKeySaved === true, JSON.stringify(out.apiKeySaved));
    check('config 不泄露明文 Key', out.noPlainKey === true);
    check('页面切换', out.repoPageTitle === '仓库翻译', String(out.repoPageTitle));
    check('进度层显示或秒失败(网络快速拒绝)', out.progressShown === true || out.elapsed < 1500, `shown=${out.progressShown} elapsed=${out.elapsed}ms`);
    check('查询失败后进度层释放', out.progressReleased === true, `elapsed=${out.elapsed}ms`);
    check('查询未卡死(≤30s)', out.elapsed < 30000, `${out.elapsed}ms`);
    // 网络可达时查询成功（显示仓库信息），不可达时报错提示——两种结果都是有效反馈
    check('查询有结果反馈(成功或失败)', /失败|错误/.test(out.toastText + out.logTail) || out.repoInfoText.length > 0, out.toastText + ' | ' + out.repoInfoText);
    check('无 JS 运行错误', errors.length === 0, errors.join(' | '));

    // 清理测试配置（恢复原状态：有 Key 则保留，无 Key 则清空）
    await win.webContents.executeJavaScript(`fetch(window.apiBase + '/api/config', {method:'POST', headers:{'Content-Type':'application/json', 'x-auth-token': window.authToken}, body: JSON.stringify({api_key: ${hadKey ? "'********'" : "''"}})})`);
    win.destroy();
  } catch (e) {
    check('测试执行', false, String(e && e.stack || e));
  }
  console.log(results.join('\n'));
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  app.exit(pass ? 0 : 1);
});
