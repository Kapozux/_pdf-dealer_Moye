/**
 * 转换管线（服务端版）。
 *
 * 从 lib/pdf-to-markdown.ts 移植：版面/公式/表格的渲染规则、AI 结果校验与回退
 * 都逐条照搬，不做「顺手改进」——那些逻辑是调过的，重写只会引入回归。
 * 只替换掉三处浏览器专有实现：
 *   DOMParser        → linkedom
 *   canvas 渲染页面  → server/render.mjs（pypdfium2）
 *   fetch 自己的服务 → 依赖注入进来的函数（同进程直接调用，无网络跳转）
 *
 * Surya 与 AI 调用通过 deps 注入（参考 Verbatim harness 的 call_fn 注入），
 * 因此本模块无副作用、可单独测试。
 */

import { parseHTML } from "linkedom";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 读 PDF 文字层放在**短命子进程**里跑，而不是在服务进程里直接调 pdfjs。
 *
 * 实测（428MB、698 页的教材）：pdfjs 光 getTextContent 就把进程堆推到 3GB，
 * 逐页 page.cleanup()、loadingTask.destroy() 都放不掉（最多降到 2.6GB）——
 * 这是 pdfjs 在 Node 里的行为，服务进程只要碰过一次这种书就再也瘦不回去，
 * 之后每份大文档都往上叠，迟早 OOM。子进程读完把几 MB 的 JSON 交回来就退出，
 * 那 3GB 由操作系统整体回收，服务本体始终干净。
 * 进度走 stderr 的 `progress <page> <total>` 行，结果走 stdout。
 */
const TEXTLAYER_WORKER = join(dirname(fileURLToPath(import.meta.url)), "textlayer-worker.mjs");
const TEXTLAYER_TIMEOUT_MS = Number(process.env.MOYE_TEXTLAYER_TIMEOUT_MS) || 15 * 60 * 1000;

function runTextLayerWorker(pdfPath, args = [], onProgress = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // 大书的 pdfjs 堆会到 3GB+，Node 默认上限可能不够，子进程单独放宽
      ["--max-old-space-size=8192", TEXTLAYER_WORKER, pdfPath, ...args],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const stdoutChunks = [];
    let stderrTail = "";
    let lineBuffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`读取 PDF 文字层超时（${Math.round(TEXTLAYER_TIMEOUT_MS / 1000)}s 未完成）。`));
    }, TEXTLAYER_TIMEOUT_MS);
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => {
      lineBuffer += c;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop();
      for (const line of lines) {
        const m = line.match(/^progress (\d+) (\d+)$/);
        if (m) onProgress?.(Number(m[1]), Number(m[2]));
        else stderrTail = `${stderrTail}${line}\n`.slice(-4000);   // pdfjs 的 Warning 之类，只在失败时抛出
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderrTail.trim() || `文字层进程退出码 ${code}`));
      try {
        resolve(JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")));
      } catch {
        reject(new Error("文字层结果解析失败。"));
      }
    });
  });
}

/** @returns {Promise<{total:number, pages:object[]}>} 逐页文字层初稿 */
const extractTextLayer = (pdfPath, onProgress) => runTextLayerWorker(pdfPath, [], onProgress);
/** 只要页数：同样走子进程，避免为了一个数字在服务进程里解析整本书。 */
const pdfPageCount = async (pdfPath) => (await runTextLayerWorker(pdfPath, ["--count"])).total;

async function openPdf(pdfPath) {
  const buffer = await readFile(pdfPath);
  // 零拷贝视图。以前是 new Uint8Array(buffer)——那是复制，428MB 的文件先占 900MB。
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
}

const { Node: DomNode } = parseHTML("<html><body></body></html>");

// 一份文档内同时送多少页给模型。AI 调用是纯网络等待，串行等于把 86 页排成
// 86 段往返。实测这把 key 12 并发零限流，取 6 留足余量（可用 MOYE_AI_PAGE_CONCURRENCY 调）。
// 上游 postWithRetries 已对 429/5xx 退避重试，偶发限流不会丢页。
const AI_PAGE_CONCURRENCY = Number(process.env.MOYE_AI_PAGE_CONCURRENCY) || 6;

// AI 模式一次渲染几页（见 refineWithAi 里分块滚动渲染的说明）。
// 48 页 ≈ 1.5s 渲染 + ~25MB base64，远在单次 Python 调用的超时和内存舒适区内；
// 又比 aiGate 的并发（几十路）小一点，保证 worker 总能跨到下一组、预热不断档。
const RENDER_CHUNK = Math.max(1, Number(process.env.MOYE_RENDER_CHUNK_PAGES) || 48);

const median = (values) => {
  if (!values.length) return 12;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const escapeMarkdown = (text) =>
  text.replace(/([\\`*_{}[\]<>])/g, "\\$1").replace(/\s+/g, " ").trim();

function countFormulas(markdown) {
  return markdown.match(/\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$/g)?.length ?? 0;
}

function countOptions(markdown) {
  return markdown.match(/^\s*(?:[-*]\s*)?[A-D][.)]\s+/gim)?.length ?? 0;
}

function visibleLength(markdown) {
  return markdown.replace(/[#*`$|<>\\_\s]/g, "").length;
}

function renderHtmlNode(node, displayMath = false) {
  if (node.nodeType === DomNode.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== DomNode.ELEMENT_NODE) return "";
  const element = node;
  const tag = element.localName.toLowerCase();
  const children = Array.from(element.childNodes)
    .map((child) => renderHtmlNode(child, displayMath))
    .join("");
  if (tag === "math") {
    const latex = (element.textContent ?? "").trim();
    return latex ? (displayMath ? `\n$$${latex}$$\n` : `$${latex}$`) : "";
  }
  if (tag === "br") return "\n";
  if (/^h[1-6]$/.test(tag)) return `### ${children.trim()}\n\n`;
  if (tag === "p" || tag === "div" || tag === "section") return `${children.trim()}\n\n`;
  if (tag === "li") return `- ${children.trim()}\n`;
  if (tag === "ul" || tag === "ol") return `${children.trim()}\n\n`;
  if (tag === "strong" || tag === "b") return `**${children.trim()}**`;
  if (tag === "em" || tag === "i") return `*${children.trim()}*`;
  if (tag === "code") return `\`${children.trim()}\``;
  if (tag === "sup") return `<sup>${children.trim()}</sup>`;
  if (tag === "sub") return `<sub>${children.trim()}</sub>`;
  if (tag === "table") {
    const rows = Array.from(element.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll(":scope > th, :scope > td")).map((cell) =>
        Array.from(cell.childNodes)
          .map((child) => renderHtmlNode(child))
          .join("")
          .trim()
          .replace(/\|/g, "\\|")
      )
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((row) => row.length));
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    return [
      `| ${normalized[0].join(" | ")} |`,
      `| ${Array(width).fill("---").join(" | ")} |`,
      ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
      "",
    ].join("\n");
  }
  return children;
}

function suryaHtmlToMarkdown(html, displayMath = false) {
  const parsed = parseHTML(`<html><body>${html}</body></html>`).document;
  const rendered = Array.from(parsed.body.childNodes)
    .map((node) => renderHtmlNode(node, displayMath))
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const missingFormula = Array.from(parsed.querySelectorAll("math"))
    .map((node) => (node.textContent ?? "").trim())
    .find((latex) => latex && !rendered.includes(latex));
  if (missingFormula) throw new Error("公式区块已识别，但转换为 Markdown 时丢失。请重新识别。");
  return rendered;
}

function renderSuryaPage(page, pageNumber) {
  const blocks = [...(page.blocks ?? [])]
    .sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0))
    .filter((block) => !["PageHeader", "PageFooter"].includes(block.label ?? ""));
  const hasVisual = blocks.some((block) => ["Picture", "Diagram"].includes(block.label ?? ""));
  const markdown = blocks
    .map((block) => {
      if (["Picture", "Diagram"].includes(block.label ?? "") && !block.html) {
        return "_[图像或示意图：请对照原 PDF]_";
      }
      return block.html ? suryaHtmlToMarkdown(block.html, block.label === "Equation") : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const reasons = [];
  if (blocks.some((block) => block.error)) reasons.push("本地视觉识别报告了异常区块");
  if (hasVisual) reasons.push("包含图像或示意图，建议核对");
  if (!markdown) reasons.push("本地高精度识别后仍未检测到文字");
  return {
    page: pageNumber,
    markdown,
    charCount: visibleLength(markdown),
    lineCount: markdown ? markdown.split(/\n+/).length : 0,
    method: markdown ? "surya" : "empty",
    status: reasons.length ? "review" : "good",
    reasons,
    formulaCount: countFormulas(markdown),
    optionCount: countOptions(markdown),
  };
}

function linesToMarkdown(items) {
  const rows = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find(
      (candidate) => Math.abs(candidate[0].y - item.y) <= Math.max(2.5, item.size * 0.24)
    );
    if (row) row.push(item);
    else rows.push([item]);
  }
  const bodySize = median(items.map((item) => item.size).filter((size) => size > 3));
  const rendered = rows
    .map((row) => {
      row.sort((a, b) => a.x - b.x);
      let text = "";
      let edge = 0;
      for (const item of row) {
        if (text && item.x - edge > Math.max(2.5, item.size * 0.24)) text += " ";
        text += item.text;
        edge = item.x + item.width;
      }
      return {
        text: escapeMarkdown(text),
        size: row.reduce((sum, item) => sum + item.size, 0) / row.length,
        y: row[0].y,
      };
    })
    .filter((line) => line.text);
  const output = [];
  for (let index = 0; index < rendered.length; index += 1) {
    const line = rendered[index];
    if (line.size > bodySize * 1.55 && line.text.length < 100) output.push(`### ${line.text}`);
    else if (line.size > bodySize * 1.28 && line.text.length < 120) output.push(`#### ${line.text}`);
    else if (/^[•●▪◦]\s*/.test(line.text)) output.push(`- ${line.text.replace(/^[•●▪◦]\s*/, "")}`);
    else if (/^\d+[.)]\s+/.test(line.text)) output.push(line.text.replace(/^(\d+)[.)]\s+/, "$1. "));
    else {
      const previous = output.at(-1);
      const verticalGap = index ? rendered[index - 1].y - line.y : 0;
      if (previous && !previous.startsWith("#") && !previous.startsWith("-") && verticalGap < bodySize * 1.75) {
        output[output.length - 1] = previous.endsWith("-")
          ? previous.slice(0, -1) + line.text
          : `${previous} ${line.text}`;
      } else output.push(line.text);
    }
  }
  return output.join("\n\n");
}


/**
 * 全局 AI 调用闸（可调容量）。
 *
 * fanout 的并发是**每份文档**的，而队列同时会跑好几个 AI 任务：
 * 4 个任务 × 每个 64 路 = 256 路同时在飞，实测那个量级 60% 的请求会吃 429。
 * 真正该限制的是「此刻打向模型的请求总数」，所以闸放在模块级，所有任务共用一份，
 * 跟 queue.mjs 里 job 级并发用全局信号量是同一个道理。
 */
const aiGate = {
  limit: 6,
  inFlight: 0,
  waiters: [],
  setLimit(next) {
    this.limit = Math.max(1, next);
    this._drain();
  },
  _drain() {
    while (this.inFlight < this.limit && this.waiters.length) {
      this.inFlight += 1;
      this.waiters.shift()();
    }
  },
  async run(fn) {
    if (this.inFlight >= this.limit) await new Promise((r) => this.waiters.push(r));
    else this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      this._drain();
    }
  },
};

/**
 * 渲染闸。每份文档渲染页面都要 spawn 一个 Python 进程（pypdfium2）。
 *
 * 这里的数字曾经设成 4，结果它自己成了瓶颈：38 份文档同时跑时有 22 份卡在
 * 「正在生成图像」，AI 那边反而闲着。实测证明这个担心是多余的——单次渲染
 * 72–79ms，8 路并发**总共** 94ms（几乎完全并行，spawn 开销可以忽略）。
 * 所以闸的作用只剩下防止极端情况下几百个 Python 进程同时存在，放宽到 16。
 */
const renderGate = {
  limit: Math.max(1, Number(process.env.MOYE_RENDER_CONCURRENCY) || 16),
  inFlight: 0,
  waiters: [],
  async run(fn) {
    if (this.inFlight >= this.limit) await new Promise((r) => this.waiters.push(r));
    else this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      if (this.waiters.length && this.inFlight < this.limit) {
        this.inFlight += 1;
        this.waiters.shift()();
      }
    }
  },
};

/**
 * 并发 map，**保序**。单个失败不影响其他（错误由调用方在 fn 内部处理）。
 * 对应 Verbatim harness 的 fanout —— 页面级 AI 调用是纯网络等待，
 * 一页一页串行等于把一份 86 页的文档排成 86 段串行网络往返。
 */
async function fanout(items, fn, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function extractFastPages(pdfDoc, onProgress) {
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    onProgress(pageNumber - 1, pdfDoc.numPages, `读取第 ${pageNumber} 页文字层`);
    const page = await pdfDoc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = [];
    for (const raw of content.items) {
      if (!("str" in raw) || !raw.str.trim()) continue;
      items.push({
        text: raw.str,
        x: raw.transform[4],
        y: raw.transform[5],
        width: raw.width,
        size: Math.max(1, Math.hypot(raw.transform[2], raw.transform[3])),
      });
    }
    const markdown = linesToMarkdown(items);
    const reasons =
      items.map((item) => item.text).join("").trim().length < 30
        ? ["文字层过少；扫描页或公式页请改用本地高精度"]
        : [];
    pages.push({
      page: pageNumber,
      markdown,
      charCount: visibleLength(markdown),
      lineCount: markdown ? markdown.split(/\n+/).length : 0,
      method: markdown ? "text" : "empty",
      status: reasons.length ? "review" : "good",
      reasons,
      formulaCount: countFormulas(markdown),
      optionCount: countOptions(markdown),
    });
    onProgress(pageNumber, pdfDoc.numPages, `第 ${pageNumber} 页完成`);
  }
  return pages;
}

function validateAiPage(draft, refined) {
  const failures = [];
  const draftLength = visibleLength(draft.markdown);
  const finalLength = visibleLength(refined.markdown ?? "");
  const finalFormulaCount = countFormulas(refined.markdown ?? "");
  const finalOptionCount = countOptions(refined.markdown ?? "");
  if (!(refined.markdown ?? "").trim()) failures.push("模型返回空白内容");
  if (draftLength >= 120 && finalLength < Math.max(80, draftLength * 0.45)) {
    failures.push("模型结果比本地初稿短太多");
  }
  if ((draft.formulaCount ?? 0) > 0 && finalFormulaCount < (draft.formulaCount ?? 0)) {
    failures.push("模型结果丢失了本地已识别公式");
  }
  if ((draft.optionCount ?? 0) >= 2 && finalOptionCount < (draft.optionCount ?? 0)) {
    failures.push("模型结果丢失了选项标签");
  }
  return { failures, finalFormulaCount, finalOptionCount };
}

function assembleResult(title, mode, pageCount, pages, startedMs) {
  const aiPages = pages.filter((page) => page.method === "ai").length;
  const provenance =
    mode === "ai"
      ? `由视觉模型直接识别 ${aiPages}/${pageCount} 页；PDF 文字层作为提示与回退，识别未通过校验的页面回退文字层。`
      : mode === "fast"
        ? "直接读取 PDF 文字层，文件未上传。"
        : "使用本机 Surya 解析版面与公式，文件未上传。";
  const markdown =
    [
      `# ${escapeMarkdown(title)}`,
      "",
      `> 由墨页转换，共 ${pageCount} 页。${provenance}`,
      "",
      ...pages.flatMap((page) => [
        `## PDF 第 ${page.page} 页`,
        "",
        page.markdown || "_[此页未检测到文字，请查看原始 PDF。]_",
        "",
        "---",
        "",
      ]),
    ]
      .join("\n")
      .trim() + "\n";
  return {
    title,
    mode,
    pageCount,
    markdown,
    pages,
    durationMs: Math.round(performance.now() - startedMs),
  };
}

/**
 * @param {object} deps
 * @param {(pdfPath: string) => Promise<{pages: any[]}>} deps.runSurya  本机 Surya
 * @param {(input: {imageBase64, mimeType, draft, page}) => Promise<object>} deps.refinePage  视觉模型精校
 * @param {() => Promise<object>} deps.loadSettings
 * @param {{renderPages: Function}} deps.renderer
 */
export function createConverter({ runSurya, refinePage, loadSettings, renderer, aiPageConcurrency }) {
  // 并发上限：可传函数（按供应商 / key 数动态算），否则用默认值。
  // 每次解析完都同步给全局闸——用户在设置里换了供应商，下一份文档就按新上限跑。
  async function pageConcurrency() {
    const limit = typeof aiPageConcurrency === "function"
      ? Math.max(1, await aiPageConcurrency())
      : Math.max(1, aiPageConcurrency || AI_PAGE_CONCURRENCY);
    aiGate.setLimit(limit);
    return limit;
  }

  async function convertWithSurya(pdfPath, total, onProgress) {
    onProgress(0, total, "正在使用 Surya 逐页解析版面、表格与公式（首次会较慢）");
    const payload = await runSurya(pdfPath);
    const pages = payload?.pages;
    if (!Array.isArray(pages)) throw new Error("Surya 本地视觉识别失败。");
    if (pages.length !== total) {
      throw new Error(`Surya 返回 ${pages.length} 页，但 PDF 有 ${total} 页。`);
    }
    onProgress(total, total, "本地高精度初稿完成");
    return pages.map((page, index) => renderSuryaPage(page, index + 1));
  }

  /**
   * 单页精校。AI 调用失败时返回带 aiFailed 标记的回退结果，供补救轮识别。
   * @param {(page:number)=>Promise<string>} getImage 取该页 base64 JPEG（按需渲染，见 refineWithAi）
   */
  async function refineOne(draft, getImage, rescue = false) {
    try {
      const imageBase64 = await getImage(draft.page);
      if (!imageBase64) throw new Error("页面图像生成失败。");
      // 过全局闸：并发上限约束的是「所有任务合计在飞的请求数」，不是单份文档的
      const refined = await aiGate.run(() => refinePage({
        page: draft.page,
        draft: draft.markdown,
        imageBase64,
        mimeType: "image/jpeg",
        rescue,   // 补救轮：只试一次、超时更短，失败就痛快回退
      }));
      const validation = validateAiPage(draft, refined);
      if (validation.failures.length) {
        return {
          ...draft,
          rawMarkdown: draft.markdown,
          aiAttempted: true,
          status: "review",
          reasons: [...draft.reasons, `AI 结果未通过程序校验：${validation.failures.join("；")}`],
          model: refined.model,
          provider: refined.provider,
        };
      }
      const uncertain = refined.uncertain ?? [];
      const reasons = [...uncertain.map((item) => `模型标记不确定：${item}`)];
      if (refined.markdown.includes("[unclear]")) reasons.push("结果中仍有无法辨认的符号");
      return {
        page: draft.page,
        markdown: refined.markdown.trim(),
        rawMarkdown: draft.markdown,
        charCount: visibleLength(refined.markdown),
        lineCount: refined.markdown.trim().split(/\n+/).length,
        method: "ai",
        status: reasons.length ? "review" : "good",
        reasons,
        model: refined.model,
        provider: refined.provider,
        formulaCount: validation.finalFormulaCount,
        optionCount: validation.finalOptionCount,
        uncertain,
        aiAttempted: true,
      };
    } catch (error) {
      // 以前这里静默吞掉：AI 失败只体现为「某页回退了文字层」，日志里一个字都没有，
      // 排查时只能靠猜。失败原因是唯一能区分「超时 / 限流 / 认证 / 格式」的线索。
      console.warn(`[AI失败] 第 ${draft.page} 页：${String(error?.message ?? error).slice(0, 160)}`);
      return {
        ...draft,
        rawMarkdown: draft.markdown,
        aiAttempted: true,
        aiFailed: true, // 补救轮的筛选标记，成功产出前必须清掉
        status: "review",
        reasons: [
          ...draft.reasons,
          draft.markdown
            ? `AI 识别失败，已回退 PDF 文字层：${error?.message ?? "未知错误"}`
            : `AI 识别失败，且此页没有文字层可回退：${error?.message ?? "未知错误"}`,
        ],
      };
    }
  }

  async function refineWithAi(pdfPath, drafts, onProgress, checkpoint = null) {
    const settings = await loadSettings();
    if (!settings.aiConfigured) {
      throw new Error("AI 精校尚未配置。请点击右上角“设置”，填写当前服务的 API Key。");
    }
    // 重启续跑：已经存档的页直接拿来用，不重新调模型也不重新渲染
    const finishedPages = checkpoint ? await checkpoint.load() : new Map();
    if (finishedPages.size) {
      onProgress(finishedPages.size, drafts.length, `续跑：已有 ${finishedPages.size} 页存档，跳过`);
    }
    // 注意：初稿现在来自文字层，大多数页会是 "good"。若仍按 review 过滤，
    // 选了 AI 却几乎没有页面被精校，所以 aiScope=all 时一律精校。
    const targets = drafts.filter(
      (draft) =>
        !finishedPages.has(draft.page) &&
        (settings.aiScope === "all" ||
          draft.status === "review" ||
          (draft.formulaCount ?? 0) > 0 ||
          (draft.optionCount ?? 0) > 0)
    );
    /**
     * 分块滚动渲染，而不是一次把所有页渲染完再开始。
     *
     * 老做法是「需要的页一次性渲染」——对几十页没问题，但 698 页那份实测：
     * 渲染本身只要 22s（31ms/页），可每页 base64 约 510KB，698 页拼成一个
     * ~350MB 的 JSON 经 stdout 传回，120s 硬超时前根本传不完（就算传完，
     * 一份文档的全部图像还要在内存里驻留到最后一页精校结束）。
     *
     * 现在按 RENDER_CHUNK 页一组：某页的 worker 要图时才触发它所在那组的渲染
     * （同组只渲染一次，Promise 记忆化），并顺手预热下一组，让 AI 并发不必在
     * 组边界上停等；一组的页全部精校完就把这组图像丢掉。内存上限从「整份文档」
     * 变成「约两组」，单次 Python 调用也只有几秒——多大的文档都是同一个常数开销。
     * 不需要把 PDF 拆成几个小文件排队：一条记录、一份 document.md、逐页存档照旧。
     */
    const chunks = [];
    for (let i = 0; i < targets.length; i += RENDER_CHUNK) {
      chunks.push(targets.slice(i, i + RENDER_CHUNK).map((d) => d.page));
    }
    const chunkOfPage = new Map();
    chunks.forEach((pages, k) => pages.forEach((p) => chunkOfPage.set(p, k)));
    const chunkPending = chunks.map((pages) => pages.length);   // 该组还有几页没精校完
    const chunkImages = new Map();                               // k → Promise<{page: base64}>
    const renderChunk = (k) => {
      // 已经全部处理完（图像已释放）的组不再碰：两组并行渲染时后一组可能先跑完，
      // 前一组的 worker 醒来后"预热下一组"会把它重新渲染一遍——实测多渲染整整 48 页。
      if (k < 0 || k >= chunks.length || chunkPending[k] <= 0 || chunkImages.has(k)) return chunkImages.get(k);
      const promise = renderGate.run(() => renderer.renderPages(pdfPath, chunks[k]));
      // 渲染失败不能让整份文档炸掉：由 refineOne 的 catch 转成「该页回退文字层」，
      // 这里只负责不把 rejected promise 留在缓存里，下次（补救轮）还能再试。
      promise.catch(() => chunkImages.delete(k));
      chunkImages.set(k, promise);
      return promise;
    };
    const getImage = async (page) => {
      const k = chunkOfPage.get(page);
      if (k === undefined) throw new Error("页面不在渲染计划内。");
      const images = await renderChunk(k);
      renderChunk(k + 1);   // 预热下一组；已经在渲染/渲染完了就是空操作
      return images[String(page)];
    };
    const releaseImage = (page) => {
      const k = chunkOfPage.get(page);
      if (k !== undefined && --chunkPending[k] <= 0) chunkImages.delete(k);
    };
    // 进度从存档页数起步，而不是从 0 数上去：以前存档页在 fanout 里瞬间刷几百次
    // 回调，全被 queue.mjs 的 300ms 节流吞掉，界面反而停在 0/N 十几秒。
    let finished = finishedPages.size;
    if (targets.length) {
      onProgress(finished, drafts.length, `${targets.length} 页待识别，按 ${RENDER_CHUNK} 页一组滚动生成图像`);
    }

    const concurrency = await pageConcurrency();
    const output = await fanout(drafts, async (draft) => {
      // 存档命中：这一页上次已经跑完了，直接用，省掉一次模型调用
      const archived = finishedPages.get(draft.page);
      if (archived) return archived;   // 已计入 finished 的起点，不再逐页报进度
      if (!targets.includes(draft)) {
        finished += 1;
        onProgress(finished, drafts.length, `第 ${draft.page} 页跳过`);
        return draft;
      }
      let result;
      try {
        result = await refineOne(draft, getImage);
      } finally {
        releaseImage(draft.page);   // 成败都释放，否则一页异常就让整组图像常驻
      }
      // 每页一落盘：下次重启从这里续，而不是整份重来
      if (checkpoint) await checkpoint.save(draft.page, result).catch(() => undefined);
      finished += 1;
      onProgress(finished, drafts.length, `已完成 ${finished}/${drafts.length} 页`);
      return result;
    }, concurrency);

    // 补救轮：把「AI 调用本身失败」的页低压力重跑一遍。
    //
    // 高并发下失败几乎都是长尾超时，而超时后的重试是在**同一批请求还压着上游**时
    // 发出的，等于撞进同一个堵住的队列，三次机会经常一起废掉。实测 92 页 / 64 并发
    // 那轮就是这样：最后 9 页全部 90s 超时，直接降级成纯文字层（占 11%）。
    // 等主轮跑完、压力归零之后再用低并发补几页，几乎不影响总时长，却能把这批救回来。
    const casualtyIndexes = output.map((page, index) => (page.aiFailed ? index : -1)).filter((i) => i >= 0);
    if (casualtyIndexes.length) {
      console.warn(`[补救] ${casualtyIndexes.length}/${drafts.length} 页主轮失败，开始重试`);
      // 补救轮并发。这里曾经写死上限 4，理由是「等压力归零再低并发补几页」——
      // 那是按「同时只有一份文档在补救」设想的。实测 15 份大文档并行时有 7 份同时
      // 进入补救，每份只跑 4 路，在途请求塌到 8 条，而全局 aiGate 有 84 的余量在闲着。
      // 总量本来就由 aiGate 兜底，这里再压一层只会饿死自己。
      const rescueConcurrency = Math.max(4, Math.floor(concurrency / 4));
      onProgress(finished, drafts.length, `补救 ${casualtyIndexes.length} 页失败的识别`);
      // 主轮的分组图像已经按组释放了，补救的只是零星几页：一次性重新渲染这几页即可，
      // 代价是几秒，比让主轮为了补救轮把整份文档的图像留在内存里划算得多。
      const rescuePages = casualtyIndexes.map((index) => drafts[index].page);
      let rescueImages = {};
      try {
        rescueImages = await renderGate.run(() => renderer.renderPages(pdfPath, rescuePages));
      } catch (error) {
        console.warn(`[补救] 重新渲染 ${rescuePages.length} 页失败：${String(error?.message ?? error).slice(0, 160)}`);
      }
      const rescued = await fanout(
        casualtyIndexes,
        (index) => refineOne(drafts[index], async (page) => rescueImages[String(page)], true),
        rescueConcurrency
      );
      // JSONL 是追加写，同一页后写的那行会在 load() 时覆盖先写的——
      // 所以补救成功的结果必须再存一次，否则续跑会读回主轮那个失败版本。
      for (const [i, index] of casualtyIndexes.entries()) {
        if (rescued[i] && !rescued[i].aiFailed) {
          output[index] = rescued[i];
          if (checkpoint) await checkpoint.save(drafts[index].page, rescued[i]).catch(() => undefined);
        }
      }
    }
    for (const page of output) delete page.aiFailed;
    return output;
  }

  /** 一份 PDF → ConversionResult。onProgress(page, total, detail) */
  async function convertPdf(pdfPath, title, mode, onProgress = () => {}, checkpoint = null) {
    const started = performance.now();
    let pages;
    let total;
    if (mode === "fast") {
      ({ pages, total } = await extractTextLayer(pdfPath, (page, count) =>
        onProgress(page, count, `读取文字层 ${page}/${count} 页`)
      ));
    } else if (mode === "ai") {
      // AI 模式直接让视觉模型读页面，**不再先跑一遍慢的 Surya**：
      // 既然要用更强的模型，为了一份会被覆盖的初稿等上几分钟没有意义。
      // 改用 PDF 文字层当提示 + 回退——几乎零成本，电子版 PDF 质量也够；
      // 扫描件没有文字层时提示为空，就是纯视觉识别（本来也该如此）。
      // 读文字层也要报进度：几百页的书这一步要一两分钟，以前回调是空函数，
      // 界面停在 0/N 一动不动，看起来就像卡死了。
      const hints = await extractTextLayer(pdfPath, (page, count) =>
        onProgress(page, count, `读取文字层作为提示 ${page}/${count} 页，随后交给视觉模型`)
      );
      total = hints.total;
      pages = await refineWithAi(pdfPath, hints.pages, onProgress, checkpoint);
    } else {
      total = await pdfPageCount(pdfPath);
      pages = await convertWithSurya(pdfPath, total, onProgress);
    }
    return assembleResult(title, mode, total, pages, started);
  }

  /** 复用 Library 里已有的本地初稿，只重跑 AI 精校。 */
  async function refineExisting(pdfPath, title, previous, onProgress = () => {}, checkpoint = null) {
    const started = performance.now();
    const pageCount = await pdfPageCount(pdfPath);
    if (pageCount !== previous.pageCount) {
      throw new Error("原 PDF 页数与 Library 记录不一致，无法复用初稿。");
    }
    const drafts = previous.pages.map((page) => {
      const markdown = page.rawMarkdown ?? page.markdown;
      return {
        ...page,
        markdown,
        rawMarkdown: undefined,
        method: markdown ? "surya" : "empty",
        aiAttempted: false,
        model: undefined,
        provider: undefined,
        formulaCount: countFormulas(markdown),
        optionCount: countOptions(markdown),
        charCount: visibleLength(markdown),
        lineCount: markdown ? markdown.split(/\n+/).length : 0,
      };
    });
    const pages = await refineWithAi(pdfPath, drafts, onProgress, checkpoint);
    return assembleResult(title, "ai", pageCount, pages, started);
  }

  return { convertPdf, refineExisting };
}

export const __test__ = { suryaHtmlToMarkdown, linesToMarkdown, validateAiPage, countFormulas, countOptions };
/** 给 textlayer-worker.mjs 用：文字层提取的实现留在这里，子进程只是换个进程跑它。 */
export const __textlayer__ = { openPdf, extractFastPages };

/**
 * 两个闸的实时状态，给 /api/debug 用。
 *
 * 加这个是因为排查时只能从进程外数 TCP 连接来猜「到底有多少请求在飞」，
 * 而那个数字既不准（连接复用、keep-alive 残留）又看不出请求卡在哪一层，
 * 结果反复得出错误结论。闸内部的 inFlight/waiters 才是真相。
 */
export function gateStats() {
  return {
    ai: { limit: aiGate.limit, inFlight: aiGate.inFlight, waiting: aiGate.waiters.length },
    render: { limit: renderGate.limit, inFlight: renderGate.inFlight, waiting: renderGate.waiters.length },
  };
}
