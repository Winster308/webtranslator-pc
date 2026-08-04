'use strict';
/** 端到端测试：ZIP 打包正确性 + 服务器 API。 */
const fs = require('fs');
const path = require('path');
const { makeZip } = require('../server/zip');
const { startServer } = require('../server');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}  ${detail}`); }
}

(async () => {
  console.log('== ZIP 打包 ==');
  const files = [
    { path: 'index.html', data: Buffer.from('<h1>你好</h1>', 'utf8') },
    { path: 'js/main.js', data: Buffer.from('console.log("测试");', 'utf8') },
    { path: 'img/logo.png', data: Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]) },
    { path: '子目录/文件.txt', data: Buffer.from('中文文件名测试', 'utf8') },
  ];
  const zip = makeZip(files);
  check('ZIP 有 PK 头', zip.readUInt32LE(0) === 0x04034b50);
  check('ZIP 有 EOCD 尾', zip.readUInt32LE(zip.length - 22) === 0x06054b50);
  check('大小合理', zip.length > 200 && zip.length < 5000, `${zip.length} bytes`);
  // 写到磁盘用系统解压验证
  const tmp = path.join(__dirname, '..', 'test_tmp.zip');
  fs.writeFileSync(tmp, zip);
  const { execSync } = require('child_process');
  const outDir = path.join(__dirname, '..', 'test_tmp_out');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  try {
    execSync(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${tmp}' -DestinationPath '${outDir}'"`, { timeout: 30000 });
    const list = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else list.push(path.relative(outDir, p).replace(/\\/g, '/'));
      }
    };
    walk(outDir);
    check('解压出 4 个文件', list.length === 4, list.join(','));
    check('含中文文件名', list.includes('子目录/文件.txt'), list.join(','));
    check('文件内容正确', fs.readFileSync(path.join(outDir, 'js', 'main.js'), 'utf8') === 'console.log("测试");');
    check('二进制字节一致', fs.readFileSync(path.join(outDir, 'img', 'logo.png')).equals(files[2].data));
  } catch (e) {
    check('系统解压验证', false, String(e.message));
  }
  fs.rmSync(tmp, { force: true });
  fs.rmSync(outDir, { recursive: true, force: true });

  console.log('== 服务器 API ==');
  const { url, authToken } = await startServer(0);
  const api = async (p, data, noToken = false) => {
    const headers = {};
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    if (!noToken) headers['x-auth-token'] = authToken;
    const resp = await fetch(url + p, {
      method: data !== undefined ? 'POST' : 'GET',
      headers,
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
    return resp.json();
  };
  const apiRaw = async (p, noToken = false) => {
    const headers = {};
    if (!noToken) headers['x-auth-token'] = authToken;
    return fetch(url + p, { headers });
  };

  // 鉴权：无 token 必须被拒；bootstrap 可拿到 token
  const noAuth = await apiRaw('/api/config', true);
  check('无 token 请求被拒(403)', noAuth.status === 403, `status=${noAuth.status}`);
  const noAuthZip = await apiRaw('/api/repo/zip', true);
  check('zip 无 token 被拒(403)', noAuthZip.status === 403, `status=${noAuthZip.status}`);
  const boot = await apiRaw('/api/bootstrap');
  const bootJson = await boot.json();
  check('bootstrap 返回 token 与主题', boot.status === 200 && bootJson.token === authToken && typeof bootJson.theme === 'string', `status=${boot.status}`);
  // DNS rebinding 防护：恶意 Host 头伪装同源读取 bootstrap 必须被拒
  const httpMod = require('http');
  const evilHostStatus = await new Promise((resolve) => {
    const u = new URL(url);
    const req = httpMod.request({ host: '127.0.0.1', port: u.port, path: '/api/bootstrap', headers: { Host: 'evil.com' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(-1));
    req.end();
  });
  check('bootstrap 拒绝恶意 Host(DNS rebinding)', evilHostStatus === 403, `status=${evilHostStatus}`);
  // 恶意 Origin（无 token）的响应必须无 ACAO 头（浏览器拦截读取）；带 token 的预检（Electron file:// 关键路径）必须放行
  const evilOrigin = await fetch(url + '/api/config', { headers: { Origin: 'https://evil.com' } });
  check('恶意 Origin 无 CORS 反射', evilOrigin.status === 403 && evilOrigin.headers.get('access-control-allow-origin') === null, `status=${evilOrigin.status} ACAO=${evilOrigin.headers.get('access-control-allow-origin')}`);
  const preflight = await fetch(url + '/api/config?t=' + authToken, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Headers': 'x-auth-token' } });
  check('带 token 预检放行(Electron 路径)', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === 'null', `status=${preflight.status} ACAO=${preflight.headers.get('access-control-allow-origin')}`);

  const cfg = await api('/api/config');
  check('config 返回默认值', cfg.ok && cfg.config.model === 'deepseek-chat' && cfg.config.lang === '简体中文', JSON.stringify(cfg));
  check('config 不泄露明文密钥', cfg.config.api_key === undefined && cfg.config.github_token === undefined &&
    typeof cfg.config.api_key_set === 'boolean' && typeof cfg.config.github_token_set === 'boolean', JSON.stringify(cfg));
  check('config 含主题与 API 地址', typeof cfg.config.theme === 'string' && typeof cfg.config.api_base === 'string', JSON.stringify(cfg.config));
  check('config 含代理/温度/最大输出', typeof cfg.config.proxy === 'string' && typeof cfg.config.temperature === 'number' && typeof cfg.config.max_tokens === 'number', JSON.stringify(cfg.config));
  const cfgBefore = JSON.stringify(cfg.config);

  // 通用 ZIP 打包端点（本地批量翻译"全部保存"用）
  const zipResp = await fetch(url + '/api/zip?t=' + authToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': authToken },
    body: JSON.stringify({ files: [{ path: 'a.html', content: '<h1>你好</h1>' }, { path: '子目录/b.txt', content: '测试' }], base: 'webtranslated' }),
  });
  const zipBuf = Buffer.from(await zipResp.arrayBuffer());
  check('POST /api/zip 返回合法 ZIP', zipResp.status === 200 && zipBuf.readUInt32LE(0) === 0x04034b50 && zipBuf.readUInt32LE(zipBuf.length - 22) === 0x06054b50, `status=${zipResp.status} len=${zipBuf.length}`);
  const zipNoAuth = await fetch(url + '/api/zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"files":[]}' });
  check('zip 无 token 被拒(403)', zipNoAuth.status === 403, `status=${zipNoAuth.status}`);
  // 路径穿越防护（.. / 反斜杠 / 盘符冒号 / NUL）
  const zipBadPath = await fetch(url + '/api/zip?t=' + authToken, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: [{ path: '../evil.txt', content: 'x' }] }) });
  check('zip 拒绝路径穿越(..)', zipBadPath.status === 200 && (await zipBadPath.json()).ok === false, `status=${zipBadPath.status}`);
  const zipBadPath2 = await fetch(url + '/api/zip?t=' + authToken, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: [{ path: 'C:\\evil.txt', content: 'x' }] }) });
  check('zip 拒绝路径穿越(盘符/反斜杠)', zipBadPath2.status === 200 && (await zipBadPath2.json()).ok === false, `status=${zipBadPath2.status}`);

  const r1 = await api('/api/translate', { name: 'x.js', content: 'var a=1;', api_key: 'sk-fake', model: 'deepseek-chat', lang: '简体中文' });
  check('translate 返回 jobId', r1.ok && !!r1.jobId);
  // 轮询等待任务结束（代理环境下可能较慢）
  let r2 = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000));
    r2 = await api(`/api/job/${r1.jobId}`);
    if (r2.status === 'done' || r2.status === 'error') break;
  }
  check('job 状态为 error（假 key）', r2.status === 'error' && /401|Authentication/.test(r2.error || ''), String(r2.error));

  const r3 = await api('/api/job/not-exist');
  check('不存在 job 报错', !r3.ok && /不存在/.test(r3.error || ''));

  const cfg2 = await api('/api/config');
  check('假 key 未污染配置', JSON.stringify(cfg2.config) === cfgBefore, JSON.stringify(cfg2.config));

  // config 写入 → 回读持久化（温度/最大输出/代理），随后恢复默认
  await api('/api/config', { temperature: 0.7, max_tokens: 4096, proxy: 'http://127.0.0.1:9' });
  const cfg3 = await api('/api/config');
  check('config 写入后回读', cfg3.config.temperature === 0.7 && cfg3.config.max_tokens === 4096 && cfg3.config.proxy === 'http://127.0.0.1:9', JSON.stringify(cfg3.config));
  await api('/api/config', { temperature: 0.3, max_tokens: 16384, proxy: '' });
  const cfg4 = await api('/api/config');
  check('config 恢复默认', cfg4.config.temperature === 0.3 && cfg4.config.proxy === '', JSON.stringify(cfg4.config));

  // 通用静态网站解析（本地站点模拟 GitLab/Netlify 等静态站）
  const siteServer = require('http').createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><script src="main.js"></script></html>'); }
    if (p === '/main.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('var x=1;'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => siteServer.listen(0, '127.0.0.1', r));
  const q2 = await api('/api/repo/query', { url: `http://127.0.0.1:${siteServer.address().port}/` });
  check('通用静态网站解析(generic)', q2.ok && q2.mode === 'generic' && Array.isArray(q2.files) && q2.files.length === 2, JSON.stringify(q2).slice(0, 160));

  // 翻译历史接口（服务器持久化）
  const hist = await api('/api/history');
  check('history 接口可用', hist.ok && Array.isArray(hist.history), JSON.stringify(hist).slice(0, 100));

  // 静态资源
  for (const p of ['/', '/style.css', '/app.js', '/favicon.ico']) {
    const resp = await fetch(url + p);
    const ok = resp.status === 200 || (p === '/favicon.ico' && resp.status === 204);
    check(`静态资源 ${p}`, ok, `status=${resp.status}`);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
