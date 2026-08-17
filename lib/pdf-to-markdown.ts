import { getAiSettings, type AiProvider } from "./ai-settings";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

export type ConversionMode = "fast" | "balanced" | "math" | "ai";

export type PageResult = {
  page: number;
  markdown: string;
  rawMarkdown?: string;
  charCount: number;
  lineCount: number;
  method: "text" | "ocr" | "surya" | "ai" | "empty";
  status: "good" | "review";
  reasons: string[];
  model?: string;
  provider?: AiProvider;
  formulaCount?: number;
  optionCount?: number;
  uncertain?: string[];
  aiAttempted?: boolean;
};

export type ConversionResult = {
  title: string;
  mode: ConversionMode;
  pageCount: number;
  markdown: string;
  pages: PageResult[];
  durationMs: number;
};

type PositionedText = {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
};

type SuryaBlock = {
  label?: string;
  reading_order?: number;
  html?: string;
  error?: boolean;
};

type SuryaPage = { blocks?: SuryaBlock[] };

type AiPagePayload = {
  markdown: string;
  formulaCount: number;
  questionNumbers: string[];
  optionLabels: string[];
  uncertain: string[];
  provider: AiProvider;
  model: string;
  error?: string;
};

const serviceBase = "http://127.0.0.1:8765";

const median = (values: number[]) => {
  if (!values.length) return 12;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const escapeMarkdown = (text: string) =>
  text.replace(/([\\`*_{}[\]<>])/g, "\\$1").replace(/\s+/g, " ").trim();

function countFormulas(markdown: string) {
  return markdown.match(/\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\n])+\$/g)?.length ?? 0;
}

function countOptions(markdown: string) {
  return markdown.match(/^\s*(?:[-*]\s*)?[A-D][.)]\s+/gim)?.length ?? 0;
}

function visibleLength(markdown: string) {
  return markdown.replace(/[#*`$|<>\\_\s]/g, "").length;
}

function renderHtmlNode(node: Node, displayMath = false): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  const tag = element.localName.toLowerCase();
  const children = Array.from(element.childNodes).map((child) => renderHtmlNode(child, displayMath)).join("");
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
      Array.from(row.querySelectorAll(":scope > th, :scope > td"))
        .map((cell) => Array.from(cell.childNodes).map((child) => renderHtmlNode(child)).join("").trim().replace(/\|/g, "\\|")),
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

function suryaHtmlToMarkdown(html: string, displayMath = false) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
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

function renderSuryaPage(page: SuryaPage, pageNumber: number): PageResult {
  const blocks = [...(page.blocks ?? [])]
    .sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0))
    .filter((block) => !["PageHeader", "PageFooter"].includes(block.label ?? ""));
  const hasVisual = blocks.some((block) => ["Picture", "Diagram"].includes(block.label ?? ""));
  const markdown = blocks
    .map((block) => {
      if (["Picture", "Diagram"].includes(block.label ?? "") && !block.html) return "_[图像或示意图：请对照原 PDF]_";
      return block.html ? suryaHtmlToMarkdown(block.html, block.label === "Equation") : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const reasons: string[] = [];
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

async function convertWithSurya(
  file: File,
  total: number,
  onProgress: (page: number, total: number, detail?: string) => void,
) {
  onProgress(0, total, "正在使用 Surya 逐页解析版面、表格与公式（首次会较慢）");
  let response: Response;
  try {
    response = await fetch(`${serviceBase}/api/surya`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
  } catch {
    throw new Error("本地高精度服务没有启动。请重新运行 start.command。");
  }
  const payload = await response.json() as { pages?: SuryaPage[]; error?: string };
  if (!response.ok || !payload.pages) throw new Error(payload.error || "Surya 本地视觉识别失败。");
  if (payload.pages.length !== total) throw new Error(`Surya 返回 ${payload.pages.length} 页，但 PDF 有 ${total} 页。`);
  onProgress(total, total, "本地高精度初稿完成");
  return payload.pages.map((page, index) => renderSuryaPage(page, index + 1));
}

function linesToMarkdown(items: PositionedText[]) {
  const rows: PositionedText[][] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.find((candidate) => Math.abs(candidate[0].y - item.y) <= Math.max(2.5, item.size * 0.24));
    if (row) row.push(item);
    else rows.push([item]);
  }
  const bodySize = median(items.map((item) => item.size).filter((size) => size > 3));
  const rendered = rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let text = "";
    let edge = 0;
    for (const item of row) {
      if (text && item.x - edge > Math.max(2.5, item.size * 0.24)) text += " ";
      text += item.text;
      edge = item.x + item.width;
    }
    return { text: escapeMarkdown(text), size: row.reduce((sum, item) => sum + item.size, 0) / row.length, y: row[0].y };
  }).filter((line) => line.text);
  const output: string[] = [];
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
        output[output.length - 1] = previous.endsWith("-") ? previous.slice(0, -1) + line.text : `${previous} ${line.text}`;
      } else output.push(line.text);
    }
  }
  return output.join("\n\n");
}

async function extractFastPages(
  document: PDFDocumentProxy,
  onProgress: (page: number, total: number, detail?: string) => void,
) {
  const pages: PageResult[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    onProgress(pageNumber - 1, document.numPages, `读取第 ${pageNumber} 页文字层`);
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: PositionedText[] = [];
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
    const reasons = items.map((item) => item.text).join("").trim().length < 30
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
    onProgress(pageNumber, document.numPages, `第 ${pageNumber} 页完成`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  }
  return pages;
}

async function renderPageJpeg(page: PDFPageProxy) {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("浏览器无法创建页面画布。");
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
}

function validateAiPage(draft: PageResult, refined: AiPagePayload) {
  const failures: string[] = [];
  const draftLength = visibleLength(draft.markdown);
  const finalLength = visibleLength(refined.markdown);
  const finalFormulaCount = countFormulas(refined.markdown);
  const finalOptionCount = countOptions(refined.markdown);
  if (!refined.markdown.trim()) failures.push("模型返回空白内容");
  if (draftLength >= 120 && finalLength < Math.max(80, draftLength * 0.45)) failures.push("模型结果比本地初稿短太多");
  if ((draft.formulaCount ?? 0) > 0 && finalFormulaCount < (draft.formulaCount ?? 0)) failures.push("模型结果丢失了本地已识别公式");
  if ((draft.optionCount ?? 0) >= 2 && finalOptionCount < (draft.optionCount ?? 0)) failures.push("模型结果丢失了选项标签");
  return { failures, finalFormulaCount, finalOptionCount };
}

async function refineWithAi(
  document: PDFDocumentProxy,
  drafts: PageResult[],
  onProgress: (page: number, total: number, detail?: string) => void,
) {
  const settings = await getAiSettings();
  if (!settings.aiConfigured) throw new Error("AI 精校尚未配置。请点击右上角“设置”，填写当前服务的 API Key。");
  const output: PageResult[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const shouldRefine = settings.aiScope === "all" || draft.status === "review" || (draft.formulaCount ?? 0) > 0 || (draft.optionCount ?? 0) > 0;
    if (!shouldRefine) {
      output.push(draft);
      continue;
    }
    onProgress(index, drafts.length, `第 ${draft.page} 页：生成图像并由视觉模型精校`);
    try {
      const page = await document.getPage(draft.page);
      const imageBase64 = await renderPageJpeg(page);
      const response = await fetch(`${serviceBase}/api/ai-refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: draft.page, draft: draft.markdown, imageBase64, mimeType: "image/jpeg" }),
      });
      const refined = await response.json() as AiPagePayload;
      if (!response.ok) throw new Error(refined.error || "视觉模型精校失败。");
      const validation = validateAiPage(draft, refined);
      if (validation.failures.length) {
        output.push({
          ...draft,
          rawMarkdown: draft.markdown,
          aiAttempted: true,
          status: "review",
          reasons: [...draft.reasons, `AI 结果未通过程序校验：${validation.failures.join("；")}`],
          model: refined.model,
          provider: refined.provider,
        });
      } else {
        const uncertain = refined.uncertain ?? [];
        const reasons = [...uncertain.map((item) => `模型标记不确定：${item}`)];
        if (refined.markdown.includes("[unclear]")) reasons.push("结果中仍有无法辨认的符号");
        output.push({
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
        });
      }
    } catch (error) {
      output.push({
        ...draft,
        rawMarkdown: draft.markdown,
        aiAttempted: true,
        status: "review",
        reasons: [...draft.reasons, `AI 精校失败，已保留本地初稿：${error instanceof Error ? error.message : "未知错误"}`],
      });
    }
    onProgress(index + 1, drafts.length, `第 ${draft.page} 页精校完成`);
  }
  return output;
}

export async function convertPdf(
  file: File,
  mode: ConversionMode,
  onProgress: (page: number, total: number, detail?: string) => void,
): Promise<ConversionResult> {
  if (typeof window === "undefined") throw new Error("PDF 转换只能在浏览器中运行。");
  const started = performance.now();
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data }).promise;

  let pages: PageResult[];
  if (mode === "fast") pages = await extractFastPages(document, onProgress);
  else {
    const drafts = await convertWithSurya(file, document.numPages, onProgress);
    pages = mode === "ai" ? await refineWithAi(document, drafts, onProgress) : drafts;
  }

  return assembleResult(file, mode, document.numPages, pages, started);
}

function assembleResult(file: File, mode: ConversionMode, pageCount: number, pages: PageResult[], started: number): ConversionResult {

  const title = file.name.replace(/\.pdf$/i, "");
  const aiPages = pages.filter((page) => page.method === "ai").length;
  const provenance = mode === "ai"
    ? `先在本机生成初稿，再由视觉模型精校 ${aiPages}/${pageCount} 页；未通过校验的页面自动保留本地初稿。`
    : mode === "fast"
      ? "直接读取 PDF 文字层，文件未上传。"
      : "使用本机 Surya 解析版面与公式，文件未上传。";
  const markdown = [
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
  ].join("\n").trim() + "\n";

  return {
    title,
    mode,
    pageCount,
    markdown,
    pages,
    durationMs: Math.round(performance.now() - started),
  };
}

export async function refineExistingPdf(
  file: File,
  previous: ConversionResult,
  onProgress: (page: number, total: number, detail?: string) => void,
): Promise<ConversionResult> {
  if (typeof window === "undefined") throw new Error("PDF 转换只能在浏览器中运行。");
  const started = performance.now();
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data }).promise;
  if (document.numPages !== previous.pageCount) throw new Error("原 PDF 页数与 Library 记录不一致，无法复用初稿。");
  const drafts = previous.pages.map((page) => {
    const markdown = page.rawMarkdown ?? page.markdown;
    return {
      ...page,
      markdown,
      rawMarkdown: undefined,
      method: markdown ? "surya" as const : "empty" as const,
      aiAttempted: false,
      model: undefined,
      provider: undefined,
      formulaCount: countFormulas(markdown),
      optionCount: countOptions(markdown),
      charCount: visibleLength(markdown),
      lineCount: markdown ? markdown.split(/\n+/).length : 0,
    };
  });
  const pages = await refineWithAi(document, drafts, onProgress);
  return assembleResult(file, "ai", document.numPages, pages, started);
}
