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

const { document: sharedDoc, Node: DomNode } = parseHTML("<html><body></body></html>");

// 一份文档内同时送多少页给模型。AI 调用是纯网络等待，串行等于把 86 页排成
// 86 段往返。实测这把 key 12 并发零限流，取 6 留足余量（可用 MOYE_AI_PAGE_CONCURRENCY 调）。
// 上游 postWithRetries 已对 429/5xx 退避重试，偶发限流不会丢页。
const AI_PAGE_CONCURRENCY = Number(process.env.MOYE_AI_PAGE_CONCURRENCY) || 6;

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

  async function openPdf(pdfPath) {
    const data = new Uint8Array(await readFile(pdfPath));
    return getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
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

  /** 单页精校。AI 调用失败时返回带 aiFailed 标记的回退结果，供补救轮识别。 */
  async function refineOne(draft, images, rescue = false) {
    try {
      const imageBase64 = images[String(draft.page)];
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
    // 需要的页一次性渲染，省掉逐页起 Python 进程
    let images = {};
    if (targets.length) {
      onProgress(0, drafts.length, `正在为 ${targets.length} 页生成图像`);
      images = await renderGate.run(() => renderer.renderPages(pdfPath, targets.map((d) => d.page)));
    }

    let finished = 0;
    const concurrency = await pageConcurrency();
    const output = await fanout(drafts, async (draft) => {
      // 存档命中：这一页上次已经跑完了，直接用，省掉一次模型调用
      const archived = finishedPages.get(draft.page);
      if (archived) {
        finished += 1;
        onProgress(finished, drafts.length, `第 ${draft.page} 页（存档）`);
        return archived;
      }
      if (!targets.includes(draft)) {
        finished += 1;
        onProgress(finished, drafts.length, `第 ${draft.page} 页跳过`);
        return draft;
      }
      const result = await refineOne(draft, images);
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
      const rescued = await fanout(
        casualtyIndexes,
        (index) => refineOne(drafts[index], images, true),
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
    const pdfDoc = await openPdf(pdfPath);
    const total = pdfDoc.numPages;
    let pages;
    if (mode === "fast") {
      pages = await extractFastPages(pdfDoc, onProgress);
    } else if (mode === "ai") {
      // AI 模式直接让视觉模型读页面，**不再先跑一遍慢的 Surya**：
      // 既然要用更强的模型，为了一份会被覆盖的初稿等上几分钟没有意义。
      // 改用 PDF 文字层当提示 + 回退——几乎零成本，电子版 PDF 质量也够；
      // 扫描件没有文字层时提示为空，就是纯视觉识别（本来也该如此）。
      onProgress(0, total, "读取文字层作为提示，随后交给视觉模型");
      const hints = await extractFastPages(pdfDoc, () => {});
      pages = await refineWithAi(pdfPath, hints, onProgress, checkpoint);
    } else {
      pages = await convertWithSurya(pdfPath, total, onProgress);
    }
    return assembleResult(title, mode, total, pages, started);
  }

  /** 复用 Library 里已有的本地初稿，只重跑 AI 精校。 */
  async function refineExisting(pdfPath, title, previous, onProgress = () => {}, checkpoint = null) {
    const started = performance.now();
    const pdfDoc = await openPdf(pdfPath);
    if (pdfDoc.numPages !== previous.pageCount) {
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
    return assembleResult(title, "ai", pdfDoc.numPages, pages, started);
  }

  return { convertPdf, refineExisting };
}

export const __test__ = { suryaHtmlToMarkdown, linesToMarkdown, validateAiPage, countFormulas, countOptions };

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
