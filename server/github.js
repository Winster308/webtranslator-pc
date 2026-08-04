'use strict';
/**
 * GitHub 全套：REST API 客户端、OAuth 设备码、仓库管理/推送/Pages、
 * Pages 链接解析（含 DNS CNAME）、itch.io 游戏页解析。Node 内置 fetch 实现。
 */
const MAX_FILE_BYTES = 150 * 1024;
const TRANS_EXT = new Set(['html', 'htm', 'xhtml', 'js', 'mjs', 'cjs', 'css', 'txt', 'md', 'json', 'xml', 'csv']);
const ASSET_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp3', 'ogg', 'wav', 'mp4', 'webm', 'ogv', 'zip', 'pdf', 'wasm']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const UA = 'WebTranslator';
// 支持环境变量覆盖（测试用 / 自建 GitHub API 镜像或代理）
const GH_API = process.env.GITHUB_API_BASE || 'https://api.github.com';
const ITCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ITCH_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

function isTextFile(path) {
  const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
  return TRANS_EXT.has(ext);
}

function encPath(path) {
  return path.split('/').map(s => encodeURIComponent(s)).join('/');
}

async function ghFetch(url, { method = 'GET', token = null, body = null, timeout = 12000, headers = {} } = {}) {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': UA, ...headers };
  if (token) h.Authorization = `token ${token}`;
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: h,
      body: body !== null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`网络连接失败，请检查网络后重试: ${e.message}`);
  }
  const text = await resp.text();
  return { status: resp.status, body: text };
}

function friendlyError(what, status, body, token) {
  if (status === 403) {
    if (body.includes('rate limit')) {
      const tip = token ? '，请过一会儿再试' : '。登录 GitHub 后自动升级到 5000 次/小时，或在主界面登录后重试';
      return new Error(`GitHub API 限流了（每小时调用次数用完）${tip}（HTTP 403）`);
    }
    return new Error('没有权限访问（HTTP 403）');
  }
  if (status === 404) return new Error(`${what}不存在（HTTP 404）：仓库名、路径或分支可能不对，检查链接是否为公开仓库`);
  if (status === 401) return new Error('GitHub Token 无效或已过期，请重新登录（HTTP 401）');
  return new Error(`${what}失败（HTTP ${status}）: ${body.slice(0, 150)}`);
}

// ==================== REST API ====================

class GithubApi {
  constructor(token = null) { this.token = token; }

  async getRepoInfo(owner, repo) {
    const r = await ghFetch(`${GH_API}/repos/${owner}/${repo}`, { token: this.token });
    if (!(r.status >= 200 && r.status < 300)) throw friendlyError(`仓库 ${owner}/${repo} `, r.status, r.body, this.token);
    const o = JSON.parse(r.body);
    return { owner, repo, default_branch: o.default_branch || 'main' };
  }

  async listFiles(owner, repo, branch, includeAssets = false) {
    const r = await ghFetch(`${GH_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { token: this.token });
    if (!(r.status >= 200 && r.status < 300)) throw friendlyError('文件列表 ', r.status, r.body, this.token);
    const tree = JSON.parse(r.body).tree || [];
    const out = [];
    for (const item of tree) {
      if (item.type !== 'blob') continue;
      const path = item.path || '';
      const seg = path.split('/');
      if (seg.some(s => SKIP_DIRS.has(s))) continue;
      if (seg.some(s => s.includes('.min.'))) continue;
      const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
      if (TRANS_EXT.has(ext) || (includeAssets && ASSET_EXT.has(ext))) {
        out.push({ path, size: item.size || 0 });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async _rawDownload(owner, repo, branch, path) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encPath(path)}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
        if (!resp.ok) throw new Error(`下载失败 (HTTP ${resp.status}): ${path}`);
        return Buffer.from(await resp.arrayBuffer());
      } catch (e) {
        if (e.message && e.message.startsWith('下载失败')) throw e;
        if (attempt >= 2) throw new Error(`下载 ${path} 失败: ${e.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error(`下载 ${path} 失败: 网络错误`);
  }

  async download(owner, repo, branch, path) {
    const buf = await this._rawDownload(owner, repo, branch, path);
    return buf.toString('utf8').replace(/^\uFEFF/, '');
  }

  async downloadBytes(owner, repo, branch, path) {
    return this._rawDownload(owner, repo, branch, path);
  }
}

// ==================== OAuth 设备码 ====================

async function oauthPostForm(url, params) {
  const body = new URLSearchParams(params).toString();
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`GitHub OAuth 网络错误: ${e.message}`);
  }
  const text = await resp.text();
  if (!resp.ok) throw new Error(`GitHub OAuth 错误 (HTTP ${resp.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function requestDeviceCode(clientId) {
  const o = await oauthPostForm('https://github.com/login/device/code', { client_id: clientId, scope: 'repo' });
  if (o.error) throw new Error(`申请授权码失败: ${o.error_description || o.error}`);
  return {
    device_code: o.device_code,
    user_code: o.user_code,
    verification_uri: o.verification_uri || 'https://github.com/login/device',
    expires_in: o.expires_in || 900,
    interval: o.interval || 5,
  };
}

async function pollAccessToken(clientId, deviceCode) {
  const o = await oauthPostForm('https://github.com/login/oauth/access_token', {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (o.access_token) return { status: 'token', value: o.access_token };
  switch (o.error) {
    case 'authorization_pending': return { status: 'pending', value: '' };
    case 'slow_down': return { status: 'slow_down', value: '' };
    case 'expired_token': return { status: 'error', value: '授权码已过期，请重新开始' };
    case 'access_denied': return { status: 'error', value: '你取消了授权' };
    default: return { status: 'error', value: `未知响应: ${JSON.stringify(o).slice(0, 200)}` };
  }
}

// ==================== 仓库管理 / 推送 ====================

async function getUser(token) {
  const r = await ghFetch(`${GH_API}/user`, { token });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`GitHub 登录失败 (HTTP ${r.status})`);
  const o = JSON.parse(r.body);
  return { login: o.login || '', name: o.name || null };
}

async function listRepos(token) {
  const r = await ghFetch(`${GH_API}/user/repos?per_page=100&sort=updated`, { token });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`获取仓库失败 (HTTP ${r.status})`);
  return JSON.parse(r.body).map(o => ({ full_name: o.full_name, default_branch: o.default_branch || 'main' }));
}

async function createRepo(token, name, description = 'Created by WebTranslator') {
  const r = await ghFetch(`${GH_API}/user/repos`, {
    method: 'POST', token,
    body: { name, description, private: false, auto_init: true },
  });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`创建仓库失败 (HTTP ${r.status}): ${r.body.slice(0, 200)}`);
  const o = JSON.parse(r.body);
  return { full_name: o.full_name || name, default_branch: o.default_branch || 'main' };
}

async function pushFileBinary(token, owner, repo, branch, path, data, message = 'Update via WebTranslator') {
  if (data.length > 900 * 1024) throw new Error(`${path} 超过 900KB，GitHub Contents API 无法推送（可用 Git LFS）`);
  const enc = encPath(path);
  // 查已有文件拿 sha（更新用）
  let sha = null;
  const g = await ghFetch(`${GH_API}/repos/${owner}/${repo}/contents/${enc}?ref=${branch}`, { token });
  if (g.status === 200) sha = JSON.parse(g.body).sha || null;
  const payload = { message, content: data.toString('base64'), branch };
  if (sha) payload.sha = sha;
  let r = await ghFetch(`${GH_API}/repos/${owner}/${repo}/contents/${enc}`, { method: 'PUT', token, body: payload });
  // 409 竞态（并发推送时 sha 已变化）：重新拉取 sha 重试一次
  if (r.status === 409) {
    const g2 = await ghFetch(`${GH_API}/repos/${owner}/${repo}/contents/${enc}?ref=${branch}`, { token });
    if (g2.status === 200) {
      payload.sha = JSON.parse(g2.body).sha || null;
      r = await ghFetch(`${GH_API}/repos/${owner}/${repo}/contents/${enc}`, { method: 'PUT', token, body: payload });
    }
  }
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`推送 ${path} 失败 (HTTP ${r.status}): ${r.body.slice(0, 200)}`);
}

async function pushFile(token, owner, repo, branch, path, content, message = 'Update via WebTranslator') {
  await pushFileBinary(token, owner, repo, branch, path, Buffer.from(content, 'utf8'), message);
}

async function pushFolder(token, owner, repo, branch, localDir, base = '', onFile = null) {
  const fs = require('fs');
  const path = require('path');
  let entries = [];
  try { entries = fs.readdirSync(localDir).sort(); } catch (e) { return; }
  for (const d of entries) {
    if (fs.statSync(path.join(localDir, d)).isDirectory()) {
      await pushFolder(token, owner, repo, branch, path.join(localDir, d), `${base}${d}/`, onFile);
    }
  }
  for (const f of entries) {
    const full = path.join(localDir, f);
    if (!fs.statSync(full).isFile()) continue;
    const p = `${base}${f}`;
    if (onFile) onFile(p);
    await pushFileBinary(token, owner, repo, branch, p, fs.readFileSync(full));
  }
}

async function enablePages(token, owner, repo, branch) {
  await ghFetch(`${GH_API}/repos/${owner}/${repo}/pages`, {
    method: 'PUT', token, body: { source: { branch, path: '/' } },
  });
  const r = await ghFetch(`${GH_API}/repos/${owner}/${repo}/pages`, { token });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`获取 Pages 信息失败 (HTTP ${r.status})`);
  return JSON.parse(r.body).html_url || `https://${owner}.github.io/${repo}/`;
}

// ==================== 仓库文件管理（浏览/编辑/新增/删除） ====================

/** 获取仓库内单个文件内容（GitHub Contents API，base64）。返回 {path, size, data: Buffer, isText}。 */
async function getFileContent(token, owner, repo, branch, path) {
  const enc = encPath(path);
  const r = await ghFetch(`${GH_API}/repos/${owner}/${repo}/contents/${enc}?ref=${branch}`, { token });
  if (!(r.status >= 200 && r.status < 300)) throw friendlyError(`文件 ${path} `, r.status, r.body, token);
  const o = JSON.parse(r.body);
  if (o.type === 'dir') throw new Error(`${path} 是目录，请选择文件`);
  if (o.encoding === 'base64') {
    const buf = Buffer.from(String(o.content || '').replace(/\n/g, ''), 'base64');
    // 文本判断：无 NUL 字节（二进制文件通常含 NUL）
    const isText = !buf.includes(0);
    return { path, size: buf.length, data: buf, isText, sha: o.sha || null };
  }
  const text = String(o.content || '');
  return { path, size: text.length, data: Buffer.from(text, 'utf8'), isText: true, sha: o.sha || null };
}

/** 删除仓库文件（GitHub Contents API DELETE）。 */
async function deleteFile(token, owner, repo, branch, path, message = 'Delete via WebTranslator') {
  const enc = encPath(path);
  const g = await ghFetch(`${GH_API}/repos/${owner}/${repo}/contents/${enc}?ref=${branch}`, { token });
  if (!(g.status >= 200 && g.status < 300)) throw new Error(`文件不存在或无法访问: ${path}`);
  const sha = JSON.parse(g.body).sha;
  if (!sha) throw new Error(`无法获取 ${path} 的 sha`);
  const r = await ghFetch(`${GH_API}/repos/${owner}/${repo}/contents/${enc}`, {
    method: 'DELETE', token, body: { message, sha, branch },
  });
  if (!(r.status >= 200 && r.status < 300)) throw new Error(`删除 ${path} 失败 (HTTP ${r.status}): ${r.body.slice(0, 200)}`);
}

// ==================== Pages 链接解析 ====================

function resolveRepoUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(trimmed);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  let u;
  try { u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  if (host.endsWith('.github.io') && host !== 'github.io') {
    const user = host.replace(/\.github\.io$/, '');
    const repo = seg.length && seg[0] !== user ? seg[0] : `${user}.github.io`;
    return { owner: user, repo };
  }
  return null; // 自定义域名需要异步 CNAME 查询，见 resolveRepoUrlAsync
}

async function queryCname(host) {
  const providers = [
    `https://dns.alidns.com/resolve?name=${host}&type=CNAME`,
    `https://cloudflare-dns.com/dns-query?name=${host}&type=CNAME`,
  ];
  for (const p of providers) {
    try {
      const resp = await fetch(p, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
      const obj = await resp.json();
      for (const a of obj.Answer || []) {
        if (a.type === 5) {
          const data = (a.data || '').trim();
          if (data.endsWith('.github.io.') || data.endsWith('.github.io')) return data;
        }
      }
    } catch (e) { /* 下一个 DoH */ }
  }
  return null;
}

async function resolveRepoUrlAsync(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(trimmed);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
  let u;
  try { u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  if (host.endsWith('.github.io') && host !== 'github.io') {
    const user = host.replace(/\.github\.io$/, '');
    const repo = seg.length && seg[0] !== user ? seg[0] : `${user}.github.io`;
    return { owner: user, repo };
  }
  const cname = await queryCname(host);
  if (!cname) return null;
  const target = cname.replace(/\.$/, '');
  if (!target.endsWith('.github.io')) return null;
  const user = target.replace(/\.github\.io$/, '');
  const repo = seg.length ? seg[0] : `${user}.github.io`;
  return { owner: user, repo };
}

// ==================== itch.io 解析 ====================

async function itchFetchText(url, expectHost = null) {
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        'User-Agent': ITCH_UA,
        Accept: ITCH_ACCEPT,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new Error(`下载失败: ${url} (${e.message})`);
  }
  if (!resp.ok) throw new Error(`下载失败 (HTTP ${resp.status}): ${url}`);
  if (expectHost && !resp.url.includes(expectHost)) {
    throw new Error(`请求被 itch.io 重定向到 ${resp.url}（可能被反爬检测），请尝试开启代理/VPN 或更换网络后重试`);
  }
  return (await resp.text()).replace(/^\uFEFF/, '');
}

async function resolveItch(input) {
  const trimmed = input.trim();
  let host;
  try { host = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname; }
  catch (e) { return null; }
  if (!(host.endsWith('itch.io') && host !== 'itch.io')) return null;

  const page = await itchFetchText(trimmed);
  const m = /https:\/\/html-classic\.itch\.zone\/html\/\d+\/[^"&\\]*/.exec(page);
  if (!m) return null;
  const base = m[0].slice(0, m[0].lastIndexOf('/') + 1).replace(/ /g, '%20');

  const indexHtml = await itchFetchText(base + 'index.html');
  const files = new Map();
  files.set('index.html', { path: 'index.html', size: 0 });
  const refRe = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let mm;
  while ((mm = refRe.exec(indexHtml)) !== null) {
    const ref = mm[1];
    if (ref.startsWith('http') || ref.startsWith('//') || ref.startsWith('#') || ref.startsWith('data:')) continue;
    if (ref.includes('{{') || ref.includes('}}') || ref.includes('.discordLink')) continue;
    if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(ref)) continue;
    const p = ref.split('?')[0].split('#')[0].replace(/^\.\//, '');
    if (p) files.set(p, { path: p, size: 0 });
  }
  // mod.js 里的 modFiles
  try {
    const modJs = await itchFetchText(base + 'js/mod.js');
    const mf = /modFiles\s*:\s*\[([^\]]*)\]/.exec(modJs);
    if (mf) {
      for (const m3 of mf[1].matchAll(/["']([^"']+\.js)["']/g)) {
        const p = 'js/' + m3[1].split('?')[0];
        files.set(p, { path: p, size: 0 });
      }
    }
  } catch (e) { /* 可选 */ }

  // 探测大小
  const result = [];
  for (const [p, f] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    f.size = await itchProbeSize(base, p);
    result.push(f);
  }
  return { base_url: base, files: result };
}

async function itchProbeSize(base, path) {
  try {
    const resp = await fetch(base + encPath(path), {
      headers: { 'User-Agent': ITCH_UA, Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 206) {
      const cr = resp.headers.get('content-range') || '';
      const size = parseInt(cr.split('/').pop(), 10);
      return Number.isFinite(size) ? size : 0;
    }
    const cl = parseInt(resp.headers.get('content-length') || '', 10);
    return Number.isFinite(cl) ? cl : 0;
  } catch (e) { return 0; }
}

async function itchDownload(baseUrl, path) {
  const bytes = await itchDownloadRaw(baseUrl, path);
  const name = path.toLowerCase();
  if (name.endsWith('.html') || name.endsWith('.htm')) {
    const text = bytes.toString('utf8');
    const cleaned = text.replace(/<script[^>]*src="https:\/\/static\.itch\.io\/htmlgame\.js[^"]*"[^>]*>\s*<\/script>/gi, '');
    if (cleaned !== text) return Buffer.from(cleaned, 'utf8');
  }
  return bytes;
}

async function itchDownloadRaw(baseUrl, path) {
  const resp = await fetch(baseUrl + encPath(path), {
    headers: { 'User-Agent': ITCH_UA, Accept: ITCH_ACCEPT },
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`下载失败 (HTTP ${resp.status}): ${path}`);
  return Buffer.from(await resp.arrayBuffer());
}

module.exports = {
  MAX_FILE_BYTES, isTextFile, GithubApi, getUser, listRepos, createRepo,
  pushFile, pushFileBinary, pushFolder, enablePages,
  getFileContent, deleteFile,
  requestDeviceCode, pollAccessToken,
  resolveRepoUrlAsync, queryCname,
  resolveItch, itchDownload,
};
