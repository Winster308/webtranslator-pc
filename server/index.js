'use strict';
/**
 * 内置 HTTP 服务器 + API 路由（Node 标准库，零依赖）。
 * 提供静态文件（renderer/）与全部业务 API；长任务走 job 队列（前端轮询进度）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ★ 系统代理自动适配：浏览器能开 GitHub 而应用网络错误时，Node 需走代理；
//   设置里配置了手动代理则优先使用，否则读 Windows 系统代理
const { setupProxy } = require('./proxy');
const CONFIG_FILE = path.join(os.homedir(), '.webtranslator_pc_config.json');
setupProxy(loadConfig().proxy);

const T = require('./translator');
const { DeepSeekClient } = require('./deepseek');
const GH = require('./github');
const SF = require('./site_fetcher');
const { makeZip } = require('./zip');
const { cacheGet, cacheSet, cacheClear } = require('./cache');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'renderer');

// ==================== 配置持久化 ====================

function loadConfig() {
  const def = { api_key: '', model: 'deepseek-chat', lang: '简体中文', github_client_id: '', github_token: '', github_repo: '',
                api_base: '', theme: 'dark', proxy: '', temperature: 0.3, max_tokens: 16384 };
  try { return { ...def, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch (e) { return def; }
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
}

// ==================== 会话状态与任务队列 ====================

const state = {
  cfg: loadConfig(),
  repoInfo: null,         // {owner, repo, default_branch}
  repoMode: 'gh',         // 'gh' | 'itch' | 'generic'
  siteBase: null,         // 通用模式下的站点根 URL
  itchBase: null,
  repoFiles: [],
  translatedRemote: null, // {path: content}
  translatedAssets: {},   // {path: Buffer}
  failedReports: {},      // {path: reason}
};

// ==================== GitHub 多账号（独立存储 + 兼容旧 github_token） ====================

const ACCOUNTS_FILE = path.join(os.homedir(), '.webtranslator_pc_accounts.json');
const ghAccounts = loadAccounts(); // [{id, name, token, user, created}]

function loadAccounts() {
  try {
    const arr = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveAccounts() {
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(ghAccounts, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
}

/** 旧版本只有 github_token：自动迁移为第一个账号，并确定激活账号。 */
function ensureAccountMigration() {
  if (!ghAccounts.length && state.cfg.github_token) {
    ghAccounts.push({ id: `acc_${Date.now()}`, name: '主账号', token: state.cfg.github_token, user: '', created: Date.now() });
    saveAccounts();
  }
  if (!state.cfg.github_active && ghAccounts.length) {
    state.cfg.github_active = ghAccounts[0].id;
    saveConfig(state.cfg);
  }
}

/** 当前激活账号的 token（无账号列表时回退旧字段）。 */
function activeGithubToken() {
  const act = ghAccounts.find(a => a.id === state.cfg.github_active);
  if (act && act.token) return act.token;
  return state.cfg.github_token || null;
}

function activeAccount() {
  return ghAccounts.find(a => a.id === state.cfg.github_active) || null;
}

/** 添加或更新账号（同 login 覆盖更新），并设为激活。 */
function upsertAccount(token, user, name = '') {
  const login = user && user.login;
  let acc = login ? ghAccounts.find(a => a.user === login) : null;
  if (acc) {
    acc.token = token;
    acc.name = name || acc.name || login;
  } else {
    acc = { id: `acc_${Date.now()}_${Math.floor(Math.random() * 10000)}`, name: name || login || '账号', token, user: login || '', created: Date.now() };
    ghAccounts.push(acc);
  }
  state.cfg.github_active = acc.id;
  state.cfg.github_token = token; // 兼容镜像：旧逻辑仍可读
  saveAccounts();
  saveConfig(state.cfg);
  return acc;
}

function sanitizeAccount(a) {
  return { id: a.id, name: a.name, user: a.user || '', token_set: !!a.token };
}

// 迁移旧 token → 账号（state 初始化后执行）
ensureAccountMigration();

// ==================== 翻译会话历史（内存 + 磁盘持久化） ====================

const HISTORY_FILE = path.join(os.homedir(), '.webtranslator_pc_history.json');
const HISTORY_MAX = 50;
const historyList = loadHistory();

function loadHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyList.slice(0, HISTORY_MAX), null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
}

function addHistory(entry) {
  historyList.unshift({ time: Date.now(), ...entry });
  if (historyList.length > HISTORY_MAX) historyList.length = HISTORY_MAX;
  saveHistory();
}

const jobs = new Map(); // id -> {status, done, total, logs:[], result, error}

// 本次启动的本地安全令牌（createServer 时生成；单实例设计，模块级共享）
let serverAuthToken = null;

function runJob(fn) {
  // 清理保护：运行超过 30 分钟仍卡住的任务视为异常，删除释放内存（正常任务有 15 分钟超时）
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && now - j.created > 10 * 60 * 1000) jobs.delete(id);
    else if (j.status === 'running' && now - j.created > 30 * 60 * 1000) jobs.delete(id);
  }
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, status: 'running', done: 0, total: 0, logs: [], result: null, error: null, created: Date.now() };
  jobs.set(id, job);
  const log = (kind, payload) => {
    job.logs.push([kind, payload, Date.now()]);
    if (kind === 'progress') { job.done = payload.done || 0; job.total = payload.total || 0; }
    if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
  };
  Promise.resolve()
    .then(() => fn(log))
    .then((result) => { job.status = 'done'; job.result = result; })
    .catch((e) => { job.status = 'error'; job.error = String(e.message || e); });
  return id;
}

// ==================== 工具 ====================

/**
 * CORS 收紧：只对可信来源反射跨域头，杜绝任意网页读取本地 API。
 * - 127.0.0.1 / localhost / ::1（浏览器模式同源页面）→ 反射
 * - 其他来源（含无 Origin 的 file:// 页面、远程网页）→ 仅当请求携带有效安全令牌才反射：
 *   程序页面（Electron preload 注入 / 浏览器模式同源）总是携带 token，恶意本地 HTML / 远程网页没有。
 *   （无 token 的响应不反射 CORS 头，浏览器会拦截读取——包括 /api/bootstrap 的 token 引导。）
 */
function authOk(req) {
  if (!serverAuthToken) return true; // 鉴权关闭（测试模式）
  const t = req.headers['x-auth-token'] || new URL(req.url, 'http://localhost').searchParams.get('t') || '';
  return t === serverAuthToken;
}

/** Host 头是否为本地回环地址（防 DNS rebinding 伪装同源）。 */
function isLocalHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === '127.0.0.1' || host.startsWith('127.0.0.1:') ||
         host === 'localhost' || host.startsWith('localhost:') ||
         host === '[::1]' || host.startsWith('[::1]:');
}

function corsAllowed(origin, req) {
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') return true;
    } catch (e) { /* 非法 Origin 走 token 判定 */ }
  }
  return authOk(req);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!corsAllowed(origin, req)) return {};
  return { 'Access-Control-Allow-Origin': origin || '*' };
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(res.__cors || {}),
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 200 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function handleError(res, e) {
  json(res, 200, { ok: false, error: String(e.message || e) });
}

function makeClient(reqCfg) {
  const cfg = { ...state.cfg, ...(reqCfg || {}) };
  return new DeepSeekClient(cfg.api_key, cfg.model || 'deepseek-chat', cfg.api_base || 'https://api.deepseek.com', {
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.3,
    maxTokens: cfg.max_tokens || 16384,
  });
}

// ==================== 业务逻辑 ====================

/** 批量翻译远程文件（并发池 + 15 分钟超时 + 合并未翻译资源）。 */
async function translateRemoteFiles(reqCfg, selectedPaths, log) {
  const cfg = { ...state.cfg, ...(reqCfg || {}) };
  const info = state.repoInfo;
  const itchBase = state.itchBase;
  const siteBase = state.siteBase;
  const mode = state.repoMode || 'gh';
  const token = activeGithubToken() || null;
  const api = new GH.GithubApi(token);
  const client = makeClient(reqCfg);
  const results = {};
  const failed = [];
  const failedReports = {};
  let skipped = 0, noTranslate = 0;
  const total = selectedPaths.length;

  const pool = Math.min(total, 8);
  let idx = 0;
  let doneCount = 0;
  const tick = () => log('progress', { done: ++doneCount, total });
  const runWorker = async () => {
    while (true) {
      const i = idx++;
      if (i >= total) return;
      const f = selectedPaths[i];
      try {
        if (f.size > GH.MAX_FILE_BYTES) { skipped++; log('log', `跳过 ${f.path} (超过 ${Math.floor(GH.MAX_FILE_BYTES / 1024)}KB)`); tick(); continue; }
        const content = mode === 'generic'
          ? (await SF.downloadSite(siteBase, f.path)).toString('utf8').replace(/^\uFEFF/, '')
          : mode === 'itch'
            ? (await GH.itchDownload(itchBase, f.path)).toString('utf8').replace(/^\uFEFF/, '')
            : await api.download(info.owner, info.repo, info.default_branch, f.path);
        const type = T.detectType(f.path, content);
        // 超时控制：超时后 abort 底层翻译请求（不再继续消耗 API 额度），并清理计时器
        const ctrl = new AbortController();
        let timeoutTimer;
        let translated;
        try {
          translated = await Promise.race([
            T.translate({
              text: content, type, targetLang: cfg.lang || '简体中文', client, filePath: f.path, signal: ctrl.signal,
              onRetry: (a) => log('log', `  ${f.path} 语法校验失败，自动重译 (第 ${a} 次)`),
              onSkip: (reason) => {
                if (reason.startsWith('AI 判定无需翻译')) noTranslate++;
                else { failedReports[f.path] = reason; require('./failure_memory').remember(f.path, reason); log('log', `  ${f.path}: ${reason.slice(0, 120)}`); }
              },
            }),
            new Promise((_, rej) => { timeoutTimer = setTimeout(() => { ctrl.abort(); rej(new Error('翻译超时（超过 15 分钟），已保留原文')); }, 15 * 60 * 1000); }),
          ]);
        } finally {
          clearTimeout(timeoutTimer); // 无论成败都清理计时器，防止失败文件挂留定时器
        }
        results[f.path] = translated;
      } catch (e) {
        if (String(e.message || e).includes('翻译超时')) { failedReports[f.path] = String(e.message); results[f.path] = null; }
        else failed.push(`${f.path} (${e.message || e})`);
      }
      tick();
    }
  };
  await Promise.all(Array.from({ length: pool }, runWorker));

  // 合并未翻译文件（含资源）
  const merged = { ...results };
  const assets = {};
  let fullList = [];
  if (mode === 'generic' || mode === 'itch') fullList = state.repoFiles || [];
  else {
    try { fullList = await api.listFiles(info.owner, info.repo, info.default_branch, true); }
    catch (e) { fullList = state.repoFiles || []; }
  }
  const sel = new Set(selectedPaths.map(f => f.path));
  const mergeList = fullList.filter(o => !sel.has(o.path) && !(o.path in merged) && !(o.path in assets));
  if (mergeList.length) {
    log('log', `合并 ${mergeList.length} 个未翻译文件（含资源）…`);
    const mPool = Math.min(mergeList.length, 16);
    let mi = 0;
    const mWorker = async () => {
      while (true) {
        const k = mi++;
        if (k >= mergeList.length) return;
        const o = mergeList[k];
        try {
          if (o.size > GH.MAX_FILE_BYTES) continue;
          if (mode === 'generic') {
            const data = await SF.downloadSite(siteBase, o.path);
            if (SF.isTextFile(o.path, '')) merged[o.path] = data.toString('utf8').replace(/^\uFEFF/, '');
            else assets[o.path] = data;
          } else if (mode === 'itch') {
            const data = await GH.itchDownload(itchBase, o.path);
            if (GH.isTextFile(o.path)) merged[o.path] = data.toString('utf8').replace(/^\uFEFF/, '');
            else assets[o.path] = data;
          } else {
            if (GH.isTextFile(o.path)) merged[o.path] = await api.download(info.owner, info.repo, info.default_branch, o.path);
            else assets[o.path] = await api.downloadBytes(info.owner, info.repo, info.default_branch, o.path);
          }
        } catch (e) { /* 合并失败忽略 */ }
      }
    };
    await Promise.all(Array.from({ length: mPool }, mWorker));
  }

  return { results: merged, assets, failed, skipped, noTranslate, failedReports, mergeCount: mergeList.length };
}

/** 重试失败文件。 */
async function retryFailedFiles(reqCfg, log) {
  const cfg = { ...state.cfg, ...(reqCfg || {}) };
  const info = state.repoInfo;
  const itchBase = state.itchBase;
  const siteBase = state.siteBase;
  const mode = state.repoMode || 'gh';
  const api = new GH.GithubApi(activeGithubToken() || null);
  const client = makeClient(reqCfg);
  const paths = Object.keys(state.failedReports);
  let succeeded = 0, doneCount = 0;
  const stillFailed = [];
  const pool = Math.min(paths.length, 8);
  let idx = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= paths.length) return;
      const p = paths[i];
      try {
        const content = mode === 'generic'
          ? (await SF.downloadSite(siteBase, p)).toString('utf8').replace(/^\uFEFF/, '')
          : mode === 'itch'
            ? (await GH.itchDownload(itchBase, p)).toString('utf8').replace(/^\uFEFF/, '')
            : await api.download(info.owner, info.repo, info.default_branch, p);
        const type = T.detectType(p, content);
        // 超时控制：超时后 abort 底层翻译请求（不再继续消耗 API 额度），并清理计时器
        const ctrl = new AbortController();
        let timeoutTimer;
        let translated;
        try {
          translated = await Promise.race([
            T.translate({
              text: content, type, targetLang: cfg.lang || '简体中文', client, filePath: p,
              previousErrors: state.failedReports[p], signal: ctrl.signal,
              onRetry: (a) => log('log', `  ${p} 语法校验失败，自动重译 (第 ${a} 次)`),
              onSkip: (reason) => {
                if (reason.startsWith('AI 判定无需翻译')) delete state.failedReports[p];
                else { state.failedReports[p] = reason; require('./failure_memory').remember(p, reason); stillFailed.push(p); }
              },
            }),
            new Promise((_, rej) => { timeoutTimer = setTimeout(() => { ctrl.abort(); rej(new Error('重试超时（超过 15 分钟），已保留原文')); }, 15 * 60 * 1000); }),
          ]);
        } finally {
          clearTimeout(timeoutTimer); // 无论成败都清理计时器，防止失败文件挂留定时器
        }
        if (!stillFailed.includes(p)) {
          delete state.failedReports[p];
          state.translatedRemote = { ...(state.translatedRemote || {}), [p]: translated };
          succeeded++;
        }
      } catch (e) {
        stillFailed.push(p);
        state.failedReports[p] = `重试失败: ${e.message || e}`;
      }
      log('progress', { done: ++doneCount, total: paths.length });
    }
  };
  await Promise.all(Array.from({ length: pool }, worker));
  return { succeeded, stillFailed: stillFailed.length };
}

// ==================== API 路由 ====================

const routes = {

  // 设置（密钥脱敏：不向页面返回明文 api_key / github_token，防止本地端口被恶意网页窃取）
  'GET /api/config': async (req, res) => json(res, 200, {
    ok: true,
    config: {
      api_key_set: !!state.cfg.api_key,
      github_token_set: !!activeGithubToken(),
      model: state.cfg.model,
      lang: state.cfg.lang,
      api_base: state.cfg.api_base || '',
      theme: state.cfg.theme || 'dark',
      proxy: state.cfg.proxy || '',
      temperature: typeof state.cfg.temperature === 'number' ? state.cfg.temperature : 0.3,
      max_tokens: state.cfg.max_tokens || 16384,
      github_client_id: state.cfg.github_client_id,
      github_repo: state.cfg.github_repo,
    },
  }),
  'POST /api/config': async (req, res, body) => {
    const cfg = JSON.parse(body.toString('utf8') || '{}');
    // 密钥特殊语义：undefined / '********'（掩码）→ 保留原值；'' → 清空；其他 → 更新
    for (const k of ['api_key', 'github_token']) {
      if (cfg[k] === undefined || cfg[k] === '********') continue;
      state.cfg[k] = cfg[k];
      // github_token 写入同步进账号存储（消除镜像/账号双源分叉）
      if (k === 'github_token') {
        const act = activeAccount();
        if (act) { act.token = cfg[k]; saveAccounts(); }
      }
    }
    for (const k of ['model', 'lang', 'github_client_id', 'github_repo', 'api_base', 'theme', 'proxy']) {
      if (cfg[k] !== undefined) state.cfg[k] = cfg[k];
    }
    if (typeof cfg.temperature === 'number' && cfg.temperature >= 0 && cfg.temperature <= 2) state.cfg.temperature = cfg.temperature;
    if (typeof cfg.max_tokens === 'number') state.cfg.max_tokens = Math.max(256, Math.min(32768, Math.floor(cfg.max_tokens)));
    saveConfig(state.cfg);
    // 代理变更立即生效（重新配置全局代理）
    if (cfg.proxy !== undefined) setupProxy(state.cfg.proxy || '');
    json(res, 200, { ok: true });
  },

  // 本地安全令牌引导：页面（同源或 file://）从这里获取本次启动的随机 token，用于后续 API 鉴权
  // 仅接受本机 Host（防 DNS rebinding：恶意域名解析到 127.0.0.1 时也无法伪装同源读取）
  'GET /api/bootstrap': async (req, res) => {
    if (serverAuthToken && !isLocalHost(req)) return json(res, 403, { ok: false, error: '拒绝访问' });
    json(res, 200, { ok: true, token: serverAuthToken || '', theme: state.cfg.theme || 'dark' });
  },

  // 本地翻译（job）
  'POST /api/translate': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    if (b.content && b.content.length > 5 * 1024 * 1024) {
      throw new Error('文件超过 5MB，超出单文件翻译上限，请先拆分文件');
    }
    const jobId = runJob(async (log) => {
      const type = T.detectType(b.name, b.content);
      const client = makeClient(b);
      const translated = await T.translate({
        text: b.content, type, targetLang: b.lang || state.cfg.lang || '简体中文', client, filePath: b.name,
        onProgress: (d, t) => log('progress', { done: d, total: t }),
        onRetry: (a, e) => log('log', `语法校验失败，自动重译 (第 ${a} 次): ${String(e).slice(0, 100)}`),
        onSkip: (r) => log('log', `翻译失败已保留原文: ${r.slice(0, 120)}`),
      });
      addHistory({ kind: 'local', lang: b.lang || state.cfg.lang || '', name: b.name, total: 1, ok: 1, fail: 0 });
      return { name: b.name, type, translated };
    });
    json(res, 200, { ok: true, jobId });
  },

  // 仓库/网站查询（结果缓存 10 分钟，避免重复消耗配额）
  // 自动判定：itch.io → GitHub（Pages/github.com/自定义域名 CNAME）→ 通用静态网站（GitLab/Gitee/Netlify/Vercel/任意静态站）
  'POST /api/repo/query': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const url = (b.url || '').trim();
    const tokenTag = activeGithubToken() ? 'auth' : 'anon';
    const cacheKey = `repo:query:${tokenTag}:${url}`;
    const cached = cacheGet(cacheKey, 10 * 60 * 1000);
    if (cached) {
      state.repoInfo = cached.info || null;
      state.repoMode = cached.mode || 'gh';
      state.siteBase = cached.siteBase || null;
      state.itchBase = cached.itchBase || null;
      state.repoFiles = cached.files || [];
      return json(res, 200, { ok: true, ...cached.data });
    }
    const isItch = /itch\.io/i.test(url);
    if (isItch) {
      const site = await GH.resolveItch(url);
      if (!site) throw new Error('无法解析 itch.io 游戏页（未找到游戏本体 iframe）');
      state.itchBase = site.base_url;
      state.repoMode = 'itch';
      state.siteBase = null;
      state.repoInfo = { owner: 'itch', repo: site.base_url.split('/html/')[1].replace(/\/+$/, ''), default_branch: '' };
      state.repoFiles = site.files;
      cacheSet(cacheKey, { data: { files: site.files, isItch: true, mode: 'itch' }, info: state.repoInfo, itchBase: state.itchBase, siteBase: null, mode: 'itch', files: site.files });
      json(res, 200, { ok: true, files: site.files, isItch: true, mode: 'itch' });
      return;
    }
    const repo = await GH.resolveRepoUrlAsync(url);
    if (repo) {
      const api = new GH.GithubApi(activeGithubToken());
      const info = await api.getRepoInfo(repo.owner, repo.repo);
      const files = await api.listFiles(info.owner, info.repo, info.default_branch);
      state.repoInfo = info;
      state.repoMode = 'gh';
      state.siteBase = null;
      state.itchBase = null;
      state.repoFiles = files;
      cacheSet(cacheKey, { data: { files, info, isItch: false, mode: 'gh' }, info, itchBase: null, siteBase: null, mode: 'gh', files });
      json(res, 200, { ok: true, files, info, isItch: false, mode: 'gh' });
      return;
    }
    // 通用静态网站解析（GitLab Pages / Gitee Pages / Netlify / Vercel / 任意静态站）
    const site = await SF.parseSite(url);
    state.repoInfo = null;
    state.repoMode = 'generic';
    state.siteBase = site.baseUrl;
    state.itchBase = null;
    state.repoFiles = site.files;
    cacheSet(cacheKey, { data: { files: site.files, isItch: false, mode: 'generic', homeUrl: site.homeUrl }, info: null, itchBase: null, siteBase: site.baseUrl, mode: 'generic', files: site.files });
    json(res, 200, { ok: true, files: site.files, isItch: false, mode: 'generic', homeUrl: site.homeUrl });
  },

  // AI 选文件
  'POST /api/repo/ai-select': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const files = b.files || [];
    const manifest = files.map(f => `${f.path}|${Math.floor(f.size / 1024)}KB`).join('\n');
    const system = `你是一个网站本地化项目管理专家。下面是一个网站仓库的文件清单（每行格式：路径|大小KB），共 ${files.length} 个文件。

请决定哪些文件需要翻译成简体中文。

【需要翻译的】
- HTML/JS/CSS/文本文件中包含"用户打开网页能看到"的界面文案的
- 游戏/应用的核心逻辑文件（含按钮文字、提示信息、界面标题等）
- 不确定的文件宁可选上（翻译环节会自动校验，失败会保留原文，不会损坏）

【不需要翻译的】
- 第三方库/框架：文件名或路径含 vue、react、jquery、bootstrap、angular、axios、lodash 等库名
- 压缩代码：*.min.js、*.min.css
- 构建产物目录：dist/、build/、out/、release/
- 依赖目录：node_modules/、vendor/、lib/（第三方库）
- 纯逻辑/引擎库：游戏引擎、数学库、工具库（如 break_eternity.js、prototype 库等不含界面文案的）
- 纯资源：图片(.png .jpg .svg .webp .gif .ico)、字体(.woff .ttf .eot)、音频(.mp3 .ogg)、视频(.mp4)
- 不含界面文案的纯配置文件（如纯数据 .json、地图/关卡数据）

只输出一个 JSON 字符串数组（文件路径列表），不要任何解释、不要 markdown 代码块。示例：["index.html","js/main.js"]`;
    const client = makeClient(b);
    const raw = await client.chat(system, manifest);
    const cleaned = T.stripMarkdownFence(raw);
    const paths = T.parseJsonArray(cleaned);
    const valid = new Set(files.map(f => f.path));
    const picked = [...new Set(paths)].filter(p => valid.has(p));
    if (!picked.length) throw new Error(`AI 没有选出任何文件，返回: ${raw.slice(0, 100)}`);
    json(res, 200, { ok: true, picked, raw });
  },

  // 批量翻译（job）
  'POST /api/repo/translate': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const jobId = runJob(async (log) => {
      const result = await translateRemoteFiles(b, b.files, log);
      state.translatedRemote = result.results;
      state.translatedAssets = result.assets;
      state.failedReports = result.failedReports;
      addHistory({
        kind: 'repo', mode: state.repoMode || 'gh', lang: b.lang || state.cfg.lang || '',
        name: state.repoInfo ? `${state.repoInfo.owner}/${state.repoInfo.repo}` : (state.siteBase || ''),
        total: b.files.length,
        ok: Object.keys(result.results || {}).length,
        fail: Object.keys(result.failedReports || {}).length,
        skipped: result.skipped || 0, noTranslate: result.noTranslate || 0,
      });
      return result;
    });
    json(res, 200, { ok: true, jobId });
  },

  // 翻译会话历史（重启后仍保留）
  'GET /api/history': async (req, res) => json(res, 200, { ok: true, history: historyList }),

  // 重试失败文件（job）
  'POST /api/repo/retry': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const jobId = runJob((log) => retryFailedFiles(b, log));
    json(res, 200, { ok: true, jobId });
  },

  // 任务状态轮询
  'GET /api/job/:id': async (req, res, body, url) => {
    const id = url.pathname.split('/').pop();
    const job = jobs.get(id);
    if (!job) return json(res, 200, { ok: false, error: '任务不存在' });
    // 完成后 10 分钟清理
    if (job.status !== 'running' && Date.now() - job.created > 10 * 60 * 1000) jobs.delete(id);
    json(res, 200, { ok: true, jobId: id, status: job.status, done: job.done, total: job.total, logs: job.logs, result: job.result, error: job.error });
  },

  // 通用 ZIP 打包：POST { files: [{path, content}] } → zip 二进制（本地批量翻译"全部保存"用）
  'POST /api/zip': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const files = [];
    for (const f of b.files || []) {
      const p = String(f.path || '').replace(/^\/+/, '');
      if (!p || p.includes('..') || p.includes('\\') || p.includes('\0') || p.includes(':')) {
        throw new Error(`文件路径不合法: ${p}`);
      }
      files.push({ path: p, data: Buffer.from(String(f.content ?? ''), 'utf8') });
    }
    if (!files.length) throw new Error('没有可打包的文件');
    const zip = makeZip(files);
    const base = (b.base || 'translated').replace(/[^\w\-.]/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(`${base}.zip`)}"`,
      'Content-Length': zip.length,
      ...(res.__cors || {}),
    });
    res.end(zip);
  },

  // 保存 ZIP（翻译结果 + 资源）
  'GET /api/repo/zip': async (req, res) => {
    const merged = state.translatedRemote || {};
    const assets = state.translatedAssets || {};
    const files = [];
    for (const [p, content] of Object.entries(merged)) files.push({ path: p, data: Buffer.from(content, 'utf8') });
    for (const [p, buf] of Object.entries(assets)) files.push({ path: p, data: buf });
    if (!files.length) throw new Error('没有可打包的翻译结果');
    const zip = makeZip(files);
    const info = state.repoInfo;
    const base = info && info.repo ? `${info.repo}_translated.zip` : 'translated.zip';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(base)}"`,
      'Content-Length': zip.length,
      ...(res.__cors || {}),
    });
    res.end(zip);
  },

  // JS 检测
  'POST /api/js/check': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const url = (b.url || '').trim();
    const rawUrl = url.includes('/blob/') ? url.replace('/blob/', '/raw/') : url;
    const resp = await fetch(rawUrl, { headers: { 'User-Agent': 'WebTranslator' }, signal: AbortSignal.timeout(60000) });
    if (!resp.ok) throw new Error(`下载失败 (HTTP ${resp.status})`);
    const text = (await resp.text()).replace(/^\uFEFF/, '');
    const err = await T.verifyJs(text);
    json(res, 200, { ok: true, sizeKB: Math.floor(text.length / 1024), error: err, url: rawUrl });
  },

  // GitHub 登录（token 或设备码成功 → 保存为账号并激活；同名账号自动更新）
  'POST /api/github/login-token': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const token = (b.token || '').trim();
    const user = await GH.getUser(token);
    upsertAccount(token, user, b.name);
    json(res, 200, { ok: true, user });
  },
  'POST /api/github/oauth-start': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    state.cfg.github_client_id = b.client_id;
    saveConfig(state.cfg);
    const dc = await GH.requestDeviceCode(b.client_id);
    json(res, 200, { ok: true, device: dc });
  },
  'POST /api/github/oauth-poll': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const r = await GH.pollAccessToken(b.client_id, b.device_code);
    if (r.status === 'token') {
      const user = await GH.getUser(r.value);
      upsertAccount(r.value, user);
      json(res, 200, { ok: true, token_set: true, user });
    } else {
      json(res, 200, { ok: false, status: r.status, error: r.value });
    }
  },
  // GitHub 多账号管理（token 脱敏，不返回明文）
  'GET /api/github/accounts': async (req, res) => json(res, 200, {
    ok: true,
    accounts: ghAccounts.map(sanitizeAccount),
    active_id: state.cfg.github_active || '',
  }),
  'POST /api/github/accounts': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const token = (b.token || '').trim();
    if (!token) throw new Error('缺少 GitHub Token');
    const user = await GH.getUser(token);
    upsertAccount(token, user, b.name);
    json(res, 200, { ok: true, user, accounts: ghAccounts.map(sanitizeAccount), active_id: state.cfg.github_active });
  },
  'POST /api/github/accounts/switch': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const acc = ghAccounts.find(a => a.id === b.id);
    if (!acc) throw new Error('账号不存在');
    state.cfg.github_active = acc.id;
    state.cfg.github_token = acc.token; // 兼容镜像
    saveConfig(state.cfg);
    json(res, 200, { ok: true });
  },
  'POST /api/github/accounts/remove': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const idx = ghAccounts.findIndex(a => a.id === b.id);
    if (idx < 0) throw new Error('账号不存在');
    const wasActive = state.cfg.github_active === b.id;
    ghAccounts.splice(idx, 1);
    saveAccounts();
    if (wasActive) {
      const next = ghAccounts[0];
      state.cfg.github_active = next ? next.id : '';
      state.cfg.github_token = next ? next.token : '';
      saveConfig(state.cfg);
    }
    json(res, 200, { ok: true, accounts: ghAccounts.map(sanitizeAccount), active_id: state.cfg.github_active });
  },

  // 当前登录账号信息
  'GET /api/github/me': async (req, res) => {
    if (!activeGithubToken()) return json(res, 200, { ok: false, loggedIn: false });
    try {
      const user = await GH.getUser(activeGithubToken());
      json(res, 200, { ok: true, loggedIn: true, user });
    } catch (e) {
      json(res, 200, { ok: false, loggedIn: false, error: String(e.message) });
    }
  },

  // 仓库
  'GET /api/github/repos': async (req, res) => {
    if (!activeGithubToken()) throw new Error('请先登录 GitHub');
    const repos = await GH.listRepos(activeGithubToken());
    json(res, 200, { ok: true, repos });
  },
  'POST /api/github/create-repo': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const repo = await GH.createRepo(activeGithubToken(), b.name);
    state.cfg.github_repo = repo.full_name;
    saveConfig(state.cfg);
    json(res, 200, { ok: true, repo });
  },

  // 推送翻译结果
  'POST /api/github/push': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const token = activeGithubToken();
    if (!token) throw new Error('请先登录 GitHub');
    const [owner, name] = b.repo.full_name.split('/');
    const branch = b.repo.default_branch || 'main';
    const logs = [];
    // mode='translated'：直接用服务器内存中的翻译结果（避免大体积 base64 传输）
    let textFiles = b.textFiles || {};
    let assetBuffers = {};
    if (b.mode === 'translated') {
      textFiles = state.translatedRemote || {};
      assetBuffers = state.translatedAssets || {};
    } else {
      for (const [p, b64] of Object.entries(b.assets || {})) assetBuffers[p] = Buffer.from(b64, 'base64');
    }
    try {
      await GH.pushFileBinary(token, owner, name, branch, '.nojekyll', Buffer.alloc(0), 'Add .nojekyll for GitHub Pages');
    } catch (e) { /* 失败不阻塞 */ }
    // 并发推送（同一仓库不同文件互不冲突，6 并发大幅缩短等待时间）
    const files = [
      ...Object.entries(textFiles).map(([p, content]) => ({ path: p, data: Buffer.from(content, 'utf8'), label: '推送' })),
      ...Object.entries(assetBuffers).map(([p, buf]) => ({ path: p, data: buf, label: '推送资源' })),
    ];
    const total = files.length;
    let i = 0, idx = 0;
    const failed = [];
    const worker = async () => {
      while (true) {
        const k = idx++;
        if (k >= total) return;
        const f = files[k];
        logs.push(['log', `${f.label} ${f.path}…`]);
        try {
          await GH.pushFileBinary(token, owner, name, branch, f.path, f.data, 'Translate via WebTranslator');
        } catch (e) {
          failed.push(`${f.path} (${e.message || e})`);
        }
        logs.push(['progress', { done: ++i, total }]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, Math.max(total, 1)) }, worker));
    let pagesUrl = null;
    if (b.enablePages) {
      try { pagesUrl = await GH.enablePages(token, owner, name, branch); } catch (e) { /* 忽略 */ }
    }
    json(res, 200, { ok: true, pushed: total - failed.length, failed, pagesUrl, logs });
  },

  // 上传本地文件（base64，并发推送）
  'POST /api/github/upload': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const token = activeGithubToken();
    if (!token) throw new Error('请先登录 GitHub');
    const [owner, name] = b.repo.full_name.split('/');
    const branch = b.repo.default_branch || 'main';
    const files = b.files || [];
    const failed = [];
    let done = 0, idx = 0;
    const worker = async () => {
      while (true) {
        const k = idx++;
        if (k >= files.length) return;
        const f = files[k];
        const data = Buffer.from(f.base64, 'base64');
        if (data.length > 900 * 1024) { failed.push(`${f.name} (>900KB)`); continue; }
        try {
          await GH.pushFileBinary(token, owner, name, branch, f.name, data, 'Upload via WebTranslator');
          done++;
        } catch (e) { failed.push(`${f.name} (${e.message})`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, Math.max(files.length, 1)) }, worker));
    let pagesUrl = null;
    if (b.enablePages && done > 0) { try { pagesUrl = await GH.enablePages(token, owner, name, branch); } catch (e) { /* 忽略 */ } }
    json(res, 200, { ok: true, done, failed, pagesUrl });
  },

  // ========== 仓库文件管理（本地浏览/编辑/新增/删除） ==========

  // 文件树（文本 + 资源，缓存 10 分钟）
  'POST /api/github/file-tree': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const token = activeGithubToken();
    if (!token) throw new Error('请先登录 GitHub');
    const [owner, name] = b.repo.full_name.split('/');
    const branch = b.repo.default_branch || 'main';
    const cacheKey = `repo:tree:${token.slice(-8)}:${owner}/${name}:${branch}`;
    const cached = cacheGet(cacheKey, 10 * 60 * 1000);
    if (cached) return json(res, 200, { ok: true, files: cached });
    const api = new GH.GithubApi(token);
    const files = await api.listFiles(owner, name, branch, true);
    cacheSet(cacheKey, files);
    json(res, 200, { ok: true, files });
  },

  // 读取文件内容（文本返回内容，二进制返回 isText=false）
  'POST /api/github/file-content': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const token = activeGithubToken();
    if (!token) throw new Error('请先登录 GitHub');
    const [owner, name] = b.repo.full_name.split('/');
    const branch = b.repo.default_branch || 'main';
    const f = await GH.getFileContent(token, owner, name, branch, b.path);
    if (f.data.length > 2 * 1024 * 1024) throw new Error(`${b.path} 超过 2MB，不支持在线编辑（可下载后处理）`);
    if (!f.isText) throw new Error(`${b.path} 是二进制文件，不支持在线编辑`);
    json(res, 200, { ok: true, path: b.path, content: f.data.toString('utf8'), size: f.size, sha: f.sha });
  },

  // 保存/新增文件（更新或创建，UTF-8 文本）
  'POST /api/github/file-save': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const token = activeGithubToken();
    if (!token) throw new Error('请先登录 GitHub');
    const [owner, name] = b.repo.full_name.split('/');
    const branch = b.repo.default_branch || 'main';
    const path = String(b.path || '').trim().replace(/^\/+/, '');
    if (!path || path.includes('..')) throw new Error('文件路径不合法');
    await GH.pushFileBinary(token, owner, name, branch, path, Buffer.from(String(b.content || ''), 'utf8'),
      b.message || (b.isNew ? 'Add file via WebTranslator' : 'Update file via WebTranslator'));
    json(res, 200, { ok: true, path });
  },

  // 删除文件
  'POST /api/github/file-delete': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const token = activeGithubToken();
    if (!token) throw new Error('请先登录 GitHub');
    const [owner, name] = b.repo.full_name.split('/');
    const branch = b.repo.default_branch || 'main';
    await GH.deleteFile(token, owner, name, branch, b.path);
    json(res, 200, { ok: true, path: b.path });
  },

  // 独立开启 GitHub Pages
  'POST /api/github/pages': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const token = activeGithubToken();
    if (!token) throw new Error('请先登录 GitHub');
    const [owner, name] = b.repo.full_name.split('/');
    const branch = b.repo.default_branch || 'main';
    try {
      await GH.pushFileBinary(token, owner, name, branch, '.nojekyll', Buffer.alloc(0), 'Add .nojekyll for GitHub Pages');
    } catch (e) { /* 已有则忽略 */ }
    const pagesUrl = await GH.enablePages(token, owner, name, branch);
    json(res, 200, { ok: true, pagesUrl });
  },

  // 网站文件夹语法扫描
  'POST /api/site/scan': async (req, res, body) => {
    const b = JSON.parse(body.toString('utf8'));
    const broken = [];
    for (const f of b.files || []) {
      try {
        const name = f.path.toLowerCase();
        if (name.endsWith('.js') && !name.includes('.min.')) {
          if (await T.verifyJs(f.content)) broken.push(f.path);
        } else if (name.endsWith('.html') || name.endsWith('.htm')) {
          if (await T.verifyInlineScripts(f.content)) broken.push(f.path);
        }
      } catch (e) { /* 跳过 */ }
    }
    json(res, 200, { ok: true, broken });
  },
};

// ==================== 静态文件 ====================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  if (urlPath === '/favicon.ico') { res.writeHead(204); return res.end(); } // 图标已内联在 HTML
  const p = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.resolve(PUBLIC, '.' + p); // 规范化后做真实路径边界检查（防 /../ 前缀绕过）
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ==================== 服务器 ====================

function createServer(opts = {}) {
  // 本地安全令牌：每次启动随机生成。页面经 /api/bootstrap（同源）或 preload（Electron）获取；
  // 其他来源即使请求到达本地端口，也会因 token 不匹配被拒（403），且无 CORS 头无法读取响应。
  const authEnabled = opts.auth !== false;
  serverAuthToken = authEnabled ? crypto.randomBytes(16).toString('hex') : null;

  // 参数路由匹配：key 中的 :xxx 段匹配任意值
  function matchRoute(method, pathname) {
    const exact = routes[`${method} ${pathname}`];
    if (exact) return exact;
    const segs = pathname.split('/').filter(Boolean);
    for (const key of Object.keys(routes)) {
      if (!key.startsWith(method + ' ')) continue;
      const pattern = key.slice(method.length + 1).split('/').filter(Boolean);
      if (pattern.length !== segs.length) continue;
      let ok = true;
      for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] !== segs[i] && !pattern[i].startsWith(':')) { ok = false; break; }
      }
      if (ok) return routes[key];
    }
    return null;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // CORS 预检（file:// 页面跨域 POST JSON）
    if (req.method === 'OPTIONS') {
      const cors = corsHeaders(req);
      if (!cors['Access-Control-Allow-Origin']) { res.writeHead(403); return res.end(); }
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-auth-token',
      });
      return res.end();
    }
    // API 鉴权：除 /api/bootstrap 外的所有 /api/* 都要求本次启动的随机 token（header 或 query ?t=）
    const isApi = url.pathname.startsWith('/api/');
    if (authEnabled && isApi && url.pathname !== '/api/bootstrap' && !authOk(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); // 不带 CORS 头，恶意页面读不到
      return res.end(JSON.stringify({ ok: false, error: '未授权访问（本地安全令牌无效），请刷新页面重试' }));
    }
    res.__cors = corsHeaders(req);
    const route = matchRoute(req.method, url.pathname);
    if (route) {
      try {
        const body = req.method === 'POST' ? await readBody(req) : null;
        await route(req, res, body, url);
      } catch (e) {
        handleError(res, e);
      }
      return;
    }
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    res.writeHead(405);
    res.end();
  });
}

function startServer(port = 0, opts = {}) {
  return new Promise((resolve) => {
    const server = createServer(opts);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}`, authToken: serverAuthToken, theme: state.cfg.theme || 'dark' });
    });
  });
}

module.exports = { startServer, createServer, state, CONFIG_FILE };
