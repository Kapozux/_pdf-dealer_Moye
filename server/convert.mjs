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
  // 并发上限：可传函数（按 key 数动态算），否则用默认值
  async function pageConcurrency() {
    if (typeof aiPageConcurrency === "function") return Math.max(1, await aiPageConcurrency());
    return Math.max(1, aiPageConcurrency || AI_PAGE_CONCURRENCY);
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

  async function refineWithAi(pdfPath, drafts, onProgress) {
    const settings = await loadSettings();
    if (!settings.aiConfigured) {
      throw new Error("AI 精校尚未配置。请点击右上角“设置”，填写当前服务的 API Key。");
    }
    // 注意：初稿现在来自文字层，大多数页会是 "good"。若仍按 review 过滤，
    // 选了 AI 却几乎没有页面被精校，所以 aiScope=all 时一律精校。
    const targets = drafts.filter(
      (draft) =>
        settings.aiScope === "all" ||
        draft.status === "review" ||
        (draft.formulaCount ?? 0) > 0 ||
        (draft.optionCount ?? 0) > 0
    );
    // 需要的页一次性渲染，省掉逐页起 Python 进程
    let images = {};
    if (targets.length) {
      onProgress(0, drafts.length, `正在为 ${targets.length} 页生成图像`);
      images = await renderer.renderPages(pdfPath, targets.map((d) => d.page));
    }

    let finished = 0;
    const output = await fanout(drafts, async (draft, index) => {
      if (!targets.includes(draft)) {
        finished += 1;
        onProgress(finished, drafts.length, `第 ${draft.page} 页跳过`);
        return draft;
      }
      try {
        const imageBase64 = images[String(draft.page)];
        if (!imageBase64) throw new Error("页面图像生成失败。");
        const refined = await refinePage({
          page: draft.page,
          draft: draft.markdown,
          imageBase64,
          mimeType: "image/jpeg",
        });
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
        } else {
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
        }
      } catch (error) {
        return {
          ...draft,
          rawMarkdown: draft.markdown,
          aiAttempted: true,
          status: "review",
          reasons: [
            ...draft.reasons,
            draft.markdown
              ? `AI 识别失败，已回退 PDF 文字层：${error?.message ?? "未知错误"}`
              : `AI 识别失败，且此页没有文字层可回退：${error?.message ?? "未知错误"}`,
          ],
        };
      } finally {
        finished += 1;
        onProgress(finished, drafts.length, `已完成 ${finished}/${drafts.length} 页`);
      }
    }, await pageConcurrency());
    return output;
  }

  /** 一份 PDF → ConversionResult。onProgress(page, total, detail) */
  async function convertPdf(pdfPath, title, mode, onProgress = () => {}) {
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
      pages = await refineWithAi(pdfPath, hints, onProgress);
    } else {
      pages = await convertWithSurya(pdfPath, total, onProgress);
    }
    return assembleResult(title, mode, total, pages, started);
  }

  /** 复用 Library 里已有的本地初稿，只重跑 AI 精校。 */
  async function refineExisting(pdfPath, title, previous, onProgress = () => {}) {
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
    const pages = await refineWithAi(pdfPath, drafts, onProgress);
    return assembleResult(title, "ai", pdfDoc.numPages, pages, started);
  }

  return { convertPdf, refineExisting };
}

export const __test__ = { suryaHtmlToMarkdown, linesToMarkdown, validateAiPage, countFormulas, countOptions };
