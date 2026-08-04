'use strict';
/**
 * 通用静态网站解析器：
 * 给定任意静态网站 URL（GitLab Pages / Gitee Pages / Netlify / Vercel /
 * Cloudflare Pages / 任意自定义域名静态站），抓取首页 → 递归提取同源
 * src/href/srcset/CSS url() 资源 → 返回文件清单，支持按路径下载。
 * GitHub Pages / github.com / itch.io 走各自专用解析（更完整），本模块作为兜底与扩展。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MAX_FILES = 400;              // 最多抓取文件数（含资源）
const MAX_QUEUE = 2000;             // 队列防爆炸
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT = 20000;
const DOWNLOAD_TIMEOUT = 60000;

const TEXT_EXT = new Set(['html', 'htm', 'xhtml', 'js', 'mjs', 'cjs', 'css', 'txt', 'md', 'json', 'xml', 'csv', 'svg', 'map', 'yaml', 'yml']);

function isTextFile(path, contentType = '') {
  const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
  if (TEXT_EXT.has(ext)) return true;
  return /text\/|json|javascript|xml|svg|yaml/.test(contentType);
}

function sameOrigin(u1, u2) {
  return u1.protocol === u2.protocol && u1.host === u2.host;
}

/** 去掉 query/hash、解码并规范成仓库相对路径（index.html 兜底）。 */
function normalizePath(pathname) {
  let p = pathname;
  try { p = decodeURIComponent(p); } catch (e) { /* 保留原文 */ }
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/' || p === '') p = 'index.html';
  return p.replace(/^\/+/, '');
}

/** 提取文本中的同源资源引用（HTML src/href/srcset + CSS url()）。 */
function extractRefs(text, contentType, baseUrl) {
  const out = [];
  const base = new URL(baseUrl);
  const tryRef = (r) => {
    if (!r || typeof r !== 'string') return;
    r = r.trim();
    if (!r || r.startsWith('#') || r.startsWith('data:') || r.startsWith('javascript:') || r.startsWith('mailto:') || r.startsWith('blob:')) return;
    if (r.startsWith('//')) r = base.protocol + r;
    let u;
    try { u = new URL(r, base); } catch (e) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    if (!sameOrigin(u, base)) return; // 只抓同源（外链 CDN 不抓）
    u.hash = '';
    out.push(u.href);
  };
  if (contentType.includes('css')) {
    for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) tryRef(m[2]);
  } else {
    for (const m of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) tryRef(m[1]);
    for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const part of m[1].split(',')) tryRef(part.trim().split(/\s+/)[0]);
    }
    for (const m of text.matchAll(/@import\s+(?:url\()?\s*["']?([^"');]+)["']?\s*\)?/gi)) tryRef(m[1]);
    // ES module 静态导入（Vite/webpack 构建产物常见）：import "x" / import("x") / from "x"
    for (const m of text.matchAll(/\bimport\s*(?:\(\s*)?["']([^"']+)["']/g)) tryRef(m[1]);
    for (const m of text.matchAll(/\bfrom\s*["']([^"']+)["']/g)) tryRef(m[1]);
  }
  return out;
}

/**
 * 解析静态网站。返回 { files: [{path, size, isText}], baseUrl, homeUrl }。
 * BFS 抓取：只记录同源资源，文本类（HTML/CSS/JS）继续递归解析引用。
 */
async function parseSite(inputUrl) {
  let home;
  try { home = new URL(inputUrl.trim().startsWith('http') ? inputUrl.trim() : `https://${inputUrl.trim()}`); }
  catch (e) { throw new Error('链接格式不正确'); }
  if (home.protocol !== 'http:' && home.protocol !== 'https:') throw new Error('仅支持 http/https 链接');

  const seen = new Set();      // 已请求的绝对 URL
  const files = new Map();     // path -> {path, size, isText, url}
  const queue = [home.href];
  let guard = 0;

  while (queue.length && seen.size < MAX_QUEUE && guard++ < MAX_QUEUE) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let resp;
    try {
      resp = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
    } catch (e) { continue; }
    if (!resp.ok) continue;
    let u;
    try { u = new URL(resp.url); } catch (e) { continue; }
    if (!sameOrigin(u, home)) continue;
    const data = Buffer.from(await resp.arrayBuffer());
    if (data.length > MAX_FILE_BYTES) continue;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const path = normalizePath(u.pathname);
    if (!path || path.includes('..')) continue;
    files.set(path, { path, size: data.length, url: u.href, isText: isTextFile(path, ct) });

    // 文本类继续递归提取引用
    const isParseable = ct.includes('html') || ct.includes('css') || ct.includes('javascript') ||
      /\.(html?|css|js|mjs|cjs|json|xml|txt|md|svg)(\?|$)/i.test(path);
    if (files.size < MAX_FILES && isParseable) {
      const text = data.toString('utf8');
      for (const ref of extractRefs(text, ct, u.href)) {
        if (!seen.has(ref) && !queue.includes(ref)) queue.push(ref);
      }
    }
  }

  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (!list.length) throw new Error('未能从该网址解析出任何文件（可能不是静态网站、需要登录或已被反爬拦截）');
  return { files: list, baseUrl: `${home.origin}/`, homeUrl: home.href };
}

/** 按路径下载（路径需来自 parseSite 返回的清单；强制同源，防跨域下载）。 */
async function downloadSite(baseUrl, path) {
  let u, b;
  try {
    u = new URL(path, baseUrl);
    b = new URL(baseUrl);
  } catch (e) { throw new Error(`路径不合法: ${path}`); }
  if (u.protocol !== b.protocol || u.host !== b.host) throw new Error(`跨域下载被拒绝: ${path}`);
  const resp = await fetch(u.href, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
  });
  if (!resp.ok) throw new Error(`下载失败 (HTTP ${resp.status}): ${path}`);
  return Buffer.from(await resp.arrayBuffer());
}

module.exports = { parseSite, downloadSite, isTextFile, extractRefs, normalizePath, MAX_FILE_BYTES };
