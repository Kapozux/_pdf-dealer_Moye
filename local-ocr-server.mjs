#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { createZip, safeEntryName } from "./server/zip.mjs";
import { JobStore } from "./server/jobstore.mjs";
import { JobQueue, EventHub } from "./server/queue.mjs";
import { createConverter, gateStats } from "./server/convert.mjs";
import { isFallback } from "./lib/page-result.mjs";
import { maskedKey, splitKeys } from "./lib/key-pool.mjs";
import { foreignRequestReason, LOCAL_ORIGIN } from "./server/request-guard.mjs";
import { ALL_PROVIDERS, createSettingsStore, defaultSettings, normalizeSettings, providerConfigured } from "./server/settings.mjs";
import { createRenderer } from "./server/render.mjs";
import { createOfficeConverter, isOfficeFile } from "./server/office2pdf.mjs";
import { createImageConverter, isImageFile } from "./server/image2pdf.mjs";
import { createImageBookBuilder, decodePartName } from "./server/images2pdf.mjs";
import { stripSourceExtension } from "./server/filenames.mjs";
import { bundledHeadlessShell, forgetChromePath, markdownToPdf, markdownTitle, pdfGateStats } from "./server/md2pdf.mjs";
import { createSetup, findSoffice } from "./server/setup.mjs";
import { AdaptivePacer } from "./server/pacer.mjs";
import { createReflect } from "./server/reflect.mjs";
import { createUsage } from "./server/usage.mjs";

const root = dirname(fileURLToPath(import.meta.url));
// Python 环境（pypdfium2 渲染页面、Pillow 处理图片、可选的 Surya）。
// 老安装在仓库外的 ../.venv-marker；一键安装（install.sh）建在仓库里的 .venv，
// 不往用户目录里乱放东西。MOYE_VENV 可以指到别处。
const venv = process.env.MOYE_VENV
  ? resolve(process.env.MOYE_VENV)
  : [resolve(root, ".venv"), resolve(root, "../.venv-marker")].find((dir) => existsSync(join(dir, "bin/python")))
    ?? resolve(root, ".venv");
const venvPython = join(venv, "bin/python");
const surya = join(venv, "bin/surya_ocr");
const jobRoot = resolve(root, "tmp/pdfs/moye-web-job-");
const settingsPath = resolve(root, "settings.local.json");
// 用量记账（data/usage.db）：四条 provider 路径拿到响应体后各记一笔，归属靠 usage.scope 传
const usage = createUsage(resolve(root, "data"));
const port = Number(process.env.MOYE_PORT) || 8765;
const maxJsonBytes = 24 * 1024 * 1024;

const settingsStore = createSettingsStore(settingsPath);
const loadSettings = () => settingsStore.load();
const saveSettings = (patch) => settingsStore.save(patch);

await mkdir(resolve(root, "tmp/pdfs"), { recursive: true });

// 本机来源一律放行：写死 localhost:3000 时，用 127.0.0.1:3000 打开页面会被
// 浏览器整个拦掉（Library 看起来就是空的），而两个地址都指向同一台机器。

function cors(response, request) {
  const origin = request?.headers?.origin;
  response.setHeader(
    "Access-Control-Allow-Origin",
    origin && LOCAL_ORIGIN.test(origin) ? origin : "http://localhost:3000"
  );
  response.setHeader("Vary", "Origin");
  // 漏加自定义头 = 浏览器直接拦掉整个请求（之前 x-mode 漏过一次，表现是提交任务毫无反应）
  response.setHeader("Access-Control-Allow-Headers", "content-type,x-filename,x-mode,x-batch-id,x-batch-label,x-session,x-index");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
}

function sendJson(response, status, payload) {
  // CORS 头已在请求入口按 Origin 设置好，这里不要再覆盖
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendPdf(response, buffer, filename, extraHeaders = {}) {
  cors(response);
  response.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Length": buffer.length,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    ...extraHeaders,
  });
  response.end(buffer);
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


/** 所有可用的 Gemini key：主 key + 额外 key（各自是独立项目、独立配额）。 */
function geminiKeyPool(settings) {
  return [settings.geminiKey, ...splitKeys(settings.geminiKeysExtra)].map((k) => (k || "").trim()).filter(Boolean);
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

function publicSettings(settings) {
  const activeConfigured = settings.multiChannel
    ? configuredChannels(settings).length > 0
    : providerConfigured(settings, settings.provider);
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
    // Ollama 没有 Key 可打码：「已配置」= 选了模型。能不能连上是另一回事，看 /api/setup
    ollamaConfigured: Boolean(settings.ollamaModel),
    ollamaModel: settings.ollamaModel,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    aiScope: settings.aiScope,
    autoTag: settings.autoTag !== false,
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
- Put handwritten annotations in a final Markdown blockquote beginning with “手写批注：”. Group them by ink colour, one line per colour, each line prefixed with the colour in Chinese in full-width brackets: 【红笔】, 【蓝笔】, 【黑笔】, 【铅笔】, 【荧光笔】 (say the colour, e.g. 【黄色荧光笔】). Use the same 【颜色】 prefix inline for any printed text set in a non-black colour when the colour carries meaning (e.g. a red answer key, a blue correction). Do not tag black or grey printed body text.
- If a symbol truly cannot be read, write [unclear] instead of guessing.
- If the page holds no extractable text at all (a photograph, an illustration, a blank page, an unlabelled diagram), do not invent or describe text: set "noText" to true, leave "markdown" empty, and say in "note" what the image actually is, in one short phrase (e.g. "photo of a cat", "blank page", "unlabelled circuit diagram"). Otherwise "noText" is false and "note" is "".
- Return JSON only with this exact shape:
  {"markdown":"...","formulaCount":0,"questionNumbers":["1"],"optionLabels":["A","B"],"uncertain":["brief note"],"noText":false,"note":""}

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
    // 「这张图里根本没有字」是一个正常答案，不是失败。OpenAI 的 strict json_schema
    // 要求 required 列全所有字段，所以这两个也进 required，模型没话说时给 false/""。
    noText: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["markdown", "formulaCount", "questionNumbers", "optionLabels", "uncertain", "noText", "note"],
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

function normalizeAiResult(raw, provider, model, used = null) {
  const markdown = cleanString(raw.markdown);
  const note = cleanString(raw.note).slice(0, 200);
  // 模型说「这页没有可提取的文字」时，空 markdown 就是正确答案。以前这里一律抛错，
  // 一张风景照会被记成「AI 识别失败，已回退文字层」，用户根本分不清是模型炸了
  // 还是图里本来就没字（仓库规矩第四条：失败路径要留下真实原因，这条同样适用于
  // 「其实没失败」）。只有既没内容、也没给出说明时才算真失败。
  const noText = raw.noText === true || (!markdown && Boolean(note));
  if (!markdown && !noText) throw new Error("模型返回了空白 Markdown。");
  return {
    markdown,
    noText,
    note,
    formulaCount: Number.isFinite(raw.formulaCount) ? Math.max(0, Math.round(raw.formulaCount)) : 0,
    questionNumbers: Array.isArray(raw.questionNumbers) ? raw.questionNumbers.map(String).slice(0, 200) : [],
    optionLabels: Array.isArray(raw.optionLabels) ? raw.optionLabels.map(String).slice(0, 400) : [],
    uncertain: Array.isArray(raw.uncertain) ? raw.uncertain.map(String).filter(Boolean).slice(0, 30) : [],
    provider,
    model,
    // 这次调用的用量（token / 美元），由 usage.record* 返回；逐页写进结果，结果页能看每页花了多少。
    // 完整账在 usage.db，这里只是随手带一份，没有就不带。
    ...(used ? { usage: { inputTokens: used.inputTokens, outputTokens: used.outputTokens, costUsd: used.costUsd } } : {}),
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
  // 本机小模型：实测正常页 5～15s（2026-09-24，只测过一份 4 页文档），180s 是留给慢机器和死循环重试的余量
  ollama: Number(process.env.MOYE_TIMEOUT_OLLAMA) || 180000,
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
      // 先记账再解析：响应回来就已经花了钱，JSON 坏了也得算
      const used = usage.recordGemini(payload, model, { page: opts.page });
      const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
      if (testOnly) return { ok: true, provider: "gemini", model };
      return normalizeAiResult(extractJson(text), "gemini", model, used);
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
 * 所以兜底顺序不是按速度排的，是按「公式保真度」排的——理科文档丢公式等于白转。
 *
 * 2026-08-25：qwen/qwen3.7-flash 曾经也挂在这条链上（4.2 页/s、$0.00013/页，
 * 最快最便宜），但线上实测 OpenRouter 白名单五家现在对它全部返回
 * 404「No endpoints found for qwen/qwen3.7-flash」——这个模型在 OpenRouter
 * 上已经没有供应商在提供了。留着它只会让每次真正落到兜底链尾部时，
 * callOpenRouterFailover 白白把五家逐个试一遍再失败，纯粹浪费时间预算，
 * 于是摘掉。如果之后 OpenRouter 恢复了这个模型的供应商，可以加回来
 * （直连 Qwen 走的是另一条代码路径，不受这里影响，qwen3.7-flash 本身没坏）。
 */
const OPENROUTER_FALLBACK_MODELS = (process.env.MOYE_OPENROUTER_FALLBACK_MODELS
  || "z-ai/glm-5v-turbo").split(",").map((m) => m.trim()).filter(Boolean);

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
          { attempts: 1, timeoutMs: perTry, budgetMs: perTry + 2000, page: opts.page }
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
      // Moonshot 直连 API 对 kimi-k2.6 这类模型锁死了采样参数：温度传 0 会被
      // 拒绝——"invalid temperature: only 0.6 is allowed for this model"，
      // 实测直连测试时 400 就是这个。只在直连 Kimi 时用 0.6，其余渠道
      // （包括 OpenRouter 上转售的同名模型，走的是第三方主机，不受此限制）
      // 仍用 0——微调过、别顺手改回统一值。
      temperature: config.provider === "kimi" ? 0.6 : 0,
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
      // OpenRouter 只有带这个才会在 usage 里回实价（usage.cost），否则只回 token 数
      ...(config.provider === "openrouter" ? { usage: { include: true } } : {}),
      messages: [{ role: "user", content }],
    }),
  }, opts.attempts ?? 3, testOnly ? 60000 : (opts.timeoutMs ?? PAGE_CALL_TIMEOUT_MS),
     testOnly ? Infinity : Date.now() + (opts.budgetMs ?? PAGE_TIME_BUDGET_MS)).catch((error) => {
    // 强制推理的端点：记下来，之后这个模型都不再带该字段，然后立刻重发一次。
    if (config.provider === "openrouter" && !config.noReasoningToggle && /reasoning is mandatory/i.test(String(error?.message))) {
      forcedReasoningModels.add(config.model);
      return callOpenAiCompatible({ ...config, noReasoningToggle: true }, imageBase64, mimeType, draft, testOnly, opts)
        .then((result) => ({ __done: result }));
    }
    throw error;
  });
  if (payload?.__done) return payload.__done;
  // 先记账再解析：响应回来就已经花了钱，JSON 坏了也得算
  const used = usage.recordOpenAi(payload, config.provider, config.model, { page: opts.page });
  if (testOnly) return { ok: true, provider: config.provider, model: payload?.model || config.model };
  const responseContent = payload?.choices?.[0]?.message?.content || "";
  const text = Array.isArray(responseContent)
    ? responseContent.map((part) => typeof part === "string" ? part : part?.text || "").join("")
    : responseContent;
  return normalizeAiResult(extractJson(text), config.provider, payload?.model || config.model, used);
}

// ===== 本机 Ollama =====
//
// 走 Ollama 原生的 /api/chat，而不是它的 OpenAI 兼容层 /v1/chat/completions：
// 兼容层不能设上下文长度（num_ctx），而 Ollama 默认的上下文只有几千 token——
// 一页图像约 2–3k token，再加文字层初稿和提示词，会被**静默截掉前面的内容**，
// 模型看不到提示词也不报错（仓库规矩第四条）。原生接口还能直接给 JSON Schema（format）。
//
// 下面这些数字是按 8B 级视觉模型 + 16GB 内存的 Mac 估的，**还没有实测**，
// 跑过真实文档后按规矩改成实测值：
//   num_ctx 16384      ≈ 图像 3k + 提示 1k + 初稿 ≤6k + 输出 ≤6k；8B 模型 KV 缓存约 2.4GB
//   初稿截到 6000 字   云端给 60000 字，本机上下文装不下
//   单次超时 180s      本机小模型一页几十秒，给足余量；云端那套 30s 会把每页都判超时
//   并发 1             Ollama 默认一个模型只并行跑 1 路（OLLAMA_NUM_PARALLEL），
//                      多发只是在它那边排队，排队时间照样算进我们的超时
const OLLAMA_NUM_CTX = Number(process.env.MOYE_OLLAMA_NUM_CTX) || 16384;
const OLLAMA_DRAFT_CHARS = Number(process.env.MOYE_OLLAMA_DRAFT_CHARS) || 6000;
const OLLAMA_NUM_PREDICT = Number(process.env.MOYE_OLLAMA_NUM_PREDICT) || 6144;

const ollamaRoot = (settings) => String(settings.ollamaBaseUrl || defaultSettings.ollamaBaseUrl)
  .replace(/\/+$/, "").replace(/\/v1$/, "");   // 有人会照 OpenAI 习惯填 …/v1，这里容错

/** 连接失败时 fetch 只说 "fetch failed"，换成人话。 */
function ollamaUnreachable(settings, error) {
  const cause = String(error?.cause?.code || error?.message || error);
  return new Error(`连不上本机 Ollama（${ollamaRoot(settings)}）：${cause}。请确认 Ollama 已经打开（菜单栏有它的图标）。`);
}

/** 模型能力（vision / thinking）缓存：每页都去问一次 /api/show 没必要。 */
const ollamaCapabilities = new Map();   // `${root}|${model}` → string[]

async function ollamaModelCapabilities(settings, model) {
  const cacheKey = `${ollamaRoot(settings)}|${model}`;
  if (ollamaCapabilities.has(cacheKey)) return ollamaCapabilities.get(cacheKey);
  let response;
  try {
    response = await fetchWithTimeout(`${ollamaRoot(settings)}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    }, 15000);
  } catch (error) {
    throw ollamaUnreachable(settings, error);
  }
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error(`本机 Ollama 里还没有模型 ${model}。在「设置 → 环境」里一键下载，或终端运行：ollama pull ${model}`);
  if (!response.ok) throw new Error(`Ollama 读取模型信息失败（${response.status}）：${String(payload?.error || "").slice(0, 200)}`);
  // 老版本 Ollama（< 0.6）不回 capabilities，只能按名字猜；猜错了真跑时模型会自己报错
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities
    : [/vl|vision|llava|minicpm-v|gemma3|moondream|granite.*vision|ocr/i.test(model) ? "vision" : "completion"];
  ollamaCapabilities.set(cacheKey, capabilities);
  return capabilities;
}

async function callOllama(settings, imageBase64, draft, testOnly = false, opts = {}) {
  const model = settings.ollamaModel;
  if (!model) throw new Error("请先在设置里选择一个 Ollama 视觉模型。");
  // 「测试连接」必须真的去连一次：走缓存的话 Ollama 关了也会报成功
  if (testOnly) ollamaCapabilities.delete(`${ollamaRoot(settings)}|${model}`);
  const capabilities = await ollamaModelCapabilities(settings, model);
  if (!capabilities.includes("vision")) {
    throw new Error(`Ollama 模型 ${model} 不支持图片输入，AI 精校需要视觉模型（例如 qwen3-vl:8b-instruct、qwen2.5vl、gemma3）。`);
  }
  // 会思考的模型不能用。2026-09-24 实测（Ollama 0.34.3、官方 qwen3-vl:8b，它就是思考版）：
  //   think:false + JSON Schema → 回答被写进 message.thinking、content 为空，而且只有半截（275 token 就停）
  //   think:false、不给格式    → think:false 被无视，照样先想 1.4 万字
  // 同一页换成 Instruct 版（qwen3-vl:8b-instruct / 魔搭 Qwen3-VL-8B-Instruct-GGUF）一次就出合法 JSON。
  // 在「测试连接」就挡住，别等整份文档每页都回退了才发现。
  if (capabilities.includes("thinking")) {
    throw new Error(`Ollama 模型 ${model} 是会「思考」的版本，Ollama 关不掉它的思考，结构化输出会坏掉。请换成 Instruct 版，例如 qwen3-vl:8b-instruct。`);
  }
  if (testOnly) return { ok: true, provider: "ollama", model };
  const chat = async (sampling) => {
    try {
      return await postWithRetries(`${ollamaRoot(settings)}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          format: refinementSchema,
          options: { temperature: 0, ...sampling, num_ctx: OLLAMA_NUM_CTX, num_predict: OLLAMA_NUM_PREDICT },
          messages: [{
            role: "user",
            content: `${refinementPrompt}${draft.slice(0, OLLAMA_DRAFT_CHARS)}`,
            images: [imageBase64],
          }],
        }),
      }, opts.attempts ?? 2, opts.timeoutMs ?? providerTimeout("ollama"), Date.now() + (opts.budgetMs ?? PAGE_TIME_BUDGET_MS));
    } catch (error) {
      if (/fetch failed|ECONNREFUSED/i.test(String(error?.message)) || error?.cause?.code === "ECONNREFUSED") throw ollamaUnreachable(settings, error);
      throw error;
    }
  };
  let payload = await chat({});
  let used = usage.recordOllama(payload, model, { page: opts.page });
  // 输出到上限几乎都是「死循环」而不是页面真有那么多字。2026-09-24 实测（魔搭 Qwen3-VL-8B-Instruct Q4_K_M，
  // 一页 IB 物理作业，云端结果只有 372 字）：temperature 0 时在 JSON 字符串里无限输出 "\n"，写满 6144 token
  // 耗时约 100s；温度 0 是确定性的，补救轮原样重放又白等 167s。同一页换采样参数（各跑 2～4 次）：
  //   repeat_penalty 1.1        → 2.4s 出合法 JSON，但会把 JSON 里的 "\\frac" 写成 "\frac"，解析后公式变成「换页符+rac」，不能用
  //   presence_penalty 1.5（温度仍 0）→ 3.5s 出合法 JSON、公式完好、结果确定；代价是会吃掉选项之间的空行、偶尔丢页脚
  // 所以主轮保持原参数（空行对网页渲染有用），只有撞上限时才当场用 presence_penalty 重试一次。
  if (payload?.done_reason === "length") {
    console.warn(`[Ollama循环] 第 ${opts.page ?? "?"} 页输出写满 ${OLLAMA_NUM_PREDICT} token（多半是重复输出），换 presence_penalty 重试一次`);
    payload = await chat({ presence_penalty: 1.5 });
    used = usage.recordOllama(payload, model, { page: opts.page });
  }
  // 兜底：能力表没标 thinking、却还是把回答写进了思考字段（见上面的实测），说出真实原因
  if (!String(payload?.message?.content || "").trim() && payload?.message?.thinking) {
    throw new Error(`Ollama 模型 ${model} 把回答写进了「思考」字段、正文为空。请换成 Instruct 版模型。`);
  }
  // 输出到上限被截断时 JSON 是半截的，解析报错会误导人去查模型——先把真实原因说出来
  if (payload?.done_reason === "length") {
    throw new Error(`Ollama 输出达到上限（${OLLAMA_NUM_PREDICT} token）被截断：模型在重复输出，换采样参数重试也没停下来（也可能这一页内容确实太多，可调大 MOYE_OLLAMA_NUM_PREDICT）。`);
  }
  return normalizeAiResult(extractJson(String(payload?.message?.content || "")), "ollama", payload?.model || model, used);
}

/** 纯文本调用（打标签 / 回顾叙事）。 */
async function callOllamaText(settings, prompt, { model = null, maxTokens = 200, timeoutMs = 30000 } = {}) {
  const name = model || settings.ollamaModel;
  if (!name) throw new Error("Ollama 未选择模型。");
  let payload;
  try {
    payload = await postWithRetries(`${ollamaRoot(settings)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        stream: false,
        format: "json",
        options: { temperature: 0.3, num_ctx: 8192, num_predict: Math.max(maxTokens, 512) },
        ...((await ollamaModelCapabilities(settings, name)).includes("thinking") ? { think: false } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    // 本机模型第一次调用要先把几 GB 权重读进内存，给冷启动留时间
    }, 1, Math.max(timeoutMs, 120000), Date.now() + Math.max(timeoutMs, 120000));
  } catch (error) {
    if (/fetch failed|ECONNREFUSED/i.test(String(error?.message))) throw ollamaUnreachable(settings, error);
    throw error;
  }
  usage.recordOllama(payload, name);
  return String(payload?.message?.content || "");
}

/** 本机已下载的模型，标出哪些能看图。 */
async function listOllamaModels(settings) {
  let response;
  try {
    response = await fetchWithTimeout(`${ollamaRoot(settings)}/api/tags`, {}, 10000);
  } catch (error) {
    throw ollamaUnreachable(settings, error);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ollama 模型列表读取失败（${response.status}）。`);
  const models = [];
  for (const entry of payload.models || []) {
    const id = String(entry.model || entry.name || "");
    if (!id) continue;
    const capabilities = await ollamaModelCapabilities(settings, id).catch(() => []);
    models.push({ id, sizeBytes: Number(entry.size) || 0, vision: capabilities.includes("vision"), thinking: capabilities.includes("thinking") });
  }
  return models;
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
const DIRECT_PROVIDER_WEIGHTS = {
  openrouter: 8 * OPENROUTER_PROVIDERS.length, kimi: 8, qwen: 8,
  // 本机 Ollama 默认一次只算一路（OLLAMA_NUM_PARALLEL），多发只会在它那边排队、吃掉超时。
  // 用户若给 Ollama 调大了并行数，这里跟着调 MOYE_OLLAMA_CONCURRENCY。
  ollama: Number(process.env.MOYE_OLLAMA_CONCURRENCY) || 1,
};

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
  const allow = Array.isArray(settings.channels) && settings.channels.length ? settings.channels : null;
  return ALL_PROVIDERS
    .filter((provider) => providerConfigured(settings, provider) && (!allow || allow.includes(provider)))
    .map((provider) => ({ provider, weight: channelWeight(provider, settings) }));
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
  // 本机 Ollama 的补救轮不能用 25s：它正常一页就要几十秒，25s 等于必败。
  // 云端补救短超时的理由（对面「收下不回」）在本机不成立，本机慢就是慢。
  const rescueMs = provider === "ollama" ? perTry : RESCUE_TIMEOUT_MS;
  const opts = input.rescue
    ? { attempts: RESCUE_ATTEMPTS, timeoutMs: rescueMs, budgetMs: rescueMs + 2000 }
    // 按渠道给超时；总预算给足两轮，够它在同一家重试或换一家，但不至于无限拖
    : { timeoutMs: perTry, budgetMs: Math.max(PAGE_TIME_BUDGET_MS, perTry * 2) };
  opts.page = input.page;   // 记账用：这笔花在第几页
  if (provider === "gemini") {
    return callGemini(settings, input.imageBase64 || "", input.mimeType || "image/jpeg", input.draft || "", testOnly, opts);
  }
  if (provider === "ollama") {
    return callOllama(settings, input.imageBase64 || "", input.draft || "", testOnly, opts);
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
  if (settings.provider === "ollama") {
    // 只列能看图的：纯文本模型选了也跑不了精校
    // 只列能看图、且不是思考版的（思考版在精校里用不了，见 callOllama）
    const models = (await listOllamaModels(settings)).filter((model) => model.vision && !model.thinking);
    return { provider: "ollama", models: models.map((model) => ({ id: model.id, label: `${model.id} · ${(model.sizeBytes / 1e9).toFixed(1)} GB` })) };
  }
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

/**
 * 文档主题标签：转换完成后（不分模式）用当前配置的模型给文档打 2-4 个简短
 * 主题/类型标签，供 Library 统计面板的「关注领域」用。参考 getAudio 的
 * enrich.py：只读一小段内容、模型选便宜的就行，不走 aiGate/pacer 那整套节流
 * （量小——一份文档一次，没必要）。
 *
 * 这是用户自己决定要的行为：本地模式（fast/balanced）的文档本来"零上传"，
 * 打标签会为了这一小段摘要发一次内容出去，跟"本地模式不上传"不是同一件事——
 * 这是明确的取舍，不是应该"修复"掉的疏漏。没配置任何 AI Key 时这个功能
 * 本来就调不动，直接跳过（返回 null），不算失败。
 */
const CARD_PROMPT = (title, content) => `根据这份文档转换出的内容，生成用于列表卡片展示的元数据。

原文件名（已去后缀）：${title}
内容开头：
${content}

严格输出 JSON，不要输出其他任何内容：
{
  "title": "不超过18个字的标题，说清这份文档是什么，别照抄文件名",
  "one_line": "一句话简介，不超过40字，让人不点开就知道大致内容",
  "tags": ["2-4个简短的主题/类型标签，如：教材、试卷、论文、合同、小说、财报、计算机科学、数学、历史"],
  "filename_meaningful": true或false
}

filename_meaningful 的判断标准：上面的原文件名本身是不是一个能说明内容的、人写的标题。
像"A.2.10_MS_Circular_motion_exercise""高一物理必修一讲义"这种是 true；
像"Screenshot 2026-09-08 at 7.21.49 PM""Note Sep 7""IMG_0001""scan_0012""文档""下载""a1b2c3d4"
这种截图默认名、日期、序号、设备默认名、随机串是 false。
title / one_line / tags 用与内容相同的语言输出（内容是英文就用英文，是中文就用中文）。`;

/** 纯文本模型调用（打标签用），不带图像，走当前设置里选定的那一家 provider。 */
async function callTextModel(settings, prompt, { provider = settings.provider, model = null, maxTokens = 200, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  if (provider === "gemini") {
    if (!settings.geminiKey) throw new Error("Gemini 未配置 Key。");
    const key = nextGeminiKey(settings) || settings.geminiKey;
    const url = `${settings.geminiBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model || settings.geminiModel)}:generateContent`;
    const payload = await postWithRetries(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: Math.max(maxTokens, 1024) },
      }),
    }, 2, Math.min(20000, timeoutMs), deadline);
    usage.recordGemini(payload, model || settings.geminiModel);
    return payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  }
  if (provider === "ollama") return callOllamaText(settings, prompt, { model, maxTokens, timeoutMs });
  const config = directProviderConfig(provider, settings);
  if (!config?.key) throw new Error(`${config?.label ?? provider} 未配置 Key。`);
  const payload = await postWithRetries(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
    body: JSON.stringify({
      model: model || config.model,
      // kimi-k2.6 直连锁死温度：关推理时必须是 0.6，不关推理必须是 1（实测两条路各自
      // 唯一允许值不同）。这里漏加过 thinking 字段，导致温度传 0.6 却没关推理，
      // 135 份补标签全部 400——修的时候两个字段必须配对着改，见 callOpenAiCompatible。
      temperature: provider === "kimi" ? 0.6 : 0.3,
      messages: [{ role: "user", content: prompt }],
      ...(provider !== "qwen" ? { response_format: { type: "json_object" } } : {}),
      ...(provider === "kimi" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(provider === "kimi" && (model || config.model).startsWith("kimi-k2.6") ? { thinking: { type: "disabled" } } : {}),
      ...(provider === "openrouter" ? { usage: { include: true } } : {}),
    }),
  }, 2, Math.min(20000, timeoutMs), deadline);
  usage.recordOpenAi(payload, provider, model || config.model);
  const content = payload?.choices?.[0]?.message?.content || "";
  return Array.isArray(content) ? content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("") : content;
}

/**
 * 给一份已完成的任务生成卡片元数据：标签 + AI 标题 + 一句话 + 原文件名是否有意义。
 * 没配 Key、内容太短、模型失败都返回 null（调用方决定要不要重试）。
 */
async function generateCardMeta(job) {
  const settings = await loadSettings();
  if (!providerConfigured(settings, settings.provider)) return null;
  const result = await jobStore.readResult(job.id);
  const content = String(result?.markdown ?? "")
    .replace(/[#*`$|<>\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
  if (content.length < 20) return null;
  const raw = await usage.scope({ ref: job.id, purpose: "card" }, () =>
    callTextModel(settings, CARD_PROMPT(stripSourceExtension(job.filename), content), { maxTokens: 400 }));
  const parsed = extractJson(raw);
  const tags = Array.isArray(parsed?.tags)
    ? parsed.tags.map((t) => String(t).trim().slice(0, 10)).filter(Boolean).slice(0, 4)
    : [];
  if (!tags.length) return null;
  return {
    tags,
    title: String(parsed?.title ?? "").trim().slice(0, 30) || null,
    oneLine: String(parsed?.one_line ?? "").trim().slice(0, 60) || null,
    filenameMeaningful: typeof parsed?.filename_meaningful === "boolean" ? parsed.filename_meaningful : null,
  };
}

// ===== 服务端编排：存储 + 管线 + 队列 =====
// Surya 与 AI 调用以依赖注入方式交给管线（同进程直接调用，不再自己请求自己）。
const jobStore = new JobStore(resolve(root, "data"));

// 回顾叙事用的模型。原来配了 OpenRouter 就走 Claude Opus 4.6，一次刷新 4 个时段、
// 每次转换完还会重算，结果它一家吃掉了 usage.db 里 99% 的花销（58 次 ≈ $5.9）。
// 这活儿是把一份清单缩成一段话、文风还被 prompt 管死，换成 flash-lite 后单次几分钱、
// 三秒出结果，输出看不出差别。想用回大模型：REFLECT_OPENROUTER_MODEL=anthropic/claude-opus-4.6。
const REFLECT_GEMINI_MODEL = process.env.REFLECT_MODEL || "gemini-3.5-flash-lite";
const REFLECT_OPENROUTER_MODEL = (process.env.REFLECT_OPENROUTER_MODEL || "").trim();
// 中英合在一个请求里出，比单语言那会儿要宽的输出预算
const REFLECT_MAX_TOKENS = 3000;
async function generateReflectText(prompt) {
  return usage.scope({ purpose: "reflect", ref: null }, () => generateReflectTextInner(prompt));
}
async function generateReflectTextInner(prompt) {
  const settings = await loadSettings();
  if (REFLECT_OPENROUTER_MODEL && settings.openrouterKey) {
    try {
      return await callTextModel(settings, prompt, { provider: "openrouter", model: REFLECT_OPENROUTER_MODEL, maxTokens: REFLECT_MAX_TOKENS, timeoutMs: 120000 });
    } catch (error) {
      console.warn(`[回顾] OpenRouter/${REFLECT_OPENROUTER_MODEL} 失败，改用 Gemini：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  if (settings.geminiKey) {
    try {
      return await callTextModel(settings, prompt, { provider: "gemini", model: REFLECT_GEMINI_MODEL, maxTokens: REFLECT_MAX_TOKENS, timeoutMs: 120000 });
    } catch (error) {
      console.warn(`[回顾] Gemini/${REFLECT_GEMINI_MODEL} 失败，改用当前服务商：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  return callTextModel(settings, prompt, { maxTokens: REFLECT_MAX_TOKENS, timeoutMs: 120000 });
}
const reflect = createReflect({
  rows: () => jobStore.reflectRows(),
  generate: generateReflectText,
  dataDir: resolve(root, "data"),
});
const events = new EventHub();

async function runSuryaOnPdf(pdfPath) {
  // 没装 Surya 时以前报的是一句 spawn ENOENT，用户根本不知道缺什么
  if (!existsSync(surya)) {
    throw new Error("高精度（本地）模式需要 Surya，这台电脑还没装。打开「设置 → 环境」一键安装，或改用快速 / AI 精校模式。");
  }
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

// 渲染器两处用：AI 精校的页面图像（converter 里）和逐页核对的原图（/api/library/<id>/page/<n>.jpg）
const pageRenderer = createRenderer({ python: venvPython });

/**
 * 逐页核对要看的原图：按需渲染一页，最近 40 页留在内存（一页约 300KB）。
 * 存的是 Promise：预加载下一页和用户点下一页同时到，只起一次 Python。
 */
const pageImageCache = new Map();
function pageImage(id, page) {
  const key = `${id}:${page}`;
  const cached = pageImageCache.get(key);
  if (cached) {
    pageImageCache.delete(key);   // 挪到最新，按最近使用淘汰
    pageImageCache.set(key, cached);
    return cached;
  }
  const rendering = pageRenderer.renderPages(jobStore.sourcePath(id), [page], { quality: 82 }).then((images) => {
    const jpeg = Buffer.from(images[String(page)] ?? "", "base64");
    if (!jpeg.length) throw new Error(`第 ${page} 页渲染结果为空。`);
    return jpeg;
  });
  // 失败的不留在缓存里，下次还能重试；错误本身照样抛给这次的请求
  rendering.catch(() => pageImageCache.delete(key));
  pageImageCache.set(key, rendering);
  if (pageImageCache.size > 40) pageImageCache.delete(pageImageCache.keys().next().value);
  return rendering;
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
  renderer: pageRenderer,
});

// PPT/PPTX/Word（doc/docx）提交时先经 LibreOffice 转成 PDF，转完直接顶替 source.pdf
// 走上面这套转换管线，不单独写一份 Office 处理逻辑。soffice 路径可用 MOYE_SOFFICE 覆盖，
// 默认吃 PATH（brew 装的话会链到 /opt/homebrew/bin/soffice）；官网 .dmg 装的只在 LibreOffice.app 里，
// findSoffice 会去那里找。都找不到就留 "soffice"，装完（brew 会链进 PATH）不用重启也能用上。
const officeConverter = createOfficeConverter({
  soffice: process.env.MOYE_SOFFICE || findSoffice() || "soffice",
  timeoutMs: Number(process.env.MOYE_OFFICE_TIMEOUT_MS) || 120000,
});

// 图片（png/jpg/webp/bmp/tiff/gif/heic）同样先转成 PDF 再走上面这套管线。
// 用 Surya venv 里的 Pillow，HEIC 走 macOS 自带 sips——理由见 server/image2pdf.mjs 顶部。
const imageConverter = createImageConverter({
  python: venvPython,
  timeoutMs: Number(process.env.MOYE_IMAGE_TIMEOUT_MS) || 120000,
});

// 「很多图片 → 一份 PDF」是成品那条路（server/images2pdf.mjs），跟上面那个共用 venv
// 但不共用参数：那边为识别压到 4000px，这边一个像素都不缩。
const imageBook = createImageBookBuilder({
  python: venvPython,
  timeoutMs: Number(process.env.MOYE_IMAGEBOOK_TIMEOUT_MS) || 300000,
});
// 分片上传的暂存区：一次合成的图片先逐张流式落到这里，合成完（无论成败）立刻删。
const imageBookRoot = resolve(root, "tmp/images2pdf");

/** 会话 id 直接当目录名用，必须先挡住 ../ 之类的东西。 */
function imageBookSession(value) {
  const id = cleanString(value);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error("合成会话 id 不合法。");
  return id;
}

/** 扫掉没走到 build 就被放弃的暂存目录（页面中途关了、上传到一半断了）。 */
async function sweepImageBookSessions(maxAgeMs = 2 * 60 * 60 * 1000) {
  const entries = await readdir(imageBookRoot).catch(() => []);
  for (const entry of entries) {
    const dir = join(imageBookRoot, entry);
    const info = await stat(dir).catch(() => null);
    if (info && Date.now() - info.mtimeMs > maxAgeMs) await rm(dir, { recursive: true, force: true });
  }
}

// 「设置 → 环境」：组件检测 + 页面里一键补装（安装逻辑在 install.sh，这里只负责调起和汇报进度）
const setup = createSetup({
  root,
  venv,
  logFile: resolve(root, "logs/setup.log"),
  ollamaBase: () => ollamaRoot(currentSettingsSnapshot),
  listOllamaModels: () => listOllamaModels(currentSettingsSnapshot),
  onInstalled: async (component, task) => {
    if (component === "browser") forgetChromePath();
    if (component === "ollama-model") {
      ollamaCapabilities.clear();
      // 刚下好模型：还没选过 Ollama 模型、或选的那个根本用不了（思考版 / 不能看图）就换成它；
      // 一个 AI 都没配过就直接把 Ollama 设成当前服务。已经在用云端的不动 provider——换不换是用户的决定。
      // （2026-09-24：先拉了官方思考版 qwen3-vl:8b 写进设置，再下好魔搭 Instruct 版，设置里还是思考版，一用就报错）
      const settings = await loadSettings();
      const patch = {};
      const currentUsable = settings.ollamaModel
        && await ollamaModelCapabilities(settings, settings.ollamaModel)
          .then((caps) => caps.includes("vision") && !caps.includes("thinking"))
          .catch(() => false);
      if (!currentUsable) patch.ollamaModel = task.model;
      if (!publicSettings(settings).aiConfigured) Object.assign(patch, { provider: "ollama", ollamaModel: task.model });
      if (Object.keys(patch).length) {
        currentSettingsSnapshot = await saveSettings(patch);
        console.log(`[环境] 已把 Ollama 模型 ${task.model} 写进设置${patch.provider ? "，并设为当前 AI 服务" : ""}`);
      }
    }
  },
});
// setup 的回调是同步取地址的，用最近一次读到的设置；每次 /api/setup 前刷新
let currentSettingsSnapshot = defaultSettings;

const jobQueue = new JobQueue({
  store: jobStore,
  // 本机跑 Surya 很吃资源，默认串行（MOYE_CONCURRENCY 只调本机识别）。
  // AI 模式不受它影响：那边限的是文档并发，见 queue.mjs 的 MOYE_AI_JOB_CONCURRENCY。
  concurrency: Number(process.env.MOYE_CONCURRENCY) || 1,
  // 整份任务包在 usage.scope 里：底下每一次模型调用都记到这个 job.id 名下。
  // 跑完把费用摘要抄进 jobs 表（明细在 usage.db），Library 列表和结果页直接读。
  run: async (job, onProgress) => usage.scope({ ref: job.id, purpose: "refine" }, async () => {
    const result = await runJob(job, onProgress);
    jobStore.setCost(job.id, usage.costFor(job.id));
    return result;
  }),
});

async function runJob(job, onProgress) {
    const pdfPath = jobStore.sourcePath(job.id);
    const title = stripSourceExtension(job.filename);
    // 「重跑精校」的任务带着上次的初稿，直接复用，不重跑 Surya
    let previous = null;
    try {
      previous = JSON.parse(await readFile(join(jobStore.dir(job.id), "previous.json"), "utf8"));
    } catch {
      previous = null;
    }
    // 重跑范围（refine.json，由 /refine 路由写入）：只重跑回退页 / 全部重跑。
    // 单独放一个文件而不塞进 previous.json：失败时 previous 会原样当结果存回去，不能混进选项。
    let refineOptions = {};
    try {
      refineOptions = JSON.parse(await readFile(join(jobStore.dir(job.id), "refine.json"), "utf8"));
    } catch {
      refineOptions = {};
    }
    // 逐页存档：服务重启后从上次的页续跑，而不是整份重来
    const checkpoint = jobStore.checkpoint(job.id);
    if (previous) {
      // 重新精校现在是原地覆盖同一条记录（见 /refine 路由的说明）：失败绝不能让
      // 这份已经成功过的文档从 Library 消失。这里兜底——精校失败就把旧结果原样
      // 交回去（等同"这次没有变化"），但把真实原因记进 error 字段，不是静默吞掉，
      // 前端会在结果页显示"重新精校失败，已保留原结果"。
      try {
        return await converter.refineExisting(pdfPath, title, previous, onProgress, checkpoint, {
          pageNoun: isImageFile(job.filename) ? "图" : "页",
          only: refineOptions.only === "fallback" ? "fallback" : "all",
        });
      } catch (error) {
        console.warn(`[重新精校失败] ${job.filename}：${String(error?.message ?? error).slice(0, 200)}，已回退保留原结果`);
        jobStore.update(job.id, { error: `重新精校失败，已保留原结果：${String(error?.message ?? error).slice(0, 200)}` });
        return previous;
      }
    }
    return converter.convertPdf(pdfPath, title, job.mode, onProgress, checkpoint, {
      // 图片任务在这里已经是 PDF 了，但正文里再写「PDF 第 1 页」会让人莫名其妙
      pageNoun: isImageFile(job.filename) ? "图" : "页",
    });
}

jobQueue.on("job", (job) => events.broadcast("job", job));

// 转换完成后顺手打标签：不阻塞任务本身完成（fire-and-forget），失败按规则记日志，不静默吞掉。
// "job" 事件里 done 只在 queue.mjs 的 finally 里广播一次，不会为同一份文档重复触发；
// 但"重新精校"现在是原地重跑同一个 id，同一份文档会再走一次 done——已经打过
// 标签的不用重打，省一次没必要的调用（内容大概率还是那些主题）。
jobQueue.on("job", (job) => {
  if (job.status !== "done") return;
  reflect.touch();                       // 回顾：10 分钟防抖后后台重算，打开面板时已经是新的
  if (job.tags && job.ai_title) return;
  // 自动打标签是可关的（设置里）；"补标签"按钮是用户主动点的，不受这个开关影响
  void loadSettings()
    .then((settings) => (settings.autoTag === false ? null : generateCardMeta(job)))
    .then((card) => {
      if (!card) return;
      jobStore.setCardMeta(job.id, card);
      events.broadcast("job", jobStore.get(job.id));
    })
    .catch((error) => {
      console.warn(`[标签生成失败] ${job.filename}：${String(error?.message ?? error).slice(0, 160)}`);
    });
});

// 补标签进度：给已完成但还没打过标签的旧记录批量生成，仿 getAudio 的 "Auto-title"。
// 模块级状态即可——同一时间只需要一份进度，不需要为每次调用建任务表。
const tagBackfillState = { running: false, done: 0, total: 0, failed: 0 };
async function runTagBackfill() {
  // 没标签的、或有标签但还没有 AI 标题的（标题是后加的字段）都要补
  const pending = jobStore.list({ limit: 5000 }).filter((job) => job.status === "done" && (!job.tags || !job.ai_title));
  tagBackfillState.running = true;
  tagBackfillState.done = 0;
  tagBackfillState.total = pending.length;
  tagBackfillState.failed = 0;
  for (const job of pending) {
    try {
      const card = await generateCardMeta(job);
      if (card) {
        jobStore.setCardMeta(job.id, card);
        events.broadcast("job", jobStore.get(job.id));
      } else {
        tagBackfillState.failed += 1;
      }
    } catch (error) {
      tagBackfillState.failed += 1;
      console.warn(`[标签生成失败] ${job.filename}：${String(error?.message ?? error).slice(0, 160)}`);
    }
    tagBackfillState.done += 1;
    await sleep(300);   // 别把这一批打太快，跟正常转换任务抢配额
  }
  tagBackfillState.running = false;
  reflect.touch();                       // 补完标题/标签，回顾的原料变了
}

/** 「测试连接」：Gemini 逐把测 key；其它家测一次，OpenRouter 顺带报余额。 */
async function handleSettingsTest(settings, response) {
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
  // OpenRouter 能顺手报余额：GET /key 回 usage（已用美元）和 limit（上限，null = 无上限）。
  // 查不到就不带这一段，连接本身通了就算成功。
  if (settings.provider === "openrouter" && result?.ok) {
    try {
      const keyResponse = await fetchWithTimeout(`${settings.openrouterBaseUrl.replace(/\/$/, "")}/key`, {
        headers: { Authorization: `Bearer ${settings.openrouterKey}` },
      }, 15000);
      const data = (await keyResponse.json())?.data;
      if (keyResponse.ok && data && Number.isFinite(data.usage)) {
        result.balance = { usage: data.usage, limit: Number.isFinite(data.limit) ? data.limit : null };
      }
    } catch (error) {
      console.warn(`[测试连接] OpenRouter 余额查询失败：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  sendJson(response, 200, result);
}

// 外来请求每种原因只记一条日志：被某个网页反复探测时不刷屏，但第一次一定看得到
const loggedForeign = new Set();

const server = createServer(async (request, response) => {
  const foreign = foreignRequestReason(request.headers, port);
  if (foreign) {
    if (!loggedForeign.has(foreign) && loggedForeign.size < 100) {
      loggedForeign.add(foreign);
      console.warn(`[拒绝外来请求] ${request.method} ${String(request.url).slice(0, 80)}：${foreign}`);
    }
    response.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: `墨页只接受本机的请求（${foreign}）。` }));
    return;
  }
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
        gates: { ...gateStats(), pdf: pdfGateStats() },
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

    if (request.method === "GET" && request.url === "/api/setup") {
      const settings = await loadSettings();
      currentSettingsSnapshot = settings;
      const pub = publicSettings(settings);
      sendJson(response, 200, await setup.status({
        bundledBrowser: await bundledHeadlessShell(),
        ai: { ok: pub.aiConfigured, provider: settings.provider, ollamaModel: settings.ollamaModel },
      }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/setup/install") {
      const body = await readJson(request, 16 * 1024);
      currentSettingsSnapshot = await loadSettings();
      sendJson(response, 200, setup.install(cleanString(body.component), { model: cleanString(body.model) }));
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
      await usage.scope({ purpose: "test", ref: null }, () => handleSettingsTest(settings, response));
      return;
    }

    if (request.method === "GET" && request.url === "/api/usage") {
      sendJson(response, 200, usage.summary());
      return;
    }

    // 按模式的每页秒数中位数：首页模式说明里的「约 X 秒/页」和进度页的预计剩余时间都用它
    if (request.method === "GET" && request.url === "/api/speed") {
      sendJson(response, 200, jobStore.speedTable());
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
      // PPT/PPTX/Word 和图片都不是 PDF，得先转一道：整份收进内存交给转换器，
      // 转出来的 PDF 才落盘成 source.pdf。不能像 PDF 那样边收边写——
      // soffice 和 Pillow 都要一个完整文件才能转换。
      const preConvert = isOfficeFile(filename)
        ? { converter: officeConverter, label: "Office 文档" }
        : isImageFile(filename)
          ? { converter: imageConverter, label: "图片" }
          : null;
      if (preConvert) {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const pdfBuffer = await preConvert.converter.convertToPdf(Buffer.concat(chunks), filename);
          await writeFile(jobStore.sourcePath(id), pdfBuffer);
        } catch (error) {
          const message = error instanceof Error ? error.message : `${preConvert.label}转 PDF 失败。`;
          jobStore.update(id, { status: "failed", error: `${preConvert.label}转 PDF 失败：${message}` });
          throw new Error(`${preConvert.label}转 PDF 失败：${message}`);
        }
      } else {
        await pipeline(request, createWriteStream(jobStore.sourcePath(id)));
      }
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

    // ---- 回顾：这段时间在弄什么（叙事提前算好，缓存过期先给旧的） ----
    if (request.method === "GET" && request.url?.startsWith("/api/reflect")) {
      const query = new URL(request.url, "http://127.0.0.1").searchParams;
      const payload = await reflect.build(query.get("range") || "1m", query.get("lang") || "zh", query.get("refresh") === "1");
      sendJson(response, 200, payload);
      return;
    }

    // ---- 个人数据统计面板：总量 / 每日时间线 / 标签占比 ----
    if (request.method === "GET" && request.url === "/api/stats") {
      const totals = jobStore.statsTotals();
      const tagCounts = new Map();
      for (const row of jobStore.statsTagRows()) {
        let tags;
        try {
          tags = JSON.parse(row.tags);
        } catch {
          continue;   // 坏掉的 JSON 直接跳过，不让一条脏数据搞挂整个统计
        }
        if (!Array.isArray(tags)) continue;
        for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
      const topTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([tag, count]) => ({ tag, count }));
      // 按模式的份数/页数（资料库栏目的分段条）
      const byMode = {};
      for (const row of jobStore.reflectRows()) {
        const m = byMode[row.mode] || (byMode[row.mode] = { count: 0, pages: 0 });
        m.count += 1;
        m.pages += Number(row.page_count) || 0;
      }
      sendJson(response, 200, {
        totals: { transcripts: totals.transcripts, pages: totals.pages, chars: totals.chars },
        timeline: jobStore.statsTimeline(),
        topTags,
        byMode,
      });
      return;
    }

    // 给旧记录批量补标签（新完成的任务已经会自动打标签，这个只是回填历史）
    if (request.method === "POST" && request.url === "/api/tags/backfill") {
      if (tagBackfillState.running) {
        sendJson(response, 200, { ok: true, alreadyRunning: true, ...tagBackfillState });
        return;
      }
      void runTagBackfill();
      sendJson(response, 202, { ok: true, ...tagBackfillState });
      return;
    }

    if (request.method === "GET" && request.url === "/api/tags/backfill/status") {
      sendJson(response, 200, tagBackfillState);
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

    // Markdown → PDF（server/md2pdf.mjs，Chrome 无头打印）。两个入口：
    //   GET  /api/library/<id>/document.pdf  把 Library 里这份的 document.md 打成 PDF 下载
    //   POST /api/md2pdf {markdown, title}   任意 Markdown 文本 → PDF（首页拖入 .md 走这里）
    // 不落盘、不建任务：几秒就完，没必要进队列；出错直接把 Chrome 的原因回给页面。
    const docPdfMatch = request.url?.match(/^\/api\/library\/([\w-]+)\/document\.pdf$/);
    if (request.method === "GET" && docPdfMatch) {
      const job = jobStore.get(docPdfMatch[1]);
      if (!job) return sendJson(response, 404, { error: "记录不存在。" });
      if (job.status !== "done") return sendJson(response, 400, { error: "这份任务还没完成，暂时没有可导出的 Markdown。" });
      const markdown = await readFile(join(jobStore.dir(job.id), "document.md"), "utf8").catch(() => null);
      if (markdown === null) return sendJson(response, 404, { error: "没有找到这份文档的 Markdown。" });
      const pdf = await markdownToPdf(markdown, { title: stripSourceExtension(job.filename) });
      sendPdf(response, pdf, `${stripSourceExtension(job.filename)}.pdf`);
      return;
    }
    if (request.method === "POST" && request.url === "/api/md2pdf") {
      const body = await readJson(request);
      const markdown = typeof body?.markdown === "string" ? body.markdown : "";
      if (!markdown.trim()) return sendJson(response, 400, { error: "缺少 Markdown 内容。" });
      // title 是拖进来的 .md 文件名；没有就只用正文第一个标题起文件名，不印到 PDF 里
      const title = cleanString(body?.title).replace(/\.(md|markdown)$/i, "") || null;
      const pdf = await markdownToPdf(markdown, { title });
      sendPdf(response, pdf, `${title || markdownTitle(markdown)}.pdf`);
      return;
    }

    // 很多图片 → 一份 PDF（server/images2pdf.mjs）。跟 md2pdf 同一类旁路：不进队列、不进 Library、不识别。
    // 分两步上传是为了不把几十张照片一次性堆进内存（/api/jobs 那条路要整份进内存是因为
    // Pillow/soffice 需要完整文件，这里每张各自落盘就够）：
    //   POST /api/images2pdf/part   头 x-session / x-index / x-filename，body 是原始字节，边收边写
    //   POST /api/images2pdf/build  {session, title} → 按 x-index 排序合成，回 PDF，然后删掉暂存
    if (request.method === "POST" && request.url === "/api/images2pdf/part") {
      const session = imageBookSession(request.headers["x-session"]);
      const index = Math.min(Math.max(Number(request.headers["x-index"]) || 0, 0), 9999);
      const name = decodeHeader(request.headers["x-filename"], "image");
      if (!isImageFile(name)) throw new Error(`${name} 不是支持的图片格式。`);
      const dir = join(imageBookRoot, session);
      await mkdir(dir, { recursive: true });
      if ((await readdir(dir)).length >= 500) throw new Error("一次最多合成 500 张图片。");
      // 文件名 = 4 位页序 + "-" + encodeURIComponent(原名)：排序和报错都只靠它，
      // 不额外维护一份清单（清单和目录一旦不同步，排查起来最烦）
      const part = join(dir, `${String(index).padStart(4, "0")}-${encodeURIComponent(name).replace(/\//g, "%2F")}`);
      await pipeline(request, createWriteStream(part));
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && request.url === "/api/images2pdf/build") {
      const body = await readJson(request);
      const session = imageBookSession(body?.session);
      const dir = join(imageBookRoot, session);
      const entries = await readdir(dir).catch(() => []);
      if (!entries.length) return sendJson(response, 400, { error: "没有收到任何图片。" });
      const files = entries
        .map((entry) => ({ ...decodePartName(entry), path: join(dir, entry) }))
        .sort((a, b) => a.index - b.index);
      const title = cleanString(body?.title) || stripSourceExtension(files[0].name) || "图片";
      try {
        const { pdf, pages, skipped } = await imageBook.buildPdf(files);
        sendPdf(response, pdf, `${title}.pdf`, {
          // 跳过的图片必须回到页面上（规矩四：任何失败路径都要留下原因）。
          // PDF 响应体里塞不下 JSON，就走一个头；latin-1 限制所以整体编码过。
          "X-Moye-Pages": String(pages),
          "X-Moye-Skipped": encodeURIComponent(JSON.stringify(skipped)),
          "Access-Control-Expose-Headers": "X-Moye-Pages, X-Moye-Skipped",
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
        void sweepImageBookSessions();
      }
      return;
    }

    // 逐页核对的原图。图片不需要 CORS（<img> 直接加载），id 和页码都按正则卡死
    const pageImageMatch = request.url?.match(/^\/api\/library\/([\w-]+)\/page\/(\d+)\.jpg$/);
    if (request.method === "GET" && pageImageMatch) {
      const job = jobStore.get(pageImageMatch[1]);
      const page = Number(pageImageMatch[2]);
      if (!job) return sendJson(response, 404, { error: "记录不存在。" });
      if (page < 1 || (job.page_count && page > job.page_count)) return sendJson(response, 404, { error: "没有这一页。" });
      // 预转换失败的任务从来没有 source.pdf：先查，别让渲染进程去报一个看不懂的错
      const source = await stat(jobStore.sourcePath(job.id)).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (!source) return sendJson(response, 404, { error: "原文件不在了。" });
      if (!source.size) return sendJson(response, 404, { error: "原文件是空的（0 字节）。" });
      const jpeg = await pageImage(job.id, page);
      response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": jpeg.length, "Cache-Control": "private, max-age=86400" });
      response.end(jpeg);
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

    // 重跑 AI 精校：原地覆盖同一条 Library 记录，不再新建——
    // 新建会让 Library 无限增殖，还会丢掉原有的 batch_id（新记录变成孤儿，
    // 从合集里"消失"，实测找不到）。原地重跑顺带保住了 batch_id。
    const refineMatch = request.url?.match(/^\/api\/library\/([\w-]+)\/refine$/);
    if (request.method === "POST" && refineMatch) {
      const job = jobStore.get(refineMatch[1]);
      if (!job) return sendJson(response, 404, { error: "记录不存在。" });
      if (job.status !== "done") return sendJson(response, 400, { error: "这份任务还没完成，暂时不能重新精校。" });
      const previous = await jobStore.readResult(job.id);
      if (!previous) return sendJson(response, 404, { error: "没有可复用的初稿。" });
      // body 可选：{ only: "fallback" } 表示只重跑上次回退的页（见 convert.mjs 的 refineExisting）
      const body = await readJson(request);
      const only = body?.only === "fallback" ? "fallback" : "all";
      if (only === "fallback" && !(previous.pages ?? []).some(isFallback)) {
        return sendJson(response, 400, { error: "没有回退的页面需要重跑。" });
      }
      await jobStore.backupResult(job.id);   // 留一份 .prev 备份，万一这次结果更差还能手动捞回来
      await writeFile(join(jobStore.dir(job.id), "previous.json"), JSON.stringify(previous), "utf8");
      await writeFile(join(jobStore.dir(job.id), "refine.json"), JSON.stringify({ only }), "utf8");
      jobStore.update(job.id, {
        status: "queued",
        detail: only === "fallback"
          ? `重新精校排队中，只重跑 ${previous.pages.filter(isFallback).length} 页回退页，其余保留`
          : "重新精校排队中，正在复用当前结果作为初稿",
        error: null,
        page: 0,
      });
      jobQueue.enqueue(job.id);
      sendJson(response, 202, { job: jobStore.get(job.id) });
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
  reflect.startScheduler();              // 回顾提前算好：启动 90s 后首跑，之后每 6 小时
  console.log(`墨页服务已就绪 http://127.0.0.1:${port}`);
  // 重启恢复：上次没跑完的任务，源文件还在就重新排队（对齐 Verbatim 的做法）
  const recovered = await jobStore.recover((job) => jobQueue.enqueue(job.id));
  if (recovered.requeued || recovered.failed) {
    console.log(`重启恢复：重新排队 ${recovered.requeued} 个，标记失败 ${recovered.failed} 个`);
  }
  // 老记录补算回退页数（只在列刚加上的那次启动真正干活）
  jobStore.backfillFallbackCounts().then((n) => { if (n) console.log(`补算回退页数：${n} 份`); }).catch((error) => console.error("[补算回退页数失败]", error));
  jobStore.backfillDurations().then((n) => { if (n) console.log(`补算转换耗时：${n} 份`); }).catch((error) => console.error("[补算转换耗时失败]", error));
  // 图片合成 PDF 的暂存区：上次没走完的会话清一清（正常路径在 build 的 finally 里已经删了）
  sweepImageBookSessions().catch((error) => console.error("[清理图片暂存失败]", error));
});
