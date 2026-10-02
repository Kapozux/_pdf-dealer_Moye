/**
 * 「一页最后算什么」的唯一一份定义：前端（page.tsx）、转换管线（convert.mjs）、
 * 任务表统计（jobstore.mjs）、精校路由（local-ocr-server.mjs）都从这里 import。
 *
 * 以前回退页的判定在三处各写一份（注释里互相写着「与另一份同定义」），
 * 精校页的字段在 refineOne 里四处手拼，重跑时「先整页展开再逐个删字段」，
 * 漏删的 noText / usage / modelMs 就被带进了新初稿。现在：
 *   - 判定只有 outcome()，其余都由它派生；
 *   - AI 精校结果只由 aiOk / aiNoText / aiRejected / aiFailed 构造；
 *   - 重跑用的初稿只由 toDraft() 按白名单取字段。
 *
 * 纯函数、无依赖，浏览器和 Node 都能直接跑（所以是 .mjs + JSDoc，不是 .ts）。
 */

/**
 * @typedef {{ inputTokens: number, outputTokens: number, costUsd: number | null }} PageUsage
 *
 * @typedef {object} Page
 * @property {number} page
 * @property {string} markdown
 * @property {string} [rawMarkdown]   AI 页：交给模型的那份初稿（结果页「前后对照」用）
 * @property {number} charCount
 * @property {number} lineCount
 * @property {"text"|"ocr"|"surya"|"ai"|"empty"} method
 * @property {"good"|"review"} status
 * @property {string[]} reasons
 * @property {number} [formulaCount]
 * @property {number} [optionCount]
 * @property {string[]} [uncertain]
 * @property {boolean} [aiAttempted]  这一页交给过模型（不管结果用没用上）
 * @property {boolean} [noText]       模型判定这页本来就没有可提取的文字
 * @property {string} [note]          noText 时模型说这张图是什么
 * @property {boolean} [aiFailed]     调用本身失败；只在一轮精校内部给补救轮用，交付前会删掉
 * @property {string} [model]
 * @property {string} [provider]
 * @property {number} [durationMs]
 * @property {number} [modelMs]
 * @property {PageUsage} [usage]
 *
 * @typedef {{ markdown?: string, noText?: boolean, note?: string, uncertain?: string[],
 *   model?: string, provider?: string, usage?: PageUsage }} ModelReply  refinePage 的返回值
 *
 * @typedef {"ai" | "noText" | "fallback" | "local"} Outcome
 *   ai       采用了模型结果
 *   noText   模型判定没有文字——算成功，不算回退（风景照不该记成「识别失败」）
 *   fallback 交给过模型，但最终没用模型结果（调用失败，或没过程序校验）
 *   local    没交给模型（快速 / Surya 模式，或 AI 范围外的页）
 */

/**
 * @param {Partial<Page> | null | undefined} page
 * @returns {Outcome}
 */
export function outcome(page) {
  if (page?.method === "ai") return page.noText ? "noText" : "ai";
  return page?.aiAttempted ? "fallback" : "local";
}

/** 「只重跑回退页」按钮的计数、服务端筛选、Library 的 fallback_count 都用这一个。 */
export function isFallback(/** @type {Partial<Page> | null | undefined} */ page) {
  return outcome(page) === "fallback";
}

export function countFallback(/** @type {Partial<Page>[]} */ pages) {
  return pages.filter(isFallback).length;
}

// ---- 页面内容度量（初稿和 AI 结果共用同一套口径） ----

export function countFormulas(/** @type {string} */ markdown) {
  return markdown.match(/\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$/g)?.length ?? 0;
}

export function countOptions(/** @type {string} */ markdown) {
  return markdown.match(/^\s*(?:[-*]\s*)?[A-D][.)]\s+/gim)?.length ?? 0;
}

export function visibleLength(/** @type {string} */ markdown) {
  return markdown.replace(/[#*`$|<>\\_\s]/g, "").length;
}

// ---- AI 精校结果的四种构造 ----

/** usage 只在这次调用真的带回来时才写；没有就不留这个键（不是 undefined 值）。 */
const usageOf = (/** @type {ModelReply} */ reply) => (reply.usage ? { usage: reply.usage } : {});

/** 采用模型结果。reasons 只来自模型自己标的不确定和残留的 [unclear]。 */
export function aiOk(/** @type {Page} */ draft, /** @type {ModelReply} */ reply) {
  const markdown = reply.markdown ?? "";
  const uncertain = reply.uncertain ?? [];
  const reasons = uncertain.map((item) => `模型标记不确定：${item}`);
  if (markdown.includes("[unclear]")) reasons.push("结果中仍有无法辨认的符号");
  return {
    page: draft.page,
    markdown: markdown.trim(),
    rawMarkdown: draft.markdown,
    charCount: visibleLength(markdown),
    lineCount: markdown.trim().split(/\n+/).length,
    method: /** @type {const} */ ("ai"),
    status: reasons.length ? /** @type {const} */ ("review") : /** @type {const} */ ("good"),
    reasons,
    model: reply.model,
    provider: reply.provider,
    formulaCount: countFormulas(markdown),
    optionCount: countOptions(markdown),
    uncertain,
    aiAttempted: true,
    ...usageOf(reply),
  };
}

/**
 * 「图里就是没有字」——照实记下来，不回退文字层假装识别过。
 * status 仍是 review：让它出现在结果页「需复核」清单里，用户要的正是这条提示。
 */
export function aiNoText(/** @type {Page} */ draft, /** @type {ModelReply} */ reply) {
  const note = reply.note ?? "";
  return {
    page: draft.page,
    markdown: "",
    rawMarkdown: draft.markdown,
    charCount: 0,
    lineCount: 0,
    method: /** @type {const} */ ("ai"),
    status: /** @type {const} */ ("review"),
    noText: true,
    note,
    reasons: [`AI 检测：未发现可提取的文字${note ? `（${note}）` : ""}`],
    model: reply.model,
    provider: reply.provider,
    formulaCount: 0,
    optionCount: 0,
    uncertain: [],
    aiAttempted: true,
    ...usageOf(reply),
  };
}

/** 模型回答了，但没过程序校验：保留初稿，记下没过的原因。 */
export function aiRejected(/** @type {Page} */ draft, /** @type {ModelReply} */ reply, /** @type {string[]} */ failures) {
  return {
    ...draft,
    rawMarkdown: draft.markdown,
    aiAttempted: true,
    status: /** @type {const} */ ("review"),
    reasons: [...draft.reasons, `AI 结果未通过程序校验：${failures.join("；")}`],
    model: reply.model,
    provider: reply.provider,
    ...usageOf(reply),
  };
}

/** 调用本身失败：回退初稿。aiFailed 是补救轮的筛选标记，交付前由调用方删掉。 */
export function aiFailed(/** @type {Page} */ draft, /** @type {unknown} */ error) {
  const message = /** @type {{message?: string}} */ (error)?.message ?? "未知错误";
  return {
    ...draft,
    rawMarkdown: draft.markdown,
    aiAttempted: true,
    aiFailed: true,
    status: /** @type {const} */ ("review"),
    reasons: [
      ...draft.reasons,
      draft.markdown
        ? `AI 识别失败，已回退 PDF 文字层：${message}`
        : `AI 识别失败，且此页没有文字层可回退：${message}`,
    ],
  };
}

// ---- 重跑：把上一轮的结果还原成初稿 ----

/** 上面四个构造写进 reasons 的前缀。重跑前要剥掉，否则每重跑一次就叠一条「AI 识别失败」。 */
const AI_REASON = /^(AI 识别失败|AI 结果未通过程序校验|AI 检测：|模型标记不确定：|结果中仍有无法辨认的符号)/;

/**
 * 上一轮的页结果 → 这一轮的初稿。按白名单取字段：上一轮 AI 留下的
 * noText / note / uncertain / usage / durationMs / modelMs / model / provider 一律不带。
 *
 * status 原样沿用、不按初稿重算：AI 范围不是「全部页」时，精校目标按 status === "review"
 * 筛，回退页的 AI 原因剥掉后会变成 good，重算就会把它们漏掉。
 *
 * @param {Page} page
 * @returns {Page}
 */
export function toDraft(page) {
  const markdown = page.rawMarkdown ?? page.markdown ?? "";
  return {
    page: page.page,
    markdown,
    charCount: visibleLength(markdown),
    lineCount: markdown ? markdown.split(/\n+/).length : 0,
    method: markdown ? "surya" : "empty",
    status: page.status,
    reasons: (page.reasons ?? []).filter((reason) => !AI_REASON.test(String(reason))),
    formulaCount: countFormulas(markdown),
    optionCount: countOptions(markdown),
    aiAttempted: false,
  };
}
