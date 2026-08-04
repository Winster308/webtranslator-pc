'use strict';
/** 公共词法工具：正则开头判断、CJK 标识符检查、外来标识符提取。 */

function isForeign(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
         (cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0xAC00 && cp <= 0xD7AF);
}

function isIdentChar(c) {
  return /[A-Za-z0-9_$]/.test(c) || isForeign(c);
}

function isRegexStart(code, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (j < 0) return true;
  const prev = code[j];
  return prev !== ')' && prev !== ']' && prev !== '}' &&
    !/[A-Za-z0-9_$]/.test(prev) && prev !== "'" && prev !== '"' && prev !== '`' &&
    !'+-*/%'.includes(prev);
}

/** 扫描 JS 代码（跳过字符串/注释/正则），提取"含非 ASCII 字符的标识符"。 */
function extractForeignIdentifiers(code) {
  const out = new Set();
  const n = code.length;
  let i = 0, inLine = false, inBlock = false, quote = null;
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
    else if (c === "'" || c === '"' || c === '`') quote = c;
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
    else if (isIdentChar(c)) {
      const start = i;
      while (i < n && isIdentChar(code[i])) i++;
      const token = code.slice(start, i);
      if ([...token].some(isForeign)) out.add(token);
      continue;
    }
    i++;
  }
  const bk = /(?<=[\w$)\]])\s*\[\s*(['"])([^'"]+)\1\s*\]/g;
  let m;
  while ((m = bk.exec(code)) !== null) if ([...m[2]].some(isForeign)) out.add(m[2]);
  const qk = /(?<=[{,])\s*(['"])([^'"]+)\1\s*:/g;
  while ((m = qk.exec(code)) !== null) if ([...m[2]].some(isForeign)) out.add(m[2]);
  return out;
}

module.exports = { isForeign, isIdentChar, isRegexStart, extractForeignIdentifiers };
