'use strict';
/**
 * DeepSeek Chat Completions API 客户端（Node 内置 fetch）。
 * 自动重试（指数退避，最多 3 次）、max_tokens 超限降级（16384 → 8192）、网络异常友好提示。
 */
const RETRY_TIMES = 3;
const RETRY_BASE_DELAY_MS = 1200;

class DeepSeekError extends Error {}

class DeepSeekClient {
  constructor(apiKey, model, baseUrl = 'https://api.deepseek.com', opts = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.3;
    this.maxOutputTokens = opts.maxTokens || 16384; // 绝不能为 null：不传 = API 默认 8192，长译文会被截断
  }

  async chat(system, user, opts = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= RETRY_TIMES; attempt++) {
      try {
        return await this._chatOnce(system, user, opts.signal);
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || e);
        if ((msg.includes('max_tokens') || msg.includes('Maximum length')) && this.maxOutputTokens !== 8192) {
          this.maxOutputTokens = 8192;
          continue;
        }
        if (!this._isRetryable(e) || attempt === RETRY_TIMES) break;
        await new Promise(r => setTimeout(r, RETRY_BASE_DELAY_MS * (1 << (attempt - 1))));
      }
    }
    throw this._friendlyNetworkError(lastErr);
  }

  _isRetryable(e) {
    const msg = String(e.message || e);
    if (msg.includes('HTTP 429') || msg.includes('HTTP 5')) return true;
    if (msg.includes('不是有效 JSON')) return true; // 网关/代理篡改响应，重试一次可能恢复
    return e instanceof TypeError || e instanceof Error && /fetch|network|ECONN|ENOTFOUND|ETIMEDOUT/i.test(msg);
  }

  _friendlyNetworkError(e) {
    if (!e) return new DeepSeekError('未知错误');
    const msg = String(e.message || e);
    if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
      return new DeepSeekError('无法连接 DeepSeek 服务器：DNS 解析失败（网络未连接、DNS 异常或代理/VPN 拦截）。请检查网络后重试');
    }
    if (/ETIMEDOUT|timeout/i.test(msg)) {
      return new DeepSeekError('连接 DeepSeek 服务器超时，请检查网络后重试');
    }
    if (/ECONNREFUSED|fetch failed/i.test(msg)) {
      return new DeepSeekError('无法连接 DeepSeek 服务器（连接被拒绝），请检查网络/防火墙后重试');
    }
    if (msg.includes('HTTP 429')) return new DeepSeekError('DeepSeek API 请求过于频繁（限流），请稍后重试');
    if (msg.startsWith('API 错误')) return new DeepSeekError(msg);
    return new DeepSeekError(`网络错误: ${msg}`);
  }

  async _chatOnce(system, user, externalSignal = null) {
    const body = {
      model: this.model,
      temperature: this.temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: this.maxOutputTokens,
    };
    // 合并超时与外部取消信号（AbortSignal.any 需 Node 20+，手动组合保证 Node 18 兼容）
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), 300000);
    const onExternalAbort = () => ctrl.abort(externalSignal.reason || new Error('请求已取消'));
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort(externalSignal.reason || new Error('请求已取消'));
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let resp;
    try {
      resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (externalSignal && externalSignal.aborted) throw new DeepSeekError('翻译已取消（超时）');
      throw e; // 网络层异常交给 chat() 统一处理
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
    const raw = await resp.text();
    if (!resp.ok) {
      let reason = raw.slice(0, 300);
      try { reason = JSON.parse(raw).error?.message || reason; } catch (e) { /* 保留原文 */ }
      throw new DeepSeekError(`API 错误 (HTTP ${resp.status}): ${reason}`);
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new DeepSeekError(`响应不是有效 JSON（HTTP ${resp.status}，可能被代理/VPN 网关拦截）: ${raw.slice(0, 120)}`);
    }
    return (obj.choices?.[0]?.message?.content || '').trim();
  }
}

module.exports = { DeepSeekClient, DeepSeekError };
