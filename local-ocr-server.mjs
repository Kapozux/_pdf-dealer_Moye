#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { JobStore } from "./server/jobstore.mjs";
import { JobQueue, EventHub } from "./server/queue.mjs";
import { createConverter } from "./server/convert.mjs";
import { createRenderer } from "./server/render.mjs";

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
  openrouterModel: "google/gemini-2.5-flash",
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
  aiScope: "all",
};

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
  response.setHeader("Access-Control-Allow-Headers", "content-type,x-filename,x-mode");
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

function normalizeSettings(input, previous = defaultSettings) {
  const provider = ["gemini", "kimi", "qwen", "openrouter"].includes(input.provider) ? input.provider : "gemini";
  const aiScope = input.aiScope === "review" ? "review" : "all";
  return {
    provider,
    geminiKey: cleanString(input.geminiKey) || previous.geminiKey || "",
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

function maskedKey(value) {
  if (!value) return "";
  return `••••••••${value.slice(-4)}`;
}

function publicSettings(settings) {
  const activeConfigured = Boolean({
    gemini: settings.geminiKey,
    kimi: settings.kimiKey,
    qwen: settings.qwenKey,
    openrouter: settings.openrouterKey,
  }[settings.provider]);
  return {
    provider: settings.provider,
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postWithRetries(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);
      const text = await response.text();
      if (response.ok) return JSON.parse(text);
      const message = (() => {
        try { return JSON.parse(text)?.error?.message || JSON.parse(text)?.error || text; } catch { return text; }
      })();
      const error = new Error(`模型请求失败（${response.status}）：${String(message).slice(0, 500)}`);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 900));
  }
  throw lastError || new Error("模型请求失败。");
}

async function callGemini(settings, imageBase64, mimeType, draft, testOnly = false) {
  if (!settings.geminiKey) throw new Error("请先在设置中填写 Gemini API Key。");
  const models = [settings.geminiModel, settings.geminiFallbackModel].filter((model, index, values) => model && values.indexOf(model) === index);
  let lastError;
  for (const model of models) {
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
        headers: { "Content-Type": "application/json", "x-goog-api-key": settings.geminiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            ...(testOnly ? {} : { responseJsonSchema: refinementSchema }),
          },
        }),
      });
      const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
      if (testOnly) return { ok: true, provider: "gemini", model };
      return normalizeAiResult(extractJson(text), "gemini", model);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Gemini 调用失败。");
}

async function callOpenAiCompatible(config, imageBase64, mimeType, draft, testOnly = false) {
  if (!config.key) throw new Error(`请先在设置中填写 ${config.label} API Key。`);
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
      messages: [{ role: "user", content }],
    }),
  });
  if (testOnly) return { ok: true, provider: config.provider, model: payload?.model || config.model };
  const responseContent = payload?.choices?.[0]?.message?.content || "";
  const text = Array.isArray(responseContent)
    ? responseContent.map((part) => typeof part === "string" ? part : part?.text || "").join("")
    : responseContent;
  return normalizeAiResult(extractJson(text), config.provider, payload?.model || config.model);
}

async function callConfiguredModel(settings, input, testOnly = false) {
  if (settings.provider === "gemini") {
    return callGemini(settings, input.imageBase64 || "", input.mimeType || "image/jpeg", input.draft || "", testOnly);
  }
  const providers = {
    kimi: {
      provider: "kimi", label: "Kimi", key: settings.kimiKey,
      model: settings.kimiModel, baseUrl: settings.kimiBaseUrl,
    },
    qwen: {
      provider: "qwen", label: "Qwen / 阿里百炼", key: settings.qwenKey,
      model: settings.qwenModel, baseUrl: settings.qwenBaseUrl,
    },
    openrouter: {
      provider: "openrouter", label: "OpenRouter", key: settings.openrouterKey,
      model: settings.openrouterModel, baseUrl: settings.openrouterBaseUrl,
    },
  };
  return callOpenAiCompatible(providers[settings.provider], input.imageBase64 || "", input.mimeType || "image/jpeg", input.draft || "", testOnly);
}

async function listConfiguredModels(settings) {
  if (settings.provider === "gemini") {
    if (!settings.geminiKey) throw new Error("请先在设置中填写 Gemini API Key。");
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
  runSurya: runSuryaOnPdf,
  refinePage: async (input) => callConfiguredModel(await loadSettings(), input, false),
  loadSettings: async () => publicSettings(await loadSettings()),
  renderer: createRenderer({ python: resolve(root, "../.venv-marker/bin/python") }),
});

const jobQueue = new JobQueue({
  store: jobStore,
  // 本机跑 Surya 很吃资源，默认串行；纯文字层模式很轻，用 MOYE_CONCURRENCY 可调。
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
    return previous
      ? converter.refineExisting(pdfPath, title, previous, onProgress)
      : converter.convertPdf(pdfPath, title, job.mode, onProgress);
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
      const id = randomUUID();
      const job = jobStore.create({ id, filename, fileSize: 0, mode });
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
