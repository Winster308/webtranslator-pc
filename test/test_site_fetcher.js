'use strict';
/** 通用静态网站解析器测试：本地 HTTP 站点模拟静态站（类似 GitLab/Gitee/Netlify 构建产物），
 * 验证递归抓取、外域排除、CSS url()、JS 内引用、二进制下载。 */
const http = require('http');
const SF = require('../server/site_fetcher');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}  ${detail}`); }
}

(async () => {
  console.log('== 通用静态网站解析 ==');
  const site = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const send = (ct, body) => { res.writeHead(200, { 'Content-Type': ct }); res.end(body); };
    if (p === '/') return send('text/html',
      '<html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script></head>' +
      '<body><img src="img/logo.png"><script src="https://cdn.example.com/ext.js"></script></body></html>');
    if (p === '/app.js') return send('text/javascript', 'import("./data.json");\nimport lib from "lib.js";');
    if (p === '/style.css') return send('text/css', 'body{background:url(../img/bg.png)}');
    if (p === '/data.json') return send('application/json', '{"a":1}');
    if (p === '/lib.js') return send('text/javascript', 'export default 1;');
    if (p === '/img/logo.png') return send('image/png', Buffer.from([1, 2, 3]));
    if (p === '/img/bg.png') return send('image/png', Buffer.from([4, 5, 6]));
    res.writeHead(404); res.end();
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;

  const r = await SF.parseSite(base + '/');
  const paths = r.files.map(f => f.path);
  console.log('  解析到:', paths.join(', '));
  check('抓取首页', paths.includes('index.html'));
  check('递归 JS/CSS', paths.includes('app.js') && paths.includes('style.css'));
  check('JS 内引用', paths.includes('data.json') && paths.includes('lib.js'));
  check('CSS url() 引用', paths.includes('img/bg.png'));
  check('资源图片', paths.includes('img/logo.png'));
  check('外域排除', !paths.includes('ext.js') && !r.files.some(f => (f.url || '').includes('cdn.example.com')));
  check('baseUrl 正确', r.baseUrl === base + '/', r.baseUrl);

  const buf = await SF.downloadSite(r.baseUrl, 'img/logo.png');
  check('下载二进制字节一致', buf.equals(Buffer.from([1, 2, 3])));
  const txt = (await SF.downloadSite(r.baseUrl, 'app.js')).toString('utf8');
  check('下载文本正确', txt.includes('data.json'));
  const notFound = await SF.downloadSite(r.baseUrl, 'missing.js').then(() => true, () => false);
  check('404 下载报错', notFound === false);
  const crossDomain = await SF.downloadSite(r.baseUrl, 'https://evil.com/x.png').then(() => false, () => true);
  check('跨域下载被拒绝', crossDomain === true);

  let threw = false;
  try { await SF.parseSite('not a url'); } catch (e) { threw = true; }
  check('非法链接报错', threw);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
