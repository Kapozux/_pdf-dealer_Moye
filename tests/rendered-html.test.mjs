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
  assert.match(html, /<title>墨页 · PDF\/PPT\/Word\/图片 转 Markdown<\/title>/);
  assert.match(html, /拖放一个或多个 PDF/);
  assert.match(html, /本地 · 不上传/);
  assert.match(html, /accept="application\/pdf,.pdf,.ppt,.pptx,.doc,.docx,image\/\*/);
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
    // 仓库里存的是模板（安装时才填入绝对路径），不是渲染后的 .plist
    readFile(new URL("../launchd/com.kapozux.moye-web.plist.template", import.meta.url), "utf8"),
    readFile(new URL("../launchd/com.kapozux.moye-ocr.plist.template", import.meta.url), "utf8"),
  ]);

  assert.match(page, /download\(result\.markdown/);
  assert.match(page, /逐页质量/);
  assert.match(page, /pageTimeLabel/);          // 逐页耗时显示
  assert.match(library, /modelMs = Math\.round/);  // 服务端逐页计时
  assert.match(page, /AI 前后对照/);
  assert.match(page, /AI 精校设置/);
  assert.match(page, /Qwen 百炼/);
  assert.match(page, /Kimi K2\.6/);
  assert.match(page, /Qwen3\.8 Max Preview/);
  assert.match(page, /qwen-vl-ocr/);
  assert.match(page, /从服务商同步模型/);
  assert.match(page, /ModelPicker/);
  assert.match(page, /refineLibraryEntry/);
  assert.match(page, /只重跑 \{n\} 页回退页/);          // 只重跑回退页，不整份重来
  assert.match(ocrServer, /only === "fallback"/);
  assert.match(page, /下载 PDF/);                      // Markdown → PDF（结果页按钮 + 首页拖入 .md）
  assert.match(page, /isMarkdownFile/);
  assert.match(ocrServer, /\/api\/md2pdf/);
  assert.match(ocrServer, /document\.pdf/);
  assert.match(page, /原始 PDF/);
  assert.match(page, /你的分析资料库/);
  assert.match(page, /submitJob/);
  assert.match(page, /subscribeJobs/);   // 进度来自服务端 SSE，不是本地 state
  assert.match(page, /async function processFiles/);
  assert.match(page, /status === "batch"/);
  assert.match(page, /下载合并 \.md/);
  assert.match(page, /单个文件失败不会中断后续文件/);
  assert.match(page, /openRecord/);
  // 图片支持：走「转成 PDF 再复用现有管线」这条路，且模型能回答「图里没有字」
  assert.match(page, /IMAGE_EXTENSIONS/);
  assert.match(ocrServer, /image2pdf\.mjs/);
  assert.match(ocrServer, /noText/);
  // 反方向：很多图片 → 一份成品 PDF（不识别、不进队列），跟识别用的 image2pdf 是两条路
  assert.match(page, /mergeStagedImages/);
  assert.match(page, /合成一份 PDF · \{n\} 张图片/);
  assert.match(ocrServer, /\/api\/images2pdf\/part/);
  assert.match(ocrServer, /\/api\/images2pdf\/build/);
  // noText / 回退页的判定：行为测试见 tests/behaviour/page-result.test.mjs
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
  assert.match(ocrServer, /callOpenAiCompatible/);
  assert.match(ocrServer, /listConfiguredModels/);
  assert.match(ocrServer, /enable_thinking: false/);
  assert.match(launcher, /启动全部服务\.command/);
  assert.match(installer, /launchctl bootstrap/);
  assert.match(installer, /com\.kapozux\.moye-web/);
  assert.match(installer, /com\.kapozux\.moye-ocr/);
  assert.match(webAgent, /npm<\/string>\s*<string>run<\/string>\s*<string>start<\/string>/);
  assert.match(ocrAgent, /local-ocr-server\.mjs/);
  // Node 路径安装时才填：写死 /opt/homebrew 的话 Intel Mac / 不用 brew 的机器服务起不来
  assert.match(ocrAgent, /__NODE_DIR__\/node/);
  assert.doesNotMatch(webAgent, /\/opt\/homebrew\/bin\/npm/);
  // 本机 Ollama：走原生 /api/chat（能设 num_ctx），没 Key 也算配置好，按渠道单独给超时和并发
  assert.match(settings, /"ollama"/);
  assert.match(ocrServer, /\/api\/chat/);
  assert.match(ocrServer, /num_ctx: OLLAMA_NUM_CTX/);
  assert.match(ocrServer, /ollama: Number\(process\.env\.MOYE_TIMEOUT_OLLAMA\)/);
  assert.match(ocrServer, /是会「思考」的版本/);             // 思考版 qwen3-vl 实测结构化输出会坏，必须挡住
  assert.doesNotMatch(page, /value: "qwen3-vl:8b"/);          // 推荐的必须是 -instruct
  assert.match(page, /本机 Ollama/);
  assert.match(page, /aiStaysLocal/);
  // 「设置 → 环境」：检测 + 一键补装，安装逻辑只在 install.sh 一份
  assert.match(ocrServer, /\/api\/setup\/install/);
  assert.match(page, /panelPane === "setup"/);
  await access(new URL("../dist/client/pdf.worker.min.mjs", import.meta.url));
});

test("一键安装脚本：可重复运行、组件可单装、不写死 Homebrew", async () => {
  const [script, setupModule] = await Promise.all([
    readFile(new URL("../install.sh", import.meta.url), "utf8"),
    readFile(new URL("../server/setup.mjs", import.meta.url), "utf8"),
  ]);
  for (const component of ["python", "surya", "browser", "libreoffice", "ollama", "ollama-model"]) {
    assert.match(script, new RegExp(`\\b${component}\\)`), `install.sh --only ${component}`);
  }
  assert.match(script, /UV_UNMANAGED_INSTALL/);          // uv 装进项目，不改 shell 配置
  assert.match(script, /SHASUMS256/);                    // 下载的 Node 要校验
  assert.match(script, /llama-server/);                  // Surya 2 的推理引擎，漏了 Surya 跑不起来
  assert.match(setupModule, /"--only", name/);           // 页面里的按钮调的就是同一份脚本
  // 官方模型库在一些网络上下不动：两边都有魔搭镜像表 + 实测选源，别只剩一边
  assert.match(script, /modelscope\.cn\/Qwen\/Qwen3-VL-8B-Instruct-GGUF:Q4_K_M/);
  assert.match(setupModule, /modelscope\.cn\/Qwen\/Qwen3-VL-8B-Instruct-GGUF:Q4_K_M/);
  assert.match(script, /probe_speed/);
});

test("markdown → html keeps formulas, escapes raw html, and picks the first h1 as title", async () => {
  // 不碰 Chrome：只测渲染层，打印那一步依赖本机浏览器，见 server/md2pdf.mjs
  const { renderMarkdownHtml, markdownTitle } = await import("../server/md2pdf.mjs");
  const html = renderMarkdownHtml("# 标题\n\n行内 $E=mc^2$\n\n$$\\int_0^1 x\\,dx$$\n\n<script>alert(1)</script>\n");
  assert.match(html, /class="katex"/);
  assert.match(html, /katex-display/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(markdownTitle("# 标题\n\n正文"), "标题");
  assert.equal(markdownTitle("没有标题", "fallback"), "fallback");
  assert.equal(markdownTitle("# Economics\\_-\\_Tragakes"), "Economics_-_Tragakes");
  // 大文档分段打印：切口只在标题前，不落在代码块 / 公式块里，拼回去与原文一致
  const { splitMarkdownForPrint } = await import("../server/md2pdf.mjs");
  const source = "# A\n正文\n```\n# 代码里的井号\n```\n$$\n# 公式里\n$$\n## B\n正文\n";
  const parts = splitMarkdownForPrint(source, 4);
  assert.deepEqual(parts, ["# A\n正文\n```\n# 代码里的井号\n```\n$$\n# 公式里\n$$", "## B\n正文\n"]);
  assert.equal(splitMarkdownForPrint("# A\n\n\n", 1).length, 1); // 不会切出只有空行的一段
  assert.equal(parts.join("\n"), source);
});

test("图片合成 PDF：分片名能解回页序和原名（含中文与空格）", async () => {
  // 不碰 Pillow：合成本身要本机的 venv，这里只测「上传分片名 → 页序 + 原名」这一段纯逻辑。
  // 页序错了用户拿到的是乱序的一本书，是这条路最容易出问题、也最难一眼看出的地方。
  const { decodePartName } = await import("../server/images2pdf.mjs");
  assert.deepEqual(decodePartName(`0007-${encodeURIComponent("作业 第2页.jpg")}`), { index: 7, name: "作业 第2页.jpg" });
  assert.deepEqual(decodePartName("0010-IMG_10.HEIC"), { index: 10, name: "IMG_10.HEIC" });
  assert.equal(decodePartName("0002-%E4%B8%8D%E5%AE%8C%E6%95%B4%25.png").name.endsWith(".png"), true);
});
