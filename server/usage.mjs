/**
 * 模型用量与费用记账。
 *
 * 每次模型调用结束后记一行：谁（provider / model）、干什么（purpose）、为谁
 * （ref = 任务 id）、用了多少 token、花了多少钱。存 data/usage.db（跟 moye.db 并列），
 * 面板「用量」栏汇总，单份文档的详情页也能看到这份花了多少。
 *
 * 这份数据以前其实就在手边被扔掉了：postWithRetries 返回的是完整响应体，
 * callGemini 只取了 candidates[0]、callOpenAiCompatible 只取了 choices[0]，
 * usage 字段直接丢掉。现在四条 provider 路径在拿到响应体之后先记一笔再解析。
 *
 * 费用来源两种：
 *   - reported：OpenRouter 每次响应直接带 usage.cost（美元），照抄。
 *     前提是请求里带 usage: {include: true}，否则它只回 token 数。
 *   - table：Gemini 只返回 token 数，按下面 PRICES（美元 / 百万 token）算。
 *     价格表可被 data/prices.json 覆盖（同结构），模型涨价 / 新模型自己补，30 秒热重读。
 *   查不到价的模型（直连 Kimi / Qwen 直连，价目表是人民币且按模型分档，这里没抄）
 *   只记 token，cost 留空，界面上标「未计价」，不瞎猜。
 *
 * 调用点不知道自己在给哪份任务干活（callGemini 是通用函数），所以 ref / purpose
 * 走 AsyncLocalStorage：队列跑一份任务时 `usage.scope({ref: job.id, purpose: "refine"}, fn)`，
 * 中间任何层调 record() 都自动带上。Promise 链、fanout、setTimeout 都会继承。
 */

import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 美元 / 百万 token。tiers 按 prompt token 数分档（Gemini Pro 超 20 万 token 更贵）：
 * [[上限, 输入, 输出], ...]，最后一档上限 null。cached：命中上下文缓存的输入单价（没有则同 input）。
 * Gemini 的图片输入和文字同价（flash 系列），这里不单列。
 *
 * 只放有把握的：Gemini 这几条跟 getAudio 的表一致。OpenRouter 上的模型不需要（它报实价）。
 */
export const PRICES = {
  "gemini-2.5-flash":       { input: 0.30, output: 2.50, cached: 0.075 },
  "gemini-flash-latest":    { input: 0.30, output: 2.50, cached: 0.075 },
  "gemini-2.5-flash-lite":  { input: 0.10, output: 0.40, cached: 0.025 },
  "gemini-2.0-flash":       { input: 0.10, output: 0.40, cached: 0.025 },
  "gemini-2.5-pro":         { tiers: [[200000, 1.25, 10.0], [null, 2.50, 15.0]], cached: 0.31 },
  "gemini-3-pro-preview":   { tiers: [[200000, 2.00, 12.0], [null, 4.00, 18.0]], cached: 0.20 },
  "gemini-3-flash-preview": { input: 0.50, output: 3.00, cached: 0.05 },
  "gemini-3.5-flash-lite":  { input: 0.30, output: 2.50, cached: 0.03 },
  "gemini-3.5-flash":       { input: 1.50, output: 9.00, cached: 0.15 },
};

const PRICES_TTL_MS = 30000;

export function createUsage(dataDir, { log = console } = {}) {
  const dbPath = join(dataDir, "usage.db");
  const pricesPath = join(dataDir, "prices.json");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS calls (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT NOT NULL,
      provider        TEXT NOT NULL,
      model           TEXT NOT NULL,
      purpose         TEXT NOT NULL,
      ref             TEXT,
      page            INTEGER,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cached_tokens   INTEGER NOT NULL DEFAULT 0,
      thinking_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL,
      cost_source     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
    CREATE INDEX IF NOT EXISTS idx_calls_ref ON calls(ref);
  `);
  const insert = db.prepare(`
    INSERT INTO calls (ts, provider, model, purpose, ref, page, input_tokens, output_tokens,
                       cached_tokens, thinking_tokens, cost_usd, cost_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const als = new AsyncLocalStorage();

  /** `usage.scope({ref, purpose}, fn)`：fn 及其之后的所有异步链里 record() 自动带上归属。 */
  function scope(ctx, fn) {
    return als.run({ ...(als.getStore() || {}), ...ctx }, fn);
  }
  function current() {
    return als.getStore() || {};
  }

  // ---- 价格 ----
  let pricesCache = { stamp: -Infinity, data: null };
  function prices() {
    const now = Date.now();
    if (pricesCache.data && now - pricesCache.stamp < PRICES_TTL_MS) return pricesCache.data;
    const merged = { ...PRICES };
    try {
      const override = JSON.parse(readFileSync(pricesPath, "utf8"));
      for (const [k, v] of Object.entries(override || {})) if (v && typeof v === "object") merged[k] = v;
    } catch (error) {
      if (error?.code !== "ENOENT") log.warn(`[用量] prices.json 读取失败：${String(error?.message ?? error).slice(0, 120)}`);
    }
    pricesCache = { stamp: now, data: merged };
    return merged;
  }
  function priceFor(model) {
    const table = prices();
    if (table[model]) return table[model];
    // 带版本 / 日期后缀的名字（gemini-2.5-flash-preview-05-20）按最长前缀匹配
    let best = null;
    for (const k of Object.keys(table)) {
      if (model.startsWith(k) && (best === null || k.length > best.length)) best = k;
    }
    return best ? table[best] : null;
  }
  /** 按价格表算美元；没价 → null。thinking 按输出计价（Gemini 就是这么收的）。 */
  function estimateCost(model, { inputTokens = 0, outputTokens = 0, cachedTokens = 0, thinkingTokens = 0 } = {}) {
    const p = priceFor(String(model || ""));
    if (!p) return null;
    let inRate;
    let outRate;
    if (Array.isArray(p.tiers)) {
      for (const [limit, i, o] of p.tiers) {
        if (limit === null || inputTokens <= limit) { inRate = i; outRate = o; break; }
      }
    } else {
      inRate = p.input;
      outRate = p.output;
    }
    if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return null;
    const cachedRate = Number.isFinite(p.cached) ? p.cached : inRate;
    const plainIn = Math.max(0, inputTokens - cachedTokens);
    const usd = (plainIn * inRate + cachedTokens * cachedRate + (outputTokens + thinkingTokens) * outRate) / 1e6;
    return Math.round(usd * 1e6) / 1e6;
  }

  // ---- 记录 ----
  /** 记一次调用。costUsd 传入 = 服务商报的实价；不传则按价格表估。永不抛异常。 */
  function record({ provider, model, purpose, ref, page, inputTokens = 0, outputTokens = 0, cachedTokens = 0, thinkingTokens = 0, costUsd = null }) {
    try {
      const ctx = current();
      let source = null;
      let cost = costUsd;
      if (Number.isFinite(cost)) {
        source = "reported";
      } else {
        cost = estimateCost(model, { inputTokens, outputTokens, cachedTokens, thinkingTokens });
        source = cost === null ? null : "table";
      }
      insert.run(
        new Date().toISOString(),
        String(provider || "unknown"),
        String(model || ""),
        String(purpose || ctx.purpose || "other"),
        ref ?? ctx.ref ?? null,
        Number.isFinite(page) ? page : (Number.isFinite(ctx.page) ? ctx.page : null),
        Math.round(inputTokens || 0),
        Math.round(outputTokens || 0),
        Math.round(cachedTokens || 0),
        Math.round(thinkingTokens || 0),
        cost,
        source
      );
      return { inputTokens, outputTokens, costUsd: cost, costSource: source };
    } catch (error) {
      log.warn(`[用量] 记账失败：${String(error?.message ?? error).slice(0, 120)}`);
      return null;
    }
  }

  /** 从 Gemini generateContent 响应的 usageMetadata 记一笔。没有 usageMetadata 就不记。 */
  function recordGemini(payload, model, extra = {}) {
    const um = payload?.usageMetadata;
    if (!um) return null;
    return record({
      provider: "gemini",
      model,
      inputTokens: um.promptTokenCount || 0,
      outputTokens: um.candidatesTokenCount || 0,
      cachedTokens: um.cachedContentTokenCount || 0,
      thinkingTokens: um.thoughtsTokenCount || 0,
      ...extra,
    });
  }

  /**
   * 从 OpenAI 兼容响应的 usage 记一笔（OpenRouter / Kimi / Qwen 直连）。
   * OpenRouter 带 usage.cost（请求要带 usage: {include: true}），照抄为实价。
   */
  function recordOpenAi(payload, provider, model, extra = {}) {
    const u = payload?.usage;
    if (!u) return null;
    const cost = u.cost;
    return record({
      provider,
      model: payload?.model || model,
      inputTokens: u.prompt_tokens || 0,
      outputTokens: u.completion_tokens || 0,
      cachedTokens: u.prompt_tokens_details?.cached_tokens || 0,
      thinkingTokens: u.completion_tokens_details?.reasoning_tokens || 0,
      costUsd: Number.isFinite(cost) ? cost : null,
      ...extra,
    });
  }

  /**
   * 本机 Ollama（原生 /api/chat）：prompt_eval_count / eval_count。
   * 费用记 0 而不是 null——它确实不花钱，记 null 会在界面上显示成「未计价」，像是漏算了。
   */
  function recordOllama(payload, model, extra = {}) {
    if (!payload || !Number.isFinite(payload.eval_count)) return null;
    return record({
      provider: "ollama",
      model: payload.model || model,
      inputTokens: payload.prompt_eval_count || 0,
      outputTokens: payload.eval_count || 0,
      costUsd: 0,
      ...extra,
    });
  }

  // ---- 汇总 ----
  const sumSql = (col) => `
    SELECT ${col} AS k, COUNT(*) AS n, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
           SUM(cost_usd) AS c, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS u
      FROM calls WHERE ts >= ? GROUP BY ${col} ORDER BY c DESC, n DESC`;
  const groupStmts = Object.fromEntries(["provider", "purpose", "model"].map((col) => [col, db.prepare(sumSql(col))]));
  const totalStmt = db.prepare(`
    SELECT COUNT(*) AS n, SUM(cost_usd) AS c, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS u,
           SUM(input_tokens) AS i, SUM(output_tokens) AS o
      FROM calls WHERE ts >= ?`);
  const dailyStmt = db.prepare(`
    SELECT substr(ts, 1, 10) AS d, SUM(cost_usd) AS c, COUNT(*) AS n
      FROM calls WHERE ts >= ? GROUP BY d ORDER BY d`);
  const refStmt = db.prepare(`
    SELECT COUNT(*) AS n, SUM(cost_usd) AS c, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS u,
           SUM(input_tokens) AS i, SUM(output_tokens) AS o
      FROM calls WHERE ref = ?`);

  const rowsOf = (rows) => rows.map((r) => ({
    key: r.k, calls: r.n, inputTokens: r.i || 0, outputTokens: r.o || 0,
    costUsd: r.c === null ? 0 : Math.round(r.c * 1e6) / 1e6, unpriced: r.u || 0,
  }));
  const totalOf = (r) => ({
    calls: r.n || 0, costUsd: Math.round((r.c || 0) * 1e6) / 1e6, unpriced: r.u || 0,
    inputTokens: r.i || 0, outputTokens: r.o || 0,
  });

  /** 面板「用量」栏：本月 / 累计，按服务商 / 用途 / 模型，近 30 天按日。 */
  function summary() {
    const now = new Date();
    // ts 存的是 ISO（UTC），本月起点也按 UTC 取：差几小时对月度账单无所谓，但两边口径要一致
    const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
    const d30 = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const by = {};
    for (const [col, stmt] of Object.entries(groupStmts)) {
      by[col] = { month: rowsOf(stmt.all(monthStart)), all: rowsOf(stmt.all("0000")) };
    }
    return {
      since: db.prepare("SELECT MIN(ts) AS t FROM calls").get()?.t ?? null,
      month: totalOf(totalStmt.get(monthStart)),
      all: totalOf(totalStmt.get("0000")),
      by,
      daily: dailyStmt.all(d30).map((r) => ({ date: r.d, costUsd: Math.round((r.c || 0) * 1e6) / 1e6, calls: r.n })),
      unpricedModels: db.prepare("SELECT DISTINCT model FROM calls WHERE cost_usd IS NULL ORDER BY model").all().map((r) => r.model),
      pricesPath,
    };
  }

  /** 单份任务的费用：{costUsd, calls, unpriced, inputTokens, outputTokens}；没调用过 → null。 */
  function costFor(ref) {
    if (!ref) return null;
    const r = refStmt.get(ref);
    if (!r || !r.n) return null;
    return totalOf(r);
  }

  return { scope, current, record, recordGemini, recordOpenAi, recordOllama, estimateCost, prices, summary, costFor, dbPath, pricesPath };
}
