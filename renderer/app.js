'use strict';
/* ===== WebTranslator 电脑版 — 前端逻辑 ===== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ==================== 基础工具 ====================

// API 服务地址：Electron 模式由 preload 注入（window.apiBase）；浏览器模式为空（同源相对路径）
const API = (window.apiBase || '').replace(/\/+$/, '');
// 本地安全令牌：Electron 由 preload 注入；浏览器模式从同源的 /api/bootstrap 获取
// （变量名避开 contextBridge 注入的全局 authToken，防止全局词法声明冲突）
let apiAuthToken = window.authToken || null;

async function ensureAuthToken() {
  if (apiAuthToken) return;
  const resp = await fetch(API + '/api/bootstrap', { signal: AbortSignal.timeout(10000) });
  const obj = await resp.json();
  apiAuthToken = obj.token || null;
  if (obj.theme && !window.themePreload) applyTheme(obj.theme); // 浏览器模式：尽早应用持久化主题，避免闪色
}

async function api(path, data) {
  await ensureAuthToken();
  // token 同时经 query ?t= 传递：file:// 页面(无 Origin)也按"带 token 才反射 CORS"判定，
  // 预检 OPTIONS 会携带完整 URL(含 query)，恶意页面无 token 则读不到任何响应
  const sep = path.includes('?') ? '&' : '?';
  const url = API + path + (apiAuthToken ? sep + 't=' + encodeURIComponent(apiAuthToken) : '');
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (apiAuthToken) headers['x-auth-token'] = apiAuthToken;
  const resp = await fetch(url, {
    method: data !== undefined ? 'POST' : 'GET',
    headers,
    body: data !== undefined ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(25000), // 防止任何请求挂起导致界面"一直加载"
  });
  const obj = await resp.json();
  if (!obj.ok) throw new Error(obj.error || '请求失败');
  return obj;
}

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function toast(msg, type = '') {
  const wrap = $('#toast-wrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function log(msg, cls = '') {
  const body = $('#log-body');
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  const t = new Date().toTimeString().slice(0, 8);
  line.innerHTML = `<span class="t">[${t}]</span>${escapeHtml(String(msg))}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 系统通知（仅 Electron 模式经 preload 桥可用，其他环境静默忽略）。 */
function sysNotify(title, body) {
  try { if (window.notify) window.notify(title, body); } catch (e) { /* 忽略 */ }
}

/** 复制文本到剪贴板（clipboard API + 降级 execCommand）。 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) { return false; }
  }
}

// ==================== 日志与历史 ====================

/** 导出当前日志为 .txt 下载。 */
async function exportLog() {
  const text = $('#log-body').textContent;
  if (!text.trim()) { toast('日志为空', 'warn'); return; }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const ok = await saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `webtranslator_log_${stamp}.txt`);
  if (ok) toast('日志已导出', 'success');
}

/** 翻译历史面板（服务器持久化，重启保留）。 */
async function showHistory() {
  const box = $('#modal-box');
  box.innerHTML = `<h3>🕘 翻译历史（最近 50 条 · 保存在本机）</h3>
    <div class="body" id="history-body" style="max-height:50vh;overflow-y:auto"></div>
    <div class="actions"><button class="btn" id="modal-cancel2">关闭</button></div>`;
  showModal();
  $('#modal-cancel2').onclick = hideModal;
  const body = $('#history-body');
  body.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const r = await api('/api/history');
    const list = r.history || [];
    if (!list.length) { body.innerHTML = '<div class="empty-hint">还没有翻译记录，翻译完成后会自动出现在这里</div>'; return; }
    body.innerHTML = list.map(h => {
      const t = new Date(h.time);
      const timeStr = `${t.getMonth() + 1}月${t.getDate()}日 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      const kind = h.kind === 'repo' ? (h.mode === 'generic' ? '🌐' : h.mode === 'itch' ? '🎮' : '📦') : '📄';
      const name = escapeHtml(String(h.name || ''));
      const stat = `${h.ok}/${h.total} 成功${h.fail ? `，${h.fail} 失败` : ''}${h.skipped ? `，跳过 ${h.skipped}` : ''}`;
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border-soft)">${kind} <b>${name}</b><br>
        <span style="font-size:11.5px;color:var(--text-faint)">${timeStr} · ${escapeHtml(String(h.lang || ''))} · ${stat}</span></div>`;
    }).join('');
  } catch (e) {
    body.innerHTML = `<div class="empty-hint">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

// ==================== 进度与日志 ====================

function showProgress(title) {
  $('#progress-title').textContent = title;
  $('#progress-fill').style.width = '0%';
  $('#progress-text').textContent = '';
  $('#progress-overlay').hidden = false;
}

function updateProgress(done, total, text) {
  const pct = total > 0 ? Math.min(100, Math.round(done * 100 / total)) : 0;
  $('#progress-fill').style.width = pct + '%';
  if (text) $('#progress-text').textContent = text;
}

function hideProgress() {
  $('#progress-overlay').hidden = true;
}

/** 轮询任务直到完成；期间把服务器日志刷入前端日志面板。 */
async function waitJob(jobId, opts = {}) {
  let seenIdx = 0; // 服务器日志只增不减，按索引去重（内容相同但来自不同文件/时刻的日志不会被吞）
  while (true) {
    const r = await api(`/api/job/${jobId}`);
    const logs = r.logs || [];
    for (let k = seenIdx; k < logs.length; k++) {
      const [kind, payload] = logs[k];
      seenIdx = k + 1;
      if (kind === 'log') {
        const text = String(payload);
        const cls = text.includes('失败') || text.includes('错误') || text.includes('超时') ? 'warn'
          : text.startsWith('  ') ? '' : 'ok';
        log(text, cls);
      } else if (kind === 'progress' && opts.onProgress) {
        opts.onProgress(payload.done, payload.total);
      }
    }
    if (r.status === 'done') return r.result;
    if (r.status === 'error') throw new Error(r.error || '任务失败');
    await new Promise(res => setTimeout(res, 600));
  }
}

// ==================== 文件保存 ====================

async function saveBlob(blob, defaultName) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: defaultName });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
      // 降级到下载
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  return true;
}

// ==================== 页面导航 ====================

const PAGE_META = {
  local: ['本地文件翻译', '翻译 HTML / JS / CSS / 文本文件，自动语法校验与修复'],
  repo: ['仓库翻译', '从 GitHub Pages / github.com / itch.io 拉取网站并批量翻译'],
  github: ['GitHub 登录与推送', '登录 GitHub，推送翻译结果、网站或文件，一键开启 Pages'],
  site: ['本地网站文件夹', '加载本地网站，扫描语法错误，预览并推送到 GitHub Pages'],
};

function switchPage(name) {
  $$('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  $('#page-title').textContent = PAGE_META[name][0];
  $('#page-subtitle').textContent = PAGE_META[name][1];
}

// ==================== 主题 ====================

const THEMES = ['dark', 'light', 'midnight'];
const THEME_ICON = { dark: '🌙', light: '☀️', midnight: '💜' };
const THEME_NAME = { dark: '暗色', light: '亮色', midnight: '午夜紫' };

function applyTheme(t) {
  const theme = THEMES.includes(t) ? t : 'dark';
  document.documentElement.dataset.theme = theme;
  const btn = $('#btn-theme');
  if (btn) btn.textContent = THEME_ICON[theme];
  return theme;
}

// 启动早期应用 preload 注入的主题（避免 light/midnight 用户启动闪暗色）
if (window.themePreload && ['dark', 'light', 'midnight'].includes(window.themePreload)) {
  document.documentElement.dataset.theme = window.themePreload;
}

function cycleTheme() {
  const cur = document.documentElement.dataset.theme || 'dark';
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  config.theme = applyTheme(next);
  toast(`主题已切换为「${THEME_NAME[next]}」`);
  // 防抖保存：快速连点只持久化最后一次选择
  clearTimeout(themeSaveTimer);
  themeSaveTimer = setTimeout(() => {
    api('/api/config', { theme: next }).catch(() => { /* 持久化失败不影响使用 */ });
  }, 400);
}
let themeSaveTimer = null;

// ==================== 设置 ====================

let config = {};

async function loadConfig() {
  const r = await api('/api/config');
  config = r.config;
  applyTheme(config.theme);
}

function showSettingsModal() {
  const box = $('#modal-box');
  const keyShown = config.api_key_set ? '********' : '';
  const LANGS = ['简体中文', '繁体中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский', 'Português'];
  const isCustomLang = config.lang && !LANGS.includes(config.lang);
  box.innerHTML = `
    <h3>⚙ 设置</h3>
    <div class="body">
      <div class="row"><label class="lbl" style="width:92px">DeepSeek API Key</label>
        <input type="password" class="input grow" id="set-apikey" placeholder="sk-..." value="${keyShown}"></div>
      <div class="row"><label class="lbl" style="width:92px">模型</label>
        <input type="text" class="input grow" id="set-model" placeholder="deepseek-chat"></div>
      <div class="row"><label class="lbl" style="width:92px">API 地址</label>
        <input type="text" class="input grow" id="set-api-base" placeholder="https://api.deepseek.com（支持任意 OpenAI 兼容 API，留空用默认）"></div>
      <div class="row"><label class="lbl" style="width:92px">目标语言</label>
        <select class="select" id="set-lang" style="min-width:130px">
          ${LANGS.map(l => `<option>${l}</option>`).join('')}
        </select>
        <input type="text" class="input grow" id="set-lang-custom" placeholder="自定义语言（如 乌克兰语 / 阿拉伯语，填了优先）" value="${isCustomLang ? escapeHtml(config.lang) : ''}"></div>
      <div class="row"><label class="lbl" style="width:92px">主题</label>
        <select class="select" id="set-theme" style="min-width:130px">
          <option value="dark">🌙 暗色</option>
          <option value="light">☀️ 亮色</option>
          <option value="midnight">💜 午夜紫</option>
        </select></div>
      <div class="row"><label class="lbl" style="width:92px">代理地址</label>
        <input type="text" class="input grow" id="set-proxy" placeholder="留空=自动检测系统代理；如 http://127.0.0.1:7890"></div>
      <div class="row"><label class="lbl" style="width:92px">温度</label>
        <input type="number" class="input" id="set-temperature" min="0" max="2" step="0.1" style="width:90px">
        <span class="hint" style="margin:0">0~2，越小越严谨（默认 0.3）</span></div>
      <div class="row"><label class="lbl" style="width:92px">最大输出</label>
        <input type="number" class="input" id="set-max-tokens" min="256" max="32768" step="256" style="width:110px">
        <span class="hint" style="margin:0">tokens（默认 16384）</span></div>
      <div class="hint">API Key 在 platform.deepseek.com 申请。设置保存在本机用户目录。
        ${config.api_key_set ? '<a href="javascript:void(0)" id="set-key-clear" style="color:var(--red)">清除已保存的 Key</a>' : ''}</div>
    </div>
    <div class="actions">
      <button class="btn" id="modal-cancel">取消</button>
      <button class="btn primary" id="modal-save">保存</button>
    </div>`;
  $('#set-model').value = config.model || 'deepseek-chat';
  $('#set-api-base').value = config.api_base || '';
  $('#set-lang').value = isCustomLang ? '简体中文' : (config.lang || '简体中文');
  $('#set-theme').value = THEMES.includes(config.theme) ? config.theme : 'dark';
  $('#set-proxy').value = config.proxy || '';
  $('#set-temperature').value = config.temperature ?? 0.3;
  $('#set-max-tokens').value = config.max_tokens || 16384;
  showModal();
  const clr = $('#set-key-clear');
  if (clr) clr.onclick = async () => {
    try {
      await api('/api/config', { api_key: '' });
      config.api_key_set = false;
      toast('已清除 API Key', 'success');
      $('#set-apikey').value = '';
    } catch (e) { toast('清除失败: ' + e.message, 'error'); }
  };
  $('#modal-save').onclick = async () => {
    const customLang = $('#set-lang-custom').value.trim();
    const payload = {
      model: $('#set-model').value.trim() || 'deepseek-chat',
      lang: customLang || $('#set-lang').value,
    };
    payload.api_base = $('#set-api-base').value.trim().replace(/\/+$/, '');
    payload.proxy = $('#set-proxy').value.trim();
    const themeVal = $('#set-theme').value;
    if (THEMES.includes(themeVal)) payload.theme = themeVal;
    const temp = parseFloat($('#set-temperature').value);
    if (Number.isFinite(temp) && temp >= 0 && temp <= 2) payload.temperature = temp;
    const mt = parseInt($('#set-max-tokens').value, 10);
    if (Number.isFinite(mt)) payload.max_tokens = Math.max(256, Math.min(32768, mt));
    // 掩码/空输入表示"保留原 Key"，不提交 api_key 字段（服务器端保留原值）
    const v = $('#set-apikey').value.trim();
    if (v && v !== '********') payload.api_key = v;
    Object.assign(config, payload);
    config.api_key_set = config.api_key_set || !!payload.api_key;
    try {
      await api('/api/config', payload);
      if (payload.theme) applyTheme(payload.theme); // 立即应用设置里选择的主题
      toast('设置已保存', 'success');
      hideModal();
    } catch (e) { toast('保存失败: ' + e.message, 'error'); }
  };
  $('#modal-cancel').onclick = hideModal;
}

function showModal() { $('#modal-mask').hidden = false; }
function hideModal() { $('#modal-mask').hidden = true; }
$('#modal-mask').addEventListener('click', (e) => { if (e.target === $('#modal-mask')) hideModal(); });

// ==================== 本地翻译（批量队列） ====================

let localFiles = [];      // [{name, content, size, status: wait|run|ok|fail, translated, error}]
let localSelected = -1;   // 结果列表当前选中的文件索引
let localViewMode = 'translated'; // 'translated' | 'original'
let localTranslating = false;
let localGen = 0;         // 代际计数：防止"停止后立即重开"产生双循环并发

const LOCAL_STATE_TEXT = { wait: '待翻译', run: '翻译中…', ok: '成功', fail: '失败' };
const LOCAL_STATE_CLS = { wait: 'wait', run: 'run', ok: 'ok', fail: 'fail' };

function translatedName(name) {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name) + '_translated' + (dot > 0 ? name.slice(dot) : '.txt');
}

function updateLocalTranslateBtn() {
  const pending = localFiles.some(f => f.status === 'wait' || f.status === 'fail');
  $('#btn-local-translate').disabled = !pending || localTranslating;
}

function renderLocalQueue() {
  const list = $('#local-queue');
  list.hidden = localFiles.length === 0;
  list.innerHTML = '';
  for (const f of localFiles) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<span class="f-path">📄 ${escapeHtml(f.name)}</span><span class="f-size">${fmtSize(f.size)}</span><span class="f-state ${LOCAL_STATE_CLS[f.status]}">${LOCAL_STATE_TEXT[f.status]}</span>`;
    list.appendChild(item);
  }
  updateLocalTranslateBtn();
}

function setupLocal() {
  const dz = $('#local-dropzone');
  const input = $('#local-file-input');
  dz.onclick = () => input.click();

  const addFiles = async (fileList) => {
    const files = [...(fileList || [])].filter(f => f && f.size !== undefined);
    if (!files.length) return;
    for (const f of files) {
      const content = await f.text();
      if (content.length > 5 * 1024 * 1024) { toast(`跳过 ${f.name}（超过 5MB 上限）`, 'warn'); continue; }
      localFiles.push({ name: f.name, content, size: content.length, status: 'wait', translated: null, error: null });
    }
    renderLocalQueue();
    $('#local-type-badge').hidden = true; // 多文件模式不再显示单一类型徽章
  };
  input.onchange = () => { addFiles(input.files); input.value = ''; };
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', async (e) => { await addFiles(e.dataTransfer.files); });

  $('#btn-local-translate').onclick = startLocalTranslate;
  $('#btn-local-stop').onclick = () => { localTranslating = false; toast('正在停止…', 'warn'); };

  $('#btn-local-save').onclick = saveCurrentLocal;
  $('#btn-local-save-all').onclick = saveAllLocalZip;
  $('#btn-view-translated').onclick = () => setLocalView('translated');
  $('#btn-view-original').onclick = () => setLocalView('original');
  $('#btn-local-copy-fail').onclick = async () => {
    const fails = localFiles.filter(f => f.status === 'fail').map(f => `${f.name}: ${f.error || '未知错误'}`);
    if (!fails.length) { toast('没有失败文件', 'warn'); return; }
    const ok = await copyText(fails.join('\n'));
    toast(ok ? `已复制 ${fails.length} 个失败文件清单` : '复制失败，请手动选择', ok ? 'success' : 'error');
  };
}

async function startLocalTranslate() {
  if (!config.api_key_set) { toast('请先在「设置」中填写 DeepSeek API Key', 'warn'); showSettingsModal(); return; }
  const queue = localFiles.filter(f => f.status === 'wait' || f.status === 'fail');
  if (!queue.length) { toast('没有待翻译的文件', 'warn'); return; }
  const gen = ++localGen; // 新循环代际；旧循环收尾时若代际已变则不再触碰 UI
  localTranslating = true;
  $('#btn-local-stop').hidden = false;
  updateLocalTranslateBtn();
  const total = queue.length;
  let done = 0;
  showProgress(`批量翻译 ${total} 个文件…`);
  log(`开始批量翻译 ${total} 个文件`, 'ok');
  for (const f of queue) {
    if (gen !== localGen) break; // 已被新循环取代
    if (!localTranslating) { f.status = 'wait'; renderLocalQueue(); break; }
    f.status = 'run';
    f.translated = null; f.error = null;
    renderLocalQueue();
    updateProgress(done, total, `正在翻译 ${done + 1}/${total}: ${f.name}`);
    log(`翻译 ${f.name}…`, 'ok');
    try {
      const r = await api('/api/translate', { name: f.name, content: f.content, ...config });
      const result = await waitJob(r.jobId, {
        onProgress: (d, t) => {
          if (gen !== localGen) return; // 旧循环不再写进度
          const seg = t > 1 ? `（分段 ${d}/${t}）` : '';
          updateProgress(done + (t ? d / t : 0), total, `正在翻译 ${done + 1}/${total}: ${f.name}${seg}`);
        },
      });
      f.translated = result.translated;
      f.status = 'ok';
    } catch (e) {
      if (gen !== localGen) return; // 旧循环：不覆盖新循环已更新的状态
      f.status = 'fail';
      f.error = e.message;
      log(`翻译失败 ${f.name}: ${e.message}`, 'error');
    }
    done++;
    renderLocalQueue();
    if (gen !== localGen) break;
    if (!localTranslating) break;
  }
  if (gen !== localGen) return; // 旧循环：不清理 UI，不展示结果
  localTranslating = false;
  $('#btn-local-stop').hidden = true;
  hideProgress();
  updateLocalTranslateBtn();

  const okList = localFiles.filter(f => f.translated);
  if (okList.length) {
    localSelected = localFiles.findIndex(f => f.translated);
    setLocalView('translated');
    renderLocalResult();
    $('#local-result-card').hidden = false;
    const failCount = localFiles.filter(f => f.status === 'fail').length;
    const skipCount = localFiles.filter(f => f.status === 'wait' && !f.translated).length;
    const notes = [];
    if (failCount) notes.push(`${failCount} 个失败`);
    if (skipCount) notes.push(`${skipCount} 个未翻译`);
    $('#local-result-status').textContent = `完成 ${okList.length}/${localFiles.length} 个${notes.length ? ' · ' + notes.join('，') : ''}`;
    $('#btn-local-copy-fail').hidden = failCount === 0;
    toast(`翻译完成: ${okList.length} 个文件 ✓${failCount ? '，' + failCount + ' 个失败' : ''}`, failCount ? 'warn' : 'success');
    log(`批量翻译结束: 成功 ${okList.length} 个${failCount ? '，失败 ' + failCount + ' 个' : ''}`, failCount ? 'warn' : 'ok');
    sysNotify('本地翻译完成', `成功 ${okList.length} 个文件${failCount ? `，失败 ${failCount} 个` : ''}`);
  } else {
    toast('没有翻译成功任何文件', 'error');
    sysNotify('本地翻译完成', '没有翻译成功任何文件');
  }
}

function renderLocalResult() {
  const list = $('#local-result-list');
  const done = localFiles.map((f, i) => ({ f, i })).filter(x => x.f.translated);
  list.hidden = done.length <= 1;
  list.innerHTML = '';
  for (const { f, i } of done) {
    const item = document.createElement('div');
    item.className = 'file-item selectable' + (i === localSelected ? ' selected' : '');
    item.innerHTML = `<span class="f-path">📄 ${escapeHtml(f.name)}</span><span class="f-state ok">成功</span>`;
    item.onclick = () => { localSelected = i; renderLocalResult(); };
    list.appendChild(item);
  }
  updateLocalView();
  $('#btn-local-save').disabled = !localFiles[localSelected] || !localFiles[localSelected].translated;
  $('#btn-local-save-all').disabled = done.length === 0;
}

function setLocalView(mode) {
  localViewMode = mode;
  $('#btn-view-translated').classList.toggle('active', mode === 'translated');
  $('#btn-view-original').classList.toggle('active', mode === 'original');
  updateLocalView();
}

function updateLocalView() {
  const view = $('#local-result-view');
  const cur = localFiles[localSelected];
  if (!cur || !cur.translated) { view.hidden = true; return; }
  view.hidden = false;
  view.textContent = localViewMode === 'original' ? cur.content : cur.translated;
  $('#local-result-status').textContent = `${cur.name} · ${localViewMode === 'original' ? '原文' : '译文'}`;
}

async function saveCurrentLocal() {
  const cur = localFiles[localSelected];
  if (!cur || !cur.translated) return;
  const ok = await saveBlob(new Blob([cur.translated], { type: 'text/plain;charset=utf-8' }), translatedName(cur.name));
  if (ok) toast(`已保存 ${cur.name}`, 'success');
}

async function saveAllLocalZip() {
  const okList = localFiles.filter(f => f.translated);
  if (!okList.length) { toast('没有可打包的翻译结果', 'warn'); return; }
  showProgress('正在打包 ZIP…');
  try {
    await ensureAuthToken();
    const q = apiAuthToken ? '?t=' + encodeURIComponent(apiAuthToken) : '';
    const resp = await fetch(API + '/api/zip' + q, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiAuthToken ? { 'x-auth-token': apiAuthToken } : {}) },
      body: JSON.stringify({ files: okList.map(f => ({ path: f.name, content: f.translated })), base: 'webtranslated' }),
      signal: AbortSignal.timeout(120000), // 大批量文件打包可能较慢，放宽到 2 分钟
    });
    if (!resp.ok) throw new Error('打包失败');
    const blob = await resp.blob();
    const ok = await saveBlob(blob, `webtranslated_${okList.length}files.zip`);
    if (ok) toast(`ZIP 已保存（${okList.length} 个文件）`, 'success');
    hideProgress();
  } catch (e) { hideProgress(); toast('保存失败: ' + e.message, 'error'); }
}

function guessType(name, content) {
  const n = name.toLowerCase();
  const head = content.trimStart().toLowerCase();
  if (n.endsWith('.html') || n.endsWith('.htm') || head.startsWith('<!doctype') || head.startsWith('<html')) return 'HTML';
  if (n.endsWith('.js') || n.endsWith('.mjs') || n.endsWith('.cjs')) return 'JavaScript';
  if (n.endsWith('.css')) return 'CSS';
  return '文本';
}

// ==================== 仓库翻译 ====================

let repoFiles = [];       // [{path, size}]
let repoSelected = new Set();
let repoInfo = null;
let translatedCount = 0;
let repoFailed = {};      // {path: reason}

function setupRepo() {
  $('#btn-repo-query').onclick = queryRepo;
  $('#repo-url').addEventListener('keydown', e => { if (e.key === 'Enter') queryRepo(); });

  $('#btn-ai-select').onclick = async () => {
    if (!repoFiles.length) return;
    if (!config.api_key_set) { toast('请先在「设置」中填写 DeepSeek API Key', 'warn'); showSettingsModal(); return; }
    showProgress('AI 正在分析文件清单…');
    try {
      const r = await api('/api/repo/ai-select', { files: repoFiles, ...config });
      repoSelected = new Set(r.picked);
      renderRepoFiles();
      toast(`AI 选出 ${r.picked.length}/${repoFiles.length} 个文件`, 'success');
      hideProgress();
    } catch (e) { hideProgress(); toast('AI 筛选失败: ' + e.message, 'error'); }
  };

  $('#btn-repo-translate').onclick = async () => {
    const files = repoFiles.filter(f => repoSelected.has(f.path));
    if (!files.length) { toast('未选择任何文件', 'warn'); return; }
    if (!config.api_key_set) { toast('请先在「设置」中填写 DeepSeek API Key', 'warn'); showSettingsModal(); return; }
    $('#btn-repo-translate').disabled = true;
    showProgress(`批量翻译 ${files.length} 个文件…`);
    log(`开始批量翻译 ${files.length} 个文件`, 'ok');
    try {
      const r = await api('/api/repo/translate', { files, ...config });
      const result = await waitJob(r.jobId, {
        onProgress: (d, t) => updateProgress(d, t, `翻译中 ${d}/${t} 个文件`),
      });
      translatedCount = Object.keys(result.results || {}).length;
      repoFailed = result.failedReports || {};
      const failCount = Object.keys(repoFailed).length;
      const notes = [];
      if (Object.keys(result.assets || {}).length) notes.push(`含 ${Object.keys(result.assets).length} 个资源`);
      if (result.mergeCount) notes.push(`合并 ${result.mergeCount} 个未翻译文件`);
      if (result.skipped) notes.push(`跳过 ${result.skipped} 个大文件`);
      if (result.noTranslate) notes.push(`${result.noTranslate} 个无需翻译`);
      if (failCount) notes.push(`${failCount} 个失败已保留原文`);
      updateProgress(result.total, result.total, '完成');
      $('#btn-repo-zip').disabled = false;
      $('#btn-gh-push-translated').disabled = false;
      if (failCount) { $('#btn-repo-retry').hidden = false; $('#btn-repo-copy-fail').hidden = false; }
      else { $('#btn-repo-retry').hidden = true; $('#btn-repo-copy-fail').hidden = true; }
      toast(`翻译完成: ${translatedCount} 个文件 ✓ ${notes.join('，')}`, failCount ? 'warn' : 'success');
      log(`翻译完成: ${translatedCount} 个文件 ✓ ${notes.join('，')}`, failCount ? 'warn' : 'ok');
      sysNotify('仓库翻译完成', `成功 ${translatedCount} 个文件${failCount ? `，失败 ${failCount} 个` : ''}`);
      setTimeout(hideProgress, 800);
    } catch (e) {
      hideProgress();
      toast('批量翻译失败: ' + e.message, 'error');
      log('批量翻译失败: ' + e.message, 'error');
    } finally {
      $('#btn-repo-translate').disabled = false;
    }
  };

  $('#btn-repo-zip').onclick = async () => {
    showProgress('正在打包 ZIP…');
    try {
      await ensureAuthToken();
      const q = apiAuthToken ? '?t=' + encodeURIComponent(apiAuthToken) : '';
      const headers = apiAuthToken ? { 'x-auth-token': apiAuthToken } : {};
      const resp = await fetch(API + '/api/repo/zip' + q, { headers, signal: AbortSignal.timeout(60000) });
      if (!resp.ok) throw new Error('打包失败');
      const blob = await resp.blob();
      const base = repoInfo && repoInfo.repo ? repoInfo.repo : 'translated';
      const ok = await saveBlob(blob, `${base}_translated.zip`);
      if (ok) toast('ZIP 已保存', 'success');
      hideProgress();
    } catch (e) { hideProgress(); toast('保存失败: ' + e.message, 'error'); }
  };

  $('#btn-repo-retry').onclick = async () => {
    if (!config.api_key_set) { toast('请先填写 API Key', 'warn'); showSettingsModal(); return; }
    $('#btn-repo-retry').disabled = true;
    showProgress('重试失败文件…');
    try {
      const r = await api('/api/repo/retry', { ...config });
      const result = await waitJob(r.jobId, {
        onProgress: (d, t) => updateProgress(d, t, `重试中 ${d}/${t}`),
      });
      toast(`重试完成：成功 ${result.succeeded} 个${result.stillFailed ? '，仍失败 ' + result.stillFailed + ' 个' : ''}`, result.stillFailed ? 'warn' : 'success');
      hideProgress();
    } catch (e) { hideProgress(); toast('重试失败: ' + e.message, 'error'); }
    finally { $('#btn-repo-retry').disabled = false; }
  };

  // 一键复制失败文件清单
  $('#btn-repo-copy-fail').onclick = async () => {
    const entries = Object.entries(repoFailed);
    if (!entries.length) { toast('没有失败文件', 'warn'); return; }
    const text = entries.map(([p, r]) => `${p}: ${r}`).join('\n');
    const ok = await copyText(text);
    toast(ok ? `已复制 ${entries.length} 个失败文件清单` : '复制失败，请手动选择', ok ? 'success' : 'error');
  };

  // JS 检测
  $('#btn-js-check').onclick = async () => {
    const url = $('#js-url').value.trim();
    if (!url) { toast('请先粘贴 JS 链接', 'warn'); return; }
    $('#btn-js-check').disabled = true;
    try {
      const r = await api('/api/js/check', { url });
      const box = $('#js-result');
      if (r.error === null) {
        box.innerHTML = `<div class="badge success" style="margin-top:8px">✅ 语法正常 · ${r.sizeKB} KB</div>`;
        log(`JS 检测通过: ${r.url}`, 'ok');
      } else {
        box.innerHTML = `<div class="badge error" style="margin-top:8px">⚠ ${escapeHtml(r.error)}</div>`;
        log(`JS 语法错误: ${r.error}`, 'error');
      }
    } catch (e) { toast('检测失败: ' + e.message, 'error'); }
    finally { $('#btn-js-check').disabled = false; }
  };
}

async function queryRepo() {
  const url = $('#repo-url').value.trim();
  if (!url) { toast('请先填写链接', 'warn'); return; }
  $('#btn-repo-query').disabled = true;
  showProgress('正在解析网站…');
  try {
    const r = await api('/api/repo/query', { url }); // 服务器自动判定：itch.io → GitHub → 通用静态网站
    repoFiles = r.files;
    repoInfo = r.info || null;
    repoSelected = new Set(repoFiles.map(f => f.path));
    renderRepoFiles();
    const MODE_HEAD = {
      itch: '🎮 itch.io 游戏',
      gh: repoInfo ? `📦 ${repoInfo.owner}/${repoInfo.repo}（分支 ${repoInfo.default_branch}）` : '📦 GitHub 仓库',
      generic: '🌐 通用静态网站（自动抓取同源资源）',
    };
    const head = MODE_HEAD[r.mode || 'gh'];
    $('#repo-info').hidden = false;
    $('#repo-info').textContent = `${head}\n共 ${r.files.length} 个文件 · 文本可翻译，资源自动合并 · 默认全选`;
    $('#btn-repo-translate').disabled = false;
    $('#btn-ai-select').disabled = false;
    $('#btn-repo-zip').disabled = true;
    $('#btn-repo-retry').hidden = true;
    $('#btn-repo-copy-fail').hidden = true;
    repoFailed = {};
    log(`网站解析成功: ${r.files.length} 个文件（模式: ${r.mode || 'gh'}）`, 'ok');
    hideProgress();
  } catch (e) {
    hideProgress();
    toast('解析失败: ' + e.message, 'error');
  } finally {
    $('#btn-repo-query').disabled = false;
  }
}

function renderRepoFiles() {
  const list = $('#repo-files');
  list.innerHTML = '';
  for (const f of repoFiles) {
    const item = document.createElement('label');
    item.className = 'file-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = repoSelected.has(f.path);
    cb.onchange = () => {
      if (cb.checked) repoSelected.add(f.path); else repoSelected.delete(f.path);
      updateRepoCount();
    };
    const p = document.createElement('span');
    p.className = 'f-path';
    p.textContent = f.path;
    const s = document.createElement('span');
    s.className = 'f-size';
    s.textContent = fmtSize(f.size);
    item.append(cb, p, s);
    list.appendChild(item);
  }
  updateRepoCount();
  const all = $('#repo-check-all');
  all.onchange = () => {
    if (all.checked) repoSelected = new Set(repoFiles.map(f => f.path));
    else repoSelected = new Set();
    renderRepoFiles();
  };
}

function updateRepoCount() {
  $('#repo-count').textContent = `已选 ${repoSelected.size}/${repoFiles.length}`;
}

// ==================== GitHub ====================

let ghLoggedIn = false;
let ghRepos = [];
let ghAccounts = [];   // [{id, name, user, token_set}]
let ghActiveId = '';

/** 从服务器拉取账号列表（脱敏）并渲染下拉。 */
async function refreshAccountSelect() {
  try {
    const r = await api('/api/github/accounts');
    ghAccounts = r.accounts || [];
    ghActiveId = r.active_id || '';
  } catch (e) { ghAccounts = []; ghActiveId = ''; }
  const row = $('#gh-account-row');
  const sel = $('#gh-account-select');
  row.hidden = ghAccounts.length <= 0;
  sel.innerHTML = '';
  for (const a of ghAccounts) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.user || a.name || '账号'}${a.token_set ? '' : '（无效）'}`;
    sel.appendChild(opt);
  }
  if (ghAccounts.length) sel.value = ghActiveId;
}

async function switchAccount(id) {
  await api('/api/github/accounts/switch', { id });
  const acc = ghAccounts.find(a => a.id === id);
  toast(`已切换到账号: ${acc ? (acc.user || acc.name) : id}`, 'success');
  log(`GitHub 账号已切换: ${acc ? (acc.user || acc.name) : id}`, 'ok');
  // 重新加载当前账号的仓库并刷新文件面板状态
  $('#gh-repo-select').innerHTML = '';
  $('#gh-files-card').hidden = true;
  try { await loadRepos(); } catch (e) { /* 账号无效时忽略 */ }
}

/** 弹窗添加新账号（粘贴 token）。 */
function showAddAccountModal() {
  const box = $('#modal-box');
  box.innerHTML = `
    <h3>＋ 添加 GitHub 账号</h3>
    <div class="body">
      <input type="password" class="input grow" id="add-account-token" placeholder="粘贴该账号的 GitHub Token（ghp_... 或 gho_...）">
      <div class="hint" style="margin-top:6px">添加后自动切换为该账号。Token 仅保存在本机。</div>
    </div>
    <div class="actions">
      <button class="btn" id="add-account-cancel">取消</button>
      <button class="btn primary" id="add-account-ok">添加并切换</button>
    </div>`;
  showModal();
  $('#add-account-cancel').onclick = hideModal;
  $('#add-account-ok').onclick = async () => {
    const token = $('#add-account-token').value.trim();
    if (!token) { toast('请粘贴 GitHub Token', 'warn'); return; }
    $('#add-account-ok').disabled = true;
    try {
      const r = await api('/api/github/accounts', { token });
      hideModal();
      await afterLogin(r.user);
      toast(`已添加账号: ${r.user.login}`, 'success');
    } catch (e) {
      toast('添加失败: ' + e.message, 'error');
      $('#add-account-ok').disabled = false;
    }
  };
}

/** 删除当前账号（激活账号被删则自动切换下一个）。 */
async function removeAccount() {
  const id = $('#gh-account-select').value;
  const acc = ghAccounts.find(a => a.id === id);
  if (!acc) { toast('没有可删除的账号', 'warn'); return; }
  if (!confirm(`确定删除 GitHub 账号「${acc.user || acc.name}」？此操作不可恢复。`)) return;
  try {
    const r = await api('/api/github/accounts/remove', { id });
    ghAccounts = r.accounts || [];
    ghActiveId = r.active_id || '';
    await refreshAccountSelect();
    toast('账号已删除', 'success');
    if (!r.active_id) {
      // 没有剩余账号 → 回到未登录状态
      ghLoggedIn = false;
      $('#gh-chip-text').textContent = '未登录';
      $('#gh-chip').classList.remove('logged');
      $('#gh-login-badge').textContent = '未登录';
      $('#gh-login-badge').className = 'badge';
      $('#gh-login-hint').textContent = '登录后可推送翻译结果 / 网站 / 文件到仓库，并一键开启 GitHub Pages；多个账号可随时切换';
      $('#gh-push-card').hidden = true;
      $('#gh-files-card').hidden = true;
      $('#gh-account-row').hidden = true;
    } else {
      // 还有剩余账号：用新激活账号刷新顶栏/徽章
      const me = await api('/api/github/me').catch(() => null);
      if (me && me.loggedIn && me.user) {
        $('#gh-chip-text').textContent = me.user.login;
        $('#gh-login-badge').textContent = '已登录';
        $('#gh-login-hint').textContent = `已登录: ${me.user.login}，可随时切换多账号`;
        await loadRepos();
      }
    }
  } catch (e) { toast('删除失败: ' + e.message, 'error'); }
}

function setupGithub() {
  $('#btn-oauth-guide').onclick = () => {
    const box = $('#modal-box');
    box.innerHTML = `
      <h3>注册 GitHub OAuth App（10 秒）</h3>
      <div class="body">
        1. 打开 github.com/settings/developers<br>
        2. 点 <b>OAuth Apps</b> → <b>New OAuth App</b><br>
        3. Application name 随便填（如 WebTranslator）<br>
        4. Homepage URL 填 <b>https://github.com</b><br>
        5. Authorization callback URL 填 <b>https://github.com</b><br>
        6. 创建后复制 <b>Client ID</b> 粘贴到输入框<br><br>
        或者直接在下方输入框填已有 Token 登录（二选一）。
      </div>
      <div class="actions">
        <button class="btn" id="modal-cancel2">关闭</button>
        <button class="btn primary" id="modal-open-reg">打开注册页</button>
      </div>`;
    showModal();
    $('#modal-cancel2').onclick = hideModal;
    $('#modal-open-reg').onclick = () => window.open('https://github.com/settings/developers', '_blank');
  };

  $('#btn-gh-login').onclick = async () => {
    const token = $('#gh-token').value.trim();
    const clientId = $('#gh-client-id').value.trim();
    if (token) {
      $('#btn-gh-login').disabled = true;
      try {
        const r = await api('/api/github/login-token', { token });
        await afterLogin(r.user);
        toast(`登录成功: ${r.user.login}`, 'success');
      } catch (e) { toast('登录失败: ' + e.message, 'error'); }
      finally { $('#btn-gh-login').disabled = false; }
      return;
    }
    if (!clientId) { toast('请先填写 OAuth Client ID（或直接填 Token）', 'warn'); $('#btn-oauth-guide').click(); return; }
    startDeviceFlow(clientId);
  };

  $('#btn-gh-refresh').onclick = loadRepos;
  $('#btn-gh-newrepo').onclick = showNewRepoModal;
  $('#btn-gh-push-translated').onclick = pushTranslated;
  $('#btn-gh-upload').onclick = () => $('#gh-upload-input').click();
  $('#gh-account-select').onchange = () => {
    const id = $('#gh-account-select').value;
    if (id && id !== ghActiveId) switchAccount(id);
  };
  $('#btn-gh-account-add').onclick = showAddAccountModal;
  $('#btn-gh-account-remove').onclick = removeAccount;
  $('#gh-upload-input').onchange = () => {
    const files = [...$('#gh-upload-input').files];
    if (!files.length) return;
    $('#gh-upload-list').hidden = false;
    $('#gh-upload-list').textContent = `已选 ${files.length} 个文件: ${files.map(f => f.name).join('、').slice(0, 150)}`;
    $('#btn-gh-upload').disabled = false;
    uploadFiles(); // 选完直接上传
  };
  $('#btn-gh-push-site').onclick = pushSite;
  setupGithubFiles();
}

async function afterLogin(user) {
  ghLoggedIn = true;
  $('#gh-chip-text').textContent = user.login;
  $('#gh-chip').classList.add('logged');
  $('#gh-login-badge').textContent = '已登录';
  $('#gh-login-badge').className = 'badge success';
  $('#gh-login-hint').textContent = `已登录: ${user.login}${user.name ? ' (' + user.name + ')' : ''}，可随时切换多账号`;
  $('#gh-push-card').hidden = false;
  $('#gh-files-card').hidden = false; // 仓库文件管理面板
  await refreshAccountSelect();
  await loadRepos();
}

async function checkLogin() {
  try {
    const r = await api('/api/github/me');
    if (r.loggedIn) await afterLogin(r.user);
  } catch (e) { /* 未登录 */ }
}

function startDeviceFlow(clientId) {
  const box = $('#modal-box');
  box.innerHTML = `
    <h3>GitHub 设备码授权</h3>
    <div class="body">正在向 GitHub 申请授权码…</div>
    <div class="actions"><button class="btn" id="oauth-cancel">取消</button></div>`;
  showModal();
  $('#oauth-cancel').onclick = () => { window.__oauthStop = true; hideModal(); };

  (async () => {
    try {
      const r = await api('/api/github/oauth-start', { client_id: clientId });
      const dc = r.device;
      box.innerHTML = `
        <h3>GitHub 设备码授权</h3>
        <div class="body">请在浏览器打开授权页，输入下面的代码完成授权：</div>
        <div class="code">${escapeHtml(dc.user_code)}</div>
        <div class="body">授权页: ${escapeHtml(dc.verification_uri)}<br>（${Math.floor(dc.expires_in / 60)} 分钟内有效，授权后自动登录）</div>
        <div class="actions">
          <button class="btn" id="oauth-cancel2">取消</button>
          <button class="btn primary" id="oauth-open">打开授权页</button>
        </div>`;
      $('#oauth-open').onclick = () => window.open(dc.verification_uri, '_blank');
      $('#oauth-cancel2').onclick = () => { window.__oauthStop = true; hideModal(); };

      // 轮询
      const deadline = Date.now() + dc.expires_in * 1000;
      let interval = Math.max(dc.interval, 5);
      while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, interval * 1000));
        if (window.__oauthStop) return;
        try {
          const p = await api('/api/github/oauth-poll', { client_id: clientId, device_code: dc.device_code });
          if (p.status === 'pending') continue;
          if (p.status === 'slow_down') { interval += 5; continue; }
          if (p.token_set) {
            await afterLogin(p.user);
            hideModal();
            toast(`登录成功: ${p.user.login}`, 'success');
            return;
          }
          throw new Error(p.error);
        } catch (e) {
          if (e.message.includes('authorization_pending')) continue;
          throw e;
        }
      }
      toast('授权超时，请重新登录', 'warn');
      hideModal();
    } catch (e) {
      toast('设备码登录失败: ' + e.message, 'error');
      hideModal();
    }
  })();
}

async function loadRepos() {
  try {
    const r = await api('/api/github/repos');
    ghRepos = r.repos;
    const sel = $('#gh-repo-select');
    sel.innerHTML = '';
    for (const repo of r.repos) {
      const opt = document.createElement('option');
      opt.value = repo.full_name;
      opt.textContent = repo.full_name;
      opt.dataset.branch = repo.default_branch;
      sel.appendChild(opt);
    }
    if (config.github_repo) sel.value = config.github_repo;
    if (!sel.value && r.repos.length) sel.value = r.repos[0].full_name;
    $('#gh-push-translated-note');
    $('#btn-gh-newrepo').disabled = false;
  } catch (e) {
    toast('加载仓库失败: ' + e.message, 'error');
  }
}

function selectedRepo() {
  const sel = $('#gh-repo-select');
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return null;
  return { full_name: opt.value, default_branch: opt.dataset.branch || 'main' };
}

function showNewRepoModal() {
  const box = $('#modal-box');
  box.innerHTML = `
    <h3>新建 GitHub 仓库</h3>
    <div class="body">
      <div class="row"><input type="text" class="input grow" id="newrepo-name" placeholder="仓库名（小写字母/数字/横线）"></div>
    </div>
    <div class="actions">
      <button class="btn" id="modal-cancel3">取消</button>
      <button class="btn primary" id="modal-create">创建</button>
    </div>`;
  showModal();
  $('#modal-cancel3').onclick = hideModal;
  $('#modal-create').onclick = async () => {
    const name = $('#newrepo-name').value.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) { toast('仓库名不合法', 'warn'); return; }
    try {
      const r = await api('/api/github/create-repo', { name });
      toast(`仓库已创建: ${r.repo.full_name}`, 'success');
      hideModal();
      await loadRepos();
      $('#gh-repo-select').value = r.repo.full_name;
    } catch (e) { toast('创建失败: ' + e.message, 'error'); }
  };
}

async function pushTranslated() {
  const repo = selectedRepo();
  if (!repo) { toast('请先选择目标仓库', 'warn'); return; }
  showProgress('推送翻译结果…');
  log('开始推送翻译结果', 'ok');
  try {
    const r = await api('/api/github/push', {
      repo, mode: 'translated', enablePages: $('#gh-pages').checked,
    });
    for (const [kind, payload] of r.logs || []) if (kind === 'log') log(payload);
    const note = r.pagesUrl ? `，Pages: ${r.pagesUrl}` : '';
    const failNote = (r.failed || []).length ? `，失败 ${r.failed.length} 个: ${r.failed.slice(0, 3).join('、')}${r.failed.length > 3 ? '…' : ''}` : '';
    toast(`已推送 ${r.pushed} 个文件到 ${repo.full_name}${failNote}${note}`, failNote ? 'warn' : 'success');
    log(`推送完成 ✓ ${r.pushed} 个文件${failNote}${note}`, failNote ? 'warn' : 'ok');
    hideProgress();
  } catch (e) {
    hideProgress();
    toast('推送失败: ' + e.message, 'error');
    log('推送失败: ' + e.message, 'error');
  }
}

async function uploadFiles() {
  const repo = selectedRepo();
  if (!repo) { toast('请先选择目标仓库', 'warn'); return; }
  const files = [...$('#gh-upload-input').files];
  if (!files.length) { toast('请先选择文件', 'warn'); return; }
  const prefix = $('#gh-push-path').value.trim().replace(/^\/+|\/+$/g, '');
  showProgress(`上传 ${files.length} 个文件…`);
  try {
    const list = [];
    for (const f of files) {
      const name = prefix ? `${prefix}/${f.name}` : f.name;
      const buf = new Uint8Array(await f.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) {
        binary += String.fromCharCode(...buf.subarray(i, i + chunk));
      }
      list.push({ name, base64: btoa(binary) });
    }
    const r = await api('/api/github/upload', { repo, files: list, enablePages: $('#gh-pages').checked });
    const failNote = r.failed.length ? `，失败: ${r.failed.join('、')}` : '';
    const note = r.pagesUrl ? `，Pages: ${r.pagesUrl}` : '';
    toast(`已上传 ${r.done} 个文件${failNote}${note}`, r.failed.length ? 'warn' : 'success');
    log(`上传完成: ${r.done} 个${failNote}${note}`, r.failed.length ? 'warn' : 'ok');
    hideProgress();
  } catch (e) {
    hideProgress();
    toast('上传失败: ' + e.message, 'error');
  }
}

// ==================== 仓库文件管理（浏览/编辑/新增/删除/Pages） ====================

let ghRepoFiles = [];
let ghEditorIsNew = false;

function setupGithubFiles() {
  $('#btn-gh-files-load').onclick = loadGhFiles;
  $('#btn-gh-files-new').onclick = newGhFile;
  $('#btn-gh-files-refresh').onclick = loadGhFiles;
  $('#btn-gh-pages').onclick = enablePagesNow;
  $('#btn-gh-editor-save').onclick = saveGhFile;
  $('#btn-gh-editor-delete').onclick = deleteGhFile;
  // 切换仓库时清空文件列表
  $('#gh-repo-select').addEventListener('change', () => {
    ghRepoFiles = [];
    $('#gh-files-list').innerHTML = '<div class="hint" style="padding:14px">点击「加载文件列表」浏览仓库文件</div>';
    $('#gh-files-count').textContent = '';
    $('#gh-editor').value = '';
    $('#gh-editor-path').value = '';
    $('#btn-gh-editor-save').disabled = true;
    $('#btn-gh-editor-delete').disabled = true;
  });
}

async function loadGhFiles() {
  const repo = selectedRepo();
  if (!repo) { toast('请先选择目标仓库', 'warn'); return; }
  $('#btn-gh-files-load').disabled = true;
  try {
    const r = await api('/api/github/file-tree', { repo });
    ghRepoFiles = r.files || [];
    renderGhFiles();
    $('#gh-files-count').textContent = `${ghRepoFiles.length} 个文件`;
    $('#btn-gh-files-refresh').hidden = false;
  } catch (e) {
    toast('加载文件列表失败: ' + e.message, 'error');
  } finally {
    $('#btn-gh-files-load').disabled = false;
  }
}

const EDITABLE_EXTS = new Set(['html', 'htm', 'js', 'mjs', 'cjs', 'css', 'txt', 'md', 'json', 'xml', 'csv',
  'svg', 'yml', 'yaml', 'ini', 'conf', 'sh', 'bat', 'py', 'java', 'c', 'cpp', 'h', 'kt', 'ts',
  'map', 'lock', 'gitignore', 'editorconfig', 'properties', 'toml']);

function renderGhFiles() {
  const list = $('#gh-files-list');
  list.innerHTML = '';
  for (const f of ghRepoFiles) {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.path = f.path;
    const ext = f.path.includes('.') ? f.path.split('.').pop().toLowerCase() : '';
    const icon = EDITABLE_EXTS.has(ext) ? '📄' : '📦';
    item.innerHTML = `<span class="f-path">${icon} ${escapeHtml(f.path)}</span><span class="f-size">${fmtSize(f.size)}</span>`;
    item.onclick = () => openGhFile(f.path);
    list.appendChild(item);
  }
  if (!ghRepoFiles.length) list.innerHTML = '<div class="hint" style="padding:14px">仓库为空，点「＋ 新建文件」开始</div>';
}

async function openGhFile(path) {
  const repo = selectedRepo();
  if (!repo) return;
  $$('#gh-files-list .file-item').forEach(x => x.classList.toggle('selected', x.dataset.path === path));
  $('#gh-editor-path').value = path;
  $('#gh-editor-path').readOnly = true;
  ghEditorIsNew = false;
  $('#gh-editor').value = '加载中…';
  $('#gh-editor').classList.remove('binary');
  $('#btn-gh-editor-save').disabled = true;
  $('#btn-gh-editor-delete').disabled = true;
  try {
    const r = await api('/api/github/file-content', { repo, path });
    $('#gh-editor').value = r.content;
    $('#btn-gh-editor-save').disabled = false;
    $('#btn-gh-editor-delete').disabled = false;
  } catch (e) {
    $('#gh-editor').classList.add('binary');
    $('#gh-editor').value = `（无法在线编辑）\n${e.message}`;
    toast('打开文件失败: ' + e.message, 'error');
  }
}

function newGhFile() {
  $('#gh-editor-path').readOnly = false;
  $('#gh-editor-path').value = '';
  $('#gh-editor-path').focus();
  ghEditorIsNew = true;
  $('#gh-editor').value = '';
  $('#gh-editor').classList.remove('binary');
  $('#btn-gh-editor-save').disabled = false;
  $('#btn-gh-editor-delete').disabled = true;
  $$('#gh-files-list .file-item').forEach(x => x.classList.remove('selected'));
}

async function saveGhFile() {
  const repo = selectedRepo();
  if (!repo) { toast('请先选择目标仓库', 'warn'); return; }
  const path = $('#gh-editor-path').value.trim().replace(/^\/+/, '');
  if (!path) { toast('请填写文件路径', 'warn'); $('#gh-editor-path').focus(); return; }
  if (path.includes('..')) { toast('文件路径不合法', 'warn'); return; }
  $('#btn-gh-editor-save').disabled = true;
  try {
    await api('/api/github/file-save', {
      repo, path, content: $('#gh-editor').value, isNew: ghEditorIsNew,
    });
    toast(`已保存 ${path}`, 'success');
    log(`文件已保存: ${path}`, 'ok');
    ghEditorIsNew = false;
    $('#gh-editor-path').readOnly = true;
    await loadGhFiles(); // 刷新列表（新文件会出现在列表）
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  } finally {
    $('#btn-gh-editor-save').disabled = false;
  }
}

async function deleteGhFile() {
  const path = $('#gh-editor-path').value.trim();
  if (!path) { toast('请先选择要删除的文件', 'warn'); return; }
  if (!confirm(`确定删除仓库文件「${path}」吗？此操作不可撤销。`)) return;
  try {
    await api('/api/github/file-delete', { repo: selectedRepo(), path });
    toast(`已删除 ${path}`, 'success');
    log(`文件已删除: ${path}`, 'ok');
    $('#gh-editor').value = '';
    $('#gh-editor-path').value = '';
    $('#btn-gh-editor-save').disabled = true;
    $('#btn-gh-editor-delete').disabled = true;
    await loadGhFiles();
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

async function enablePagesNow() {
  const repo = selectedRepo();
  if (!repo) { toast('请先选择目标仓库', 'warn'); return; }
  $('#btn-gh-pages').disabled = true;
  try {
    const r = await api('/api/github/pages', { repo });
    toast(`GitHub Pages 已开启: ${r.pagesUrl}`, 'success');
    log(`Pages 已开启: ${r.pagesUrl}`, 'ok');
  } catch (e) {
    toast('开启 Pages 失败: ' + e.message, 'error');
  } finally {
    $('#btn-gh-pages').disabled = false;
  }
}

// ==================== 网站文件夹 ====================

let siteFiles = [];      // [{path, file(File), html: bool}]
let siteBroken = new Set();

function setupSite() {
  const input = $('#site-folder-input');
  $('#btn-site-pick').onclick = () => input.click();
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    showProgress('读取文件夹…');
    siteFiles = files.map(f => ({
      path: f.webkitRelativePath || f.name,
      file: f,
      html: /\.html?$/i.test(f.name),
    })).sort((a, b) => a.path.localeCompare(b.path));
    const htmls = siteFiles.filter(f => f.html);
    $('#site-info').textContent = `已加载: ${htmls.length} 个 HTML / ${siteFiles.length} 个文件`;
    renderSiteFiles();
    // 扫描语法错误
    try {
      const scanFiles = [];
      for (const f of siteFiles) {
        const low = f.path.toLowerCase();
        if (low.endsWith('.js') && !low.includes('.min.')) {
          scanFiles.push({ path: f.path, content: await f.file.text() });
        } else if (f.html) {
          scanFiles.push({ path: f.path, content: await f.file.text() });
        }
        if (scanFiles.length >= 400) break; // 避免一次性读太多
      }
      const r = await api('/api/site/scan', { files: scanFiles });
      siteBroken = new Set(r.broken);
      renderSiteFiles();
      const hint = $('#site-hint');
      if (r.broken.length) {
        hint.textContent = `⚠ 检测到 ${r.broken.length} 个文件语法错误（标红的为坏文件，浏览器打开会报错，建议重新翻译）`;
        hint.style.color = 'var(--red)';
      } else {
        hint.textContent = '✅ 语法检测通过，所有 JS/HTML 正常';
        hint.style.color = 'var(--green)';
      }
      $('#btn-site-open').disabled = false;
      $('#btn-site-push').disabled = false;
      $('#btn-gh-push-site').disabled = false;
    } catch (e) {
      toast('语法扫描失败: ' + e.message, 'error');
    }
    hideProgress();
  };

  $('#btn-site-open').onclick = () => {
    const sel = $('#site-files .file-item.selected');
    if (!sel) { toast('请先点击选中一个文件', 'warn'); return; }
    const idx = +sel.dataset.idx;
    const f = siteFiles[idx];
    if (!f || !f.html) { toast('只能打开 HTML 文件', 'warn'); return; }
    const url = URL.createObjectURL(f.file);
    window.open(url, '_blank');
  };

  $('#btn-site-push').onclick = pushSite;
  $('#btn-gh-push-site').onclick = pushSite;
}

function renderSiteFiles() {
  const list = $('#site-files');
  list.innerHTML = '';
  siteFiles.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'file-item' + (siteBroken.has(f.path) ? ' broken' : '') + (f.html ? '' : ' muted');
    item.dataset.idx = i;
    item.innerHTML = `<span class="f-path">${f.html ? '🌐' : '📄'} ${escapeHtml(f.path)}</span>`;
    item.onclick = () => {
      $$('#site-files .file-item').forEach(x => x.classList.remove('selected'));
      item.classList.add('selected');
    };
    list.appendChild(item);
  });
  if (!siteFiles.length) list.innerHTML = '<div class="hint" style="padding:16px">还没有加载文件夹</div>';
}

async function pushSite() {
  const repo = selectedRepo();
  if (!repo) { toast('请先选择目标仓库', 'warn'); switchPage('github'); return; }
  if (!siteFiles.length) { toast('请先选择网站文件夹', 'warn'); return; }
  const prefix = $('#gh-push-path').value.trim().replace(/^\/+|\/+$/g, '');
  showProgress(`读取 ${siteFiles.length} 个文件…`);
  try {
    const list = [];
    let sizeTotal = 0;
    for (const f of siteFiles) {
      const name = prefix ? `${prefix}/${f.path}` : f.path;
      const buf = new Uint8Array(await f.file.arrayBuffer());
      sizeTotal += buf.length;
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) binary += String.fromCharCode(...buf.subarray(i, i + chunk));
      list.push({ name, base64: btoa(binary) });
      updateProgress(list.length, siteFiles.length, `读取 ${list.length}/${siteFiles.length}`);
    }
    updateProgress(0, siteFiles.length, `上传中（${fmtSize(sizeTotal)}）…`);
    const r = await api('/api/github/upload', { repo, files: list, enablePages: $('#gh-pages').checked });
    const failNote = r.failed.length ? `，失败: ${r.failed.join('、')}` : '';
    const note = r.pagesUrl ? `，Pages: ${r.pagesUrl}` : '';
    toast(`网站已推送到 ${repo.full_name}（${r.done} 个文件）${failNote}${note}`, r.failed.length ? 'warn' : 'success');
    log(`网站推送完成: ${r.done} 个文件${failNote}${note}`, r.failed.length ? 'warn' : 'ok');
    hideProgress();
  } catch (e) {
    hideProgress();
    toast('推送失败: ' + e.message, 'error');
  }
}

// ==================== 初始化 ====================

async function init() {
  setupLocal();
  setupRepo();
  setupGithub();
  setupSite();

  $$('.nav-item[data-page]').forEach(b => b.onclick = () => switchPage(b.dataset.page));
  $('#btn-settings').onclick = showSettingsModal;
  $('#btn-theme').onclick = cycleTheme;
  $('#btn-history').onclick = showHistory;
  $('#gh-chip').onclick = () => switchPage('github');
  $('#btn-log-clear').onclick = () => { $('#log-body').innerHTML = ''; };
  $('#btn-log-toggle').onclick = () => $('#log-panel').classList.toggle('collapsed');
  $('#btn-log-export').onclick = exportLog;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideModal();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      const page = document.querySelector('.page.active')?.id;
      if (page === 'page-local') $('#local-file-input').click();
      else if (page === 'page-site') $('#site-folder-input').click();
      else switchPage('local'), $('#local-file-input').click();
    }
  });
  if (!document.documentElement.dataset.theme) applyTheme(config.theme || 'dark'); // 仅当 preload/bootstrap 未注入主题时兜底

  try {
    await loadConfig();
    checkLogin().catch(() => {}); // 后台验证 GitHub 登录，不阻塞界面初始化
    log('WebTranslator 电脑版已启动，本地服务运行中', 'ok');
    window.__cfgLoaded = true; // 测试/调试钩子：init 完成标记
  } catch (e) {
    log('初始化失败: ' + e.message, 'error');
  }
}

init();
