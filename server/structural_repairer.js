'use strict';
/**
 * 确定性结构修复器 —— 移植自 StructuralRepairer.kt：
 * 1. 多余的闭合括号 → 删除（或对照原文补开启）
 * 2. 未闭合/错配的括号 → 对照原文补全/修正类型
 * 3. 未闭合的字符串引号 → 对照原文补闭合引号
 * 4. 被翻译的标识符 → 上下文 token 匹配还原回原文英文标识符
 */
const { extractForeignIdentifiers, isRegexStart } = require('./translator_helpers');

class StructuralRepairer {
  static repair(original, translated) {
    const repairs = [];
    let current = translated;

    const q = this._fixQuotes(original, current);
    if (q) { current = q[0]; repairs.push(...q[1]); }
    const b = this._fixBrackets(original, current);
    if (b) { current = b[0]; repairs.push(...b[1]); }
    const id = this._restoreIdentifiers(original, current);
    if (id) { current = id[0]; repairs.push(...id[1]); }

    return { fixed: current, repairs, repaired: repairs.length > 0 };
  }

  /** 扫描代码，返回 [brackets, unclosedQuote]。bracket = {c, offset, line}。 */
  static _scan(code) {
    const brackets = [];
    let unclosed = null;
    let i = 0, n = code.length, line = 1;
    let inLine = false, inBlock = false, quote = null, quoteStart = 0;
    while (i < n) {
      const c = code[i], nxt = i + 1 < n ? code[i + 1] : '\0';
      if (inLine) { if (c === '\n') { inLine = false; line++; } }
      else if (inBlock) {
        if (c === '*' && nxt === '/') { inBlock = false; i++; }
        else if (c === '\n') line++;
      }
      else if (quote !== null) {
        if (c === '\\') i++;
        else if (quote === '`' && c === '$' && nxt === '{') {
          let d = 1; i += 2;
          while (i < n && d > 0) { if (code[i] === '{') d++; else if (code[i] === '}') d--; i++; }
          i--;
        } else if (c === quote) quote = null;
        else if (c === '\n') line++;
      }
      else if (c === '/' && nxt === '/') inLine = true;
      else if (c === '/' && nxt === '*') inBlock = true;
      else if (c === "'" || c === '"' || c === '`') { quote = c; quoteStart = i; }
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
      else if ('()[]{}'.includes(c)) brackets.push({ c, offset: i, line });
      else if (c === '\n') line++;
      i++;
    }
    if (quote !== null) unclosed = { c: quote, offset: quoteStart, line: this._lineOfOffset(code, quoteStart) };
    return [brackets, unclosed];
  }

  // ==================== 工具 ====================

  static _lineOfOffset(code, offset) {
    return code.slice(0, Math.min(offset, code.length - 1)).split('\n').length;
  }

  static _totalLines(code) { return code.split('\n').length; }

  static _mapLine(transLine, tTotal, oTotal) {
    if (tTotal <= 1) return 0;
    return Math.max(0, Math.min(oTotal - 1, Math.floor((transLine - 1) * oTotal / tTotal)));
  }

  static _lineStartOf(code, offset) {
    let i = offset;
    while (i > 0 && code[i - 1] !== '\n') i--;
    return i;
  }

  static _endOfLine(code, line) {
    let l = 1, i = 0;
    while (i < code.length && l < line) { if (code[i] === '\n') l++; i++; }
    let j = code.indexOf('\n', i);
    if (j === -1) j = code.length;
    while (j > i && (code[j - 1] === ' ' || code[j - 1] === '\t')) j--;
    if (j > i && (code[j - 1] === ';' || code[j - 1] === ',')) j--;
    return j;
  }

  static _matchBrackets(code) {
    const [brackets] = this._scan(code);
    const stack = [], pairs = {};
    for (const b of brackets) {
      if ('([{'.includes(b.c)) stack.push(b);
      else if (stack.length) {
        const op = stack.pop();
        if (this._matches(op.c, b.c)) pairs[op.offset] = b.offset;
      }
    }
    return pairs;
  }

  static _lineStartOfLine(lines, lineIdx) {
    let off = 0;
    for (let i = 0; i < lineIdx; i++) off += lines[i].length + 1;
    return off;
  }

  static _openerOf(c) { return { ')': '(', ']': '[', '}': '{' }[c] || c; }
  static _closerOf(c) { return { '(': ')', '[': ']', '{': '}' }[c] || c; }
  static _matches(openC, closeC) {
    return (openC === '(' && closeC === ')') || (openC === '[' && closeC === ']') || (openC === '{' && closeC === '}');
  }

  // ==================== 修复 1：括号 ====================

  static _bracketCounts(code) {
    const [brackets] = this._scan(code);
    const m = {};
    for (const b of brackets) m[b.c] = (m[b.c] || 0) + 1;
    return m;
  }

  static _findOriginalCloseLine(original, translated, openB, tBrackets, origPairs) {
    const oLines = original.split('\n');
    const tTotal = this._totalLines(translated);
    const oTotal = oLines.length;
    const oLine = this._mapLine(openB.line, tTotal, oTotal);
    let nth = 0;
    for (const b of tBrackets) {
      if (b.c === openB.c && b.line === openB.line && b.offset < openB.offset) nth++;
    }
    nth++;
    let found = 0;
    for (let ol = oLine; ol < oTotal; ol++) {
      const lineText = oLines[ol];
      for (let idx = 0; idx < lineText.length; idx++) {
        if (lineText[idx] === openB.c) {
          found++;
          if (found === nth) {
            const absOffset = this._lineStartOfLine(oLines, ol) + idx;
            const closeOff = origPairs[absOffset];
            if (closeOff !== undefined) return this._lineOfOffset(original, closeOff);
          }
        }
      }
    }
    return null;
  }

  static _fixBrackets(original, translated) {
    const [brackets] = this._scan(translated);
    if (!brackets.length) return null;
    const oCounts = this._bracketCounts(original);
    const tCounts = this._bracketCounts(translated);
    const oTotal = this._totalLines(original);
    const tTotal = this._totalLines(translated);
    const origPairs = this._matchBrackets(original);
    const ops = []; // [offset, deleteLen, insertText]
    const repairs = [];
    const stack = [];
    const insertAt = new Map(); // offset -> [closes]

    let i = 0;
    while (i < brackets.length) {
      const b = brackets[i];
      if ('([{'.includes(b.c)) { stack.push(b); i++; }
      else {
        if (!stack.length) {
          const tCnt = tCounts[b.c] || 0, oCnt = oCounts[b.c] || 0;
          if (tCnt > oCnt) { ops.push([b.offset, 1, '']); repairs.push(`删除多余的 '${b.c}'（第 ${b.line} 行）`); }
          else { ops.push([b.offset, 0, this._openerOf(b.c)]); repairs.push(`第 ${b.line} 行前补 '${this._openerOf(b.c)}'`); }
          i++;
        } else if (this._matches(stack[stack.length - 1].c, b.c)) { stack.pop(); i++; }
        else {
          const op = stack[stack.length - 1];
          const closeLineNo = this._findOriginalCloseLine(original, translated, op, brackets, origPairs);
          if (closeLineNo !== null) {
            const targetLine = Math.max(1, Math.min(tTotal, this._mapLine(closeLineNo, oTotal, tTotal) + 1));
            if (targetLine < b.line) {
              const lineEnd = this._endOfLine(translated, targetLine);
              if (!insertAt.has(lineEnd)) insertAt.set(lineEnd, []);
              insertAt.get(lineEnd).push(this._closerOf(op.c));
              repairs.push(`第 ${targetLine} 行行尾补 '${this._closerOf(op.c)}'（'${op.c}' 第 ${op.line} 行缺配对）`);
              stack.pop();
            } else {
              ops.push([b.offset, 1, '']);
              repairs.push(`删除多余的 '${b.c}'（第 ${b.line} 行，'${op.c}' 第 ${op.line} 行配对在后）`);
              i++;
            }
          } else {
            ops.push([b.offset, 1, '']);
            repairs.push(`删除错配的 '${b.c}'（第 ${b.line} 行）`);
            i++;
          }
        }
      }
    }

    if (stack.length) {
      const oLines = original.split('\n');
      const oTotal2 = oLines.length;
      const tTotal2 = translated.split('\n').length;
      const truncated = Math.abs(tTotal2 - oTotal2) > oTotal2 * 0.2;
      for (const op of [...stack].reverse()) {
        const closeLineNo = this._findOriginalCloseLine(original, translated, op, brackets, origPairs);
        let targetLine;
        if (truncated) targetLine = tTotal2;
        else if (closeLineNo !== null) {
          const mapped = Math.max(1, Math.min(tTotal2, this._mapLine(closeLineNo, oTotal2, tTotal2) + 1));
          targetLine = mapped < op.line ? tTotal2 : mapped;
        } else targetLine = op.line;
        const lineEnd = this._endOfLine(translated, targetLine);
        if (!insertAt.has(lineEnd)) insertAt.set(lineEnd, []);
        insertAt.get(lineEnd).push(this._closerOf(op.c));
        repairs.push(`第 ${targetLine} 行行尾补 '${this._closerOf(op.c)}'（原文配对定位）`);
      }
    }

    for (const [off, closes] of insertAt) ops.push([off, 0, closes.join('')]);
    if (!ops.length) return null;

    let sb = translated;
    for (const [off, delLen, repl] of [...ops].sort((a, b) => b[0] - a[0])) {
      if (repl === '' && delLen === 0) continue;
      sb = sb.slice(0, off) + repl + sb.slice(off + delLen);
    }
    return [sb, repairs];
  }

  // ==================== 修复 2：引号 ====================

  static _fixQuotes(original, translated) {
    const [, unclosed] = this._scan(translated);
    const q = unclosed;
    if (!q) return null;
    const oTotal = this._totalLines(original);
    const tTotal = this._totalLines(translated);
    const oLine = this._mapLine(q.line, tTotal, oTotal);
    const oLines = original.split('\n');
    const oLineText = oLines[oLine] || '';
    const tLines = translated.split('\n');
    const tLineText = tLines[q.line - 1] || '';

    let insertAt = null, repairMsg = '';
    const mapEndLine = (oEnd0) => Math.max(1, Math.min(tTotal, this._mapLine(oEnd0 + 1, oTotal, tTotal) + 1));

    if (q.c === '`') {
      const backtickCount = (oLineText.match(/`/g) || []).length;
      const trimmed = oLineText.trim();
      if (backtickCount >= 2) {
        if (tLineText.trimEnd().endsWith('`')) return null;
        if (tLineText) { insertAt = this._lineStartOf(translated, q.offset) + tLineText.length; repairMsg = `第 ${q.line} 行末尾补 '` + '`' + `'（对照原文）`; }
      } else if (backtickCount === 1 && trimmed.endsWith('`')) {
        let oEnd = -1;
        for (let ol = oLine + 1; ol < oLines.length; ol++) if (oLines[ol].includes('`')) { oEnd = ol; break; }
        if (oEnd >= 0) { const te = mapEndLine(oEnd); insertAt = this._endOfLine(translated, te); repairMsg = `第 ${te} 行行尾补 '` + '`' + `'（原文模板字符串结束于第 ${oEnd + 1} 行）`; }
        else if (tLineText) { insertAt = this._lineStartOf(translated, q.offset) + tLineText.length; repairMsg = `第 ${q.line} 行末尾补 '` + '`' + `'（原文映射行为模板结束行）`; }
      } else {
        let oEnd = -1;
        for (let ol = oLine + 1; ol < oLines.length; ol++) if (oLines[ol].includes('`')) { oEnd = ol; break; }
        if (oEnd >= 0) { const te = mapEndLine(oEnd); insertAt = this._endOfLine(translated, te); repairMsg = `第 ${te} 行行尾补 '` + '`' + `'（原文模板字符串结束于第 ${oEnd + 1} 行）`; }
      }
      if (insertAt === null) { insertAt = translated.length; repairMsg = `末尾补 '` + '`' + `'（未闭合模板字符串起始于第 ${q.line} 行）`; }
    } else {
      if ((tLineText.match(new RegExp(q.c, 'g')) || []).length >= 2) return null;
      let stripped = tLineText.trimEnd();
      if (stripped.endsWith(';') || stripped.endsWith(',')) stripped = stripped.slice(0, -1).trimEnd();
      if (stripped && stripped[stripped.length - 1] === q.c) {
        let lastIdent = -1;
        for (const m of tLineText.matchAll(/[A-Za-z_$][\w$]*/g)) lastIdent = m.index;
        if (lastIdent >= 0) { insertAt = this._lineStartOf(translated, q.offset) + lastIdent; repairMsg = `第 ${q.line} 行 '${q.c}' 前补 '${q.c}'（缺开引号）`; }
        else { insertAt = this._endOfLine(translated, q.line); repairMsg = `第 ${q.line} 行行尾补 '${q.c}'`; }
      } else { insertAt = this._endOfLine(translated, q.line); repairMsg = `第 ${q.line} 行行尾补 '${q.c}'`; }
    }

    let sb = translated;
    if (insertAt <= sb.length) sb = sb.slice(0, insertAt) + q.c + sb.slice(insertAt);
    else sb = sb + q.c;
    return [sb, [repairMsg]];
  }

  // ==================== 修复 3：标识符还原 ====================

  static _restoreIdentifiers(original, translated) {
    const transIds = extractForeignIdentifiers(translated);
    const origIds = extractForeignIdentifiers(original);
    const newIds = [...transIds].filter(id => !origIds.has(id));
    if (!newIds.length) return null;

    const oTotal = this._totalLines(original);
    const tTotal = this._totalLines(translated);
    const spans = this._codeIdentifierSpans(translated);
    const ops = [], repairs = [];
    const applied = new Set();

    for (const ident of newIds) {
      for (const [s, e] of spans) {
        if (e - s !== ident.length || translated.slice(s, e) !== ident) continue;
        if (applied.has(s + ':' + e)) continue;
        applied.add(s + ':' + e);
        const line = this._lineOfOffset(translated, s);
        const oLine = this._mapLine(line, tTotal, oTotal);
        const oLineText = (original.split('\n')[oLine]) || '';
        const prev = this._prevToken(translated, s);
        const nxt = this._nextToken(translated, e);
        let en = null;
        const pat = new RegExp(this._esc(prev) + '\\s*([A-Za-z_$][\\w$]*)\\s*' + this._esc(nxt));
        let m = pat.exec(original);
        if (!m && prev) {
          const loose = new RegExp(this._esc(prev) + '\\s*([A-Za-z_$][\\w$]*)');
          m = loose.exec(original);
        }
        if (m) en = m[1];
        else if (oLineText.trim()) { const m2 = /([A-Za-z_$][\w$]*)/.exec(oLineText); if (m2) en = m2[1]; }
        if (en && en !== ident) { ops.push([s, e, en]); repairs.push(`还原标识符 '${ident}' → '${en}'（第 ${line} 行）`); }
      }
    }

    if (!ops.length) return null;
    let sb = translated;
    for (const [s, e, repl] of [...ops].sort((a, b) => b[0] - a[0])) sb = sb.slice(0, s) + repl + sb.slice(e);
    return [sb, repairs];
  }

  static _esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  static _codeIdentifierSpans(code) {
    const spans = [];
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
      else if (/[A-Za-z0-9_$]/.test(c) || isForeign(c)) {
        const start = i;
        while (i < n && (/[A-Za-z0-9_$]/.test(code[i]) || isForeign(code[i]))) i++;
        spans.push([start, i]);
        continue;
      }
      i++;
    }
    const bk = /(?<=[\w$)\]])\s*\[\s*(['"])([^'"]+)\1\s*\]/g;
    let m;
    while ((m = bk.exec(code)) !== null) { const start = code.indexOf(m[2], m.index); if (start >= 0) spans.push([start, start + m[2].length]); }
    const qk = /(?<=[{,])\s*(['"])([^'"]+)\1\s*:/g;
    while ((m = qk.exec(code)) !== null) { const start = code.indexOf(m[2], m.index); if (start >= 0) spans.push([start, start + m[2].length]); }
    return spans;
  }

  static _prevToken(code, offset) {
    let i = offset - 1;
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (i < 0) return '';
    const c = code[i];
    if (/[A-Za-z0-9_$]/.test(c)) {
      let s = i;
      while (s >= 0 && /[A-Za-z0-9_$]/.test(code[s])) s--;
      return code.slice(s + 1, i + 1);
    }
    return c;
  }

  static _nextToken(code, offset) {
    let i = offset;
    const n = code.length;
    while (i < n && /\s/.test(code[i])) i++;
    if (i >= n) return '';
    const c = code[i];
    if (/[A-Za-z0-9_$]/.test(c)) {
      let e = i;
      while (e < n && /[A-Za-z0-9_$]/.test(code[e])) e++;
      return code.slice(i, e);
    }
    return c;
  }
}

module.exports = StructuralRepairer;
