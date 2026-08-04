'use strict';
/** 翻译失败记忆：记住每个文件的历史失败原因，下次翻译自动关联进提示词（纯内存）。 */
const MAX_PER_PATH = 5;
const MAX_OTHERS = 8;
const history = new Map(); // path -> [reasons]

function remember(path, reason) {
  if (!history.has(path)) history.set(path, []);
  const list = history.get(path);
  if (list[list.length - 1] !== reason) list.push(reason);
  while (list.length > MAX_PER_PATH) list.shift();
}

function clear() { history.clear(); }

function size() {
  let n = 0;
  for (const v of history.values()) n += v.length;
  return n;
}

function contextFor(path) {
  const sb = [];
  const own = history.get(path);
  if (own && own.length) {
    sb.push(`【该文件的历史翻译失败记录】此文件之前翻译失败过 ${own.length} 次，错误如下，本次翻译必须全部避免，绝不能再犯：`);
    own.forEach((r, i) => sb.push(`  ${i + 1}. ${r}`));
  }
  const others = [];
  for (const [k, v] of history) if (k !== path) others.push(...v);
  others.splice(0, others.length - MAX_OTHERS); // 只保留最近的 MAX_OTHERS 条，防止提示词无限膨胀
  if (others.length) {
    sb.push('【其他文件的历史失败案例（同类错误参考，也必须避免）】');
    others.forEach(o => sb.push(`  • ${o}`));
  }
  return sb.join('\n');
}

module.exports = { remember, clear, size, contextFor };
