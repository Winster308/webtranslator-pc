'use strict';
/** 极简内存缓存：减少重复 API 调用（GitHub 匿名配额有限）。 */

const store = new Map(); // key -> { time, data }

function cacheGet(key, ttlMs) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > ttlMs) {
    store.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  store.set(key, { time: Date.now(), data });
  // 防内存膨胀：超过 200 条时清理最旧的
  if (store.size > 200) {
    const oldest = [...store.entries()].sort((a, b) => a[1].time - b[1].time)[0];
    if (oldest) store.delete(oldest[0]);
  }
}

function cacheClear(keyPrefix) {
  if (!keyPrefix) { store.clear(); return; }
  for (const k of [...store.keys()]) {
    if (k.startsWith(keyPrefix)) store.delete(k);
  }
}

function cacheSize() { return store.size; }

module.exports = { cacheGet, cacheSet, cacheClear, cacheSize };
