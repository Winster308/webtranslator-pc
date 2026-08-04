'use strict';
/**
 * 系统代理自动适配：
 * 读取 Windows 系统代理（注册表 Internet Settings）→ 配置 Node 全局 fetch 走代理。
 * 解决"浏览器能打开 GitHub、应用却一直网络错误"的问题（Node 默认不走系统代理）。
 * 本地地址（127.0.0.1/localhost）经 NO_PROXY 自动绕过，不影响本地服务。
 */
const { execSync } = require('child_process');

/** 读取系统代理服务器地址；未启用代理返回 null。 */
function readSystemProxy() {
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD',
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    const enable = /0x([0-9a-fA-F]+)/.exec(out);
    if (!enable || parseInt(enable[1], 16) === 0) return null;
    const out2 = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ',
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    const m = /REG_SZ\s+(\S+)/.exec(out2);
    return m ? m[1].trim() : null;
  } catch (e) {
    return null;
  }
}

/** 启用代理（进程全局生效）。manualProxy 优先，其次系统代理。返回是否启用成功。 */
function setupProxy(manualProxy = '') {
  let proxy = String(manualProxy || '').trim();
  if (proxy) {
    // 手动代理：确保带协议前缀（支持 http/https/socks5）
    if (!/^https?:\/\/|^socks5?:\/\//i.test(proxy)) proxy = `http://${proxy}`;
    return applyProxy(proxy, '手动代理');
  }
  // 手动代理为空 → 回退系统代理；系统也未开代理 → 清除残留配置
  const sys = readSystemProxy();
  if (sys) return applyProxy(sys, '系统代理');
  return clearProxy();
}

function applyProxy(server, label) {
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
    process.env.HTTP_PROXY = server;
    process.env.HTTPS_PROXY = server;
    // 本地地址必须绕过代理，否则本地 API 也会走代理导致挂起
    const noProxy = [process.env.NO_PROXY, '127.0.0.1', 'localhost', '::1']
      .filter(Boolean).join(',');
    process.env.NO_PROXY = noProxy;
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log(`[proxy] 已启用${label}: ${server}`);
    return true;
  } catch (e) {
    console.warn('[proxy] 代理配置失败: ' + e.message);
    return false;
  }
}

function clearProxy() {
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log('[proxy] 已清除代理配置');
    return true;
  } catch (e) {
    console.warn('[proxy] 清除代理失败: ' + e.message);
    return false;
  }
}

module.exports = { setupProxy, readSystemProxy };
