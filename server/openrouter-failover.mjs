/**
 * OpenRouter 的兜底链：外层换模型，内层换供应商。从 local-ocr-server.mjs 搬出来，
 * 「总耗时不超预算」「没轮到的不算模型失败」这些规则以前只能靠线上实测，现在有测试。
 * 真正的调用和熔断记账从外面注入；这里只管顺序和预算。
 *
 * 顺序：第 0 次不钉死供应商，把整个白名单交给 OpenRouter 自己挑；它挑的那家失败了，
 * 才按白名单顺序逐家钉死重试，**不做轮转**。实测五家速度差 4 倍（CoreWeave p50 12s、
 * Baidu 41s、Cloudflare 51s），轮转把 80% 的请求发给了慢的四家，平均每页 236 秒；
 * 交给 OpenRouter 挑时 32 路里 31 个落在最快的 CoreWeave，p50 3.3s、2.17 页/秒。
 *
 * 预算：整页一份总预算。每家的单次超时 = min(单次上限, 剩余)，剩余不到 minTryMs 就不再开新的一家——
 * 以前每家都拿一份全新的「单次上限 + 2s」，补救轮名义 27 秒、实际能跑到 52 秒以上。
 *
 * 熔断：一个模型至少有两条线路真的试过、全部失败，才记它一次失败。预算用完一家都没轮到的不算
 * （以前也照记），补救轮只来得及试一家的也不算（一次超时说明不了模型挂了）。
 *
 * 账号级错误立刻停：401（Key 无效）、402（余额不足）是整个 OpenRouter 账号的问题，换供应商、
 * 换模型都一样被拒。以前照样把所有供应商 × 所有模型试一遍，白烧一页的预算，还把模型记成熔断。
 * 403 不在里面：OpenRouter 的 403 多是某个模型的内容审核拦截，换模型可能就过了。
 */

/** 换家、换模型都没用的错误（错误上的 status 由 postWithRetries 带上）。 */
export const isAccountError = (error) => error?.status === 401 || error?.status === 402;

/**
 * @template T
 * @param {object} o
 * @param {string[]} o.models  按优先级的模型链（第一个是设置里选的）
 * @param {string[]} o.providers  供应商白名单（按速度排好）
 * @param {number} o.perTryMs  单次调用的超时上限
 * @param {number} o.budgetMs  这一页的总预算
 * @param {number} [o.minTryMs]  剩余预算不到这么多就不再开新的一家
 * @param {(attempt: { model: string, pinned: string | null, timeoutMs: number, deadline: number }) => Promise<T>} o.call
 * @param {{ isDown: (model: string) => boolean, success: (model: string) => void, failure: (model: string) => void }} o.health
 * @param {(model: string, pinned: string | null, error: unknown) => void} [o.log]
 * @param {() => number} [o.now]  测试注入假时钟
 * @param {(error: unknown) => boolean} [o.isFatal]  遇到这种错误整条链立刻停
 * @returns {Promise<{ result: T, model: string }>}
 */
export async function failoverChain({ models, providers, perTryMs, budgetMs, minTryMs = 3000, call, health, log = () => {}, now = Date.now, isFatal = isAccountError }) {
  const overallDeadline = now() + budgetMs;
  // 已熔断的模型跳过——除非它是唯一剩下的
  const usable = models.filter((model) => !health.isDown(model));
  let lastError;
  for (const model of usable.length ? usable : models) {
    const attempts = [null, ...providers];
    let tried = 0;
    for (const pinned of attempts) {
      const remaining = overallDeadline - now();
      if (remaining < minTryMs) break;
      tried += 1;
      try {
        const result = await call({
          model,
          pinned,
          timeoutMs: Math.min(perTryMs, remaining),
          deadline: now() + Math.min(perTryMs + 2000, remaining),
        });
        health.success(model);
        return { result, model };
      } catch (error) {
        lastError = error;
        log(model, pinned, error);
        if (isFatal(error)) throw error;
      }
    }
    if (tried >= 2) health.failure(model);
    if (overallDeadline - now() < minTryMs) break;
  }
  throw lastError || new Error("OpenRouter 所有模型与供应商都失败。");
}
