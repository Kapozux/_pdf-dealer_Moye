#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { createZip, safeEntryName } from "./server/zip.mjs";
import { JobStore } from "./server/jobstore.mjs";
import { JobQueue, EventHub } from "./server/queue.mjs";
import { createConverter, gateStats } from "./server/convert.mjs";
import { createRenderer } from "./server/render.mjs";
import { AdaptivePacer } from "./server/pacer.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const surya = resolve(root, "../.venv-marker/bin/surya_ocr");
const jobRoot = resolve(root, "tmp/pdfs/moye-web-job-");
const settingsPath = resolve(root, "settings.local.json");
const port = Number(process.env.MOYE_PORT) || 8765;
const maxJsonBytes = 24 * 1024 * 1024;

const defaultSettings = {
  provider: "gemini",
  geminiKey: "",
  geminiModel: "gemini-2.5-flash",
  geminiFallbackModel: "gemini-flash-latest",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  kimiKey: "",
  kimiModel: "kimi-k2.6",
  kimiBaseUrl: "https://api.moonshot.ai/v1",
  qwenKey: "",
  qwenModel: "qwen3.7-plus",
  qwenBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openrouterKey: "",
  // 默认走 Kimi 而不是 gemini-2.5-flash：后者跟直连 Gemini 抢的是同一个 Google
  // 配额池，用 OpenRouter 绕一圈不会更快。实测 64 并发下（关推理、同一份数学 PDF）：
  //   kimi-k2.6      1.9 页/s  $0.0028/页  LaTeX 71 ← 公式最全
  //   glm-5v-turbo   1.8 页/s  $0.0055/页  LaTeX 64 ← 同速但贵一倍，淘汰
  //   qwen3.7-flash  4.2 页/s  $0.00013/页 LaTeX 36 ← 快且极便宜，但公式会掉
  // 数学/理科 PDF 用 kimi，纯文字文档换 qwen3.7-flash 可以快一倍、便宜 20 倍。
  openrouterModel: "moonshotai/kimi-k2.6",
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
  aiScope: "all",
  // 关掉时：一份文档只走 provider 选的那一家。开了：所有配了 Key 的渠道
  // 同时用，按各自并发上限加权轮询分配页面——独立的上游（Gemini 服务器
  // 和 OpenRouter/Kimi/Qwen）互不占用配额，同时开是纯加法，没有下限。
  multiChannel: false,
  // multiChannel 打开时，参与分流的渠道白名单。空数组 = 所有配了 Key 的都用。
  // 有了它才能选「Gemini + Qwen 但不要 OpenRouter」这种组合。
  channels: [],
};

const ALL_PROVIDERS = ["gemini", "kimi", "qwen", "openrouter"];

await mkdir(resolve(root, "tmp/pdfs"), { recursive: true });

// 本机来源一律放行：写死 localhost:3000 时，用 127.0.0.1:3000 打开页面会被
// 浏览器整个拦掉（Library 看起来就是空的），而两个地址都指向同一台机器。
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function cors(response, request) {
  const origin = request?.headers?.origin;
  response.setHeader(
    "Access-Control-Allow-Origin",
    origin && LOCAL_ORIGIN.test(origin) ? origin : "http://localhost:3000"
  );
  response.setHeader("Vary", "Origin");
  // 漏加自定义头 = 浏览器直接拦掉整个请求（之前 x-mode 漏过一次，表现是提交任务毫无反应）
  response.setHeader("Access-Control-Allow-Headers", "content-type,x-filename,x-mode,x-batch-id,x-batch-label");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
}

function sendJson(response, status, payload) {
  // CORS 头已在请求入口按 Origin 设置好，这里不要再覆盖
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request, limit = maxJsonBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("请求不是有效的 JSON。");
  }
}

function cleanString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

/** HTTP header 只能带 latin-1，中文（文件名、批次名）由前端编码后在这里解回来。 */
function decodeHeader(value, fallback = "") {
  const raw = cleanString(value, fallback);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 页面回传这个占位符时，表示「这一把 key 保持原样」——页面本来就拿不到明文。 */
const KEEP_KEY = "__KEEP__";

const splitKeys = (value) =>
  String(value || "").split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);

/**
 * 合并额外 key。
 * - 传数组：按位置逐项处理，KEEP_KEY 表示沿用原值；空数组 = 用户确实想清空。
 * - 传字符串：老格式，整串替换（保留向后兼容）。
 * - 没传：保持原样。
 */
function mergeExtraKeys(input, previousValue) {
  const previousKeys = splitKeys(previousValue);
  if (Array.isArray(input)) {
    return input
      .map((entry, index) => (entry === KEEP_KEY ? previousKeys[index] : String(entry || "").trim()))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof input === "string" && input.trim()) return splitKeys(input).join("\n");
  return previousKeys.join("\n");
}

function normalizeSettings(input, previous = defaultSettings) {
  const provider = ["gemini", "kimi", "qwen", "openrouter"].includes(input.provider) ? input.provider : "gemini";
  const aiScope = input.aiScope === "review" ? "review" : "all";
  return {
    provider,
    geminiKey: cleanString(input.geminiKey) || previous.geminiKey || "",
    // 多个 Gemini key（不同 Google 账号 = 各自独立配额）。
    //
    // 这里曾经是 `cleanString(input) || previous`，配上「页面永远看不到已存的
    // key」，就成了一条静默丢数据的路：用户打开设置看到空列表 → 以为没存上 →
    // 补一把新的 → 保存时新值非空，直接把旧的整串覆盖掉，旧 key 无声消失。
    // 现在页面拿到的是打码列表，回传时用 KEEP_KEY 占位表示「这一把别动」。
    geminiKeysExtra: mergeExtraKeys(input.geminiKeysExtra, previous.geminiKeysExtra),
    // 这些 key 分属几个**独立 Google 项目**（同项目的 key 共用配额，加了不提速）
    geminiProjects: Math.max(1, Number(input.geminiProjects) || Number(previous.geminiProjects) || 1),
    geminiModel: cleanString(input.geminiModel) || defaultSettings.geminiModel,
    geminiFallbackModel: cleanString(input.geminiFallbackModel) || defaultSettings.geminiFallbackModel,
    geminiBaseUrl: cleanString(input.geminiBaseUrl) || defaultSettings.geminiBaseUrl,
    kimiKey: cleanString(input.kimiKey) || previous.kimiKey || "",
    kimiModel: cleanString(input.kimiModel) || defaultSettings.kimiModel,
    kimiBaseUrl: cleanString(input.kimiBaseUrl) || defaultSettings.kimiBaseUrl,
    qwenKey: cleanString(input.qwenKey) || previous.qwenKey || "",
    qwenModel: cleanString(input.qwenModel) || defaultSettings.qwenModel,
    qwenBaseUrl: cleanString(input.qwenBaseUrl) || defaultSettings.qwenBaseUrl,
    openrouterKey: cleanString(input.openrouterKey) || previous.openrouterKey || "",
    openrouterModel: cleanString(input.openrouterModel) || defaultSettings.openrouterModel,
    openrouterBaseUrl: cleanString(input.openrouterBaseUrl) || defaultSettings.openrouterBaseUrl,
    aiScope,
    multiChannel: Boolean(input.multiChannel ?? previous.multiChannel ?? defaultSettings.multiChannel),
    channels: (Array.isArray(input.channels) ? input.channels : previous.channels ?? [])
      .filter((p) => ALL_PROVIDERS.includes(p)),
  };
}

async function loadSettings() {
  try {
    const stored = JSON.parse(await readFile(settingsPath, "utf8"));
    return normalizeSettings(stored, defaultSettings);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { ...defaultSettings };
    throw error;
  }
}

async function saveSettings(input) {
  const previous = await loadSettings();
  const settings = normalizeSettings(input, previous);
  const temporary = `${settingsPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, settingsPath);
  return settings;
}

/** 所有可用的 Gemini key：主 key + 额外 key（各自是独立项目、独立配额）。 */
function geminiKeyPool(settings) {
  return [settings.geminiKey, ...String(settings.geminiKeysExtra || "").split(/[\n,]+/)]
    .map((k) => (k || "").trim())
    .filter(Boolean);
}

let geminiKeyCursor = 0;
// 认证失败（401/403/"API key not valid"）的 key 拉黑，之后不再轮到它——
// 否则一把废 key 会按比例吃掉转换请求，表现为「部分页面莫名失败」。
const geminiDeadKeys = new Set();

function liveGeminiKeys(settings) {
  const pool = geminiKeyPool(settings);
  const live = pool.filter((k) => !geminiDeadKeys.has(k));
  return live.length ? live : pool;   // 全挂了就还用原池，让错误如实抛出
}

function markGeminiKeyDead(key, message) {
  if (!key) return;
  if (/API key not valid|API_KEY_INVALID|permission|unauthor/i.test(String(message))) {
    if (!geminiDeadKeys.has(key)) {
      geminiDeadKeys.add(key);
      console.warn(`Gemini key …${key.slice(-4)} 认证失败，已从轮询中移除：${String(message).slice(0, 90)}`);
    }
  }
}

function nextGeminiKey(settings) {
  const pool = liveGeminiKeys(settings);
  if (!pool.length) return "";
  return pool[geminiKeyCursor++ % pool.length];
}

function maskedKey(value) {
  if (!value) return "";
  return `••••••••${value.slice(-4)}`;
}

function publicSettings(settings) {
  const activeConfigured = settings.multiChannel
    ? configuredChannels(settings).length > 0
    : Boolean({
        gemini: settings.geminiKey,
        kimi: settings.kimiKey,
        qwen: settings.qwenKey,
        openrouter: settings.openrouterKey,
      }[settings.provider]);
  return {
    provider: settings.provider,
    multiChannel: settings.multiChannel,
    channels: settings.channels ?? [],
    activeChannels: settings.multiChannel ? configuredChannels(settings).map((c) => c.provider) : [settings.provider],
    // 各渠道的并发权重，给界面显示「这个组合总共多少路并发」
    channelWeights: Object.fromEntries(configuredChannels(settings).map((c) => [c.provider, c.weight])),
    geminiConfigured: Boolean(settings.geminiKey),
    geminiKeyMasked: maskedKey(settings.geminiKey),
    geminiModel: settings.geminiModel,
    geminiFallbackModel: settings.geminiFallbackModel,
    geminiBaseUrl: settings.geminiBaseUrl,
    kimiConfigured: Boolean(settings.kimiKey),
    kimiKeyMasked: maskedKey(settings.kimiKey),
    kimiModel: settings.kimiModel,
    kimiBaseUrl: settings.kimiBaseUrl,
    qwenConfigured: Boolean(settings.qwenKey),
    qwenKeyMasked: maskedKey(settings.qwenKey),
    qwenModel: settings.qwenModel,
    qwenBaseUrl: settings.qwenBaseUrl,
    openrouterConfigured: Boolean(settings.openrouterKey),
    openrouterKeyMasked: maskedKey(settings.openrouterKey),
    openrouterModel: settings.openrouterModel,
    openrouterBaseUrl: settings.openrouterBaseUrl,
    aiScope: settings.aiScope,
    aiConfigured: activeConfigured,
    // 打码回传：页面要能看见「已经存了哪几把」，否则用户以为没存上、
    // 重新添加就会覆盖掉旧的（明文永远不出这台机器）
    geminiKeysExtraMasked: splitKeys(settings.geminiKeysExtra).map(maskedKey),
    geminiKeyCount: geminiKeyPool(settings).length,
    geminiKeysLive: liveGeminiKeys(settings).length,
    geminiProjects: Math.max(1, Number(settings.geminiProjects) || 1),
  };
}

async function findResult(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findResult(path);
      if (nested) return nested;
    } else if (entry.name === "results.json") {
      return path;
    }
  }
  return null;
}

function runSurya(input, output) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(surya, [input, "--output_dir", output], {
      cwd: root,
      env: { ...process.env, SURYA_INFERENCE_BACKEND: "llamacpp" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostic = "";
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8000);
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(diagnostic || `Surya exited with code ${code}`));
    });
  });
}

const refinementPrompt = `You are the verification and correction stage of a PDF-to-Markdown pipeline.
Read only the visible PDF page image. A local OCR draft is provided as a fallible hint.

Requirements:
- Reconstruct the page in natural reading order. Preserve question numbers, answer choices A/B/C/D, headings, tables and captions.
- Convert every visible mathematical expression to valid LaTeX. Use $...$ inline and $$...$$ for display equations.
- Never solve questions, explain content, or invent missing text.
- Put handwritten annotations in a final Markdown blockquote beginning with “手写批注：”.
- If a symbol truly cannot be read, write [unclear] instead of guessing.
- Return JSON only with this exact shape:
  {"markdown":"...","formulaCount":0,"questionNumbers":["1"],"optionLabels":["A","B"],"uncertain":["brief note"]}

LOCAL OCR DRAFT:
`;

const refinementSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    markdown: { type: "string" },
    formulaCount: { type: "integer" },
    questionNumbers: { type: "array", items: { type: "string" } },
    optionLabels: { type: "array", items: { type: "string" } },
    uncertain: { type: "array", items: { type: "string" } },
  },
  required: ["markdown", "formulaCount", "questionNumbers", "optionLabels", "uncertain"],
};

function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error("模型没有返回有效 JSON。");
  }
}

function normalizeAiResult(raw, provider, model) {
  const markdown = cleanString(raw.markdown);
  if (!markdown) throw new Error("模型返回了空白 Markdown。");
  return {
    markdown,
    formulaCount: Number.isFinite(raw.formulaCount) ? Math.max(0, Math.round(raw.formulaCount)) : 0,
    questionNumbers: Array.isArray(raw.questionNumbers) ? raw.questionNumbers.map(String).slice(0, 200) : [],
    optionLabels: Array.isArray(raw.optionLabels) ? raw.optionLabels.map(String).slice(0, 400) : [],
    uncertain: Array.isArray(raw.uncertain) ? raw.uncertain.map(String).filter(Boolean).slice(0, 30) : [],
    provider,
    model,
  };
}

async function fetchWithTimeout(url, options, timeoutMs = 180000) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
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
 * 单页模型调用的超时。
 *
 * 高并发下真正拖垮总时长的不是平均延迟，是**长尾**：实测 92 页那一轮，前 57 页
 * 30 秒就完成，剩下 35 页却拖了 330 秒——少数请求卡在上游几分钟不返回。
 * 这类调用是幂等的（同一页重发一次即可），所以卡住不如早点掐掉重试。
 *
 * 30 秒是按实测中位数定的：单独探测三家（gemini-2.5-flash / qwen3.7-plus /
 * kimi-k2.6，同一页真实试卷图）分别是 18.2s / 13.1s / 12.4s，30 秒已是 p50 的
 * 两倍多。这类失败几乎全是「对面收下请求但永不回复」，等再久也等不出结果，
 * 只会把时间空烧掉——90 秒和 45 秒都试过，救回的页数没有区别。
 */
const PAGE_CALL_TIMEOUT_MS = Number(process.env.MOYE_PAGE_TIMEOUT_MS) || 30000;

/**
 * 补救轮的单页参数：只试一次、超时更短。
 *
 * 补救轮针对的是「主轮刚刚卡死过」的页。对这种页再来一遍三次重试，等于
 * 把同一份绝望重复三次：实测 96 页待补救、每份并发 4、每页烧满 150 秒，
 * 整批直接从 58 页/分钟塌到 2 页/分钟。补救的价值在于「万一只是一时拥堵」，
 * 那一次就够验证了；失败就老实回退文字层，把并发让给还没跑的页。
 */
const RESCUE_TIMEOUT_MS = Number(process.env.MOYE_RESCUE_TIMEOUT_MS) || 25000;
const RESCUE_ATTEMPTS = 1;

/**
 * 按渠道的单次调用超时。
 *
 * 一个全局超时对三家是错的——它们的正常速度差 8 倍（同一页真实试卷图，孤立测量）：
 *   openrouter/CoreWeave  3s      ← 最快
 *   qwen3.7-plus          13s
 *   gemini-2.5-flash      25s     ← 离 30s 只差 5s
 * 全局 30s 的后果：Gemini 稍有负载就超时 → 重试 3 次 → 再换回退模型 →
 * 一页烧掉 150s 预算，满配 12 路却只跑出 7 页；qwen 也被判成「慢」降到 3 路。
 * 现在各给约 3 倍 p50 的余量，快的照样快速失败，慢的不再被误杀。
 */
const PROVIDER_TIMEOUT_MS = {
  openrouter: Number(process.env.MOYE_TIMEOUT_OPENROUTER) || 30000,
  qwen: Number(process.env.MOYE_TIMEOUT_QWEN) || 45000,
  kimi: Number(process.env.MOYE_TIMEOUT_KIMI) || 45000,
  gemini: Number(process.env.MOYE_TIMEOUT_GEMINI) || 75000,
};
const providerTimeout = (provider) => PROVIDER_TIMEOUT_MS[provider] ?? PAGE_CALL_TIMEOUT_MS;

/**
 * 单页**总时间预算**（含所有重试、所有回退模型）。
 *
 * 逐层限时挡不住相乘：3 次重试 × 90s = 270s，Gemini 还要在主模型和回退模型上
 * 各跑一遍 = 540s，外面补救轮再来一遍 = 1080s。实测就抓到一份 1 页的 PDF 跑了
 * 1103 秒，另有 5 份 1–2 页的稳定停在 545 秒——正好是这个阶梯的两级。
 * 一页的价值撑不起十几分钟，超预算就直接回退文字层，把并发让给别的页。
 */
const PAGE_TIME_BUDGET_MS = Number(process.env.MOYE_PAGE_BUDGET_MS) || 150000;

/**
 * 带退避的 POST。
 *
 * 429 单独处理：高并发下它是**常态而非异常**——实测 64 并发零 429，128 并发约
 * 10%，256 并发 60%。这类请求只是需要等一会儿再来，用固定 900ms×n 的线性退避
 * 会让一整批请求几乎同时重试、再一起被打回（惊群）。所以 429 走指数退避 + 随机
 * 抖动，并且给更多次机会；服务端给了 Retry-After 就听它的。
 */
async function postWithRetries(url, options, attempts = 3, timeoutMs = undefined, deadline = Infinity) {
  let lastError;
  let rateLimitRetries = 0;
  const maxRateLimitRetries = 6;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // 预算用完就别再开新一轮：重试的意义是「换一次运气」，而不是把等待叠起来
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError || new Error("单页时间预算已用尽。");
    let backoff = attempt * 900;
    try {
      const response = await fetchWithTimeout(url, options, Math.min(timeoutMs ?? 180000, remaining));
      const text = await response.text();
      if (response.ok) return JSON.parse(text);
      const message = (() => {
        try { return JSON.parse(text)?.error?.message || JSON.parse(text)?.error || text; } catch { return text; }
      })();
      const error = new Error(`模型请求失败（${response.status}）：${String(message).slice(0, 500)}`);
      if (options?.headers?.["x-goog-api-key"]) markGeminiKeyDead(options.headers["x-goog-api-key"], message);
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
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
  }
  throw lastError || new Error("模型请求失败。");
}

async function callGemini(settings, imageBase64, mimeType, draft, testOnly = false, opts = {}) {
  if (!settings.geminiKey) throw new Error("请先在设置中填写 Gemini API Key。");
  settings = { ...settings, __key: settings.__key || nextGeminiKey(settings) };  // 指定 key 优先，否则轮询
  const models = [settings.geminiModel, settings.geminiFallbackModel].filter((model, index, values) => model && values.indexOf(model) === index);
  let lastError;
  // 主模型和回退模型**共用**一份预算：分开各给一份，两级阶梯就会相乘
  // （3 次 × 45s × 2 个模型），回退模型的存在反而让卡死的页更慢被放弃。
  const deadline = testOnly ? Infinity : Date.now() + (opts.budgetMs ?? PAGE_TIME_BUDGET_MS);
  for (const model of models) {
    if (Date.now() >= deadline) break;
    try {
      const url = `${settings.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
      const parts = testOnly
        ? [{ text: "Reply with JSON only: {\"ok\":true}" }]
        : [
            { text: `${refinementPrompt}${draft.slice(0, 60000)}` },
            { inlineData: { mimeType, data: imageBase64 } },
          ];
      const payload = await postWithRetries(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": settings.__key || settings.geminiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            ...(testOnly ? {} : { responseJsonSchema: refinementSchema }),
          },
        }),
      }, opts.attempts ?? 3, testOnly ? 60000 : (opts.timeoutMs ?? PAGE_CALL_TIMEOUT_MS), deadline);
      const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
      if (testOnly) return { ok: true, provider: "gemini", model };
      return normalizeAiResult(extractJson(text), "gemini", model);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Gemini 调用失败。");
}

/** 记住哪些 OpenRouter 端点不接受 reasoning:{enabled:false}，避免每页都先撞一次墙。 */
const forcedReasoningModels = new Set();

/**
 * OpenRouter 底层供应商白名单。
 *
 * 同一个模型 OpenRouter 上挂着 20+ 家供应商，**不指定就等于抽奖**：实测默认路由
 * 把请求几乎全灌给 StreamLake（8路里7个、32路里9个都是它），而那家并发一高就
 * 「收下请求但永不返回」——不是 429，是彻底挂死，要等客户端超时才知道。
 * 于是整条渠道的天花板变成了单家的上限（实测成功数卡在 12 上下，发 64 路也一样）。
 *
 * 2026-08-18 逐家钉死、各发 8 路实测（moonshotai/kimi-k2.6，关推理）：
 *   CoreWeave   8/8  p50 12.0s  0.42页/秒  挂死0   ← 与 Gemini 同档
 *   Parasail    8/8  p50 17.7s  0.22页/秒  挂死0
 *   Baidu       8/8  p50 41.2s  0.12页/秒  挂死0
 *   Cloudflare  8/8  p50 50.8s  0.10页/秒  挂死0
 *   ── 以下不可用 ──
 *   StreamLake  5/8  挂死3 ｜ Moonshot AI 5/8 挂死3 ｜ Novita 3/8 挂死5
 *   Crusoe 4/8 挂死4 ｜ Phala 3/8 挂死4 ｜ SiliconFlow 5/8 挂死3
 *   Fireworks / BaseTen / DeepInfra / DigitalOcean / Decart / Sail Research：0/8（429/404）
 *
 * 四家合计 32 路、0.86 页/秒——比默认路由的 0.04 页/秒快 21 倍。
 * 供应商健康度天天在变，跑 /tmp 里那个逐家压测脚本即可重新排名。
 */
const OPENROUTER_PROVIDERS = (process.env.MOYE_OPENROUTER_PROVIDERS || "CoreWeave,Parasail,Inceptron,Baidu,Cloudflare")
  .split(",").map((p) => p.trim()).filter(Boolean);

/**
 * 模型级兜底链。换供应商解决的是「这家机房挂了」，但如果是模型本身出问题
 * （下架、全网限流、持续 5xx），换多少家供应商都没用，得换模型。
 *
 * 顺序按实测（同一份数学 PDF、关推理）：
 *   moonshotai/kimi-k2.6  1.9 页/s  $0.0028/页  LaTeX 71  ← 公式最全，首选
 *   z-ai/glm-5v-turbo     1.8 页/s  $0.0055/页  LaTeX 64  ← 同速、贵一倍，但公式接近
 *   qwen/qwen3.7-flash    4.2 页/s  $0.00013/页 LaTeX 36  ← 最快最便宜，但公式会掉
 * 所以兜底顺序不是按速度排的，是按「公式保真度」排的——理科文档丢公式等于白转。
 */
const OPENROUTER_FALLBACK_MODELS = (process.env.MOYE_OPENROUTER_FALLBACK_MODELS
  || "z-ai/glm-5v-turbo,qwen/qwen3.7-flash").split(",").map((m) => m.trim()).filter(Boolean);

/**
 * 模型熔断器。
 *
 * 没有它的话，一个已经全网挂掉的模型会让**每一页**都先把 5 家供应商试一遍
 * （5 × 30s = 150s）才轮到备用模型——等于每页多付两分半的学费。
 * 连续失败到阈值就把这个模型停用一段时间，期间直接从备用模型开始。
 * 只要有一次成功就立刻清零：模型多是暂时性抽风，不该被永久打入冷宫。
 */
const MODEL_TRIP_THRESHOLD = 6;      // 连续失败多少次算挂了
const MODEL_COOLDOWN_MS = 120000;    // 挂了之后停用多久
const modelHealth = new Map();       // model → { fails, downUntil }

function modelIsDown(model) {
  const h = modelHealth.get(model);
  return Boolean(h && h.downUntil > Date.now());
}
function noteModelFailure(model) {
  const h = modelHealth.get(model) || { fails: 0, downUntil: 0 };
  h.fails += 1;
  if (h.fails >= MODEL_TRIP_THRESHOLD) {
    h.downUntil = Date.now() + MODEL_COOLDOWN_MS;
    h.fails = 0;
    console.warn(`[模型熔断] ${model} 连续失败 ${MODEL_TRIP_THRESHOLD} 次，暂停 ${MODEL_COOLDOWN_MS / 1000}s，改用备用模型`);
  }
  modelHealth.set(model, h);
}
function noteModelSuccess(model) {
  const h = modelHealth.get(model);
  if (h && h.fails) { h.fails = 0; modelHealth.set(model, h); }
}

/**
 * OpenRouter 调用：钉死单家，失败立刻换下一家，轮完一圈才算失败。
 *
 * 之前是把整个白名单交给 OpenRouter 自己挑（order + allow_fallbacks:false）。
 * 那样一旦它选中的那家挂住，请求就只能干等到超时——实测持续 64 路并发时
 * 有 49 次超时，某份 44 页文档主轮失败 33 页。换家的成本只有一次短超时，
 * 而换家之后往往立刻就成功，比在同一家上重试三次划算得多。
 */
async function callOpenRouterFailover(settings, input, opts = {}) {
  const base = directProviderConfig("openrouter", settings);
  const pool = OPENROUTER_PROVIDERS;
  if (!pool.length) return callOpenAiCompatible(base, input.imageBase64 || "", input.mimeType || "image/jpeg", input.draft || "", false, opts);

  const perTry = opts.timeoutMs ?? PAGE_CALL_TIMEOUT_MS;
  const overallDeadline = Date.now() + (opts.budgetMs ?? PAGE_TIME_BUDGET_MS);
  let lastError;

  // 外层换模型，内层换供应商。已熔断的模型直接跳过——除非它是唯一剩下的。
  const chain = [base.model, ...OPENROUTER_FALLBACK_MODELS].filter((m, i, a) => m && a.indexOf(m) === i);
  const usable = chain.filter((m) => !modelIsDown(m));
  const models = usable.length ? usable : chain;

  for (const model of models) {
    if (Date.now() >= overallDeadline) break;

    // 按 OPENROUTER_PROVIDERS 的顺序试，**不做轮转**。
    // 曾经这里用 openrouterCursor++ 轮转起点，想着「分散负载」，实测是灾难：
    // 五家速度差 4 倍（CoreWeave p50 12s、Baidu 41s、Cloudflare 51s），轮转把
    // 80% 的请求发给了慢的四家，而后两家的 p50 本身就超过 30s 超时线——必然
    // 超时、换家、再等，平均每页 236 秒，吞吐 14 页/分钟。
    // 而按顺序优先最快的一家：32 路里 31 个落在 CoreWeave，p50 3.3s、2.17 页/秒。
    // 分散负载该由 OpenRouter 在它那侧做，客户端硬分只会把活推给慢的。
    // 第 0 次尝试不钉死任何一家：把整个白名单交给 OpenRouter，让它自己在
    // 健康的几家之间做负载均衡（实测 32 路里 31 个落到最快的 CoreWeave，
    // p50 3.3s、2.17 页/秒——比客户端自己分片快 15 倍）。
    // 只有它挑的那家失败了，才逐家钉死重试。
    const attempts = [null, ...pool];
    for (const pinned of attempts) {
      if (Date.now() >= overallDeadline) break;
      try {
        const result = await callOpenAiCompatible(
          { ...base, model, pinProvider: pinned },
          input.imageBase64 || "", input.mimeType || "image/jpeg", input.draft || "", false,
          // 每家只给一次机会：失败就换人，不在同一家身上重试
          { attempts: 1, timeoutMs: perTry, budgetMs: perTry + 2000 }
        );
        noteModelSuccess(model);
        if (model !== base.model) {
          console.warn(`[换模型] 第 ${input.page ?? "?"} 页：${base.model} 不可用，改用 ${model} 成功`);
        }
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[换供应商] 第 ${input.page ?? "?"} 页：${model} @ ${pinned} 失败（${String(error?.message ?? error).slice(0, 50)}）`);
      }
    }
    // 走到这里 = 这个模型在所有供应商上都失败了，才算模型本身的一次失败
    // （成功的路径在上面直接 return 了）
    noteModelFailure(model);
  }
  throw lastError || new Error("OpenRouter 所有模型与供应商都失败。");
}

async function callOpenAiCompatible(config, imageBase64, mimeType, draft, testOnly = false, opts = {}) {
  if (!config.key) throw new Error(`请先在设置中填写 ${config.label} API Key。`);
  if (config.provider === "openrouter" && forcedReasoningModels.has(config.model)) {
    config = { ...config, noReasoningToggle: true };
  }
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const content = testOnly
    ? "Reply with JSON only: {\"ok\":true}"
    : [
        { type: "text", text: `${refinementPrompt}${draft.slice(0, 60000)}` },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
      ];
  const payload = await postWithRetries(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.key}`,
      ...(config.provider === "openrouter" ? {
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Moye PDF to Markdown",
      } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      // 钉住底层供应商。见 OPENROUTER_PROVIDERS 的实测说明——不指定的话
      // OpenRouter 会把请求几乎全灌给一家（实测是 StreamLake），那家的并发上限
      // 就成了整个渠道的天花板，超出的请求直接挂死不返回。
      ...(config.provider === "openrouter" && !testOnly
        ? { provider: { order: config.pinProvider ? [config.pinProvider] : OPENROUTER_PROVIDERS, allow_fallbacks: false } }
        : {}),
      ...(config.provider === "kimi" ? { max_completion_tokens: testOnly ? 128 : 16384 } : {}),
      ...(config.provider === "openrouter" ? { max_tokens: testOnly ? 128 : 16384 } : {}),
      ...(config.provider === "kimi" && !testOnly ? {
        response_format: {
          type: "json_schema",
          json_schema: { name: "pdf_page", strict: true, schema: refinementSchema },
        },
      } : config.provider === "qwen" && /^(?:qwen3\.(?:8|7|6|5)|qwen3-vl)/.test(config.model)
        ? { response_format: { type: "json_object" } }
        : config.provider !== "qwen" ? { response_format: { type: "json_object" } } : {}),
      ...(config.provider === "kimi" && config.model.startsWith("kimi-k2.6") ? { thinking: { type: "disabled" } } : {}),
      ...(config.provider === "qwen" && !config.model.startsWith("qwen3.8") ? { enable_thinking: false } : {}),
      // OpenRouter 上这些模型默认全是推理模型，而「照着图抄字」根本不需要思考：
      // 实测 kimi-k2.6 开推理烧掉 7153 个思考 token、169.8s/$0.0198，关掉后
      // 14.8s/$0.0028——快 11 倍、便宜 7 倍，而 LaTeX 数量不降反升（64 → 71）。
      // 少数端点（如 stepfun）强制推理，会返回 "Reasoning is mandatory"，
      // 那种情况下退回不带该字段重发一次（见 callOpenAiCompatible 的兜底）。
      ...(config.provider === "openrouter" && !config.noReasoningToggle ? { reasoning: { enabled: false } } : {}),
      messages: [{ role: "user", content }],
    }),
  }, opts.attempts ?? 3, testOnly ? 60000 : (opts.timeoutMs ?? PAGE_CALL_TIMEOUT_MS),
     testOnly ? Infinity : Date.now() + (opts.budgetMs ?? PAGE_TIME_BUDGET_MS)).catch((error) => {
    // 强制推理的端点：记下来，之后这个模型都不再带该字段，然后立刻重发一次。
    if (config.provider === "openrouter" && !config.noReasoningToggle && /reasoning is mandatory/i.test(String(error?.message))) {
      forcedReasoningModels.add(config.model);
      return callOpenAiCompatible({ ...config, noReasoningToggle: true }, imageBase64, mimeType, draft, testOnly)
        .then((result) => ({ __done: result }));
    }
    throw error;
  });
  if (payload?.__done) return payload.__done;
  if (testOnly) return { ok: true, provider: config.provider, model: payload?.model || config.model };
  const responseContent = payload?.choices?.[0]?.message?.content || "";
  const text = Array.isArray(responseContent)
    ? responseContent.map((part) => typeof part === "string" ? part : part?.text || "").join("")
    : responseContent;
  return normalizeAiResult(extractJson(text), config.provider, payload?.model || config.model);
}

// 多渠道时各家的并发权重——决定页面按什么比例分给谁，以及总并发上限。
//
// 2026-08-18 重测（三家**同时**发压、同一页真实试卷图、每级取 p50）：
//            并发1     并发4              并发8
//   gemini   14.4s     13.4s  8/8 成功    14.8s  8/8 成功   ← 零退化
//   qwen     13.0s     13.1s  8/8 成功    13.2s  8/8 成功   ← 零退化
//   openrouter 19.8s   34.9s  4/4 成功    20.3s  1/8 成功   ← 8 路直接崩
//
// 旧表给 openrouter 64、qwen 8，于是加权轮询把 76% 的页面发给了唯一一个会崩的
// 渠道，两个完美扩展的渠道只分到 24%——权重正好是反的。实测里那些 545s/1103s
// 的单页耗时，就是被分到 openrouter 的页面 120s 死等再重试叠出来的。
// openrouter 的 64 是实测出来的硬边界，别凭直觉往下调：
//   白名单 64 路 → 64/64 成功  p50 4.8s  墙钟 20.8s  3.08 页/秒
//   白名单 96 路 → 21/96 成功  75 个挂死           0.17 页/秒
// 曾经它看起来「8 路就崩」，那是因为没钉供应商、请求全被灌给坏的那家；
// 病根在路由不在并发，降并发治不了（见 OPENROUTER_PROVIDERS）。
// 前提：OPENROUTER_PROVIDERS 白名单有效。白名单空了就退回抽奖式路由，那时 64 会崩。
// 每家实测能稳住 8 路（逐家钉死压测），所以总并发 = 8 × 供应商家数。
// 64 路曾经在「打一炮就停」的压测里 64/64 全过，但那是突发；持续几十分钟的
// 真实批次里，64 路摊到 5 家就是每家 13 路，实测直接崩——某份 74 页文档
// 主轮 74 页全失败。宁可 40 路全部跑通，也不要 64 路一半在超时。
const DIRECT_PROVIDER_WEIGHTS = { openrouter: 8 * OPENROUTER_PROVIDERS.length, kimi: 8, qwen: 8 };

function geminiWeight(settings) {
  const projects = Math.max(1, Number(settings.geminiProjects) || 1);
  return 6 * Math.max(1, Math.min(projects, liveGeminiKeys(settings).length || 1));
}

function channelWeight(provider, settings) {
  return provider === "gemini" ? geminiWeight(settings) : (DIRECT_PROVIDER_WEIGHTS[provider] ?? 6);
}

/**
 * 参与分流的渠道 + 各自并发权重。
 * 必须有 Key；此外若设了 channels 白名单，则只用白名单里的（空 = 全用）。
 */
function configuredChannels(settings) {
  const keys = { gemini: settings.geminiKey, kimi: settings.kimiKey, qwen: settings.qwenKey, openrouter: settings.openrouterKey };
  const allow = Array.isArray(settings.channels) && settings.channels.length ? settings.channels : null;
  return Object.entries(keys)
    .filter(([provider, key]) => Boolean(key) && (!allow || allow.includes(provider)))
    .map(([provider]) => ({ provider, weight: channelWeight(provider, settings) }));
}

/**
 * 多渠道并发上限：各家权重直接相加。
 * 不同渠道打的是不同的上游服务器（generativelanguage.googleapis.com、
 * openrouter.ai、moonshot、dashscope），彼此不共享连接池也不共享配额，
 * 所以同时开是纯加法——这跟同一个 OpenRouter key 下混跑三个模型不是一回事，
 * 那种情况实测反而退化（见 convert.mjs 里 aiGate 的说明）：三路共用同一个
 * 上游主机，请求会互相挤占；这里各渠道走的是完全独立的主机。
 */
function totalChannelWeight(settings) {
  const channels = configuredChannels(settings);
  return channels.reduce((sum, ch) => sum + ch.weight, 0) || 6;
}

/**
 * 自适应节流器（取代原来的静态加权轮询）。
 *
 * 旧做法按固定权重把页面摊给各渠道，问题是权重是拍脑袋定的静态值：
 * 某家崩了它照样按比例分到活，于是那部分页面全部超时。实测 537 页那批，
 * 权重分配把大量页面持续送给已经打满的渠道，最终 241 页回退。
 * 现在改成按「实时空位」派活——崩掉的渠道 limit 会自己缩小，自然接不到活。
 */
const pacer = new AdaptivePacer({ minPerChannel: 2 });

function directProviderConfig(provider, settings) {
  const configs = {
    kimi: { provider: "kimi", label: "Kimi", key: settings.kimiKey, model: settings.kimiModel, baseUrl: settings.kimiBaseUrl },
    qwen: { provider: "qwen", label: "Qwen / 阿里百炼", key: settings.qwenKey, model: settings.qwenModel, baseUrl: settings.qwenBaseUrl },
    openrouter: { provider: "openrouter", label: "OpenRouter", key: settings.openrouterKey, model: settings.openrouterModel, baseUrl: settings.openrouterBaseUrl },
  };
  return configs[provider];
}

async function callProvider(provider, settings, input, testOnly) {
  // 补救轮只给一次机会、超时更短——那些页刚刚才卡死过，重复三轮只是重复绝望
  const perTry = providerTimeout(provider);
  const opts = input.rescue
    ? { attempts: RESCUE_ATTEMPTS, timeoutMs: RESCUE_TIMEOUT_MS, budgetMs: RESCUE_TIMEOUT_MS + 2000 }
    // 按渠道给超时；总预算给足两轮，够它在同一家重试或换一家，但不至于无限拖
    : { timeoutMs: perTry, budgetMs: Math.max(PAGE_TIME_BUDGET_MS, perTry * 2) };
  if (provider === "gemini") {
    return callGemini(settings, input.imageBase64 || "", input.mimeType || "image/jpeg", input.draft || "", testOnly, opts);
  }
  // OpenRouter 走换家逻辑；测试连接除外（那时要的是「这个 Key 通不通」）
  if (provider === "openrouter" && !testOnly) {
    return callOpenRouterFailover(settings, input, opts);
  }
  return callOpenAiCompatible(directProviderConfig(provider, settings), input.imageBase64 || "", input.mimeType || "image/jpeg", input.draft || "", testOnly, opts);
}

async function callConfiguredModel(settings, input, testOnly = false) {
  // 测试连接走单一 provider（设置面板里逐家测），不进节流器
  if (testOnly) return callProvider(settings.provider, settings, input, true);

  // 真正精校页面：交给自适应节流器。它按渠道各开一条车道，
  // 成功就慢慢提速、超时就砍半，并总是把活派给空位最多的那条——
  // 于是某个平台崩了，流量会自动流向其他平台，不需要人工切换。
  const channels = (settings.multiChannel
    ? configuredChannels(settings)
    : [{ provider: settings.provider, weight: channelWeight(settings.provider, settings) }])
    // slowMs = 该渠道一次尝试的超时。超过它才回来，说明底下必然重试或换过家，
    // 那就是拥塞信号；用统一阈值会把慢渠道的正常响应误杀。
    .map((c) => ({ ...c, slowMs: Math.round(providerTimeout(c.provider) * 1.5) }));
  pacer.configure(channels);
  return pacer.run((provider) => callProvider(provider, settings, input, false));
}

async function listConfiguredModels(settings) {
  if (settings.provider === "gemini") {
    if (!settings.geminiKey) throw new Error("请先在设置中填写 Gemini API Key。");
  settings = { ...settings, __key: settings.__key || nextGeminiKey(settings) };  // 指定 key 优先，否则轮询
    const response = await fetchWithTimeout(`${settings.geminiBaseUrl.replace(/\/$/, "")}/models`, {
      headers: { "x-goog-api-key": settings.geminiKey },
    }, 30000);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "Gemini 模型列表读取失败。");
    const models = (payload.models || [])
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => ({
        id: String(model.name || "").replace(/^models\//, ""),
        label: model.displayName || String(model.name || "").replace(/^models\//, ""),
      }))
      .filter((model) => model.id);
    return { provider: settings.provider, models: models.slice(0, 200) };
  }

  const configs = {
    kimi: { label: "Kimi", key: settings.kimiKey, baseUrl: settings.kimiBaseUrl },
    qwen: { label: "Qwen / 阿里百炼", key: settings.qwenKey, baseUrl: settings.qwenBaseUrl },
    openrouter: { label: "OpenRouter", key: settings.openrouterKey, baseUrl: settings.openrouterBaseUrl },
  };
  const config = configs[settings.provider];
  if (!config.key) throw new Error(`请先在设置中填写 ${config.label} API Key。`);
  const response = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${config.key}` },
  }, 30000);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `${config.label} 模型列表读取失败。`);
  let models = (payload.data || payload.models || []).map((model) => ({
    id: String(model.id || model.name || "").replace(/^models\//, ""),
    label: model.name || model.id || "",
    supportsImage: model.supports_image_in ?? model.architecture?.input_modalities?.includes("image") ?? /image|vision/i.test(model.architecture?.modality || ""),
  })).filter((model) => model.id);
  if (settings.provider === "kimi") {
    models = models.filter((model) => model.supportsImage || /^kimi-k2\.(5|6)/.test(model.id) || /vision/.test(model.id));
  } else if (settings.provider === "qwen") {
    models = models.filter((model) => /qwen3\.8-max-preview|qwen3\.7-plus|qwen3\.7-max-2026-06-08|qwen3\.6-(?:plus|flash)|qwen3\.5-(?:plus|flash)|qwen3-vl|qwen-vl|qwen.*ocr|qvq/i.test(model.id));
  } else {
    models = models.filter((model) => model.supportsImage);
  }
  return {
    provider: settings.provider,
    models: models.slice(0, 300).map(({ id, label }) => ({ id, label: label || id })),
  };
}

// ===== 服务端编排：存储 + 管线 + 队列 =====
// Surya 与 AI 调用以依赖注入方式交给管线（同进程直接调用，不再自己请求自己）。
const jobStore = new JobStore(resolve(root, "data"));
const events = new EventHub();

async function runSuryaOnPdf(pdfPath) {
  const work = await mkdtemp(jobRoot);
  const output = join(work, "surya");
  try {
    await runSurya(pdfPath, output);
    const resultPath = await findResult(output);
    if (!resultPath) throw new Error("Surya 未生成 results.json。");
    const raw = JSON.parse(await readFile(resultPath, "utf8"));
    const pages = Object.values(raw)[0];
    if (!Array.isArray(pages)) throw new Error("Surya 结果格式异常。");
    return { pages };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const converter = createConverter({
  aiPageConcurrency: async () => {
    const st = await loadSettings();
    const override = Number(process.env.MOYE_AI_PAGE_CONCURRENCY);
    if (Number.isFinite(override) && override > 0) return override;
    // 多渠道：各家权重直接相加（各打各的上游，互不占用配额，见 totalChannelWeight 的注释）
    if (st.multiChannel) return totalChannelWeight(st);
    return channelWeight(st.provider, st);
  },
  runSurya: runSuryaOnPdf,
  refinePage: async (input) => callConfiguredModel(await loadSettings(), input, false),
  loadSettings: async () => publicSettings(await loadSettings()),
  renderer: createRenderer({ python: resolve(root, "../.venv-marker/bin/python") }),
});

const jobQueue = new JobQueue({
  store: jobStore,
  // 本机跑 Surya 很吃资源，默认串行（MOYE_CONCURRENCY 只调本机识别）。
  // AI 模式不受它影响：那边限的是文档并发，见 queue.mjs 的 MOYE_AI_JOB_CONCURRENCY。
  concurrency: Number(process.env.MOYE_CONCURRENCY) || 1,
  run: async (job, onProgress) => {
    const pdfPath = jobStore.sourcePath(job.id);
    const title = job.filename.replace(/\.pdf$/i, "");
    // 「重跑精校」的任务带着上次的初稿，直接复用，不重跑 Surya
    let previous = null;
    try {
      previous = JSON.parse(await readFile(join(jobStore.dir(job.id), "previous.json"), "utf8"));
    } catch {
      previous = null;
    }
    // 逐页存档：服务重启后从上次的页续跑，而不是整份重来
    const checkpoint = jobStore.checkpoint(job.id);
    return previous
      ? converter.refineExisting(pdfPath, title, previous, onProgress, checkpoint)
      : converter.convertPdf(pdfPath, title, job.mode, onProgress, checkpoint);
  },
});

jobQueue.on("job", (job) => events.broadcast("job", job));

const server = createServer(async (request, response) => {
  cors(response, request);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (request.method === "GET" && request.url === "/health") {
      const settings = await loadSettings();
      sendJson(response, 200, { ready: true, engine: "surya-2", ai: publicSettings(settings) });
      return;
    }

    // 实时诊断：闸的占用、队列、每份任务卡在哪一阶段。
    // 排查慢的时候第一个该看的就是这里，而不是去数 TCP 连接。
    if (request.method === "GET" && request.url === "/api/debug") {
      const settings = await loadSettings();
      const jobs = jobStore.list({ limit: 200 }).filter((j) => j.status === "running");
      sendJson(response, 200, {
        gates: gateStats(),
        pacer: pacer.stats(),
        queue: jobQueue.status(),
        channels: configuredChannels(settings).map((c) => ({ provider: c.provider, weight: c.weight })),
        openrouter: {
          providers: OPENROUTER_PROVIDERS,
          modelChain: [settings.openrouterModel, ...OPENROUTER_FALLBACK_MODELS],
          modelHealth: Object.fromEntries(
            [...modelHealth.entries()].map(([m, h]) => [m, {
              fails: h.fails,
              down: h.downUntil > Date.now(),
              downForMs: Math.max(0, h.downUntil - Date.now()),
            }])
          ),
        },
        running: jobs.map((j) => ({ file: j.filename, page: j.page, total: j.total, detail: j.detail })),
      });
      return;
    }

    if (request.method === "GET" && request.url === "/api/settings") {
      sendJson(response, 200, publicSettings(await loadSettings()));
      return;
    }

    if (request.method === "POST" && request.url === "/api/settings") {
      const settings = await saveSettings(await readJson(request, 128 * 1024));
      sendJson(response, 200, publicSettings(settings));
      return;
    }

    if (request.method === "POST" && request.url === "/api/settings/test") {
      const supplied = await readJson(request, 128 * 1024);
      const stored = await loadSettings();
      const settings = normalizeSettings(supplied, stored);
      // Gemini：逐把测所有 key。只测主 key 的话，后面几把坏了要等真跑批量才发现。
      if (settings.provider === "gemini") {
        const pool = geminiKeyPool(settings);
        const keys = await Promise.all(
          pool.map(async (key, index) => {
            try {
              await callConfiguredModel({ ...settings, __key: key }, {}, true);
              return { index: index + 1, tail: key.slice(-4), ok: true };
            } catch (error) {
              return { index: index + 1, tail: key.slice(-4), ok: false,
                       reason: String(error?.message ?? error).slice(0, 160) };
            }
          })
        );
        const bad = keys.filter((k) => !k.ok);
        sendJson(response, 200, {
          ok: bad.length === 0,
          keys,
          reason: bad.length
            ? `${keys.length} 把 Key 中 ${bad.length} 把不可用：${bad.map((k) => `#${k.index}(…${k.tail})`).join("、")}`
            : `${keys.length} 把 Key 全部可用。`,
        });
        return;
      }
      const result = await callConfiguredModel(settings, {}, true);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && request.url === "/api/models") {
      const supplied = await readJson(request, 128 * 1024);
      const stored = await loadSettings();
      const settings = normalizeSettings(supplied, stored);
      sendJson(response, 200, await listConfiguredModels(settings));
      return;
    }

    if (request.method === "POST" && request.url === "/api/ai-refine") {
      const input = await readJson(request);
      if (!cleanString(input.imageBase64)) throw new Error("缺少页面图像。");
      const result = await callConfiguredModel(await loadSettings(), input, false);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && request.url === "/api/surya") {
      const job = await mkdtemp(jobRoot);
      const input = join(job, "document.pdf");
      const output = join(job, "surya");
      try {
        await pipeline(request, createWriteStream(input));
        await runSurya(input, output);
        const resultPath = await findResult(output);
        if (!resultPath) throw new Error("Surya completed without a results.json file.");
        const raw = JSON.parse(await readFile(resultPath, "utf8"));
        const pages = Object.values(raw)[0];
        if (!Array.isArray(pages)) throw new Error("Unexpected Surya result format.");
        sendJson(response, 200, { pages, engine: "surya-2" });
      } finally {
        await rm(job, { recursive: true, force: true });
      }
      return;
    }

    // ---- 任务：提交 / 查询 / 取消 / SSE ----
    if (request.method === "POST" && request.url?.startsWith("/api/jobs")) {
      // HTTP header 只能带 latin-1，中文文件名必须由前端 encodeURIComponent 后再解回来，
      // 否则「测试文档.pdf」会变成一堆乱码存进 Library。
      const rawName = cleanString(request.headers["x-filename"], "document.pdf");
      let filename = rawName;
      try {
        filename = decodeURIComponent(rawName);
      } catch {
        filename = rawName;
      }
      const mode = cleanString(request.headers["x-mode"], "fast");
      if (!["fast", "balanced", "math", "ai"].includes(mode)) throw new Error("未知的转换模式。");
      // 同一次批量提交带同一个 batch-id：Library 里就能按「合集」归组、整包下载。
      // 单份转换不带这个头，batch_id 留空，照旧显示为独立文件。
      const batchId = cleanString(request.headers["x-batch-id"]) || null;
      const batchLabel = batchId ? decodeHeader(request.headers["x-batch-label"]) : null;
      const id = randomUUID();
      const job = jobStore.create({ id, filename, fileSize: 0, mode, batchId, batchLabel });
      await pipeline(request, createWriteStream(jobStore.sourcePath(id)));
      const { size } = await stat(jobStore.sourcePath(id));
      jobStore.db.prepare("UPDATE jobs SET file_size = ? WHERE id = ?").run(size, id);
      jobQueue.enqueue(id);
      sendJson(response, 202, { job: { ...job, file_size: size } });
      return;
    }

    if (request.method === "GET" && request.url === "/api/jobs") {
      sendJson(response, 200, { jobs: jobStore.list({ limit: 200 }), queue: jobQueue.status() });
      return;
    }

    if (request.method === "GET" && request.url === "/api/events") {
      events.attach(request, response);
      return;
    }

    const cancelMatch = request.url?.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      sendJson(response, 200, { cancelled: jobQueue.cancel(cancelMatch[1]) });
      return;
    }

    // ---- Library：列表 / 结果 / 原始 PDF / 删除 ----
    if (request.method === "GET" && request.url === "/api/library") {
      const jobs = jobStore.list({ limit: 500 }).filter((job) => job.status === "done");
      sendJson(response, 200, { items: jobs });
      return;
    }

    // ---- 批次（合集）：一次批量提交归成一组，可整包下载 ----
    if (request.method === "GET" && request.url === "/api/batches") {
      sendJson(response, 200, { batches: jobStore.listBatches() });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/export/zip")) {
      const query = new URL(request.url, "http://127.0.0.1").searchParams;
      const batchId = query.get("batch");
      const explicitIds = (query.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);

      let jobs;
      let archiveName;
      if (batchId) {
        jobs = jobStore.listByBatch(batchId);
        archiveName = jobs.find((j) => j.batch_label)?.batch_label || `批次-${batchId.slice(0, 8)}`;
      } else if (explicitIds.length) {
        jobs = explicitIds.map((id) => jobStore.get(id)).filter(Boolean);
        archiveName = `墨页导出-${jobs.length}份`;
      } else {
        jobs = jobStore.list({ limit: 500 });
        archiveName = "墨页全部文档";
      }

      const finished = jobs.filter((job) => job.status === "done");
      if (!finished.length) throw new Error("这个批次还没有已完成的文档可以下载。");

      // 同名文件在 ZIP 里会互相覆盖（实测导出时就撞过一次），按出现次数加序号
      const used = new Map();
      const entries = [];
      for (const job of finished) {
        const result = await jobStore.readResult(job.id);
        if (typeof result?.markdown !== "string") continue;
        let base = safeEntryName(job.filename, job.id.slice(0, 8));
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        if (seen) base = `${base} (${seen + 1})`;
        entries.push({ name: `${base}.md`, content: result.markdown, date: new Date(job.updated_at) });
      }
      if (!entries.length) throw new Error("这些文档都没有可导出的内容。");

      const zip = createZip(entries);
      response.writeHead(200, {
        "Content-Type": "application/zip",
        // 文件名同时给 latin-1 兜底和 UTF-8 版本，中文名在各浏览器才都正常
        "Content-Disposition":
          `attachment; filename="moye-export.zip"; ` +
          `filename*=UTF-8''${encodeURIComponent(archiveName)}.zip`,
        "Content-Length": zip.length,
      });
      response.end(zip);
      return;
    }

    const resultMatch = request.url?.match(/^\/api\/library\/([\w-]+)$/);
    if (request.method === "GET" && resultMatch) {
      const job = jobStore.get(resultMatch[1]);
      if (!job) return sendJson(response, 404, { error: "记录不存在。" });
      const result = await jobStore.readResult(job.id);
      if (!result) return sendJson(response, 404, { error: "结果尚未生成。" });
      sendJson(response, 200, { job, result });
      return;
    }

    const pdfMatch = request.url?.match(/^\/api\/library\/([\w-]+)\/pdf$/);
    if (request.method === "GET" && pdfMatch) {
      const job = jobStore.get(pdfMatch[1]);
      if (!job) return sendJson(response, 404, { error: "记录不存在。" });
      cors(response);
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
      });
      createReadStream(jobStore.sourcePath(job.id)).pipe(response);
      return;
    }

    const deleteMatch = request.url?.match(/^\/api\/library\/([\w-]+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      jobQueue.cancel(deleteMatch[1]);
      await jobStore.delete(deleteMatch[1]);
      sendJson(response, 200, { deleted: true });
      return;
    }

    // 重跑 AI 精校：复用已存的本地初稿，不重新跑 Surya
    const refineMatch = request.url?.match(/^\/api\/library\/([\w-]+)\/refine$/);
    if (request.method === "POST" && refineMatch) {
      const source = jobStore.get(refineMatch[1]);
      if (!source) return sendJson(response, 404, { error: "记录不存在。" });
      const previous = await jobStore.readResult(source.id);
      if (!previous) return sendJson(response, 404, { error: "没有可复用的初稿。" });
      const id = randomUUID();
      jobStore.create({ id, filename: source.filename, fileSize: source.file_size, mode: "ai" });
      await copyFile(jobStore.sourcePath(source.id), jobStore.sourcePath(id));
      await writeFile(join(jobStore.dir(id), "previous.json"), JSON.stringify(previous), "utf8");
      jobQueue.enqueue(id);
      sendJson(response, 202, { job: jobStore.get(id) });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务处理失败。";
    const status = /API Key|缺少|有效的 JSON|过大|未知的转换模式/.test(message) ? 400 : 500;
    sendJson(response, status, { error: message });
  }
});

server.listen(port, "127.0.0.1", async () => {
  console.log(`墨页服务已就绪 http://127.0.0.1:${port}`);
  // 重启恢复：上次没跑完的任务，源文件还在就重新排队（对齐 Verbatim 的做法）
  const recovered = await jobStore.recover((job) => jobQueue.enqueue(job.id));
  if (recovered.requeued || recovered.failed) {
    console.log(`重启恢复：重新排队 ${recovered.requeued} 个，标记失败 ${recovered.failed} 个`);
  }
});
