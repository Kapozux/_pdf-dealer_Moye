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
