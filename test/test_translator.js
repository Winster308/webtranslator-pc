'use strict';
const T = require('../server/translator');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}  ${detail}`); }
}

console.log('== 基础 ==');
check('detectType js', T.detectType('a.js', 'x') === T.FileType.JS);
check('detectType html 内容', T.detectType('a.txt', '<!DOCTYPE html>') === T.FileType.HTML);
check('detectType css', T.detectType('a.css', 'x') === T.FileType.CSS);

console.log('== lightSyntaxCheck ==');
check('合法通过', T.lightSyntaxCheck('function a() { return 1; }') === null);
check('缺右括号', T.lightSyntaxCheck('function a() { return 1;') !== null);
check('缺引号', T.lightSyntaxCheck('var s = "abc;') !== null);
check('字符串内括号', T.lightSyntaxCheck("var s = '(((';") === null);
check('正则字面量', T.lightSyntaxCheck('var r = /}/; var ok = 1;') === null);
check('模板字符串', T.lightSyntaxCheck('var s = `a${x}b`;') === null);
check('宽松模式', T.lightSyntaxCheck('function a() {', true) === null);

console.log('== vm / ESM 校验 ==');
check('vm 合法现代语法', T.verifyJsSyntax('const f = (a,b) => a ?? b; class A { #x = 1 }') === null);
check('vm 损坏检出', T.verifyJsSyntax('const x = ;') !== null);
(async () => {
  check('verifyJs 合法', (await T.verifyJs('const f = (a,b)=>a??b; class A{}')) === null);
  check('verifyJs ESM 合法', (await T.verifyJs('import x from "y"; export default x;')) === null);
  const esmBad = await T.verifyJs('import x from ;');
  check('verifyJs ESM 损坏', esmBad !== null, String(esmBad));
  const lineErr = await T.verifyJs('var a = 1;\nvar b = 2;\nconst x = ;');
  check('错误带行号', lineErr !== null && /第 3 行/.test(lineErr), String(lineErr));

  console.log('== 标识符提取 ==');
  const ids = T.extractForeignIdentifiers('function 中文(){} var x = 1; obj["钥匙"] = 2;');
  check('提取中文标识符', ids.has('中文') && ids.has('钥匙'), [...ids].join(','));
  const ids2 = T.extractForeignIdentifiers('var msg = "你好"; // 注释');
  check('字符串不误报', ids2.size === 0, [...ids2].join(','));

  console.log('== splitChunks ==');
  const code = Array.from({ length: 300 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n');
  const chunks = T.splitChunks(code);
  let balanced = true;
  for (const ch of chunks) { const [d] = T.bracketDelta(ch); if (d !== 0) balanced = false; }
  check('多块且配平', chunks.length >= 1 && balanced, `${chunks.length} 块`);

  console.log('== stripMarkdownFence / parseJsonArray ==');
  check('围栏剥离', T.stripMarkdownFence('```js\nvar a=1;\n```') === 'var a=1;');
  check('looksLikeCode', T.looksLikeCode('function x(){}') && !T.looksLikeCode('无需翻译'));
  const arr = T.parseJsonArray('结果是 ["a.js","b.html"] 吧');
  check('parseJsonArray', JSON.stringify(arr) === JSON.stringify(['a.js', 'b.html']));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
