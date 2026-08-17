import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the finished PDF converter", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>墨页 · PDF 转 Markdown<\/title>/);
  assert.match(html, /拖放一个或多个 PDF/);
  assert.match(html, /本地处理 · 文件不上传/);
  assert.match(html, /accept="application\/pdf,.pdf"/);
  assert.match(html, /multiple=""/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|Your site is taking shape/);
});

test("ships local extraction, a persistent library, bundled workers, Surya, AI refinement, audit code, and managed startup", async () => {
  const [page, converter, settings, library, packageJson, ocrServer, launcher, installer, webAgent, ocrAgent] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/pdf-to-markdown.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/convert.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../local-ocr-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../start.command", import.meta.url), "utf8"),
    readFile(new URL("../安装开机自启.command", import.meta.url), "utf8"),
    readFile(new URL("../launchd/com.kapozux.moye-web.plist", import.meta.url), "utf8"),
    readFile(new URL("../launchd/com.kapozux.moye-ocr.plist", import.meta.url), "utf8"),
  ]);

  assert.match(page, /download\(result\.markdown/);
  assert.match(page, /逐页质量/);
  assert.match(page, /AI 前后对照/);
  assert.match(page, /AI 精校设置/);
  assert.match(page, /Qwen 百炼/);
  assert.match(page, /Kimi K2\.6/);
  assert.match(page, /Qwen3\.8 Max Preview/);
  assert.match(page, /qwen-vl-ocr/);
  assert.match(page, /从服务商同步模型/);
  assert.match(page, /ModelPicker/);
  assert.match(page, /refineLibraryEntry/);
  assert.match(page, /原始 PDF/);
  assert.match(page, /你的分析资料库/);
  assert.match(page, /submitJob/);
  assert.match(page, /subscribeJobs/);   // 进度来自服务端 SSE，不是本地 state
  assert.match(page, /async function processFiles/);
  assert.match(page, /status === "batch"/);
  assert.match(page, /下载合并 \.md/);
  assert.match(page, /单个文件失败不会中断后续文件/);
  assert.match(page, /openRecord/);
  // 转换在服务端跑：管线、AI 校验回退、公式保护都应在 server/convert.mjs
  assert.match(library, /export function createConverter/);
  assert.match(library, /validateAiPage/);
  assert.match(library, /公式区块已识别，但转换为 Markdown 时丢失/);
  // lib/pdf-to-markdown.ts 现在只剩前后端共用的类型，实现已在服务端
  assert.match(converter, /export type ConversionResult/);
  assert.match(converter, /rawMarkdown/);
  assert.doesNotMatch(converter, /convertPdf|GlobalWorkerOptions/);
  assert.match(settings, /\/api\/settings\/test/);
  assert.match(settings, /\/api\/models/);
  assert.match(settings, /"kimi"/);
  assert.match(settings, /"qwen"/);
  assert.match(packageJson, /"pdfjs-dist"/);
  assert.match(packageJson, /"tesseract\.js"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(packageJson, /"ocr-server": "node local-ocr-server\.mjs"/);
  assert.match(ocrServer, /SURYA_INFERENCE_BACKEND: "llamacpp"/);
  assert.match(ocrServer, /responseMimeType: "application\/json"/);
  assert.match(ocrServer, /settings\.local\.json/);
  assert.match(ocrServer, /\/api\/ai-refine/);
  assert.match(ocrServer, /api\.moonshot\.ai\/v1/);
  assert.match(ocrServer, /dashscope\.aliyuncs\.com\/compatible-mode\/v1/);
  assert.match(ocrServer, /callOpenAiCompatible/);
  assert.match(ocrServer, /listConfiguredModels/);
  assert.match(ocrServer, /enable_thinking: false/);
  assert.match(launcher, /启动全部服务\.command/);
  assert.match(installer, /launchctl bootstrap/);
  assert.match(installer, /com\.kapozux\.moye-web/);
  assert.match(installer, /com\.kapozux\.moye-ocr/);
  assert.match(webAgent, /npm<\/string>\s*<string>run<\/string>\s*<string>start<\/string>/);
  assert.match(ocrAgent, /local-ocr-server\.mjs/);
  await access(new URL("../dist/client/pdf.worker.min.mjs", import.meta.url));
});
