'use strict';
/**
 * 文件切分与翻译编排 —— 移植自 Android 版 FileTranslator.kt / Python 版。
 * JS 语法校验直接用 Node 的 vm 模块（支持全部现代语法，不支持的 ESM 退回 node --check）。
 */
const vm = require('vm');
const { execFile } = require('child_process');
const FailureMemory = require('./failure_memory');
const StructuralRepairer = require('./structural_repairer');
const { isRegexStart, isForeign, extractForeignIdentifiers } = require('./translator_helpers');

const FileType = { HTML: 'HTML', JS: 'JS', CSS: 'CSS', TEXT: 'TEXT' };
const CHUNK_TARGET = 5000;
const CHUNK_MAX = 7000;
const SINGLE_FILE_LIMIT = 150_000;

function detectType(fileName, content) {
  const name = fileName.toLowerCase();
  const head = content.trimStart().toLowerCase();
  if (name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.xhtml') ||
      head.startsWith('<!doctype') || head.startsWith('<html')) return FileType.HTML;
  if (name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')) return FileType.JS;
  if (name.endsWith('.css')) return FileType.CSS;
  return FileType.TEXT;
}

/** 一行代码的净括号数（跳过字符串/注释/块注释/正则）。返回 [delta, stillInBlock]。 */
function bracketDelta(line, inBlockComment = false) {
  let d = 0, i = 0, n = line.length, quote = null, inBlock = inBlockComment;
  while (i < n) {
    const c = line[i], nxt = i + 1 < n ? line[i + 1] : '\0';
    if (inBlock) {
      if (c === '*' && nxt === '/') { inBlock = false; i++; }
    } else if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '/' && nxt === '/') break;
    else if (c === '/' && nxt === '*') { inBlock = true; i++; }
    else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{' || c === '(' || c === '[') d++;
    else if (c === '}' || c === ')' || c === ']') d--;
    i++;
  }
  return [d, inBlock];
}

function splitChunks(text) {
  const lines = text.split('\n');
  const chunks = [];
  let sb = [], depth = 0, inBlockComment = false;
  for (const line of lines) {
    if (sb.length) sb.push('\n');
    sb.push(line);
    const [delta, still] = bracketDelta(line, inBlockComment);
    inBlockComment = still;
    depth += delta;
    const tail = line.trimEnd();
    const safe = depth === 0 && (!line.trim() || tail.endsWith('>') || tail.endsWith(';') || tail.endsWith('}'));
    const cur = sb.join('');
    if (cur.length >= CHUNK_TARGET) {
      if (safe) { chunks.push(cur); sb = []; }
      else if (cur.length >= CHUNK_MAX) { chunks.push(cur); sb = []; depth = 0; }
    }
  }
  if (sb.length) chunks.push(sb.join(''));
  if (!chunks.length) chunks.push(text);
  return chunks;
}

function buildSystemPrompt(type, targetLang) {
  const lang = targetLang;
  if (type === FileType.HTML) {
    return `你是一个专业的网页本地化翻译引擎。请将用户提供的 HTML 文件内容翻译成${lang}。
规则：
1. 只翻译"打开网页时用户能看到"的文字：h1-h6、p、a、span、div、li、label、option、button、th、td、caption、legend、fieldset、title 等标签内的文本，以及 placeholder、alt、title、aria-label 等属性值；meta 的 content 描述可翻译。<input> 的 value 属性若是按钮文字（如 <input type="submit" value="提交">）也翻译；但 value 若是代码值/数据（如 value="user123"、value="0"）保留原样。
2. 严禁修改任何标签名、属性名、class、id、href、src、data-*、style 属性、CSS 内容、URL；meta 的 charset、http-equiv、viewport 等属性值严禁改动（只有 content 描述文字可翻译）。
3. onclick、onload、onchange 等事件属性内的 JavaScript 代码：只翻译其中 alert/confirm 等用户可见的提示文字；函数名、变量名、代码逻辑严禁翻译。
4. <script> 内的 JavaScript：只翻译会显示给用户的字符串（innerText/textContent/placeholder 赋值、alert/confirm 参数、DOM 文案）；函数名、方法名、变量名、对象 key、事件名、class/id、storage key、API 路径、正则表达式、转义序列一律原样保留，严禁翻译。
5. 保持 HTML 结构、缩进、换行；注释标记保留，注释内容可翻译。
6. 只输出翻译后的完整 HTML 内容，不要任何解释、不要 markdown 代码块包裹、不要多余空行。`;
  }
  if (type === FileType.JS) {
    return `你是一个专业的 JavaScript 本地化翻译引擎。请将用户提供的 JavaScript 代码翻译成${lang}。
【核心原则】只翻译"用户打开网页时肉眼能看到"的文字（界面文案）；代码里的函数名、方法名、变量名等一切标识符一律原样保留，一个字都不能动。

【必须原样保留、严禁翻译的（哪怕里面是英文单词）】
- 函数名、方法名、类名、变量名、参数名、对象属性名（key）：function loadData()、myButton.onclick、items.map()、obj.theme、this.state 等
- 括号属性访问 obj['name']、JSON 的 key（JSON.parse/JSON.stringify 的对象字段名）
- switch/case 的匹配值：case 'active': 中的 'active'；比较运算的字符串：if (x === 'en')
- CSS 类名/ID 选择器、事件名、storage/localStorage 的 key、cookie 名、消息类型字段、API 路径、URL、fetch/axios 地址
- 枚举值/状态值：'dark'、'success'、'active'、'en'、'zh'、'desktop' 等
- 正则表达式（含正则里的字符类、转义）、运算符、语法关键字、数字、布尔值（true/false/null/undefined）
- 转义序列：'\\n'、'\\t'、'\\u4e2d'、'\\x41' 等必须原样保留，禁止改写
- console.log / console.error 的参数（开发调试用，用户看不到，保持原样）

【可以翻译的（用户可见文案）】
- 赋值给 innerHTML / innerText / textContent / placeholder / title / alt / aria-label 的字符串
- alert( )、confirm( )、prompt( ) 里的提示文字
- 创建 DOM 节点后插入页面的文字（createElement 的 text、append 的文案）
- 直接 return 给前端渲染的提示消息、错误提示（含"error message"这类展示给用户看的）
- 模板字符串里作为界面文案的静态部分（\${...} 表达式保持原样）
- ★ 游戏/网页框架的显示字段（用户打开页面能看到，必须翻译，禁止保留英文）：
  - infobox / tutorial 的 title 和 body（教程弹窗标题 + 正文，含 HTML 标签内文字如 <h3>...</h3>）
  - clickable / buyable / upgrade / milestone / achievement / challenge 的 title( ) / display( ) / name / desc( ) / description / tooltip / effectDisplay( )
    （含 \\n 分隔的多行描述、"Cost: "、"Currently: "、"Reset "、"Unlock "、"Requires: " 等引导词）
  - layer 的 name 字段（用户可见的货币/资源名，如 "dollars" → "美元"、"token mastery" → "代币精通"）
  - resource / baseResource / currencyDisplayName（资源与货币的显示名）
  - requirementDescription（解锁条件描述，如 "Reach 1e10 points" → "达到 1e10 点数"）
  - bars / grids / particles 的 display( ) / text（进度条文字、网格显示、粒子文字）
  - subtabs / microtabs / customTab / tabFormat 里的页签标签名（用户点击的页签文字）
  - modInfo 的 modName / author / description / buttons 文字、hotkeys 的快捷键说明
  - discordName / 页面标题等可见文字

【判断标准】翻译后字符串如果会被浏览器显示在页面上就翻译；只是程序内部用来比较、存储、调用、标识的，一律不翻译。
【专有名词】游戏标题、社区名（Discord 名）、自定义货币名（如 Bokens）可保留原文或音译，但按钮/提示/描述性文案必须翻译。

【硬性要求】
1. 严禁修改任何代码逻辑、语法、标识符；不得改动代码结构。
2. 保持代码格式、缩进、换行、引号风格；不得省略、合并、截断任何语句。
3. 必须在保持代码语法完全正确、可直接运行的前提下翻译：字符串引号必须成对闭合、括号必须配对、语句必须完整，严禁因为翻译导致代码结构损坏。
4. 翻译结果必须是语法完整、可直接运行的 JavaScript；不得输出解释、不要用 markdown 代码块（\`\`\`）包裹、不得输出多余文本。

【常见失败案例警示——其他文件曾经因为这些错误翻译失败，你绝对不能再犯】
- 函数定义/调用丢失参数括号：\`function load(a, b\` 少了 \`)\`，导致 missing ) after formal parameters（第 24 行报错）→ 每个函数的参数列表括号必须完整保留
- 字符串引号丢失：\`var msg = '你好;\` 少了结尾引号 → 每个字符串的引号必须成对闭合
- 多余的 \`}\`：在文件末尾或函数外多写一个 \`}\` → 代码结构必须与原文逐字一致
- 括号类型错配：\`(\` 写成了 \`[\`、\`)\` 写成了 \`]\` → 括号类型必须与原文一致
- 函数名被翻译成中文：\`function 主标签页()\` → 所有函数名、方法名、变量名必须保持原英文，一个字母都不能改
- 输出说明文字而不是代码：不要输出"这是一段压缩源码…无需翻译"之类的分析，要么翻译、要么原样输出代码`;
  }
  if (type === FileType.CSS) {
    return `你是一个专业的本地化翻译引擎。请将用户提供的 CSS 文件中的自然语言翻译成${lang}。
规则：
1. 翻译 /* */ 注释内的文字，以及 content: "..." 或 content: '...' 属性值中的文案。
2. content 值中的转义序列（如 \\2022、\\00a0、\\f0c9）必须原样保留，不得改动。
3. 严禁修改任何选择器、属性名、非 content 的属性值、颜色、尺寸、媒体查询、@规则。
4. 保持格式和缩进。
5. 只输出翻译后的 CSS，不要任何解释、不要 markdown 代码块包裹。`;
  }
  return `你是一个专业的翻译引擎。请将用户提供的文本内容完整翻译成${lang}。
规则：
1. 忠实翻译，保留原文语气；专有名词、品牌名、URL 保留原文。
2. 保持原文的段落结构、空行、编号、Markdown 语法（如 ## 标题、**加粗**、\`代码\`）不变，只翻译其中文字。
3. 只输出翻译结果，不要任何解释。`;
}

// ==================== JS 语法校验（vm 引擎） ====================

function verifyJsSyntax(code) {
  /** 严格校验：vm.Script 编译（不执行）。返回 null=正确 / 错误信息字符串。 */
  try {
    new vm.Script(code, { filename: 'translated.js' });
    return null;
  } catch (e) {
    const m = /translated\.js:(\d+)/.exec(e.stack || '');
    const line = m ? `第 ${m[1]} 行: ` : '';
    return `${line}${e.message}`;
  }
}

function verifyJsSyntaxEsm(code) {
  /** ESM 语法：node --check --input-type=module 子进程。 */
  return new Promise((resolve) => {
    const p = execFile('node', ['--check', '--input-type=module'], { timeout: 60000 }, (err, stdout, stderr) => {
      if (!err) return resolve(null);
      const msg = String(stderr || err.message);
      const m = /\[stdin\]:(\d+)/.exec(msg);
      const line = m ? `第 ${m[1]} 行: ` : '';
      const s = /(SyntaxError|ReferenceError|TypeError):\s*(.*)/.exec(msg);
      resolve(`${line}${s ? s[2] : msg.slice(0, 150)}`);
    });
    p.stdin && p.stdin.end(code);
  });
}

function lightSyntaxCheck(code, allowUnclosedBrackets = false) {
  const stack = [];
  let i = 0, n = code.length, line = 1;
  let inLine = false, inBlock = false, quote = null, quoteStartLine = 1;
  while (i < n) {
    const c = code[i], nxt = i + 1 < n ? code[i + 1] : '\0';
    if (inLine) { if (c === '\n') inLine = false; }
    else if (inBlock) { if (c === '*' && nxt === '/') { inBlock = false; i++; } }
    else if (quote !== null) {
      if (c === '\\') i++;
      else if (quote === '`' && c === '$' && nxt === '{') {
        let depth = 1; i += 2;
        while (i < n && depth > 0) { if (code[i] === '{') depth++; else if (code[i] === '}') depth--; i++; }
        i--;
      } else if (c === quote) quote = null;
    }
    else if (c === '/' && nxt === '/') inLine = true;
    else if (c === '/' && nxt === '*') inBlock = true;
    else if (c === "'" || c === '"' || c === '`') { quote = c; quoteStartLine = line; }
    else if (c === '/' && isRegexStart(code, i)) {
      i++; let inClass = false;
      while (i < n) {
        const rc = code[i];
        if (rc === '\\') i++;
        else if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) { i++; break; }
        i++;
      }
    }
    else if (c === '(' || c === '[' || c === '{') stack.push([c, line]);
    else if (c === ')' || c === ']' || c === '}') {
      const open = stack.pop();
      if (!open) { if (!allowUnclosedBrackets) return `多余的闭合符号 '${c}'（第 ${line} 行）`; }
      else if (!((open[0] === '(' && c === ')') || (open[0] === '[' && c === ']') || (open[0] === '{' && c === '}'))) {
        if (!allowUnclosedBrackets) return `括号不匹配: '${open[0]}'（第 ${open[1]} 行开）与 '${c}'（第 ${line} 行）`;
      }
    }
    if (c === '\n') line++;
    i++;
  }
  if (quote !== null) return `存在未闭合的字符串引号（${quote}，从第 ${quoteStartLine} 行开始）`;
  if (!allowUnclosedBrackets && stack.length) {
    return `存在未闭合的括号（剩余 ${stack.length} 个: ${stack.map(s => `'${s[0]}'（第 ${s[1]} 行开）`).join('、')}）`;
  }
  return null;
}

async function verifyJs(code, allowUnclosedBrackets = false) {
  const light = lightSyntaxCheck(code, allowUnclosedBrackets);
  if (light) return light;
  if (allowUnclosedBrackets) return null;
  // vm.Script 不支持 ESM（import/export）与顶层 await → 退回 node --check --input-type=module
  if (/\bimport\s*[({"']|\bimport\s+[\w"']|\bexport\s+/.test(code) || /(^|\n)\s*await\s+/.test(code)) {
    return verifyJsSyntaxEsm(code);
  }
  return verifyJsSyntax(code);
}

async function verifyInlineScripts(html, allowUnclosedBrackets = false) {
  const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const code = m[1];
    if (!code.trim()) continue;
    const err = await verifyJs(code, allowUnclosedBrackets);
    if (err) return `内嵌 <script> 语法错误: ${err}`;
  }
  return null;
}

// ==================== 标识符检查 ====================

// 复用 translator_helpers 的 isForeign / isIdentChar / isRegexStart / extractForeignIdentifiers

// ==================== 工具 ====================

function stripMarkdownFence(text) {
  let t = text.trim();
  if (t.startsWith('```')) {
    const lf = t.indexOf('\n');
    t = lf > 0 ? t.slice(lf + 1) : t.slice(3);
    if (t.endsWith('```')) t = t.slice(0, -3);
    t = t.trim();
  }
  return t;
}

function looksLikeCode(text) {
  const t = text.trim();
  if (!t) return false;
  return /[({;=]/.test(t) || /\b(function|var|let|const|return|class|if|for|while|import|export)\b/.test(t);
}

function findLineOf(code, token) {
  let line = 1;
  for (const l of code.split('\n')) { if (l.includes(token)) return line; line++; }
  return 1;
}

function extractErrorLine(err) {
  const m = /第\s*(\d+)\s*行|#(\d+)|\bline\s+(\d+)|\((\d+):\d+\)/.exec(err);
  if (!m) return null;
  for (let g = 1; g <= 4; g++) if (m[g]) return parseInt(m[g], 10);
  return null;
}

function parseJsonArray(text) {
  const t = text.trim();
  const start = t.indexOf('['), end = t.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* 继续 */ }
  }
  return [...t.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
}

// ==================== 翻译编排 ====================

async function translate(opts) {
  const { text, type, targetLang, client, onProgress = () => {}, onRetry = () => {}, onSkip = () => {},
          previousErrors = null, filePath = null, signal = null } = opts;
  const memoryCtx = FailureMemory.contextFor(filePath || '');
  const chunks = text.length <= SINGLE_FILE_LIMIT ? [text] : splitChunks(text);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal && signal.aborted) throw new Error('翻译已取消（超时）');
    const translated = await translateChunkWithRetry({
      chunk: chunks[i], type, targetLang, client, onRetry, onSkip,
      previousErrors, memoryCtx, signal,
    });
    parts.push(translated);
    onProgress(i + 1, chunks.length); // 段完成后再报进度（避免"1/N"虚报）
    if (!translated.endsWith('\n') && i < chunks.length - 1) parts.push('\n');
  }
  const result = parts.join('');
  let err = await verifyTranslation(text, result, type);
  if (err !== null) {
    let current = result, currentErr = err;
    for (let round = 0; round < 3; round++) {
      // ① 确定性算法修复
      const sr = StructuralRepairer.repair(text, current);
      if (sr.repaired) {
        onRetry(round * 2 + 1, `算法修复：${sr.repairs.length} 处`);
        const errS = await verifyTranslation(text, sr.fixed, type);
        if (errS === null) return sr.fixed;
        current = sr.fixed; currentErr = errS;
      }
      // ② 窗口修复（AI）
      if (currentErr === null) break;
      const windowed = await windowRepair(text, current, currentErr, type, targetLang, client, onRetry, signal);
      if (windowed !== null) {
        const errW = await verifyTranslation(text, windowed, type);
        if (errW === null) return windowed;
        current = windowed; currentErr = errW;
      } else break;
    }
    // ③ 全文件 AI 修复兜底
    const fixed = await translateChunkWithRetry({
      chunk: current, type, targetLang, client, onRetry, onSkip,
      previousErrors: currentErr, repairOriginal: text, memoryCtx, signal,
    });
    const err2 = await verifyTranslation(text, fixed, type);
    if (err2 === null) return fixed;
    onSkip(err2);
    return text;
  }
  return result;
}

async function windowRepair(original, translated, errorMsg, type, targetLang, client, onRetry, signal = null) {
  const errorLine = extractErrorLine(errorMsg);
  if (errorLine === null) return null;
  const tLines = translated.split('\n');
  const oLines = original.split('\n');
  const tTotal = tLines.length;
  if (tTotal < 20) return null;
  let half = 40;
  for (let attempt = 1; attempt <= 3; attempt++) {
    onRetry(attempt, errorMsg);
    const start = Math.max(errorLine - half, 1);
    const end = Math.min(errorLine + half, tTotal);
    const winSize = end - start + 1;
    if (winSize > tTotal * 3 / 5) return null;
    const ratio = oLines.length / tTotal;
    const oStart = Math.max(Math.floor(start * ratio) - 20, 1);
    const oEnd = Math.min(Math.floor(end * ratio) + 20, oLines.length);
    const tWin = tLines.slice(start - 1, end).join('\n');
    const oWin = oLines.slice(oStart - 1, oEnd).join('\n');
    const errInWin = `第 ${errorLine - start + 1} 行附近`;
    const system = `你是 JavaScript 修复专家。下面给出同一段代码的【原文片段】和【翻译片段】。
【翻译片段】存在语法错误：${errorMsg}（错误位于本片段${errInWin}）。

请对照【原文片段】逐字符检查【翻译片段】，只修复导致语法错误的位置（多余的括号、缺失的闭合引号、错配的括号类型、被翻译的标识符等）。
要求：严禁重写整个片段；严禁改动与错误无关的代码和已翻译的文案；只输出修复后的【翻译片段】这一小段代码，不要输出整个文件、不要任何解释、不要 markdown 代码块包裹。`;
    const user = `【原文片段】\n${oWin}\n\n【翻译片段】\n${tWin}`;
    const raw = await client.chat(system, user, { signal });
    const fixedWin = stripMarkdownFence(raw).replace(/\n+$/, '').replace(/^\n+/, '');
    if (!looksLikeCode(fixedWin)) { half = Math.floor(half * 1.5); continue; }
    let newLines = fixedWin.split('\n');
    while (newLines.length && !newLines[0].trim()) newLines.shift();
    while (newLines.length && !newLines[newLines.length - 1].trim()) newLines.pop();
    if (!newLines.length) { half = Math.floor(half * 1.5); continue; }
    const merged = [...tLines];
    if (newLines.length === winSize) {
      for (let k = 0; k < winSize; k++) merged[start - 1 + k] = newLines[k];
    } else {
      merged.splice(start - 1, end - start + 1, ...newLines);
    }
    const candidate = merged.join('\n');
    const err2 = await verifyTranslation(original, candidate, type);
    if (err2 === null) return candidate;
    half = Math.floor(half * 1.5);
  }
  return null;
}

async function translateChunkWithRetry(opts) {
  const { chunk, type, targetLang, client, onRetry, onSkip, previousErrors = null,
          repairOriginal = null, memoryCtx = '', signal = null } = opts;
  let lastError = null;
  const memNote = memoryCtx ? `\n\n${memoryCtx}` : '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let system;
    if (repairOriginal !== null) {
      onRetry(attempt + 1, lastError || previousErrors || '未知错误');
      system = `你是一个 JavaScript 修复专家。下面是同一段代码的【完整原文文件】和【当前翻译结果】。
【当前翻译结果】存在语法错误，错误信息如下：
${lastError || previousErrors}

请仔细查看【完整原文文件】的内容，对照【完整原文文件】逐字符检查【当前翻译结果】，只修复导致语法错误的位置（多余的括号、缺失的闭合引号、错配的括号类型等）。
要求：严禁重写整个文件；严禁改动与错误无关的代码和已翻译的文案；代码结构必须与原文完全一致，一个字符都不许多、不许少。
只输出修复后的完整 JavaScript 代码，不要任何解释、不要 markdown 代码块包裹。${memNote}`;
    } else if (attempt === 0 && previousErrors) {
      system = buildSystemPrompt(type, targetLang) +
        `\n\n【上次翻译失败原因】你上一次翻译这个文件时出现了以下问题，本次必须针对这些问题修复，避免重犯：\n${previousErrors}${memNote}`;
    } else if (attempt === 0) {
      system = buildSystemPrompt(type, targetLang) + memNote;
    } else {
      onRetry(attempt, lastError || '未知错误');
      system = buildSystemPrompt(type, targetLang) +
        `\n\n上一版翻译结果未能通过 JavaScript 语法校验。请务必在保持代码语法完全正确、可直接运行的前提下重新翻译这一段，修复以下错误，输出修复后的完整代码（不要解释、不要 markdown 包裹）：\n${lastError}` +
        `\n\n注意：严禁为了「修复」而补全或删除代码中的大括号 {}、圆括号 ()，代码结构必须与原文完全一致，一个字符都不许多、不许少；只修改被指出错误的地方。${memNote}`;
    }
    const userContent = repairOriginal !== null
      ? `【完整原文文件】\n${repairOriginal}\n\n【当前翻译结果】\n${chunk}`
      : chunk;
    const raw = await client.chat(system, userContent, { signal });
    const translated = stripMarkdownFence(raw);
    if (type === FileType.JS && !looksLikeCode(translated)) {
      lastError = repairOriginal !== null
        ? '修复失败：模型未输出代码，已保留原文'
        : 'AI 判定无需翻译：模型未输出代码（可能没有可翻译的界面文案），保留原文';
      continue;
    }
    const err = await verifyTranslation(chunk, translated, type, true);
    if (err === null) return translated;
    const sr = StructuralRepairer.repair(chunk, translated);
    if (sr.repaired) {
      const errS = await verifyTranslation(chunk, sr.fixed, type, true);
      if (errS === null) return sr.fixed;
    }
    lastError = err;
  }
  onSkip(lastError || '未知错误');
  return chunk;
}

async function verifyTranslation(original, translated, type, allowUnclosedBrackets = false) {
  if (!allowUnclosedBrackets) {
    const oLines = original.split('\n').length;
    const tLines = translated.split('\n').length;
    if (tLines < Math.floor(oLines * 7 / 10)) {
      return `译文不完整（${tLines} 行 < 原文 ${oLines} 行），疑似输出被截断，请重新翻译`;
    }
    if (type === FileType.JS || type === FileType.HTML) {
      const oLastLines = original.trimEnd().split('\n').filter(l => l.trim());
      const oLast = oLastLines.length ? oLastLines[oLastLines.length - 1].trim() : null;
      const isCodeTail = oLast && oLast.length > 0 && '});,]'.includes(oLast[oLast.length - 1]) &&
        !oLast.includes('"') && !oLast.includes("'") && !oLast.includes('`');
      if (isCodeTail) {
        const tLast3 = translated.trimEnd().split('\n').filter(l => l.trim()).slice(-3).map(l => l.trim());
        if (!tLast3.includes(oLast)) return '译文不完整（结尾不符），疑似输出被截断，请重新翻译';
      }
    }
  }
  let syntaxErr = null;
  if (type === FileType.JS) syntaxErr = await verifyJs(translated, allowUnclosedBrackets);
  else if (type === FileType.HTML) syntaxErr = await verifyInlineScripts(translated, allowUnclosedBrackets);
  if (syntaxErr) return syntaxErr;

  let origIds = new Set(), transIds = new Set();
  if (type === FileType.JS) {
    origIds = extractForeignIdentifiers(original);
    transIds = extractForeignIdentifiers(translated);
  } else if (type === FileType.HTML) {
    const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(original)) !== null) for (const id of extractForeignIdentifiers(m[1])) origIds.add(id);
    while ((m = re.exec(translated)) !== null) for (const id of extractForeignIdentifiers(m[1])) transIds.add(id);
  }
  for (const id of transIds) {
    if (!origIds.has(id)) {
      return `发现被翻译的标识符: ${id}（第 ${findLineOf(translated, id)} 行）（函数名/方法名/变量名必须保持原文，严禁翻译！请恢复为原文标识符后重新输出）`;
    }
  }
  return null;
}

// 延迟引用（避免循环依赖）
const LANGS = ['简体中文', '繁体中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский', 'Português'];

module.exports = {
  FileType, detectType, splitChunks, bracketDelta, buildSystemPrompt, translate,
  verifyJs, verifyJsSyntax, verifyJsSyntaxEsm, verifyInlineScripts, lightSyntaxCheck,
  extractForeignIdentifiers, stripMarkdownFence, looksLikeCode, extractErrorLine, parseJsonArray,
  LANGS,
};
