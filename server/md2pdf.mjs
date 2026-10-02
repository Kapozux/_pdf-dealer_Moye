/**
 * Markdown → PDF。
 *
 * 渲染链：marked + KaTeX 出 HTML（公式先占位再交给 marked、原文裸 HTML 一律转义，这两条与
 * app/page.tsx 的 renderMarkdown 相同），再用本机的 Chrome 无头模式 --print-to-pdf 打印成 PDF。
 *
 * 观感对齐 Obsidian 阅读视图的「导出为 PDF」（用户的笔记都在 Obsidian 里看，要的就是那个样子）：
 * 排版数值取自 Obsidian 1.12 默认浅色主题的 CSS 变量，样式是照着数值自己写的，没有拷贝它的文件。
 * 语法也按 Obsidian 的习惯：单个换行即换行（它默认关闭「严格换行」）、> [!note] 提示框、==高亮==、
 * [[双链]] 印成文字、开头的 YAML 属性区不印（Obsidian 导出时也隐藏属性）。
 * 这些只在 PDF 这条路上生效，页面里「渲染」tab 仍是标准 GFM。
 *
 * 为什么用 Chrome 而不是别的：
 * - 公式要真正排版出来。pandoc/wkhtmltopdf 没装；LibreOffice 能转 HTML 但 KaTeX 的 CSS 排版会散架；
 *   Python 环境里也没有 weasyprint/reportlab。Chrome 本来就在（/Applications），排版和浏览器里
 *   看到的「渲染」tab 完全一致，中文字体走系统 PingFang，不用额外装东西。
 * - KaTeX 的字体内联成 data URI：file:// 页面加载 file:// 字体在 Chrome 里受同源限制，内联最稳。
 *
 * 不要传 --user-data-dir。2026-09-07 实测（Chrome 152）：给一个全新的 profile 目录，无头打印要等
 * 60～113 秒才返回（首次初始化在等什么，没深究）；不传则 2 秒完成，两路并发各自成功，用户自己的
 * Chrome 正开着也互不影响——新无头模式自己会用临时 profile。
 */
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Marked } from "marked";
import katex from "katex";
import { PDFDocument } from "pdf-lib";
import { safeLinkRenderers } from "../lib/safe-url.mjs";

const require = createRequire(import.meta.url);

const BROWSER_DIR = fileURLToPath(new URL("../data/browser/", import.meta.url));
const INSTALL_HINT = "运行 npm run browser:install 下载一份独立的无头浏览器（约 100MB，放在 data/browser/），或用 MOYE_CHROME 指定浏览器路径。";

/**
 * 首选 data/browser/ 里自带的 chrome-headless-shell（npm run browser:install 装的，Google 官方的纯无头构建）：
 * 独立的程序、独立的 profile 和崩溃目录，跟用户自己装的 Chrome 互不相干——Obsidian 导出 PDF 也是这么干的
 * （Electron 内嵌的 Chromium）。2026-09-14 之前直接调 /Applications 里的 Chrome，用户正开着的 Chrome 被关掉过
 * 一次，原因没查清；此后 /Applications 里的浏览器只做没装自带浏览器时的兜底，用到时会在日志里提醒。
 */
export async function bundledHeadlessShell() {
  const root = join(BROWSER_DIR, "chrome-headless-shell");
  const versions = await readdir(root).catch(() => []);
  for (const version of versions.sort().reverse()) {
    const dirs = await readdir(join(root, version)).catch(() => []);
    for (const dir of dirs) {
      const binary = join(root, version, dir, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
      if (await access(binary).then(() => true, () => false)) return binary;
    }
  }
  return null;
}

const SYSTEM_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const TASKPOLICY = "/usr/sbin/taskpolicy";

let chromePathPromise;
async function findChrome() {
  chromePathPromise ??= (async () => {
    if (process.env.MOYE_CHROME) {
      await access(process.env.MOYE_CHROME).catch(() => { throw new Error(`MOYE_CHROME 指定的浏览器不存在：${process.env.MOYE_CHROME}`); });
      return process.env.MOYE_CHROME;
    }
    const bundled = await bundledHeadlessShell();
    if (bundled) return bundled;
    for (const candidate of SYSTEM_BROWSERS) {
      if (await access(candidate).then(() => true, () => false)) {
        console.error(`[PDF] 没有自带的无头浏览器，改用系统里的 ${candidate}（可能影响正在使用的浏览器）。${INSTALL_HINT}`);
        return candidate;
      }
    }
    throw new Error(`没有找到可用的浏览器，无法生成 PDF。${INSTALL_HINT}`);
  })();
  return chromePathPromise;
}

/** 「设置 → 环境」里刚装完自带浏览器：丢掉缓存的查找结果（可能是系统 Chrome，或者一次缓存住的失败）。 */
export function forgetChromePath() {
  chromePathPromise = undefined;
}

/** chrome-headless-shell 本身就是无头的，不认 --headless=new；完整的 Chrome 才需要这个开关。 */
const isHeadlessShell = (binary) => /chrome-headless-shell/.test(binary);

/** KaTeX 的 CSS，字体（只留 woff2）内联成 data URI。只算一次。 */
let katexCssPromise;
async function katexCss() {
  katexCssPromise ??= (async () => {
    const cssPath = require.resolve("katex/dist/katex.min.css");
    const fontsDir = join(cssPath, "../fonts");
    let css = await readFile(cssPath, "utf8");
    // 去掉 woff / ttf 备选，只留 woff2
    css = css.replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("[^"]+"\)/g, "");
    const fontRefs = [...new Set(css.match(/fonts\/[\w-]+\.woff2/g) ?? [])];
    for (const ref of fontRefs) {
      const data = await readFile(join(fontsDir, ref.slice("fonts/".length)));
      css = css.split(`url(${ref})`).join(`url(data:font/woff2;base64,${data.toString("base64")})`);
    }
    return css;
  })();
  return katexCssPromise;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

// Obsidian 提示框类型 → 颜色 + 图标，照 app.css 里 .callout[data-callout="…"] 的 --callout-color / --callout-icon；
// 颜色是默认浅色主题的 RGB，没列到的类型按 note 处理（Obsidian 也是）。
const CALLOUT_TYPES = (() => {
  const blue = "8, 109, 221", cyan = "0, 191, 188", green = "8, 185, 78", orange = "236, 117, 0", red = "233, 49, 71", purple = "120, 82, 238", grey = "158, 158, 158";
  return {
    note: [blue, "pencil"],
    abstract: [cyan, "clipboard-list"], summary: [cyan, "clipboard-list"], tldr: [cyan, "clipboard-list"],
    info: [blue, "info"],
    todo: [blue, "check-circle-2"],
    important: [cyan, "flame"], tip: [cyan, "flame"], hint: [cyan, "flame"],
    success: [green, "check"], check: [green, "check"], done: [green, "check"],
    question: [orange, "help-circle"], help: [orange, "help-circle"], faq: [orange, "help-circle"],
    warning: [orange, "alert-triangle"], caution: [orange, "alert-triangle"], attention: [orange, "alert-triangle"],
    failure: [red, "x"], fail: [red, "x"], missing: [red, "x"],
    danger: [red, "zap"], error: [red, "zap"],
    bug: [red, "bug"],
    example: [purple, "list"],
    quote: [grey, "quote"], cite: [grey, "quote"],
  };
})();

// Lucide 图标的 SVG 内容（从 Obsidian 的图标表导出，ISC 许可），外层 svg 标签在 calloutIcon 里统一加
const CALLOUT_ICONS = {
  "pencil": '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  "clipboard-list": '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "check-circle-2": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  "flame": '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>',
  "check": '<path d="M20 6 9 17l-5-5"/>',
  "help-circle": '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  "alert-triangle": '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  "x": '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "zap": '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  "bug": '<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>',
  "list": '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>',
  "quote": '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
};

const calloutIcon = (name) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-${name}">${CALLOUT_ICONS[name] ?? CALLOUT_ICONS.pencil}</svg>`;

const obsidianExtensions = [
  {
    // > [!type] 标题（可省）\n> 正文……  整块吃掉，正文按普通块级 Markdown 再解析
    name: "callout",
    level: "block",
    start: (src) => src.match(/^ {0,3}> ?\[!/m)?.index,
    tokenizer(src) {
      const match = src.match(/^ {0,3}> ?\[!([\w-]+)\][+-]?[ \t]*([^\n]*)(?:\n|$)((?: {0,3}>[^\n]*(?:\n|$))*)/);
      if (!match) return undefined;
      const type = match[1].toLowerCase();
      const body = match[3].replace(/^ {0,3}> ?/gm, "");
      return {
        type: "callout",
        raw: match[0],
        calloutType: type,
        titleTokens: this.lexer.inlineTokens(match[2].trim() || type.charAt(0).toUpperCase() + type.slice(1)),
        tokens: this.lexer.blockTokens(body, []),
      };
    },
    renderer(token) {
      // 结构与 Obsidian 渲染出的一致：.callout > .callout-title(.callout-icon + .callout-title-inner) + .callout-content
      const [color, icon] = CALLOUT_TYPES[token.calloutType] ?? CALLOUT_TYPES.note;
      const content = token.tokens.length ? `<div class="callout-content">${this.parser.parse(token.tokens)}</div>` : "";
      return `<div class="callout" data-callout="${escapeHtml(token.calloutType)}" style="--callout-color: ${color}"><div class="callout-title"><div class="callout-icon">${calloutIcon(icon)}</div><div class="callout-title-inner">${this.parser.parseInline(token.titleTokens)}</div></div>${content}</div>\n`;
    },
  },
  {
    name: "highlight",
    level: "inline",
    start: (src) => src.indexOf("=="),
    tokenizer(src) {
      const match = src.match(/^==(?=\S)([^\n]*?\S)==/);
      if (match) return { type: "highlight", raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
      return undefined;
    },
    renderer(token) {
      return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
    },
  },
  {
    // [[笔记名#小节|别名]] 印成别名（没有就印笔记名）；![[嵌入]] 在 vault 外找不到文件，印成淡色的名字
    name: "wikilink",
    level: "inline",
    start: (src) => src.match(/!?\[\[/)?.index,
    tokenizer(src) {
      const match = src.match(/^(!?)\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/);
      if (!match) return undefined;
      return { type: "wikilink", raw: match[0], embed: Boolean(match[1]), text: (match[3] ?? match[2]).trim() };
    },
    renderer(token) {
      return `<span class="${token.embed ? "embed-link" : "internal-link"}">${escapeHtml(token.text)}</span>`;
    },
  },
];

/**
 * 两份解析器，只差图片要不要加载网上的：
 * - Library 里转出来的文档（内容来自 PDF 和模型，不可信）→ 只认内嵌图片；
 * - 用户自己拖进来的 .md（多半是自己的笔记，网上的图是有意放的）→ 网上的图照常加载。
 * 链接两边一样过白名单（lib/safe-url.mjs）；本机路径的图片两边都不加载。
 */
const makeObsidianMarked = ({ remoteImages }) => new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    ...safeLinkRenderers("图片", { remoteImages }),
    // 列表按 Obsidian 阅读视图的 DOM 出：ul.has-list-bullet，任务项 li.task-list-item[data-task] + input.task-list-item-checkbox，
    // 圆点和勾选框都由 CSS 画（见 PRINT_CSS），这里只负责挂对类名
    list(token) {
      const tag = token.ordered ? "ol" : "ul";
      const attrs = token.ordered ? (token.start !== 1 ? ` start="${token.start}"` : "") : ' class="has-list-bullet"';
      return `<${tag}${attrs}>\n${token.items.map((item) => this.listitem(item)).join("")}</${tag}>\n`;
    },
    listitem(item) {
      let body = this.parser.parse(item.tokens, Boolean(item.loose));
      if (!item.task) return `<li>${body}</li>\n`;
      const checkbox = `<input class="task-list-item-checkbox" type="checkbox" disabled${item.checked ? " checked" : ""}> `;
      // 松散列表的项以 <p> 开头，勾选框放进段落里（Obsidian 也是 li > p > input）
      body = body.startsWith("<p>") ? `<p>${checkbox}${body.slice(3)}` : checkbox + body;
      return `<li class="task-list-item" data-task="${item.checked ? "x" : " "}">${body}</li>\n`;
    },
  },
  extensions: obsidianExtensions,
});
const obsidianMarked = makeObsidianMarked({ remoteImages: false });
const obsidianMarkedRemote = makeObsidianMarked({ remoteImages: true });

/** 开头的 YAML 属性区（--- … ---，里面至少有一行 key: value）去掉；不像属性区的 --- 当分隔线留着。 */
function stripFrontmatter(source) {
  const match = source.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  return match && /^[^\s:#][^:\n]*:/m.test(match[1]) ? source.slice(match[0].length) : source;
}

/** Markdown（含 $…$ / $$…$$ 公式）→ HTML 片段，按 Obsidian 的语法习惯解析（见文件头）。 */
export function renderMarkdownHtml(source, { remoteImages = false } = {}) {
  const formulas = [];
  const stash = (latex, display) => {
    formulas.push(katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: "ignore" }));
    return `\uE000${formulas.length - 1}\uE001`;
  };
  const withPlaceholders = stripFrontmatter(String(source ?? ""))
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, latex) => stash(latex.trim(), true))
    .replace(/(^|[^\\$])\$((?:\\.|[^$\n])+?)\$/g, (_, lead, latex) => `${lead}${stash(latex, false)}`);
  const html = (remoteImages ? obsidianMarkedRemote : obsidianMarked).parse(withPlaceholders);
  return html.replace(/\uE000(\d+)\uE001/g, (_, index) => formulas[Number(index)] ?? "");
}

/** 取正文第一个一级标题当文档标题；没有就用调用方给的。 */
export function markdownTitle(markdown, fallback = "document") {
  const match = stripFrontmatter(String(markdown ?? "")).match(/^#\s+(.+?)\s*$/m);
  // 标题要当 PDF 元数据和下载文件名用，去掉 Markdown 的反斜杠转义（转换出来的标题常是 Economics\_-\_…）
  const heading = match?.[1].replace(/\\([\\`*_{}[\]()#+\-.!|~=$<>])/g, "$1");
  return (heading ?? fallback).trim() || fallback;
}

// 勾选框里的勾（app.css 里 input[type=checkbox]:checked:after 的 mask-image，原样）
const CHECK_SVG = "data:image/svg+xml;utf8,<svg width=\"12px\" height=\"10px\" viewBox=\"0 0 12 8\" version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\"><g stroke=\"none\" stroke-width=\"1\" fill=\"none\" fill-rule=\"evenodd\"><g transform=\"translate%28-4.000000, -6.000000%29\" fill=\"%23000000\"><path d=\"M8.1043257,14.0367999 L4.52468714,10.5420499 C4.32525014,10.3497722 4.32525014,10.0368095 4.52468714,9.8424863 L5.24777413,9.1439454 C5.44721114,8.95166768 5.77142411,8.95166768 5.97086112,9.1439454 L8.46638057,11.5903727 L14.0291389,6.1442083 C14.2285759,5.95193057 14.5527889,5.95193057 14.7522259,6.1442083 L15.4753129,6.84377194 C15.6747499,7.03604967 15.6747499,7.35003511 15.4753129,7.54129009 L8.82741268,14.0367999 C8.62797568,14.2290777 8.3037627,14.2290777 8.1043257,14.0367999\"></path></g></g></svg>";

// 打印样式：逐条对照 Obsidian 1.13 的 app.css 抄的（注释里是它的选择器 / 变量名），只取默认浅色主题的值。
// 2026-09-14 从 obsidian.asar 里翻出来的几个关键事实，之前照感觉写的版本都没对上：
// - 导出时 body 的 --font-text 被强制成 --font-print，而它的兜底是 'Arial'——所以 Obsidian 导出的 PDF 是 Arial 字，不是系统字体
// - .print .markdown-preview-view { color: initial } → 正文纯黑，不是 #222；只有代码、表头这些显式取 --text-normal 的才是 #222
// - 纸张 / 边距来自导出对话框：默认 Letter + Electron 默认边距 1cm；再加 .markdown-preview-view 自己的 32px 内边距（--file-margins）
// - 每个块被包进一个没有类名的 div，所以「段落后的标题多空一截」（--heading-spacing）那条规则在导出时根本不生效，标题上下就是 1rem
// - 无序列表的圆点是 .list-bullet 画的 0.3em 小圆，勾选框是自绘的 16px 圆角方块，链接默认有下划线
// 在此之上只加了打印需要的两条——标题不在页尾孤悬、代码/表格行/图不被拦腰切断（Obsidian 没有，算是改进）。
const PRINT_CSS = `
@page { size: Letter; margin: 1cm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* .markdown-preview-view：--font-text-size 16px、--line-height-normal 1.5、padding --file-margins 32px；.print → color: initial */
body { margin: 0; padding: 32px; font-family: Arial, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.5; color: #000; text-rendering: optimizeLegibility; overflow-wrap: break-word; tab-size: 4; }
/* --p-spacing 1rem；pre / blockquote 是浏览器默认的 1em，正好相等 */
p, ul, ol, table, pre, blockquote { margin: 1rem 0; }
/* h1..h6 { margin-block: var(--p-spacing) }；字号 --hN-size、字重 --hN-weight、行高 --hN-line-height、字距 --hN-letter-spacing */
h1, h2, h3, h4, h5, h6 { margin: 1rem 0; color: inherit; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 1.618em; font-weight: 700; line-height: 1.2; letter-spacing: -0.015em; }
h2 { font-size: 1.462em; font-weight: 600; line-height: 1.2; letter-spacing: -0.011em; }
h3 { font-size: 1.318em; font-weight: 600; line-height: 1.3; }
h4 { font-size: 1.188em; font-weight: 600; line-height: 1.4; }
h5 { font-size: 1.076em; font-weight: 600; line-height: 1.5; }
h6 { font-size: 1em; font-weight: 600; line-height: 1.5; }
/* b, strong { font-weight: --font-weight 400 + --bold-modifier 200 } */
b, strong { font-weight: 600; }
/* a：--link-color = --text-accent = hsl(258, 88%, 66%)，--link-decoration underline；.print .external-link 去掉外链小图标 */
a, .internal-link { color: hsl(258, 88%, 66%); text-decoration-line: underline; text-decoration-thickness: auto; }
.embed-link { color: #ababab; }
/* .markdown-rendered blockquote：--blockquote-border-thickness 2px，颜色 --interactive-accent = --color-accent-1 */
blockquote { padding: 0 0 0 24px; border-inline-start: 2px solid hsl(257, 88.88%, 70.95%); margin-inline: 0; }
blockquote > :first-child { margin-top: 0; }
blockquote > :last-child { margin-bottom: 0; }
/* 列表：ul/ol padding-inline-start 0；li margin-inline-start 3ch，嵌套 --list-indent = 0.5625em × 4；--list-spacing 0.075em */
ul, ol { padding-inline-start: 0; }
ul > li, ol > li { margin-inline-start: 3ch; padding-top: 0.075em; padding-bottom: 0.075em; position: relative; }
ul ul > li, ol ul > li, ul ol > li, ol ol > li { margin-inline-start: 2.25em; }
ul ul, ul ol, ol ul, ol ol { margin: 0; }
li p:first-of-type { margin-top: 0; }
li p:last-of-type { margin-bottom: 0; }
ol > li::marker, ul > li::marker { color: #ababab; }
/* 无序列表的圆点：ul.has-list-bullet 把原生圆点藏掉，.list-bullet 在项目左侧 0.8em 处画一个 --list-bullet-size 0.3em 的圆，颜色 --list-marker-color */
ul.has-list-bullet { list-style-type: '\\200B'; }
ul.has-list-bullet > li::marker { color: transparent; }
ul.has-list-bullet > li:not(.task-list-item)::before { content: ""; position: absolute; left: -0.95em; top: 0.675em; width: 0.3em; height: 0.3em; border-radius: 50%; background: #ababab; }
/* 任务项：li.task-list-item 无圆点；勾选框 --checkbox-size = 16px，向左伸出 1.5 个框宽，右边 0.6em，下沉 0.2em；完成的划线变灰 */
li.task-list-item { list-style: none; }
li.task-list-item > .task-list-item-checkbox, li.task-list-item > p > .task-list-item-checkbox { position: relative; top: 0.2em; margin-inline-start: -24px; margin-inline-end: 0.6em; }
li.task-list-item[data-task="x"] { text-decoration: line-through; color: #5c5c5c; }
input[type=checkbox] { -webkit-appearance: none; appearance: none; border-radius: 4px; border: 1px solid #ababab; flex-shrink: 0; padding: 0; margin: 0; margin-inline-end: 6px; width: 16px; height: 16px; position: relative; }
input[type=checkbox]:checked { background-color: hsl(257, 88.88%, 70.95%); border-color: hsl(257, 88.88%, 70.95%); }
input[type=checkbox]:checked::after { content: ""; top: -1px; inset-inline-start: -1px; position: absolute; width: 16px; height: 16px; display: block; background-color: #fff; -webkit-mask-position: 52% 52%; -webkit-mask-size: 65%; -webkit-mask-repeat: no-repeat; -webkit-mask-image: url('${CHECK_SVG}'); }
/* 代码：--font-monospace-default、--code-size 0.875em、--code-background = --color-base-10 #fafafa、--code-radius 4px、颜色 --code-normal = --text-normal #222 */
code { color: #222; font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", "Roboto Mono", "DejaVu Sans Mono", "Liberation Mono", Menlo, Monaco, "Consolas", "Source Code Pro", monospace; font-size: 0.875em; background-color: #fafafa; border-radius: 4px; padding: 0.15em 0.3em; -webkit-box-decoration-break: clone; }
pre { position: relative; padding: 12px 16px; min-height: 38px; background-color: #fafafa; border-radius: 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
pre code { border: none; padding: 0; background-color: transparent; }
/* hr：--hr-thickness 2px、--hr-color = --color-base-30 #e4e4e4、全局 hr { margin: 2rem 0 } */
hr { border: none; border-top: 2px solid #e4e4e4; margin: 2rem 0; }
/* 表格：单元格 --size-2-2 --size-4-2 = 4px 8px、边框 --table-border-color #e4e4e4、最小列宽 6ch、--table-line-height 1.3、表头 600 / #222 */
table { border-collapse: collapse; line-height: 1.3; word-break: normal; }
th, td { padding: 4px 8px; border: 1px solid #e4e4e4; min-width: 6ch; vertical-align: top; text-align: start; white-space: break-spaces; }
th { font-weight: 600; color: #222; line-height: 1.3; }
/* 高亮：--text-highlight-bg；.print 里 mark 的文字色 initial */
mark { background-color: rgba(255, 208, 0, 0.4); color: #000; }
/* 提示框：底色是类型色 10%、--callout-radius 4px、--callout-padding 12px 12px 12px 24px、margin 1em 0；
   标题 flex + gap --size-4-1 4px、--line-height-tight 1.3、类型色；图标 --icon-m 18px / --icon-m-stroke-width 1.75px；标题字重 600 */
.callout { overflow: hidden; border-radius: 4px; margin: 1em 0; background-color: rgba(var(--callout-color), 0.1); padding: 12px 12px 12px 24px; }
.callout-title { display: flex; gap: 4px; color: rgb(var(--callout-color)); line-height: 1.3; align-items: flex-start; }
.callout-icon { flex: 0 0 auto; display: flex; align-items: center; }
.callout-icon .svg-icon { width: 18px; height: 18px; color: rgb(var(--callout-color)); }
.callout-title-inner { font-weight: 600; }
.callout-content { overflow-x: auto; }
.callout-content .callout { margin-top: 20px; }
img { max-width: 100%; }
/* 打印专用（Obsidian 没有）：代码块、表格行、引用、提示框、图片不跨页切断 */
tr, pre, blockquote, .callout, img { break-inside: avoid; page-break-inside: avoid; }
.katex-display { margin: 1rem 0; overflow: visible; }
.katex { font-size: 1.1em; }
`;

/** 完整的可打印 HTML 文档。 */
export async function buildPrintableHtml(markdown, { title, heading, remoteImages = false } = {}) {
  const docTitle = title || markdownTitle(markdown, "document");
  // 打印页是本机 file:// 页面：不许跑任何脚本，样式 / 字体 / 图片只认内嵌的（KaTeX 字体本来就内联成 data URI），
  // 用户自己的 .md 再放开网上的图片。上面的白名单漏了什么，这一层兜底
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${remoteImages ? " https: http:" : ""}`;
  return [
    "<!doctype html>",
    `<html lang="zh"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHtml(docTitle)}</title>`,
    `<style>${await katexCss()}</style>`,
    `<style>${PRINT_CSS}</style>`,
    "</head><body>",
    // Obsidian 导出对话框的「包含文件名作为标题」（默认开）：正文最前面一个普通 h1，内容就是文件名
    heading ? `<h1>${escapeHtml(heading)}</h1>` : "",
    renderMarkdownHtml(markdown, { remoteImages }),
    "</body></html>",
  ].join("\n");
}

// Chrome 一个实例几百 MB，同时开太多会把机器拖住；转换本身几秒，排队等一下没关系。
const printGate = {
  limit: Math.max(1, Number(process.env.MOYE_PDF_CONCURRENCY) || 2),
  inFlight: 0,
  waiters: [],
  async run(fn) {
    if (this.inFlight >= this.limit) await new Promise((r) => this.waiters.push(r));
    else this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight < this.limit && this.waiters.length) {
        this.inFlight += 1;
        this.waiters.shift()();
      }
    }
  },
};

/**
 * 通过 --remote-debugging-pipe 跟 Chrome 说 DevTools 协议：fd3 写命令、fd4 读回复，消息以 \0 结尾。
 * 返回 send(method, params, sessionId) 和 once(event) 两个小工具，够打印用，不引入 puppeteer。
 */
function devtoolsPipe(child) {
  const pending = new Map();
  const listeners = [];
  let nextId = 1;
  let buffer = "";
  child.stdio[4].setEncoding("utf8");
  child.stdio[4].on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject, method } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`Chrome ${method} 出错：${message.error.message}`));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of [...listeners]) listener(message);
      }
    }
  });
  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  return {
    failAll,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      });
    },
    once(method, sessionId) {
      return new Promise((resolve) => {
        const listener = (message) => {
          if (message.method !== method || (sessionId && message.sessionId !== sessionId)) return;
          listeners.splice(listeners.indexOf(listener), 1);
          resolve(message.params);
        };
        listeners.push(listener);
      });
    },
  };
}

/**
 * HTML 字符串 → PDF Buffer（Chrome 无头打印）。
 *
 * 不用 --print-to-pdf 命令行开关：它打完就退出，退出时有竞态——PDF 还没写完文件浏览器就在销毁上下文，
 * SIGTRAP 崩掉、文件没写出来（日志里是 NOTREACHED … headless_command_processor.cc）。PDF 越大写得越久越容易撞上。
 * 2026-09-14 实测（Chrome 153）：912 页的教科书 3/3 必崩，233 页那段 3 次崩 1 次，纯偶发、与内容无关。
 * 改成走 DevTools 协议 Page.printToPDF，PDF 数据经管道流回来，拿到手之后才关浏览器，关的时候崩了也不影响结果。
 */
export async function htmlToPdf(html, { timeoutMs = Number(process.env.MOYE_PDF_TIMEOUT_MS) || 90000 } = {}) {
  const chrome = await findChrome();
  return printGate.run(async () => {
    const dir = await mkdtemp(join(tmpdir(), "moye-pdf-"));
    let child;
    let timer;
    try {
      const htmlPath = join(dir, "index.html");
      await writeFile(htmlPath, html, "utf8");
      // 自带浏览器给固定的 profile 目录（也在 data/browser/ 下），崩溃日志、缓存都留在自己家里
      const profileDir = join(BROWSER_DIR, "profile");
      if (isHeadlessShell(chrome)) await mkdir(profileDir, { recursive: true });
      const chromeArgs = [
        ...(isHeadlessShell(chrome) ? [`--user-data-dir=${profileDir}`] : ["--headless=new"]),
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--remote-debugging-pipe",
        "about:blank",
      ];
      // 服务是 launchd 的 ProcessType=Background，子进程继承后台资源策略（CPU 限流、线程上限 32），
      // Chrome 在这种策略下明显更慢（2026-09-14 实测小文档 6s vs 1.3s，当时还会让上面那个退出竞态更容易触发）。
      // taskpolicy -a 让 Chrome 按普通 App 的资源策略跑，服务本体仍留在后台。
      const useTaskpolicy = process.platform === "darwin" && await access(TASKPOLICY).then(() => true, () => false);
      const [command, args] = useTaskpolicy ? [TASKPOLICY, ["-a", chrome, ...chromeArgs]] : [chrome, chromeArgs];
      child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      // Chrome 在 mac 上会打一堆 CVDisplayLink 之类的噪音，只在真失败时才把它带出来
      const stderrSummary = () => stderr.split("\n").filter((l) => l.trim() && !/CVDisplayLink|cv_display_link|process_memory_mac|gcm\/engine/.test(l)).join(" ").trim().slice(0, 300);
      const cdp = devtoolsPipe(child);
      const exited = new Promise((_, reject) => {
        child.on("error", (error) => reject(error));
        child.on("close", (code, signal) => reject(new Error(`Chrome 打印中途退出（exit ${code ?? signal}）：${stderrSummary()}`)));
      });
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Chrome 打印超时（${Math.round(timeoutMs / 1000)}s 未返回）。`)), timeoutMs);
      });
      const print = async () => {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        await cdp.send("Page.enable", {}, sessionId);
        const loaded = cdp.once("Page.loadEventFired", sessionId);
        await cdp.send("Page.navigate", { url: `file://${htmlPath}` }, sessionId);
        await loaded;
        // KaTeX 字体是 data URI，load 事件时一般已就绪；保险起见等一下 fonts.ready
        await cdp.send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true }, sessionId);
        const { stream } = await cdp.send("Page.printToPDF", {
          printBackground: true,
          preferCSSPageSize: true, // 纸张和页边距以 PRINT_CSS 里的 @page 为准
          displayHeaderFooter: false,
          transferMode: "ReturnAsStream", // 大文档几十 MB，不要一次塞进一条消息
        }, sessionId);
        const parts = [];
        for (;;) {
          const { data, base64Encoded, eof } = await cdp.send("IO.read", { handle: stream, size: 8 * 1024 * 1024 }, sessionId);
          parts.push(Buffer.from(data, base64Encoded ? "base64" : "utf8"));
          if (eof) break;
        }
        await cdp.send("IO.close", { handle: stream }, sessionId);
        return Buffer.concat(parts);
      };
      try {
        return await Promise.race([print(), exited, timedOut]);
      } catch (error) {
        cdp.failAll(error);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        // 数据已经拿到（或已失败），直接结束 Chrome；它退出时崩不崩都无所谓了
        child.kill("SIGKILL");
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

// 一次打印超过约 150 页 Chrome 就开始偶发失败（渲染进程在 printToPDF 里崩掉，返回 Printing failed）：
// 2026-09-14 实测同一本书前 80 页 4/4、157 页 4/4、308 页 2/4、616 页 1/4 成功；用 pageRanges 分批打印同一个页面
// 也一样崩，而且每批都重排整本不省时间。所以大文档在 Markdown 层按标题切段，每段单独打印再用 pdf-lib 拼起来。
// 默认 300KB 一段：那本书约 4KB/页，一段约 75 页，留足余量。切口一律在标题前（切口处会另起一页，章节开头本来就合适）；
// 连续两倍长度都没有标题才退而在空行处切。不到一段长的文档不切，版面和一次打完完全一样。
const CHUNK_BYTES = Math.max(20000, Number(process.env.MOYE_PDF_CHUNK_BYTES) || 300000);
const PRINT_ATTEMPTS = 3;

/** 把 Markdown 切成若干段，切口不落在代码块或 $$ 公式块里。 */
export function splitMarkdownForPrint(markdown, targetBytes = CHUNK_BYTES) {
  const chunks = [];
  let current = [];
  let size = 0;
  let fence = null;
  let inMath = false;
  let hasContent = false;
  for (const line of String(markdown ?? "").split("\n")) {
    const outside = !fence && !inMath;
    const cut = hasContent && outside && (
      (size >= targetBytes && /^ {0,3}#{1,6}\s/.test(line)) ||
      (size >= targetBytes * 2 && line.trim() === "")
    );
    if (cut) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
      hasContent = false;
    }
    current.push(line);
    hasContent ||= Boolean(line.trim());
    size += Buffer.byteLength(line) + 1;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) fence = null;
    } else {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) fence = open[1];
      else if ((line.match(/\$\$/g) ?? []).length % 2) inMath = !inMath;
    }
  }
  // 在空行处切到文末时，最后一段可能只剩空行，并回上一段，免得多印一张白页
  if (chunks.length && !hasContent) chunks[chunks.length - 1] += `\n${current.join("\n")}`;
  else chunks.push(current.join("\n"));
  return chunks;
}

/** 打印失败（多半是上面说的偶发崩溃）就换个新 Chrome 再试，每次失败都记日志。 */
async function htmlToPdfWithRetry(html, label) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await htmlToPdf(html);
    } catch (error) {
      if (attempt >= PRINT_ATTEMPTS || /没有找到 Chrome|超时/.test(error.message)) throw error;
      console.error(`[PDF重试] ${label} 第 ${attempt} 次失败，重试：${error.message}`);
    }
  }
}

/**
 * Markdown → PDF Buffer。
 * title 是源文件名（不带扩展名）：作 PDF 元数据标题，并像 Obsidian 一样印在正文最前面（includeName，默认开）；
 * 没给 title 就退回正文第一个一级标题，此时不再额外印一遍。
 */
/** @param {{ title?: string, includeName?: boolean, remoteImages?: boolean }} [options] remoteImages 见 makeObsidianMarked */
export async function markdownToPdf(markdown, { title, includeName = true, remoteImages = false } = {}) {
  const docTitle = title || markdownTitle(markdown, "document");
  // 墨页自己转出来的 document.md 第一行就是「# 文件名」，这种再印一遍就重复了（Obsidian 会重复，我们不必）
  const heading = includeName && title && markdownTitle(markdown, "") !== title ? title : null;
  const chunks = splitMarkdownForPrint(stripFrontmatter(String(markdown ?? "")));
  if (chunks.length === 1) {
    return htmlToPdfWithRetry(await buildPrintableHtml(chunks[0], { title: docTitle, heading, remoteImages }), docTitle);
  }
  // 各段并行交给 printGate 排队（同时最多 MOYE_PDF_CONCURRENCY 个 Chrome）；文件名标题只印在第一段
  const parts = await Promise.all(chunks.map(async (chunk, index) =>
    htmlToPdfWithRetry(await buildPrintableHtml(chunk, { title: docTitle, heading: index === 0 ? heading : null, remoteImages }), `${docTitle} 第 ${index + 1}/${chunks.length} 段`)));
  const merged = await PDFDocument.create();
  for (const part of parts) {
    const source = await PDFDocument.load(part);
    for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page);
  }
  merged.setTitle(docTitle);
  return Buffer.from(await merged.save());
}

export function pdfGateStats() {
  return { limit: printGate.limit, inFlight: printGate.inFlight, waiting: printGate.waiters.length };
}
