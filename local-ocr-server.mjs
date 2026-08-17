#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const surya = resolve(root, "../.venv-marker/bin/surya_ocr");
const jobRoot = resolve(root, "tmp/pdfs/moye-web-job-");
const settingsPath = resolve(root, "settings.local.json");
const port = 8765;
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

function cors(response) {
  response.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
  response.setHeader("Access-Control-Allow-Headers", "content-type,x-filename");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function sendJson(response, status, payload) {
  cors(response);
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

const server = createServer(async (request, response) => {
  cors(response);
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

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "服务处理失败。";
    const status = /API Key|缺少|有效的 JSON|过大/.test(message) ? 400 : 500;
    sendJson(response, status, { error: message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Moye OCR and AI service ready at http://127.0.0.1:${port}`);
});
