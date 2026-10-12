/**
 * 带超时的 fetch，超时一直覆盖到**读完响应体**。
 *
 * 以前一收到响应头就清掉计时器，之后调用方的 response.text() 不受任何超时约束：
 * 上游先回头、正文迟迟不发完时，这一页能一直挂着，30 秒的单次超时和单页总预算全部失效，
 * 还一直占着 aiGate 的名额。现在正文读完才算这次请求结束，返回的是已经读好正文的响应。
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, status: number, headers: Headers, text: () => Promise<string>, json: () => Promise<any> }>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 180000) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  } catch (error) {
    // 换成看得懂的信息：否则日志里只有一句 "This operation was aborted"
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s 未返回）。`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * 带退避的 POST（从 local-ocr-server.mjs 搬过来，为了能用测试钉住重试规则）。
 *
 * 429 单独处理：高并发下它是**常态而非异常**——实测 64 并发零 429，128 并发约
 * 10%，256 并发 60%。这类请求只是需要等一会儿再来，用固定 900ms×n 的线性退避
 * 会让一整批请求几乎同时重试、再一起被打回（惊群）。所以 429 走指数退避 + 随机
 * 抖动，并且给更多次机会；服务端给了 Retry-After 就听它的。
 *
 * 不重试的情况直接抛出：4xx（Key 错、参数错、模型不存在，重发一万次也一样）和
 * 429 超过 maxRateLimitRetries 次。以前这两处的 throw 写在 try 里，被同一个 catch
 * 接住、照样消耗普通重试次数——一把废 Key 每页白打 3 次（docs 报告 A1）。
 *
 * 抛出的错误带 `status`（上游 HTTP 状态码），上层据此判断「换家有没有用」，不用去匹配文字。
 *
 * @param {string} url
 * @param {RequestInit & { headers?: Record<string, string> }} options
 * @param {number} [attempts]
 * @param {number} [timeoutMs]
 * @param {number} [deadline]  绝对时刻；预算用完就不再开新一轮
 * @param {{ onHttpError?: (status: number, message: string) => void, maxRateLimitRetries?: number }} [hooks]
 */
export async function postWithRetries(url, options, attempts = 3, timeoutMs = undefined, deadline = Infinity, hooks = {}) {
  let lastError;
  let rateLimitRetries = 0;
  const maxRateLimitRetries = hooks.maxRateLimitRetries ?? 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // 预算用完就别再开新一轮：重试的意义是「换一次运气」，而不是把等待叠起来
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError || new Error("单页时间预算已用尽。");
    let backoff = attempt * 900;
    let response;
    let text;
    try {
      response = await fetchWithTimeout(url, options, Math.min(timeoutMs ?? 180000, remaining));
      text = await response.text();
    } catch (error) {
      // 连不上、超时：换一次运气
      lastError = error;
      if (attempt < attempts) await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
      continue;
    }
    if (response.ok) {
      // 200 但正文不是 JSON（被截断的网关页之类）：跟以前一样算一次失败、再试
      try {
        return JSON.parse(text);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
        continue;
      }
    }
    const message = (() => {
      try { return JSON.parse(text)?.error?.message || JSON.parse(text)?.error || text; } catch { return text; }
    })();
    const error = Object.assign(new Error(`模型请求失败（${response.status}）：${String(message).slice(0, 500)}`), { status: response.status });
    hooks.onHttpError?.(response.status, String(message));
    if (response.status === 429) {
      // 限流不算掉一次正式 attempt，否则并发一高就会被 3 次用光直接判失败
      rateLimitRetries += 1;
      if (rateLimitRetries > maxRateLimitRetries) throw error;
      attempt -= 1;
      const retryAfter = Number(response.headers.get("retry-after"));
      backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30000)
        : Math.min(800 * 2 ** (rateLimitRetries - 1), 20000) * (0.5 + Math.random());
      lastError = error;
      await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
      continue;
    }
    if (response.status < 500) throw error;
    lastError = error;
    if (attempt < attempts) await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
  }
  throw lastError || new Error("模型请求失败。");
}
