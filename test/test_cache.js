'use strict';
/** 缓存模块测试。 */
const { cacheGet, cacheSet, cacheClear, cacheSize } = require('../server/cache');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}  ${detail}`); }
}

console.log('== cache 基础 ==');
cacheClear();
check('初始为空', cacheSize() === 0);
cacheSet('a', { x: 1 });
check('写入后可取', JSON.stringify(cacheGet('a', 10000)) === JSON.stringify({ x: 1 }));
check('不存在的 key', cacheGet('b', 10000) === null);
cacheSet('b', 'data');
check('TTL 内命中', cacheGet('b', 10000) === 'data');
check('TTL 过期失效', cacheGet('b', -1) === null); // 负 TTL 立即过期
check('过期后被清理', cacheSize() === 1);
cacheClear('a');
check('前缀清理', cacheGet('a', 10000) === null && cacheSize() === 0);

console.log('== 大量写入清理 ==');
for (let i = 0; i < 250; i++) cacheSet(`k${i}`, i);
check('超过 200 条自动清理', cacheSize() <= 200, `size=${cacheSize()}`);
cacheClear();
check('全清', cacheSize() === 0);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
