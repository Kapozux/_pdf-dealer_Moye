"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { aiStaysLocal, defaultAiSettings, draftFromSaved, fetchAiModels, fetchSetup, getAiSettings, installComponent, patchAiSettings, saveAiSettings, testAiSettings, type AiModelOption, type AiProvider, type AiSettings, type ModelSource, type SetupComponent, type SetupStatus } from "../lib/ai-settings";
import { type ConversionMode, type ConversionResult, type PageResult } from "../lib/pdf-to-markdown";
import { fallbackCause, isFallback, outcome, parseAiReason } from "../lib/page-result.mjs";
import { explainError, summarizeCauses, type ErrorKind } from "../lib/explain-error.mjs";
import { newRow, rowsFromSaved, rowsToPayload, type KeyRow } from "../lib/key-pool.mjs";
import {
  cancelJob, deleteLibraryEntry, fetchLibraryEntry, fetchReflect, fetchSpeed, fetchStats, fetchTagBackfillStatus, fetchUsage, libraryPageImageUrl, libraryPdfUrl, listJobs, searchLibrary, type SearchResult,
  exportZipUrl, fetchLibraryDocumentPdf, imagesToPdf, listBatches, listLibraryItems, markdownToPdf, refineLibraryEntry, startTagBackfill, submitJob, subscribeJobs,
  type Batch, type Job, type Reflect, type ReflectRange, type SpeedTable, type Stats, type TagBackfillState, type Usage, type UsageRow,
} from "../lib/api";
import { t, tServer, getActiveLang, setActiveLang, readStoredLang, storeLang, type Lang } from "../lib/i18n";
import { marked } from "marked";
import { safeLinkRenderers } from "../lib/safe-url.mjs";
import katex from "katex";
import "katex/dist/katex.min.css";

// PPT/PPTX/Word（doc/docx）先在服务端转成 PDF 再走原来那套管线（见 server/office2pdf.mjs），
// 图片同理（见 server/image2pdf.mjs）。前端这边只需要放宽"只认 PDF"的校验，
// 不用关心转换细节。
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif"];
// Markdown 走的是反方向（→ PDF），不进转换队列、不进 Library：拖进来直接转成 PDF 下载
const MARKDOWN_EXTENSIONS = [".md", ".markdown"];
const ACCEPTED_EXTENSIONS = [".pdf", ".ppt", ".pptx", ".doc", ".docx", ...IMAGE_EXTENSIONS, ...MARKDOWN_EXTENSIONS];
function isAcceptedFile(f: File) {
  return f.type === "application/pdf" || ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext));
}
function isMarkdownFile(f: File) {
  return MARKDOWN_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext));
}
// 合成 PDF 的页序按文件名自然序：IMG_2 要排在 IMG_10 前面，默认的字典序会反过来
const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
function stripFileExtension(name: string) {
  return name.replace(/\.[^.]+$/, "");
}
function isImageFile(f: File) {
  return f.type.startsWith("image/") || IMAGE_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext));
}
// 只有真正的 PDF 才能直接拿浏览器本地的 blob URL 预览；PPT/Word/图片 要等服务端转完
// 才有 PDF 可看，本地文件本身塞进 <iframe> 是空白的。
function isPdfFile(f: File) {
  return f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
}

type Status = "idle" | "processing" | "batch" | "complete" | "error";
type Screen = "converter" | "library";
type ResultTab = "markdown" | "page" | "quality" | "compare" | "source";
type BatchItemStatus = "queued" | "processing" | "complete" | "error";
type BatchItem = {
  id: string;
  jobId?: string;
  /** 名字和大小单独存：从 URL 重新打开一个批次时没有 File 对象，只有服务端记录 */
  name: string;
  size: number;
  /** 只有本次会话里刚选的文件才有；提交之后就不再需要 */
  file?: File;
  status: BatchItemStatus;
  page: number;
  total: number;
  detail: string;
  result?: ConversionResult;
  error?: string;
  /** 提交时刻 / 结束时刻，用来算实时耗时 */
  startedAt?: number;
  finishedAt?: number;
};

/**
 * 页面路由（hash）。每个界面有自己的地址：Library、某份文档、某个批次——
 * 浏览器前进/后退能用，刷新不会丢页面，地址栏能直接分享给自己下次点开。
 * 用 hash 而不是真路径：vinext 的 app-router 按文件系统分路由，/library 会 404，
 * hash 对服务端完全透明，零风险。首页就是没有 hash 的裸地址。
 */
type Route =
  | { name: "home" }
  | { name: "library" }
  | { name: "doc"; id: string; page?: number }
  | { name: "batch"; id: string };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  if (path === "library") return { name: "library" };
  // #/doc/<id>/p/<n>：直接打开这份文档的「逐页核对」第 n 页
  const doc = path.match(/^doc\/([\w-]+)(?:\/p\/(\d+))?$/);
  if (doc) return doc[2] ? { name: "doc", id: doc[1], page: Number(doc[2]) } : { name: "doc", id: doc[1] };
  const batch = path.match(/^batch\/([\w-]+)$/);
  if (batch) return { name: "batch", id: batch[1] };
  return { name: "home" };
}

function routeHash(route: Route): string {
  switch (route.name) {
    case "library": return "#/library";
    case "doc": return `#/doc/${route.id}${route.page ? `/p/${route.page}` : ""}`;
    case "batch": return `#/batch/${route.id}`;
    default: return "";
  }
}

const modeNames: Record<ConversionMode, string> = {
  fast: "本地快速",
  balanced: "本地高精度",
  math: "本地高精度",
  ai: "AI 精校",
};
const visibleModes: ConversionMode[] = ["fast", "balanced", "ai"];
const modeDescriptions: Record<ConversionMode, string> = {
  fast: "直接读取 PDF 文字层，适合普通电子文档。",
  balanced: "本机 Surya 逐页识别版面、表格与公式，速度较慢。",
  math: "本机 Surya 逐页识别版面、表格与公式。",
  ai: "直接把页面图像交给视觉模型识别（不跑本地 Surya），文字层作提示与回退。",
};

/** 选模式时该一眼看到的三件事：多快、花不花钱、上不上传。数字来自实测（见 CLAUDE.md）。 */
/** AI 模式只走本机 Ollama 时，「按页计费 · 上传页面图像」这句就不对了。 */
function modeMetaFor(mode: ConversionMode, settings: AiSettings) {
  return mode === "ai" && aiStaysLocal(settings) ? "本机模型 · 较慢 · 免费 · 不上传" : modeMeta[mode];
}
const modeMeta: Record<ConversionMode, string> = {
  fast: "秒级 · 免费 · 不上传",
  balanced: "约 1 分钟/页 · 免费 · 不上传",
  math: "约 1 分钟/页 · 免费 · 不上传",
  ai: "约 15 秒/页 · 按页计费 · 上传页面图像",
};

/** tags 在库里是 JSON 数组字符串；坏数据当没有。 */
function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

/**
 * Markdown → HTML（含 LaTeX）。输出是带公式的 Markdown，只给源码看等于让人肉眼读 $…$
 * 判断公式对不对；渲染出来才叫"可验证"。
 * 公式先换成占位符再交给 marked：否则 LaTeX 里的 _ * \ 会被当成 Markdown 语法吃掉。
 * 原文里的裸 HTML 一律转义——内容来自 PDF 和模型，不可信。链接和图片同理：
 * 地址过白名单（lib/safe-url.mjs），javascript: 之类只留文字，外链图片不自动加载。
 */
function renderMarkdown(source: string): string {
  const formulas: string[] = [];
  const stash = (latex: string, display: boolean) => {
    formulas.push(katex.renderToString(latex, { displayMode: display, throwOnError: false, strict: "ignore" }));
    return `\uE000${formulas.length - 1}\uE001`;
  };
  const withPlaceholders = source
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, latex: string) => stash(latex.trim(), true))
    .replace(/(^|[^\\$])\$((?:\\.|[^$\n])+?)\$/g, (_, lead: string, latex: string) => `${lead}${stash(latex, false)}`);
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  Object.assign(renderer, safeLinkRenderers(t("图片")));
  const html = marked.parse(withPlaceholders, { renderer, gfm: true, async: false }) as string;
  return html.replace(/\uE000(\d+)\uE001/g, (_, index: string) => formulas[Number(index)] ?? "");
}

const providerNames: Record<AiProvider, string> = {
  gemini: "Gemini",
  kimi: "Kimi",
  qwen: "Qwen",
  openrouter: "OpenRouter",
  ollama: "Ollama",
};

const modelPresets: Record<AiProvider, { value: string; label: string }[]> = {
  gemini: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash · 推荐" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro · 更强" },
    { value: "gemini-flash-latest", label: "Gemini Flash Latest" },
  ],
  kimi: [
    { value: "kimi-k2.6", label: "Kimi K2.6 · 当前原生视觉推荐" },
    { value: "kimi-k2.5", label: "Kimi K2.5 · 多模态" },
  ],
  qwen: [
    { value: "qwen3.7-plus", label: "Qwen3.7 Plus · 当前稳定推荐 / 结构化输出" },
    { value: "qwen3.8-max-preview", label: "Qwen3.8 Max Preview · 最强预览 / Token Plan" },
    { value: "qwen3.7-max-2026-06-08", label: "Qwen3.7 Max 06-08 · 增强视觉" },
    { value: "qwen3.7-flash", label: "Qwen3.7 Flash · 当前低成本" },
    { value: "qwen3.7-flash-2026-07-15", label: "Qwen3.7 Flash 07-15 · 固定快照" },
    { value: "qwen3.6-plus", label: "Qwen3.6 Plus · 平衡" },
    { value: "qwen3.6-flash", label: "Qwen3.6 Flash · 低成本" },
    { value: "qwen-vl-ocr", label: "Qwen VL OCR · 文档/表格/试卷/手写" },
    { value: "qwen-vl-ocr-latest", label: "Qwen VL OCR Latest" },
  ],
  // 实测排序（同一份数学 PDF、64 路并发、关闭推理）：
  //   kimi-k2.6      1.9 页/s  $0.0028/页  LaTeX 71 ← 公式最全，理科文档首选
  //   qwen3.7-flash  4.2 页/s  $0.00013/页 LaTeX 36 ← 快一倍、便宜 20 倍，公式会掉
  //   glm-5v-turbo   1.8 页/s  $0.0055/页  LaTeX 64 ← 与 kimi 同速但贵一倍
  // gemini-2.5-flash 留着但不推荐：它和直连 Gemini 抢同一个 Google 配额池，
  // 绕道 OpenRouter 不会更快，只会多付一层加价。
  openrouter: [
    { value: "moonshotai/kimi-k2.6", label: "Kimi K2.6 · 数学/理科推荐 · 公式最全" },
    { value: "qwen/qwen3.7-flash", label: "Qwen3.7 Flash · 纯文字推荐 · 最快最便宜" },
    { value: "z-ai/glm-5v-turbo", label: "GLM-5V Turbo · 备选" },
    { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash · 与直连同配额，不建议" },
    { value: "qwen/qwen2.5-vl-72b-instruct", label: "Qwen 2.5 VL 72B" },
  ],
  // 本机模型：大小是 Ollama 库里的下载体积。都还没在墨页上实测过质量和速度，
  // 跑过真实文档后把实测数字补进标签（跟上面云端那几家一样）。
  ollama: [
    { value: "qwen3-vl:8b-instruct", label: "Qwen3-VL 8B · 6.1GB · 16GB 内存推荐" },
    { value: "qwen3-vl:4b-instruct", label: "Qwen3-VL 4B · 3.3GB · 8GB 内存可用" },
    { value: "qwen2.5vl:7b", label: "Qwen2.5-VL 7B · 6.0GB" },
    { value: "gemma3:12b", label: "Gemma 3 12B · 8.1GB · 需要 24GB 内存" },
    // 同一批模型的魔搭镜像（「环境」里选魔搭下载时就是这些名字）
    { value: "modelscope.cn/Qwen/Qwen3-VL-8B-Instruct-GGUF:Q4_K_M", label: "Qwen3-VL 8B · 魔搭镜像" },
    { value: "modelscope.cn/Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M", label: "Qwen3-VL 4B · 魔搭镜像" },
  ],
};

function ModelPicker({ id, provider, value, extra = [], onChange }: { id: string; provider: AiProvider; value: string; extra?: AiModelOption[]; onChange: (value: string) => void }) {
  const presets = [...modelPresets[provider]];
  for (const model of extra) {
    if (!presets.some((item) => item.value === model.id)) presets.push({ value: model.id, label: `${model.label} ${t("· 服务商返回")}` });
  }
  const isCustom = !presets.some((item) => item.value === value);
  return (
    <div className="model-picker">
      <select id={id} value={isCustom ? "__custom__" : value} onChange={(event) => { if (event.target.value !== "__custom__") onChange(event.target.value); }} aria-label={t("选择模型预设")}>
        {presets.map((item) => <option value={item.value} key={item.value}>{t(item.label)}</option>)}
        <option value="__custom__">{t("自定义 Model ID")}</option>
      </select>
      <input value={value} onChange={(event) => onChange(event.target.value)} aria-label={t("模型 ID")} placeholder={t("输入 Model ID")} />
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
function download(content: string, filename: string, type: string) {
  downloadBlob(new Blob([content], { type }), filename);
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 把毫秒变成「1 分 04 秒」这种好读的形式。 */
function formatElapsed(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return t("{n} 秒", { n: total });
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return t("{m} 分 {s} 秒", { m: minutes, s: String(total % 60).padStart(2, "0") });
  return t("{h} 时 {m} 分", { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, "0") });
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(getActiveLang() === "en" ? "en-US" : "zh-TW", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(timestamp);
}

/** 大数字缩写成「12.3K」这种形式，给统计面板的字数用。 */
function fmtBig(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** 美元：小于一分钱显示到 4 位，否则 2 位——AI 精校一页几厘钱，全显示两位小数就全是 $0.00 */
function fmtUsd(n: number) {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** Library 记录的费用短文案：没调用过模型 → null；有未计价的调用要标出来，不假装是全额 */
function costLabel(record: Pick<Job, "cost_usd" | "cost_calls" | "cost_unpriced">) {
  if (record.cost_calls === null || record.cost_calls === undefined || !record.cost_calls) return null;
  const usd = fmtUsd(record.cost_usd ?? 0);
  if (record.cost_unpriced) {
    return record.cost_unpriced === record.cost_calls ? t("未计价") : t("{usd}（{n} 次未计价）", { usd, n: record.cost_unpriced });
  }
  return usd;
}

/** 「约 X 秒/页」：一分钟以上换成分钟 */
function fmtSecPerPage(sec: number) {
  if (sec < 1) return t("约 {n} 秒/页", { n: sec.toFixed(1) });
  if (sec < 60) return t("约 {n} 秒/页", { n: Math.round(sec) });
  return t("约 {n} 分钟/页", { n: (sec / 60).toFixed(1) });
}

/** 统一面板的栏目 */
type PanelPane = "reflect" | "library" | "usage" | "settings" | "setup" | "about";

// 主题分段条的色阶：墨页绿 → 极浅；多出来的段落用最后一个
const REFLECT_SHADES = ["#1f5b41", "#3b8a61", "#6fae8b", "#a7cdb6", "#d3e5da", "#e9f1ec"];

// 单调三次插值（Fritsch–Carlson）：平滑但不会在 0 附近下冲出负值
function monotonePath(xs: number[], ys: number[]) {
  const n = xs.length;
  if (n < 2) return "";
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = Math.hypot(a, b);
    if (h > 3) { m[i] = (3 * a / h) * d[i]; m[i + 1] = (3 * b / h) * d[i]; }
  }
  let path = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    path += ` C${(xs[i] + dx).toFixed(1)},${(ys[i] + m[i] * dx).toFixed(1)} ${(xs[i + 1] - dx).toFixed(1)},${(ys[i + 1] - m[i + 1] * dx).toFixed(1)} ${xs[i + 1].toFixed(1)},${ys[i + 1].toFixed(1)}`;
  }
  return path;
}

// 整齐的 y 轴刻度上限：1,2,3,4,5,6,8,10,20…
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 2, 3, 4, 5, 6, 8, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}

function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  if (getActiveLang() === "zh") return `${y}年${m}月${d}日`;
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${M[m - 1]} ${d} ${y}`;
}

function fmtHour(h: number | null) {
  if (h === null || h === undefined) return "—";
  if (getActiveLang() === "zh") return `${h}:00`;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

type DayPoint = { date: string; count: number; pages: number };

/** 回顾：按日折线，实线本期、点线上一期；x 轴按自然日铺满 */
function ReflectChart({ series, prevSeries, metric }: { series: DayPoint[]; prevSeries: DayPoint[]; metric: "count" | "pages" }) {
  const W = 900, H = 260, L = 48, R = 12, T = 18, B = 34;
  const cur = series.map((p) => p[metric]);
  const prev = prevSeries.map((p) => p[metric]);
  if (cur.length < 2) return <div className="reflect-empty">{t("数据还不够画图")}</div>;
  const maxV = niceCeil(Math.max(...cur, ...prev, 1));
  const X = (i: number) => L + (i / (cur.length - 1)) * (W - L - R);
  const Y = (v: number) => H - B - (v / maxV) * (H - T - B);
  const xs = cur.map((_, i) => X(i));
  const prevXs = prev.map((_, i) => X(i + (cur.length - prev.length)));
  const ticks = [maxV, maxV * 0.6];
  const idxs = [0, Math.round((cur.length - 1) / 3), Math.round(((cur.length - 1) * 2) / 3), cur.length - 1];
  return (
    <svg className="reflect-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {ticks.map((v) => (
        <g key={v}>
          <line className="grid" x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} />
          <text className="ylab" x={L - 12} y={Y(v) + 4} textAnchor="end">{Math.round(v)}</text>
        </g>
      ))}
      <line className="base" x1={L} x2={W - R} y1={Y(0)} y2={Y(0)} />
      <text className="ylab" x={L - 12} y={Y(0) + 4} textAnchor="end">0</text>
      {idxs.map((i, k) => (
        <text key={k} className="xlab" x={X(i)} y={H - 8} textAnchor={k === 0 ? "start" : k === 3 ? "end" : "middle"}>{fmtDay(series[i].date)}</text>
      ))}
      {prev.length >= 2 && <path className="prev" d={monotonePath(prevXs, prev.map(Y))} />}
      <path className="cur" d={monotonePath(xs, cur.map(Y))} />
    </svg>
  );
}

/** 资料库：累计页数折线，按自然日铺满，带渐变面积和末端圆点 */
function CumulativeChart({ timeline }: { timeline: { day: string; pages: number }[] }) {
  if (timeline.length < 2) return <div className="reflect-empty">{t("数据还不够画图")}</div>;
  const byDay = new Map(timeline.map((p) => [p.day, p.pages]));
  const first = new Date(`${timeline[0].day}T00:00:00`);
  const last = new Date(`${timeline[timeline.length - 1].day}T00:00:00`);
  const days: { date: string; v: number }[] = [];
  let cum = 0;
  for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    cum += byDay.get(k) ?? 0;
    days.push({ date: k, v: cum });
  }
  const W = 900, H = 260, L = 52, R = 12, T = 18, B = 34;
  const maxV = niceCeil(days[days.length - 1].v);
  const X = (i: number) => L + (i / (days.length - 1)) * (W - L - R);
  const Y = (v: number) => H - B - (v / maxV) * (H - T - B);
  const xs = days.map((_, i) => X(i));
  const ys = days.map((p) => Y(p.v));
  const idxs = [0, Math.round((days.length - 1) / 3), Math.round(((days.length - 1) * 2) / 3), days.length - 1];
  const area = `M${xs[0]},${Y(0)} L${xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ")} L${xs[xs.length - 1]},${Y(0)} Z`;
  return (
    <svg className="reflect-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="libfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--green)" stopOpacity="0.16" />
          <stop offset="1" stopColor="var(--green)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[maxV, maxV * 0.6].map((v) => (
        <g key={v}>
          <line className="grid" x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} />
          <text className="ylab" x={L - 12} y={Y(v) + 4} textAnchor="end">{Math.round(v)}</text>
        </g>
      ))}
      <line className="base" x1={L} x2={W - R} y1={Y(0)} y2={Y(0)} />
      <text className="ylab" x={L - 12} y={Y(0) + 4} textAnchor="end">0</text>
      {idxs.map((i, k) => (
        <text key={k} className="xlab" x={X(i)} y={H - 8} textAnchor={k === 0 ? "start" : k === 3 ? "end" : "middle"}>{fmtDay(days[i].date)}</text>
      ))}
      <path d={area} fill="url(#libfill)" />
      <path className="cur" d={monotonePath(xs, ys)} />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={4} fill="var(--green)" />
    </svg>
  );
}

/**
 * 下载文件名：「名字 日期.md」。
 * 名字：原文件名本身像个标题（打标签时 AI 判断的 filename_meaningful）就用原文件名，
 *       否则用 AI 标题；都没有退回原文件名。日期是转换日期。
 * 不加随机串：浏览器遇到同名下载会自己加 (1)。
 */
function docDownloadName(job: Job | null | undefined, fallbackTitle: string, ext: string) {
  const clean = (x: string) => x.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  const stem = clean(job ? stripExt(job.filename) : fallbackTitle);
  const aiTitle = clean(job?.ai_title || "");
  const name = (job?.filename_meaningful === 0 && aiTitle) ? aiTitle : (stem || aiTitle || "document");
  const date = (job?.created_at || new Date().toISOString()).slice(0, 10);
  return `${name} ${date}.${ext}`;
}
function stripExt(name: string) {
  return name.replace(/\.(pdf|pptx?|docx?|png|jpe?g|webp|bmp|gif|tiff?|hei[cf])$/i, "");
}

/** 列表里显示的名字：原文件名不像标题（AI 判定）就用 AI 起的标题，规则同 docDownloadName。 */
function recordTitle(record: Pick<Job, "filename" | "ai_title" | "filename_meaningful">) {
  const aiTitle = (record.ai_title || "").trim();
  return record.filename_meaningful === 0 && aiTitle ? aiTitle : stripExt(record.filename);
}

/**
 * 质量徽记分三级：有回退页才红（模型没认出来、用了文字层），只是建议复核的灰，全过的绿。
 * 以前一律红：AI 模式下笔记类文档每页都进复核清单，四条记录全是红字，等于没标。
 */
function qualityBadge(record: Pick<Job, "review_count" | "fallback_count">) {
  const fallback = record.fallback_count ?? 0;
  if (fallback > 0) return { tone: "bad", text: t("{n} 页回退文字层", { n: fallback }) };
  if (record.review_count > 0) return { tone: "soft", text: t("{n} 页建议复核", { n: record.review_count }) };
  return { tone: "good", text: t("检查通过") };
}

/** 逐页耗时的短文案：AI 页排队和模型调用差得大时把模型那段也标出来 */
function pageTimeLabel(page: PageResult) {
  if (page.durationMs === undefined) return null;
  const total = (page.durationMs / 1000).toFixed(1);
  if (page.modelMs !== undefined && page.durationMs - page.modelMs >= 1000) {
    return t("耗时 {n} 秒 · 模型 {m} 秒", { n: total, m: (page.modelMs / 1000).toFixed(1) });
  }
  return t("耗时 {n} 秒", { n: total });
}

/**
 * 回退页留下的是交给模型的那份初稿：AI 模式下是 PDF 文字层（method "text"），本地模式下是 Surya。
 * 扫描版没有文字层（method "empty"）：没有东西可回退，这一页在结果里是空的——必须直说，
 * 实测库里这样的页有四百多页，以前被写成「已回退」，看起来像有内容。
 * 分不清出处的（重新精校过的老记录）只说「本地初稿」，不冒充 Surya。
 */
function fallbackLabel(page: PageResult) {
  if (page.method === "empty") return t("AI 未通过 · 这页没有文字层可回退，结果为空");
  return page.method === "text" ? t("AI 未通过 · 已回退 PDF 文字层") : t("AI 未通过 · 已回退本地初稿");
}

/**
 * 报错类别 → 一句人话 + 下一步（中文即 i18n 的 key）。分类规则在 lib/explain-error.mjs，
 * 那里按库里真实出现过的报错定；这里只管怎么说。short 用在汇总条里（「超时 385 · 连不上 20」）。
 */
const errorCopy: Record<ErrorKind, { short: string; title: string; action: string }> = {
  credits: { short: "额度用完", title: "服务商额度用完了", action: "去服务商充值，或在设置里换一家；额度恢复前重跑也会失败" },
  auth: { short: "Key 无效", title: "API Key 无效或没有权限", action: "去设置检查这家服务的 Key" },
  rateLimit: { short: "被限流", title: "请求太密，被服务商限流", action: "过几分钟再重跑" },
  timeout: { short: "超时", title: "服务商太慢，超时了", action: "高峰期常见，稍后重跑回退页一般能好" },
  network: { short: "连不上", title: "连不上服务商", action: "检查网络或代理，恢复后重跑" },
  model: { short: "模型不可用", title: "这个模型现在用不了", action: "去设置换一个模型" },
  blocked: { short: "被拦截", title: "内容被服务商拦截", action: "换一家服务商，或这份改用本地高精度" },
  badOutput: { short: "输出坏了", title: "模型这次的输出坏了", action: "多半是偶发的，重跑一般能好" },
  rejected: { short: "没过校验", title: "模型结果没过程序校验", action: "重跑可能会好；经常出现就换个模型" },
  emptyFile: { short: "空文件", title: "文件是空的（0 字节）", action: "重新选一次原文件" },
  unknown: { short: "其他", title: "原因不明", action: "展开看原始报错" },
};
const fixedInSettings = (kind: ErrorKind) => kind === "credits" || kind === "auth" || kind === "model";

/**
 * 一条报错：类别一句话 + 下一步。原始报错收进可展开的「原始报错」——
 * 不放在悬停提示里（Verbatim 那样触屏看不到、也复制不了）。
 */
function ExplainedError({ message, stage = "call", pageEmpty = false, onOpenSettings }: { message: string; stage?: "call" | "check"; pageEmpty?: boolean; onOpenSettings?: () => void }) {
  const { kind, detail } = explainError(message, stage);
  return (
    <div className="explained-error">
      <p>
        <b>{t(errorCopy[kind].title)}</b>{pageEmpty && <> · {t("这页结果为空")}</>} · {t(errorCopy[kind].action)}
        {onOpenSettings && fixedInSettings(kind) && <> <button type="button" className="inline-link" onClick={onOpenSettings}>{t("打开设置")}</button></>}
      </p>
      <details><summary>{t("原始报错")}</summary><code>{tServer(detail)}</code></details>
    </div>
  );
}

/** 逐页的原因：AI 失败 / 没过校验的那几行换成解释，其余（文字层过少、模型标记不确定……）照原样。 */
function PageReasons({ page, onOpenSettings }: { page: PageResult; onOpenSettings: () => void }) {
  if (!page.reasons.length) return <p>{t("程序校验通过")}</p>;
  return <>{page.reasons.map((reason) => {
    const cause = parseAiReason(reason);
    return cause
      ? <ExplainedError key={reason} message={cause.message} stage={cause.stage} pageEmpty={cause.pageEmpty} onOpenSettings={onOpenSettings} />
      : <p key={reason}>{tServer(reason)}</p>;
  })}</>;
}

/** 「⋯」菜单：次要操作收进来，一个区域只留一个主按钮（Verbatim 的 UI 规范）。点外面 / Esc 关。 */
function MoreMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="more-menu" ref={ref}>
      <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((value) => !value)}>⋯</button>
      {open && <div className="more-menu-list" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/**
 * 顶栏「进行中」：一个任务时点了直接去它那儿；多个时弹出列表（名字 · 进度 · 用时 · 取消），
 * 以前只会跳到第一个，其余的得回首页找（Verbatim 顶栏的同款弹层）。点外面 / Esc 关。
 */
function ActiveJobsMenu({ jobs, now, onOpen, onCancel }: { jobs: Job[]; now: number; onOpen: (job: Job) => void; onCancel: (job: Job) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="more-menu running-menu" ref={ref}>
      <button className="library-nav running-nav" type="button" aria-haspopup={jobs.length > 1 ? "menu" : undefined} aria-expanded={jobs.length > 1 ? open : undefined} title={t("查看进度")}
        onClick={() => (jobs.length > 1 ? setOpen((value) => !value) : onOpen(jobs[0]))}>
        <i />{t("进行中")} <b>{jobs.length}</b>
      </button>
      {open && (
        <div className="more-menu-list running-list" role="menu">
          {jobs.map((job) => (
            <div key={job.id} className="running-item">
              <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpen(job); }}>
                <span>{job.filename}</span>
                <small>{job.status === "queued" ? t("排队中") : job.total ? `${job.page}/${job.total} ${t("页")}` : t("处理中")} · ⏱ {formatElapsed(now - new Date(job.created_at).getTime())}</small>
              </button>
              <button type="button" className="running-cancel" onClick={() => onCancel(job)} aria-label={t("取消「{name}」", { name: job.filename })}>{t("取消")}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 待转区里一个文件的身份（同一个文件拖两次算一个）。 */
const stagedKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

/**
 * 待转区里这个文件是不是已经转过：PDF 按「文件名 + 大小」认（Library 存的就是原文件大小）；
 * Office / 图片存的是转出来的 PDF 的大小，对不上，只能按文件名提示「可能转过」。
 */
function findConverted(f: File, library: Job[]): { job: Job; exact: boolean } | null {
  const done = library.filter((job) => job.status === "done" && job.filename === f.name);
  const exact = isPdfFile(f) ? done.find((job) => job.file_size === f.size) : undefined;
  if (exact) return { job: exact, exact: true };
  return done[0] ? { job: done[0], exact: false } : null;
}

/** 最近 AI 精校的实际花费，每页多少钱（中位数）。没有计过价的（直连 Kimi / Qwen）不算；样本不到 3 份不给数。 */
function aiCostPerPage(library: Job[]): number | null {
  const samples = library
    .filter((job) => job.mode === "ai" && job.status === "done" && (job.cost_usd ?? 0) > 0 && job.page_count > 0)
    .slice(0, 50)
    .map((job) => (job.cost_usd as number) / job.page_count)
    .sort((a, b) => a - b);
  return samples.length >= 3 ? samples[Math.floor(samples.length / 2)] : null;
}

function methodLabel(page: PageResult) {
  const result = outcome(page);
  if (result === "ai" || result === "noText") {
    const providerName = providerNames[page.provider || "gemini"] ?? page.provider;
    return `${providerName} · ${page.model || t("视觉模型")}`;
  }
  if (result === "fallback") return fallbackLabel(page);
  if (page.method === "surya") return t("Surya 本地视觉识别");
  if (page.method === "ocr") return t("本地 OCR");
  if (page.method === "text") return t("PDF 文字层");
  return t("未识别");
}

/**
 * 等一个服务端任务跑完。进度来自 SSE（服务端广播），
 * 另有低频轮询兜底，避免 SSE 断连时干等。
 */
function waitForJob(jobId: string, onProgress: (job: Job) => void): Promise<Job> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (job: Job) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearInterval(poll);
      resolve(job);
    };
    const handle = (job: Job) => {
      if (job.id !== jobId) return;
      onProgress(job);
      if (["done", "failed", "cancelled"].includes(job.status)) finish(job);
    };
    const unsubscribe = subscribeJobs(handle);
    const poll = setInterval(() => {
      void listJobs()
        .then((jobs) => {
          const job = jobs.find((item) => item.id === jobId);
          if (job) handle(job);
        })
        .catch(() => undefined);
    }, 4000);
    setTimeout(() => {
      if (!settled) {
        void listJobs()
          .then((jobs) => {
            const job = jobs.find((item) => item.id === jobId);
            if (!job) {
              settled = true;
              unsubscribe();
              clearInterval(poll);
              reject(new Error(t("任务不存在或已被清除。")));
            }
          })
          .catch(() => undefined);
      }
    }, 2000);
  });
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<ConversionMode>("balanced");
  const [status, setStatus] = useState<Status>("idle");
  const [sourceUrl, setSourceUrl] = useState("");
  const [progress, setProgress] = useState({ page: 0, total: 0 });
  const [progressDetail, setProgressDetail] = useState(t("正在读取 PDF 结构…"));
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [error, setError] = useState("");
  // 重新精校失败时服务端会保留旧结果（不是空白报错屏），但要让用户知道这次其实没有真的变化
  const [refineWarning, setRefineWarning] = useState("");
  const [tab, setTab] = useState<ResultTab>("markdown");
  // 逐页核对：正在看第几页（0 = 这份文档还没进过核对，进来时跳到第一个要检查的页）
  const [checkPage, setCheckPage] = useState(0);
  const [imageFailedPage, setImageFailedPage] = useState(0);
  // 从「第 N 页」链接进核对时记下原来的标签，浏览器后退时回到那里
  const pageReturnTab = useRef<ResultTab>("quality");
  // Markdown 标签页：默认看渲染结果（公式、表格、标题都成形），要核对原文再切源码
  const [mdView, setMdView] = useState<"rendered" | "raw">("rendered");
  const [copied, setCopied] = useState(false);
  // Markdown → PDF：结果页「下载 PDF」的进行中状态；首页拖入 .md 后的一句结果提示
  const [pdfBusy, setPdfBusy] = useState(false);
  // mdNote 同时也是「图片合成 PDF」的结果行：两条旁路共用首页同一个位置，不叠两行状态
  const [mdNote, setMdNote] = useState("");
  const [imagesBusy, setImagesBusy] = useState(false);
  const [screen, setScreen] = useState<Screen>("converter");
  const [library, setLibrary] = useState<Job[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [activeJobId, setActiveJobId] = useState<string>("");
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [query, setQuery] = useState("");
  // 正文全文搜索的结果（id → 命中），和文件名 / 标签过滤合在一起用；quality 是「有回退页 / 建议复核」筛选
  const [textHits, setTextHits] = useState<Map<string, SearchResult>>(new Map());
  const [qualityFilter, setQualityFilter] = useState<"all" | "fallback" | "review">("all");
  const latestSearch = useRef("");
  // 自由合并下载：跟批次无关，随便勾几份就能拼成一份 .md
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<Set<string>>(new Set());
  const [mergingLibrary, setMergingLibrary] = useState(false);
  const [activeFilename, setActiveFilename] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AiSettings>(defaultAiSettings);
  const [settingsDraft, setSettingsDraft] = useState<AiSettings>(defaultAiSettings);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [remoteModels, setRemoteModels] = useState<{ provider: AiProvider; models: AiModelOption[] } | null>(null);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  // 当前批次页对应的服务端 batch_id；有了它批次页才能有自己的地址、刷新后从服务端重建
  const [batchId, setBatchId] = useState("");
  // 选好的文件先暂存，等用户按「开始转换」再提交——不再一选中就自动跑
  const [staged, setStaged] = useState<File[]>([]);
  /**
   * 并行密钥列表。每项要么是「已存在的」（只有打码文本，明文在服务端），
   * 要么是「新填的」（有明文）。以前这里只存明文字符串，而服务端从不回传
   * 明文，所以列表永远是空的——用户以为没存上，重新添加就把旧的覆盖了。
   * 行与保存请求之间的协议见 lib/key-pool.mjs。
   */
  const [extraKeys, setExtraKeys] = useState<KeyRow[]>([]);
  const updateExtraKey = (index: number, next: string) =>
    setExtraKeys((keys) => keys.map((k, i) => (i === index ? { ...k, value: next } : k)));
  const addExtraKey = () => setExtraKeys((keys) => [...keys, newRow()]);
  const removeExtraKey = (index: number) => setExtraKeys((keys) => keys.filter((_, i) => i !== index));
  // 服务端正在跑/排队的任务：任务不在浏览器里跑，所以重开页面必须能看到它们
  const [activeJobs, setActiveJobs] = useState<Job[]>([]);
  // 每秒走一次的时钟，只在有任务在跑时开着——耗时要实时跳，但空闲时不该白转
  const [now, setNow] = useState(() => Date.now());
  // 从哪个界面点进结果页的，决定「返回」回到哪
  const [cameFrom, setCameFrom] = useState<Screen | "batch" | null>(null);
  // 本次转换的开始时刻，用来显示总计时（单份和批量共用）
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runEndedAt, setRunEndedAt] = useState<number | null>(null);
  // 统一面板（回顾 / 资料库 / 设置 / 关于）：showSettings 是开关，panelPane 是当前栏目
  const [panelPane, setPanelPane] = useState<PanelPane>("reflect");
  const [panelQuery, setPanelQuery] = useState("");
  // 资料库总量：切到那一栏才拉一次
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  // 回顾：服务端提前算好；缓存过期时先给旧的，这里轮询到新的再替换
  const [reflectData, setReflectData] = useState<Reflect | null>(null);
  const [reflectRange, setReflectRange] = useState<ReflectRange>("1m");
  const [reflectMetric, setReflectMetric] = useState<"count" | "pages">("count");
  const [reflectBusy, setReflectBusy] = useState(false);
  const reflectReq = useRef(0);
  // 结果页对应的 Library 记录：下载文件名要用它的 AI 标题 / 转换日期
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [backfillState, setBackfillState] = useState<TagBackfillState | null>(null);
  // 用量栏：切过去时拉，每次打开都重新拉（费用会随任务变）
  const [usageData, setUsageData] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState("");
  const [usageScope, setUsageScope] = useState<"month" | "all">("month");
  // 环境栏：各组件装没装（首页也用它提示「这个模式缺什么」）；补装时轮询进度
  const [setupData, setSetupData] = useState<SetupStatus | null>(null);
  const [setupError, setSetupError] = useState("");
  const [ollamaPick, setOllamaPick] = useState("");
  const [modelSourcePick, setModelSourcePick] = useState<ModelSource | "">("");
  // 按模式的每页秒数（服务端按最近 50 份的中位数算；样本不足给 null）——模式说明和预计剩余时间用
  const [speed, setSpeed] = useState<SpeedTable>({});
  // 单实例 toast：只有一条、2 秒消失；再来一条就顶掉前一条
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 「跑完了」只提醒一次：批量和单份各记一个已通知的标识
  const notifiedRef = useRef<string | null>(null);
  // 界面语言。SSR 和首屏都用中文，挂载后按本机存的偏好切换（避免水合不一致）；
  // 每次渲染开头把当前语言写进 i18n 模块，之后所有 t() 都按它查表。
  const [lang, setLang] = useState<Lang>("zh");
  setActiveLang(lang);
  useEffect(() => {
    // 放到下一拍：首屏必须和 SSR 一样是中文，水合完成后再切到本机偏好
    const stored = readStoredLang();
    if (stored === "zh") return;
    const timer = setTimeout(() => setLang(stored), 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => { document.documentElement.lang = lang === "en" ? "en" : "zh-Hant"; }, [lang]);
  function toggleLang() {
    const next: Lang = lang === "en" ? "zh" : "en";
    setLang(next);
    storeLang(next);
  }

  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);
  // 计时器只在真的有东西在跑时才转；跑完（runEndedAt 有值）立刻停，避免空转重渲染
  useEffect(() => {
    const live = activeJobs.length > 0 || batchRunning || status === "processing"
      || (runStartedAt !== null && runEndedAt === null && status === "batch");
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeJobs.length, batchRunning, status, runStartedAt, runEndedAt]);
  // 开页拉一次 + 订阅 SSE：关掉页面再回来，也能看到还在跑的任务
  /**
   * 订阅服务端任务进度。
   *
   * SSE 每条进度都直接 setState 会把页面卡死：服务端对每个任务节流到 300ms，
   * 但十几个任务同时跑就是每秒几十次全页重渲染。这里先攒进 ref，每 500ms
   * 统一刷一次界面——进度条本来也不需要比这更快。
   * 同理，任务完成时不立刻拉整个 Library，攒到同一次刷新里做。
   */
  useEffect(() => {
    const isLive = (j: Job) => j.status === "queued" || j.status === "running";
    void listJobs().then((jobs) => setActiveJobs(jobs.filter(isLive))).catch(() => undefined);

    const pending = new Map<string, Job>();
    let libraryDirty = false;
    const unsubscribe = subscribeJobs((job) => {
      pending.set(job.id, job);
      if (!isLive(job)) libraryDirty = true;
    });
    const flush = setInterval(() => {
      if (pending.size) {
        const batch = [...pending.values()];
        pending.clear();
        setActiveJobs((prev) => {
          const byId = new Map(prev.map((j) => [j.id, j]));
          for (const job of batch) {
            if (isLive(job)) byId.set(job.id, job);
            else byId.delete(job.id);
          }
          return [...byId.values()];
        });
      }
      if (libraryDirty) {
        libraryDirty = false;
        void refreshLibrary();
      }
    }, 500);

    return () => { unsubscribe(); clearInterval(flush); };
  }, []);

  useEffect(() => {
    void refreshLibrary();
    void getAiSettings().then((loaded) => {
      setSettings(loaded);
      setSettingsDraft(draftFromSaved(loaded));
    }).catch(() => undefined);
    void fetchSpeed().then(setSpeed).catch(() => undefined);
    void fetchSetup().then(setSetupData).catch(() => undefined);
  }, []);
  // 每完成一份就刷新一次速度表：预计剩余时间用最近的样本
  useEffect(() => {
    if (status === "complete" || (status === "batch" && !batchRunning)) void fetchSpeed().then(setSpeed).catch(() => undefined);
  }, [status, batchRunning]);
  // Esc 关面板（点背景关已经有了）
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setShowSettings(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);

  function showToast(message: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }

  /**
   * 「跑完了」的提醒。用户经常关着页面（切到别的标签）等文件：页面不可见就发系统通知，
   * 可见就只弹一条 toast。权限在提交任务那一刻（用户手势里）申请，这里只管发。
   */
  function announceDone(key: string, title: string, body: string) {
    if (notifiedRef.current === key) return;
    notifiedRef.current = key;
    if (document.visibilityState === "visible") { showToast(`${title} · ${body}`); return; }
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const note = new Notification(title, { body, tag: key });
        note.onclick = () => { window.focus(); note.close(); };
      }
    } catch {
      /* 通知发不出去（Safari 私密窗口等）就算了，结果页本来也会在那里 */
    }
  }
  function askNotifyPermission() {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
    } catch {
      /* 同上 */
    }
  }

  const stagedHasImage = useMemo(() => staged.some(isImageFile), [staged]);
  // 待转区预检：每份几页（PDF 在浏览器里读，80MB 以内；图片一张一页；Office 转完才知道）
  const [stagedPages, setStagedPages] = useState<Record<string, number | null>>({});
  // 每个文件只读一次页数：已经开始读的记在这里（不放进 state，免得读完一份就触发重跑、把读到一半的那份丢掉重来）
  const pageCountStarted = useRef(new Set<string>());
  useEffect(() => {
    const pending = staged.filter((f) => !pageCountStarted.current.has(stagedKey(f)));
    if (!pending.length) return;
    for (const f of pending) pageCountStarted.current.add(stagedKey(f));
    void (async () => {
      // pdf-lib 按需加载：没有 PDF 的时候不下载它
      const pdfLib = pending.some(isPdfFile) ? await import("pdf-lib") : null;
      for (const f of pending) {
        let pages: number | null = null;
        if (isImageFile(f)) pages = 1;
        else if (pdfLib && isPdfFile(f) && f.size <= 80 * 1024 * 1024) {
          try {
            pages = (await pdfLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false })).getPageCount();
          } catch (caught) {
            // 读不出页数只影响预估，不影响转换：照常可以开始，页数显示「转换后才知道」
            console.warn(`[预检] 读不出 ${f.name} 的页数：`, caught);
          }
        }
        setStagedPages((prev) => ({ ...prev, [stagedKey(f)]: pages }));
      }
    })();
  }, [staged]);
  const stagedEstimate = useMemo(() => {
    const counts = staged.map((f) => stagedPages[stagedKey(f)]);
    const pages = counts.reduce<number>((sum, n) => sum + (typeof n === "number" ? n : 0), 0);
    const unknown = counts.filter((n) => typeof n !== "number").length;
    const secPerPage = speed[mode]?.secPerPage ?? null;
    const costPerPage = mode === "ai" ? aiCostPerPage(library) : null;
    return {
      pages,
      unknown,
      seconds: secPerPage !== null && pages ? pages * secPerPage : null,
      cost: costPerPage !== null && pages ? pages * costPerPage : null,
    };
  }, [staged, stagedPages, speed, mode, library]);
  // 「这页本来就没有文字」（照片、空白页）单独数：它在服务端也是 review（要出现在逐页质量里），
  // 但混进「建议检查」会把真正要看的页淹掉——笔记类文档几乎每张插图都会命中
  const noTextPages = useMemo(() => result?.pages.filter((page) => outcome(page) === "noText") ?? [], [result]);
  const reviewPages = useMemo(() => result?.pages.filter((page) => page.status === "review" && outcome(page) !== "noText") ?? [], [result]);
  // 逐页耗时的概览：平均 + 最慢的那页，具体每页看「逐页质量」tab。旧记录没这个字段就不显示
  const pageTimeSummary = useMemo(() => {
    const timed = result?.pages.filter((page) => page.durationMs !== undefined) ?? [];
    if (!timed.length) return null;
    const slowest = timed.reduce((a, b) => ((b.durationMs ?? 0) > (a.durationMs ?? 0) ? b : a));
    const avg = timed.reduce((sum, page) => sum + (page.durationMs ?? 0), 0) / timed.length / 1000;
    return t("平均 {avg} 秒/页 · 最慢第 {n} 页 {s} 秒", { avg: avg.toFixed(1), n: slowest.page, s: ((slowest.durationMs ?? 0) / 1000).toFixed(1) });
  }, [result]);
  const comparedPages = useMemo(() => result?.pages.filter((page) => page.rawMarkdown !== undefined) ?? [], [result]);
  // 上次 AI 没成功的页数：决定要不要露出「只重跑回退页」按钮（全部成功就没必要）
  const fallbackPages = useMemo(() => result?.pages.filter(isFallback) ?? [], [result]);
  // 渲染一次缓存住：几百页的文档有上千个公式，切标签页不该每次重算
  const renderedMarkdown = useMemo(() => (result && mdView === "rendered" ? renderMarkdown(result.markdown) : ""), [result, mdView]);
  // 回退页为什么回退：按类别汇总（超时 385 · 连不上 20 · 额度用完 4），以及哪些类别不先处理重跑也没用
  const fallbackSummary = useMemo(() => summarizeCauses(fallbackPages.map(fallbackCause)), [fallbackPages]);
  const checkTarget = useMemo(() => result?.pages.find((page) => page.page === checkPage) ?? null, [result, checkPage]);
  const checkHtml = useMemo(() => (checkTarget?.markdown ? renderMarkdown(checkTarget.markdown) : ""), [checkTarget]);
  // 「下一个要检查的页」：回退页和建议检查的页（不含没有文字的页），到底了从头再找
  const nextProblemPage = useMemo(() => {
    if (!reviewPages.length) return null;
    const after = reviewPages.find((page) => page.page > checkPage) ?? reviewPages[0];
    return after.page === checkPage ? null : after.page;
  }, [reviewPages, checkPage]);
  // 核对时预先要下一页原图：服务端现渲染一页要一秒左右，翻页时就不用等
  useEffect(() => {
    if (tab !== "page" || !activeJobId || !result || checkPage >= result.pageCount) return;
    const prefetch = new Image();
    prefetch.src = libraryPageImageUrl(activeJobId, checkPage + 1);
  }, [tab, activeJobId, result, checkPage]);
  // 核对时 ← → 翻页（焦点在输入框里时不抢）
  const goToPageRef = useRef<(page: number) => void>(() => undefined);
  useEffect(() => {
    if (tab !== "page") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || showSettings) return;
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (event.key === "ArrowLeft") goToPageRef.current(checkPage - 1);
      if (event.key === "ArrowRight") goToPageRef.current(checkPage + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, checkPage, showSettings]);
  const aiWasUsed = mode === "ai" || result?.pages.some((page) => page.method === "ai" || page.aiAttempted);
  // 哪些渠道已经有 Key（多渠道分流时实际参与的就是这几家）。
  // 用已保存的 settings 而不是 draft：draft 里的 Key 输入框是空的（留空=保留原值）。
  const configuredProviders = useMemo(
    () => (["gemini", "kimi", "qwen", "openrouter", "ollama"] as AiProvider[]).filter(
      (p) => settings[`${p}Configured` as const]
    ),
    [settings]
  );
  const percent = progress.total ? Math.round((progress.page / progress.total) * 100) : 0;
  const filteredLibrary = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const byQuality = qualityFilter === "fallback"
      ? library.filter((item) => (item.fallback_count ?? 0) > 0)
      : qualityFilter === "review"
        ? library.filter((item) => item.review_count > 0 && !(item.fallback_count ?? 0))
        : library;
    if (!normalized) return byQuality;
    // 文件名、AI 打的标签、正文（服务端全文搜索）都搜；正文命中的按命中次数排在前面
    const nameOrTag = (item: Job) =>
      item.filename.toLocaleLowerCase().includes(normalized)
      || parseTags(item.tags).some((tag) => tag.toLocaleLowerCase().includes(normalized));
    return byQuality
      .filter((item) => nameOrTag(item) || textHits.has(item.id))
      .sort((a, b) => (textHits.get(b.id)?.count ?? 0) - (textHits.get(a.id)?.count ?? 0));
  }, [library, query, textHits, qualityFilter]);
  // 打字停 250ms 再搜正文；只认最后一次的结果（慢的旧请求回来不覆盖新的）
  useEffect(() => {
    const term = query.trim();
    latestSearch.current = term;
    if (screen !== "library" || term.length < 2) return;
    const timer = setTimeout(() => {
      void searchLibrary(term)
        .then((results) => { if (latestSearch.current === term) setTextHits(new Map(results.map((r) => [r.id, r]))); })
        .catch((caught) => console.warn("[搜索] 全文搜索失败，只按文件名和标签过滤：", caught));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, screen]);
  const qualityCounts = useMemo(() => ({
    fallback: library.filter((item) => (item.fallback_count ?? 0) > 0).length,
    review: library.filter((item) => item.review_count > 0 && !(item.fallback_count ?? 0)).length,
  }), [library]);
  /**
   * 按合集分组显示：一次批量转换是一组（可整包下 zip），单独转的不分组。
   * 分组基于筛选后的结果，搜索时合集里只留匹配的那几份，空组不显示。
   *
   * 排列按「这组东西最后动过的时间」统一穿插排序，不是先摆完所有合集再摆单独转换——
   * 以前是那样堆的，后果是随便一条新的单独转换（比如刚原地重新精校完的）都会被排到
   * 全部合集下面，哪怕是几秒钟前才更新的，看起来就像"不见了"。
   * 相邻的单独转换合并进同一个网格（减少视觉碎片），合集各自成块、带自己的表头。
   */
  const libraryTimeline = useMemo(() => {
    const byBatch = new Map<string, Job[]>();
    const entries: { key: string; sortKey: number; batch?: Batch; item?: Job }[] = [];
    for (const item of filteredLibrary) {
      if (!item.batch_id) entries.push({ key: item.id, sortKey: new Date(item.updated_at).getTime(), item });
      else byBatch.set(item.batch_id, [...(byBatch.get(item.batch_id) ?? []), item]);
    }
    for (const batch of batches) {
      if (byBatch.has(batch.id)) entries.push({ key: batch.id, sortKey: new Date(batch.updated_at).getTime(), batch });
    }
    entries.sort((a, b) => b.sortKey - a.sortKey);
    const rows: { key: string; batch?: Batch; items: Job[] }[] = [];
    for (const entry of entries) {
      if (entry.batch) {
        rows.push({ key: entry.key, batch: entry.batch, items: byBatch.get(entry.batch.id)! });
        continue;
      }
      const prevRow = rows.at(-1);
      if (prevRow && !prevRow.batch) prevRow.items.push(entry.item!);
      else rows.push({ key: entry.key, items: [entry.item!] });
    }
    return rows;
  }, [filteredLibrary, batches]);
  const batchCompleted = batchItems.filter((item) => item.status === "complete").length;
  const batchFailed = batchItems.filter((item) => item.status === "error").length;
  // 页数统计：总页数要等各份读出 total 才有，未知的按 0 算（显示成 "?" 更诚实）
  const batchTotalPages = batchItems.reduce((sum, item) => sum + (item.total || 0), 0);
  const batchDonePages = batchItems.reduce((sum, item) => sum + (item.page || 0), 0);
  const batchPagesUnknown = batchItems.some((item) => !item.total && item.status !== "error");
  // 计时：跑完后定格在结束时刻，不再继续走
  const runElapsed = runStartedAt ? (runEndedAt ?? now) - runStartedAt : 0;
  const pagesPerMin = runElapsed > 3000 && batchDonePages
    ? (batchDonePages / (runElapsed / 60000))
    : 0;
  /**
   * 预计剩余时间。跑到一定程度（≥3 页且 ≥10%、已用 20 秒以上）用这份自己的实时速度，
   * 否则用服务端按模式统计的每页秒数中位数；两个都没有就不猜（显示 —），不算排队时间。
   */
  const etaSeconds = useMemo(() => {
    const tableSec = speed[mode]?.secPerPage ?? null;
    const remainingPages = status === "batch"
      ? (batchPagesUnknown ? null : Math.max(0, batchTotalPages - batchDonePages))
      : (progress.total ? Math.max(0, progress.total - progress.page) : null);
    if (remainingPages === null) return null;
    const donePages = status === "batch" ? batchDonePages : progress.page;
    const totalPages = status === "batch" ? batchTotalPages : progress.total;
    const liveOk = runElapsed > 20000 && donePages >= 3 && totalPages > 0 && donePages / totalPages >= 0.1;
    const sec = liveOk ? runElapsed / 1000 / donePages : tableSec;
    if (sec === null) return null;
    return Math.round(remainingPages * sec);
  }, [speed, mode, status, batchPagesUnknown, batchTotalPages, batchDonePages, progress, runElapsed]);
  const batchFinished = batchCompleted + batchFailed;
  const batchPercent = batchItems.length
    ? Math.round(batchItems.reduce((sum, item) => {
      if (item.status === "complete" || item.status === "error") return sum + 100;
      return sum + (item.total ? (item.page / item.total) * 100 : 0);
    }, 0) / batchItems.length)
    : 0;

  async function refreshLibrary() {
    setLibraryLoading(true);
    try {
      const [items, groups] = await Promise.all([listLibraryItems(), listBatches()]);
      setLibrary(items);
      setBatches(groups);
      setLibraryError("");
    } catch (caught) {
      setLibraryError(caught instanceof Error ? caught.message : t("资料库读取失败。"));
    } finally {
      setLibraryLoading(false);
    }
  }

  // ---------- 路由：地址栏 ⇄ 界面状态 ----------
  /** 只改地址栏，不动界面。提交任务这种"界面已经在正确状态"的场合用它。 */
  function setRoute(route: Route, replace = false) {
    const target = routeHash(route) || `${window.location.pathname}${window.location.search}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (replace || current === target) window.history.replaceState(null, "", target);
    else window.history.pushState(null, "", target);
  }
  /** 改地址栏并切到对应界面（点按钮跳转都走这里）。 */
  function navigate(route: Route) {
    setRoute(route);
    void applyRoute(route);
  }
  /** 按地址显示界面：初次打开、前进/后退、navigate 都最终落到这里。 */
  async function applyRoute(route: Route) {
    if (route.name === "home") { resetState(); return; }
    if (route.name === "library") { setScreen("library"); void refreshLibrary(); return; }
    if (route.name === "doc") {
      // 同一份文档已经开着（逐页核对里前进/后退）：不重新拉结果，几百页的书重拉一次要好几秒
      const alreadyOpen = route.id === activeJobId && status === "complete" && result !== null && screen === "converter";
      if (!alreadyOpen) await loadDoc(route.id);
      if (route.page) {
        setCheckPage(route.page);
        setTab("page");
      } else if (alreadyOpen && tab === "page") {
        setTab(pageReturnTab.current);
      }
      return;
    }
    await loadBatch(route.id);
  }
  // popstate 回调只注册一次，但要调用"最新"的 applyRoute（它闭包了最新 state）
  const applyRouteRef = useRef(applyRoute);
  applyRouteRef.current = applyRoute;
  useEffect(() => {
    const onPop = () => { void applyRouteRef.current(parseRoute(window.location.hash)); };
    window.addEventListener("popstate", onPop);
    void applyRouteRef.current(parseRoute(window.location.hash));
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ---------- 逐页核对 ----------
  /** 第一个要检查的页：先找回退页，再找建议检查的页，都没有就第 1 页。 */
  function firstProblemPage() {
    return (fallbackPages[0] ?? reviewPages[0] ?? result?.pages[0])?.page ?? 1;
  }
  /** 切标签。进出「逐页核对」时顺手改地址栏（replace，不多出历史记录），地址能直接分享到那一页。 */
  function selectTab(next: ResultTab) {
    if (next === "page") {
      const page = checkPage || firstProblemPage();
      setCheckPage(page);
      if (activeJobId) setRoute({ name: "doc", id: activeJobId, page }, true);
    } else if (tab === "page" && activeJobId) {
      setRoute({ name: "doc", id: activeJobId }, true);
    }
    setTab(next);
  }
  /** 从「第 N 页」链接进核对：记一条历史，浏览器后退能回到原来的列表。 */
  function openPageCheck(page: number) {
    if (tab !== "page") pageReturnTab.current = tab;
    setCheckPage(page);
    setTab("page");
    if (activeJobId) setRoute({ name: "doc", id: activeJobId, page });
  }
  /** 核对里翻页：地址栏跟着变，但不多出历史记录。 */
  function goToPage(page: number) {
    if (!result) return;
    const clamped = Math.min(Math.max(1, page), result.pageCount);
    if (clamped === checkPage) return;
    setCheckPage(clamped);
    if (activeJobId) setRoute({ name: "doc", id: activeJobId, page: clamped }, true);
  }
  goToPageRef.current = goToPage;

  /**
   * 按任务 id 打开一份文档——Library 点开、批次里点"查看"、直接输入地址、刷新，全走这里。
   * 任务还在跑就先显示进度页，跑完自动切到结果；已完成就直接取结果。
   */
  async function loadDoc(id: string) {
    try {
      const job = (await listJobs()).find((item) => item.id === id) ?? null;
      setScreen("converter");
      setActiveJobId(id);
      setCheckPage(0);
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      setSourceUrl(libraryPdfUrl(id));
      setError("");
      setRefineWarning("");
      if (job) setActiveFilename(job.filename);
      if (job && (job.status === "queued" || job.status === "running")) {
        setMode(job.mode);
        setProgress({ page: job.page, total: job.total });
        setProgressDetail(job.detail || t("正在处理…"));
        setRunStartedAt(new Date(job.created_at).getTime());
        setRunEndedAt(null);
        setStatus("processing");
        const finished = await waitForJob(id, (live) => {
          setProgress({ page: live.page, total: live.total });
          if (live.detail) setProgressDetail(live.detail);
        });
        setRunEndedAt(Date.now());
        if (finished.status !== "done") throw new Error(finished.error || t("转换未完成。"));
        announceDone(finished.id, t("转换完成"), t("{name} · {n} 页", { name: finished.filename, n: finished.total }));
      } else if (job && job.status !== "done") {
        throw new Error(job.error || t("这份任务没有完成。"));
      }
      // listJobs 只取最近 200 条；更老的记录直接按 id 取结果
      const { job: storedJob, result: stored } = await fetchLibraryEntry(id);
      setActiveJob(storedJob);
      setActiveFilename(storedJob.filename);
      setMode(stored.mode);
      setResult(stored);
      setTab(stored.mode === "ai" ? "compare" : "markdown");
      setStatus("complete");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法打开这份记录。"));
      setStatus("error");
    }
  }

  /** 跟踪批次里一份任务的进度直到结束（新提交的和从地址重建的都用它）。 */
  async function trackBatchJob(itemId: string, jobId: string) {
    try {
      // 进度回调节流：批量转换时十几份同时推进度，每条都 setState 会卡死界面
      let lastPaint = 0;
      const finished = await waitForJob(jobId, (live) => {
        const now = Date.now();
        const isEdge = live.status !== "running" || live.page >= live.total;
        if (!isEdge && now - lastPaint < 500) return;
        lastPaint = now;
        updateBatchItem(itemId, {
          page: live.page,
          total: live.total,
          detail: live.detail || t("正在转换…"),
          status: live.status === "queued" ? "queued" : "processing",
        });
      });
      if (finished.status !== "done") throw new Error(finished.error || t("转换未完成。"));
      updateBatchItem(itemId, {
        status: "complete",
        jobId: finished.id,
        page: finished.total,
        total: finished.total,
        detail: t("已完成并存入 Library · {n} 页", { n: finished.total }),
        finishedAt: Date.now(),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("转换失败。");
      updateBatchItem(itemId, { status: "error", detail: t("处理失败，其余文件继续"), error: message, finishedAt: Date.now() });
    }
  }

  /**
   * 按 batch_id 打开批次页。内存里就是这个批次直接显示；否则（刷新、直接输地址）
   * 从服务端把这一批任务读回来重建，还在跑的继续订阅进度——以前批次页只存在内存里，
   * 一刷新就没了，任务明明还在跑，人却只能去 Library 里翻。
   */
  async function loadBatch(id: string) {
    setScreen("converter");
    if (batchId === id && batchItems.length) { setStatus("batch"); return; }
    try {
      const jobs = (await listJobs()).filter((job) => job.batch_id === id);
      if (!jobs.length) throw new Error(t("找不到这个批次，可能已被删除。"));
      const toMs = (iso: string | null) => (iso ? new Date(iso).getTime() : undefined);
      const items: BatchItem[] = jobs.map((job) => ({
        id: job.id,
        jobId: job.id,
        name: job.filename,
        size: job.file_size,
        status: job.status === "done" ? "complete" : job.status === "queued" ? "queued" : job.status === "running" ? "processing" : "error",
        page: job.page,
        total: job.total,
        detail: job.status === "done" ? t("已完成并存入 Library · {n} 页", { n: job.total }) : job.status === "failed" ? t("处理失败，其余文件继续") : job.detail,
        error: job.error ?? undefined,
        startedAt: toMs(job.created_at),
        finishedAt: toMs(job.finished_at),
      }));
      const live = items.filter((item) => item.status === "queued" || item.status === "processing");
      setBatchId(id);
      setBatchItems(items);
      setMode(jobs[0].mode);
      setError("");
      setRunStartedAt(Math.min(...items.map((item) => item.startedAt ?? Date.now())));
      setRunEndedAt(live.length ? null : Math.max(...items.map((item) => item.finishedAt ?? 0)) || Date.now());
      setBatchRunning(live.length > 0);
      setStatus("batch");
      if (live.length) {
        await Promise.all(live.map((item) => trackBatchJob(item.id, item.jobId!)));
        setBatchRunning(false);
        setRunEndedAt(Date.now());
        announceBatchDone(id);
        await refreshLibrary();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法打开这个批次。"));
      setStatus("error");
    }
  }

  /** 打开统一面板到某一栏；设置栏要先把草稿从已存设置复位。 */
  function openPanel(pane: PanelPane) {
    if (pane === "settings") {
      setSettingsDraft(draftFromSaved(settings));
      setExtraKeys(rowsFromSaved(settings.geminiKeysExtraMasked));
      setSettingsStatus("");
    }
    setPanelPane(pane);
    setPanelQuery("");
    setShowSettings(true);
  }

  /** 回顾：拉某个时段；refresh=true 是手动点刷新，服务端同步重写。 */
  async function loadReflect(refresh = false) {
    const my = ++reflectReq.current;
    setReflectBusy(true);
    if (refresh) setReflectData(null);
    try {
      const next = await fetchReflect(reflectRange, lang, refresh);
      if (my !== reflectReq.current) return;
      setReflectData(next);
    } catch {
      if (my === reflectReq.current) setReflectData(null);
    } finally {
      if (my === reflectReq.current) setReflectBusy(false);
    }
  }
  // 面板开着、在回顾栏：时段或语言一变就重新拉（缓存命中是 0 秒）
  useEffect(() => {
    if (!showSettings || panelPane !== "reflect") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadReflect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings, panelPane, reflectRange, lang]);
  // 服务端在后台重算：每 6 秒再拉一次，直到拿到新的
  useEffect(() => {
    if (!showSettings || panelPane !== "reflect" || !reflectData?.regenerating) return;
    const timer = setTimeout(() => void loadReflect(), 6000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings, panelPane, reflectData]);
  // 切栏目回到顶部：上一栏滚到底了，下一栏不该从中间开始
  useEffect(() => {
    if (showSettings) document.querySelector(".panel-main")?.scrollTo(0, 0);
  }, [showSettings, panelPane]);
  // 资料库栏：第一次切过去才拉
  useEffect(() => {
    if (!showSettings || panelPane !== "library" || statsLoaded) return;
    void fetchStats().then((loaded) => { setStats(loaded); setStatsLoaded(true); }).catch(() => undefined);
  }, [showSettings, panelPane, statsLoaded]);
  // 用量栏：每次切过去都重新拉（跑一份任务费用就变了）
  useEffect(() => {
    if (!showSettings || panelPane !== "usage") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUsageError("");
    void fetchUsage().then(setUsageData).catch((caught) => setUsageError(caught instanceof Error ? caught.message : t("用量读取失败。")));
  }, [showSettings, panelPane]);

  // 环境栏：打开时拉一次；有组件在装就每 1.5 秒刷新进度，装完顺手刷新 AI 设置（下好模型会自动填进去）
  const setupRunning = Boolean(setupData && Object.values(setupData.tasks).some((task) => task?.running));
  useEffect(() => {
    if (!showSettings || panelPane !== "setup") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSetupError("");
    void fetchSetup().then(setSetupData).catch((caught) => setSetupError(caught instanceof Error ? caught.message : t("环境检测失败。")));
  }, [showSettings, panelPane]);
  useEffect(() => {
    if (!setupRunning) return;
    const timer = setInterval(() => {
      void fetchSetup().then((next) => {
        setSetupData(next);
        if (!Object.values(next.tasks).some((task) => task?.running)) {
          void getAiSettings().then(setSettings).catch(() => undefined);
        }
      }).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [setupRunning]);

  async function runInstall(component: SetupComponent, model?: string) {
    setSetupError("");
    try {
      await installComponent(component, model);
      setSetupData(await fetchSetup());
    } catch (caught) {
      setSetupError(caught instanceof Error ? caught.message : t("安装没有启动。"));
    }
  }

  /** 给还没打过标签的旧记录批量补标签（新完成的任务已经会自动打标签）。 */
  async function runBackfill() {
    try {
      setBackfillState(await startTagBackfill());
    } catch {
      /* 打标签失败不影响主流程，面板上没反应就是没反应 */
    }
  }
  // 补标签跑起来之后轮询进度；跑完再刷一次统计，把新标签体现出来
  useEffect(() => {
    if (!backfillState?.running) return;
    const timer = setInterval(() => {
      void fetchTagBackfillStatus().then((next) => {
        setBackfillState(next);
        if (!next.running) void fetchStats().then(setStats).catch(() => undefined);
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [backfillState?.running]);

  // 已存的 key 以打码行呈现，明文留在服务端；保存时用带出处的占位符（见 lib/key-pool.mjs）
  function openSettings() {
    openPanel("settings");
  }

  function selectProvider(provider: AiProvider) {
    // 第一次选 Ollama 还没有模型名：先填上按内存推荐的那个，免得下拉框落在「自定义」的空白上
    setSettingsDraft((value) => ({
      ...value,
      provider,
      ...(provider === "ollama" && !value.ollamaModel ? { ollamaModel: setupData?.components.ollama.recommended ?? "qwen3-vl:8b-instruct" } : {}),
    }));
    setRemoteModels(null);
    setSettingsStatus("");
  }

  async function persistSettings() {
    setSettingsBusy(true);
    setSettingsStatus(t("正在保存…"));
    try {
      const saved = await saveAiSettings({
        ...settingsDraft,
        geminiKeysExtra: rowsToPayload(extraKeys),
      });
      setSettings(saved);
      setSettingsDraft(draftFromSaved(saved));
      // 行要按服务端新的列表重置：行里记的是「当初在已存列表里的位置」，
      // 不重置的话同一次打开面板里再保存一次，位置就对不上了
      setExtraKeys(rowsFromSaved(saved.geminiKeysExtraMasked));
      setSettingsStatus(t("已保存到本机。密钥不会出现在网页数据或 Library 中。"));
    } catch (caught) {
      setSettingsStatus(caught instanceof Error ? caught.message : t("设置保存失败。"));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function testSettings() {
    setSettingsBusy(true);
    setSettingsStatus(t("正在连接模型…"));
    try {
      const tested = await testAiSettings(settingsDraft);
      const balance = tested.balance
        ? ` · ${tested.balance.limit === null
          ? t("已用 ${used}（无上限）", { used: tested.balance.usage.toFixed(2) })
          : t("已用 ${used} / 上限 ${limit}", { used: tested.balance.usage.toFixed(2), limit: tested.balance.limit.toFixed(2) })}`
        : "";
      setSettingsStatus(t("连接成功：{provider} / {model}", { provider: tested.provider, model: tested.model }) + balance);
    } catch (caught) {
      setSettingsStatus(caught instanceof Error ? caught.message : t("连接测试失败。"));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function syncModels() {
    setSettingsBusy(true);
    setSettingsStatus(t("正在从服务商读取可用模型…"));
    try {
      const loaded = await fetchAiModels(settingsDraft);
      setRemoteModels(loaded);
      setSettingsStatus(t("已同步 {n} 个支持图片的模型。", { n: loaded.models.length }));
    } catch (caught) {
      setSettingsStatus(caught instanceof Error ? caught.message : t("模型列表同步失败。"));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function processFile(selected: File, selectedMode: ConversionMode = mode) {
    if (!isAcceptedFile(selected) || isMarkdownFile(selected)) {
      setError(t("请选择 PDF、Office 文档、图片或 Markdown。"));
      setStatus("error");
      return;
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    // PPT/Word/图片 还没转换完，没有 PDF 可预览；等下面转换完了再指到服务端转出的那份。
    setSourceUrl(isPdfFile(selected) ? URL.createObjectURL(selected) : "");
    setActiveFilename(selected.name);
    setMode(selectedMode);
    setScreen("converter");
    setResult(null);
    setError("");
    setProgress({ page: 0, total: 0 });
    setProgressDetail(t("正在读取 PDF 结构…"));
    setStatus("processing");
    setRunStartedAt(Date.now());
    setRunEndedAt(null);
    askNotifyPermission();
    try {
      // 交给服务端跑：这里只提交 + 等结果，关掉页面任务也会继续
      const job = await submitJob(selected, selectedMode);
      setActiveJobId(job.id);
      setRoute({ name: "doc", id: job.id });   // 有了 id 就有了地址：刷新会回到这份的进度/结果
      const finished = await waitForJob(job.id, (live) => {
        setProgress({ page: live.page, total: live.total });
        if (live.detail) setProgressDetail(live.detail);
      });
      if (finished.status !== "done") {
        throw new Error(finished.error || t("转换未完成。"));
      }
      const { job: finishedJob, result: converted } = await fetchLibraryEntry(finished.id);
      setActiveJob(finishedJob);
      setResult(converted);
      setActiveJobId(finished.id);
      setCheckPage(0);
      if (!isPdfFile(selected)) {
        // 上面校验通过时不是 PDF 就是 PPT/Word/图片——服务端此刻已经把它转成 PDF 了，
        // 换成服务端那份，「源文件」标签页才有东西可看。
        if (sourceUrl) URL.revokeObjectURL(sourceUrl);
        setSourceUrl(libraryPdfUrl(finished.id));
      }
      setTab(selectedMode === "ai" ? "compare" : "markdown");
      setStatus("complete");
      announceDone(finished.id, t("转换完成"), t("{name} · {n} 页", { name: selected.name, n: converted.pageCount }));
      await refreshLibrary();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("转换失败，请换一个 PDF 再试。");
      setError(message);
      setStatus("error");
      if (message.includes("AI 精校尚未配置")) openSettings();
    }
  }

  function updateBatchItem(id: string, patch: Partial<BatchItem>) {
    setBatchItems((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  /** .md 文件不进队列：逐份发给服务端打成 PDF，直接下载。失败逐份报出来，不影响其它文件。 */
  async function convertMarkdownFiles(files: File[]) {
    setMdNote(t("正在把 {n} 份 Markdown 转成 PDF…", { n: files.length }));
    const failures: string[] = [];
    for (const file of files) {
      try {
        const title = file.name.replace(/\.(md|markdown)$/i, "");
        downloadBlob(await markdownToPdf(await file.text(), title), `${title}.pdf`);
      } catch (caught) {
        failures.push(`${file.name}：${caught instanceof Error ? tServer(caught.message) : String(caught)}`);
      }
    }
    setMdNote(
      failures.length
        ? t("{ok} 份已转成 PDF，{bad} 份失败：{reasons}", { ok: files.length - failures.length, bad: failures.length, reasons: failures.join("；") })
        : t("已把 {n} 份 Markdown 转成 PDF 并下载", { n: files.length })
    );
  }

  /**
   * 很多图片 → 一份 PDF。跟 .md → PDF 一样不进队列、不进 Library：
   * 按文件名自然序排页，一张一页，原始像素不缩（见 server/images2pdf.mjs）。
   * 服务端跳过的图片会原因一起回来，照实显示，不能默默少几页。
   */
  async function mergeStagedImages() {
    const images = staged.filter(isImageFile).slice().sort((a, b) => naturalOrder.compare(a.name, b.name));
    if (!images.length) return;
    const first = stripFileExtension(images[0].name);
    const title = images.length === 1 ? first : t("{name} 等 {n} 张", { name: first, n: images.length });
    setImagesBusy(true);
    setMdNote(t("正在把 {n} 张图片合成 PDF…", { n: images.length }));
    try {
      const { blob, pages, skipped } = await imagesToPdf(images, title, (done, total) => {
        if (done < total) setMdNote(t("正在上传 {done}/{total} 张…", { done, total }));
        else setMdNote(t("正在合成 PDF…"));
      });
      downloadBlob(blob, `${title}.pdf`);
      setMdNote(
        skipped.length
          ? t("已合成 {n} 页 PDF 并下载；{bad} 张跳过：{reasons}", {
              n: pages,
              bad: skipped.length,
              reasons: skipped.map((s) => `${s.name}（${tServer(s.reason)}）`).join("；"),
            })
          : t("已把 {n} 张图片合成 {p} 页 PDF 并下载", { n: images.length, p: pages })
      );
    } catch (caught) {
      setMdNote(t("合成 PDF 失败：{reason}", { reason: caught instanceof Error ? tServer(caught.message) : String(caught) }));
    } finally {
      setImagesBusy(false);
    }
  }

  async function processFiles(selectedFiles: File[], selectedMode: ConversionMode = mode) {
    const markdownFiles = selectedFiles.filter(isMarkdownFile);
    if (markdownFiles.length) void convertMarkdownFiles(markdownFiles);
    const pdfFiles = selectedFiles.filter((f) => isAcceptedFile(f) && !isMarkdownFile(f));
    if (!pdfFiles.length) {
      if (markdownFiles.length) return;   // 只有 .md：转 PDF 就是全部工作，不是「没选对文件」
      setError(t("请选择 PDF、Office 文档、图片或 Markdown。"));
      setStatus("error");
      return;
    }
    if (selectedMode === "ai" && !settings.aiConfigured) {
      setError(t("AI 精校尚未配置。请先在设置中选择服务商、模型并保存 API Key。"));
      setStatus("error");
      openSettings();
      return;
    }
    if (pdfFiles.length === 1) {
      await processFile(pdfFiles[0], selectedMode);
      return;
    }

    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    const queue = pdfFiles.map((selected, index): BatchItem => ({
      id: `${selected.name}-${selected.size}-${selected.lastModified}-${index}`,
      name: selected.name,
      size: selected.size,
      file: selected,
      status: "queued",
      page: 0,
      total: 0,
      detail: t("等待处理"),
    }));
    setSourceUrl("");
    setResult(null);
    setError("");
    setMode(selectedMode);
    setScreen("converter");
    setStatus("batch");
    setBatchItems(queue);
    setBatchRunning(true);
    setRunStartedAt(Date.now());
    setRunEndedAt(null);

    // 多份一起转 = 一个合集：同一个 batch id，Library 里能整包下 zip。
    // 只有一份就不建合集，免得 Library 里全是「1 份文件」的空壳分组。
    const batch = {
      id: crypto.randomUUID(),
      label: t("{n} 份 · {time}", { n: queue.length, time: new Date().toLocaleString(getActiveLang() === "en" ? "en-US" : "zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }),
    };
    setBatchId(batch.id);
    setRoute({ name: "batch", id: batch.id });   // 批次页有了地址：刷新后从服务端重建，任务照跑
    askNotifyPermission();

    // 整批一次性提交给服务端；排队和并发由服务端统一控制，
    // 浏览器只负责显示进度（关掉页面这批也会继续跑完）。
    await Promise.all(
      queue.map(async (item) => {
        try {
          const job = await submitJob(item.file!, selectedMode, batch);
          updateBatchItem(item.id, { jobId: job.id, status: "processing", detail: t("已提交，等待服务端处理…"), startedAt: Date.now() });
          await trackBatchJob(item.id, job.id);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : t("转换失败。");
          updateBatchItem(item.id, { status: "error", detail: t("处理失败，其余文件继续"), error: message, finishedAt: Date.now() });
        }
      })
    );

    setBatchRunning(false);
    setRunEndedAt(Date.now());   // 计时定格，不再跳
    announceBatchDone(batch.id);
    await refreshLibrary();
  }

  /** 批量跑完的提醒文案要用最新的 batchItems，setState 后这里读到的还是旧的，所以走函数式读取 */
  function announceBatchDone(id: string) {
    setBatchItems((items) => {
      const ok = items.filter((item) => item.status === "complete").length;
      const bad = items.filter((item) => item.status === "error").length;
      const pages = items.reduce((sum, item) => sum + (item.total || 0), 0);
      announceDone(`batch:${id}`, t("批量处理完成"),
        bad ? t("{ok} 份成功，{bad} 份失败 · {pages} 页", { ok, bad, pages }) : t("{ok} 份 · {pages} 页", { ok, pages }));
      return items;
    });
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const selected = Array.from(event.dataTransfer.files);
    if (selected.length) addStaged(selected);
  }

  function addStaged(incoming: File[]) {
    const pdfs = incoming.filter(isAcceptedFile);
    if (!pdfs.length) { setError(t("请选择 PDF、Office 文档、图片或 Markdown。")); setStatus("error"); return; }
    setError("");
    setStatus("idle");
    setStaged((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
      return [...prev, ...pdfs.filter((f) => !seen.has(`${f.name}:${f.size}:${f.lastModified}`))];
    });
  }

  /** 回到首页的界面状态（不动地址栏；地址由 reset / 路由负责）。 */
  function resetState() {
    setScreen("converter");
    setStatus("idle");
    setResult(null);
    setProgress({ page: 0, total: 0 });
    setError("");
    setRefineWarning("");
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setSourceUrl("");
    setActiveFilename("");
    setBatchItems([]);
    setBatchId("");
    setBatchRunning(false);
    if (inputRef.current) inputRef.current.value = "";
  }
  function reset() {
    navigate({ name: "home" });
  }

  /**
   * 打开批次里某一份的结果。
   * 结果存在服务端，这里按 jobId 现取——以前指望 item.result，但那个字段
   * 从来没被赋过值，所以「查看/下载」按钮永远不显示，等于跑完就打不开。
   */
  function openBatchResult(item: BatchItem) {
    if (!item.jobId) return;
    setCameFrom("batch");
    navigate({ name: "doc", id: item.jobId });
  }

  /** 下载批次里某一份的 Markdown（同样从服务端取）。 */
  async function downloadBatchItem(item: BatchItem) {
    if (!item.jobId) return;
    const { result: stored } = await fetchLibraryEntry(item.jobId);
    download(stored.markdown, docDownloadName(library.find((j) => j.id === item.jobId), stored.title, "md"), "text/markdown;charset=utf-8");
  }

  async function downloadBatchMarkdown() {
    const completed = batchItems.filter((item) => item.status === "complete" && item.jobId);
    if (!completed.length) return;
    const parts = await Promise.all(
      completed.map(async (item) => {
        const { result: stored } = await fetchLibraryEntry(item.jobId!);
        return `<!-- ${t("来源文件")}：${item.name} -->\n\n${stored.markdown}`;
      })
    );
    download(parts.join("\n\n---\n\n"), `${t("墨页批量转换")}-${new Date().toISOString().slice(0, 10)}.md`, "text/markdown;charset=utf-8");
  }

  function showLibrary() {
    navigate({ name: "library" });
  }

  function toggleLibrarySelect(id: string) {
    setSelectedLibraryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /**
   * 合并下载：把任意几份 Library 记录拼成一份 .md，各自带来源文件名注释分隔。
   * 跟 downloadBatchMarkdown 同一个套路，只是数据源换成 Library——可以是某个
   * 合集的全部成员，也可以是跨批次、跨时间随手勾的几份，服务端不需要知道这回事，
   * 全部现取现拼，在浏览器里完成。
   */
  async function downloadMergedMarkdown(ids: string[], filenameHint: string) {
    if (!ids.length) return;
    setMergingLibrary(true);
    setLibraryError("");
    try {
      const parts = await Promise.all(
        ids.map(async (id) => {
          const record = library.find((item) => item.id === id);
          const { result: stored } = await fetchLibraryEntry(id);
          return `<!-- ${t("来源文件")}：${record?.filename ?? id} -->\n\n${stored.markdown}`;
        })
      );
      const safeName = filenameHint.replace(/[\\/:*?"<>|]/g, "_");
      download(parts.join("\n\n---\n\n"), `${safeName}-${new Date().toISOString().slice(0, 10)}.md`, "text/markdown;charset=utf-8");
    } catch (caught) {
      setLibraryError(caught instanceof Error ? caught.message : t("合并下载失败，请稍后再试。"));
    } finally {
      setMergingLibrary(false);
    }
  }

  function renderLibraryCard(record: Job) {
    return (
      <article className="library-card" key={record.id}>
        <label className="library-select" title={t("选中用于合并下载")}>
          <input
            type="checkbox"
            checked={selectedLibraryIds.has(record.id)}
            onChange={() => toggleLibrarySelect(record.id)}
            aria-label={t("选中 {name} 用于合并下载", { name: record.filename })}
          />
        </label>
        <button className="library-open" type="button" onClick={() => openRecord(record)} aria-label={t("打开 {name}", { name: record.filename })}>
          <span className="library-file-icon">MD<i>PDF</i></span>
          <span className="library-card-body">
            <span className="library-card-meta">{formatDate(new Date(record.updated_at).getTime())}</span>
            <strong title={record.filename}>{recordTitle(record)}</strong>
            <span className="library-card-preview">{record.ai_one_line || record.preview || t("没有可预览的文字")}</span>
            {parseTags(record.tags).length > 0 && (
              <span className="card-tags">{parseTags(record.tags).map((tag) => <i key={tag}>{tag}</i>)}</span>
            )}
          </span>
        </button>
        {textHits.get(record.id) && (
          <div className="library-hits">
            <span>{t("正文命中 {n} 处", { n: textHits.get(record.id)!.count })}</span>
            {textHits.get(record.id)!.hits.slice(0, 2).map((hit, index) => (
              <button key={`${hit.page}:${index}`} type="button" onClick={() => { setCameFrom("library"); navigate({ name: "doc", id: record.id, page: hit.page }); }}>
                <b>{t("第 {n} 页", { n: hit.page })}</b> {hit.before}<mark>{hit.match}</mark>{hit.after}
              </button>
            ))}
          </div>
        )}
        <div className="library-card-footer">
          <span>{record.page_count} {t("页")}</span>
          <span>{formatSize(record.file_size)}</span>
          <span>{record.ai_pages ? t("{n} 页 AI 精校", { n: record.ai_pages }) : t(modeNames[record.mode]) || t("旧版转换")}</span>
          {(() => { const q = qualityBadge(record); return <span className={`quality ${q.tone}`}><i />{q.text}</span>; })()}
          <a href={exportZipUrl({ ids: [record.id] })} download aria-label={t("下载 {name}", { name: record.filename })}>{t("下载")}</a>
          <button type="button" onClick={() => void removeRecord(record)} aria-label={t("删除 {name}", { name: record.filename })}>{t("删除")}</button>
        </div>
      </article>
    );
  }

  function openRecord(record: Job) {
    setCameFrom("library");
    navigate({ name: "doc", id: record.id });   // 结果和原始 PDF 都由 loadDoc 从服务端取
  }

  async function removeRecord(record: Job) {
    if (!window.confirm(t("从本机资料库删除“{name}”？此操作无法撤销。", { name: record.filename }))) return;
    try {
      await deleteLibraryEntry(record.id);
      setLibrary((items) => items.filter((item) => item.id !== record.id));
      setSelectedLibraryIds((prev) => {
        if (!prev.has(record.id)) return prev;
        const next = new Set(prev);
        next.delete(record.id);
        return next;
      });
      setLibraryError("");
    } catch (caught) {
      setLibraryError(caught instanceof Error ? caught.message : t("删除失败。请稍后再试。"));
    }
  }

  async function copyMarkdown() {
    if (!result) return;
    await navigator.clipboard.writeText(result.markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  /**
   * only="fallback"：只把上次回退的页再交给模型，成功的页原样保留——
   * 几百页的书只坏了几十页时，整份重跑既费钱又可能把好页跑坏。
   */
  async function downloadResultPdf() {
    if (!activeJobId || !result || pdfBusy) return;
    setPdfBusy(true);
    try {
      downloadBlob(await fetchLibraryDocumentPdf(activeJobId), `${result.title}.pdf`);
    } catch (caught) {
      setRefineWarning("");
      setError(t("PDF 生成失败：{reason}", { reason: caught instanceof Error ? tServer(caught.message) : String(caught) }));
      setStatus("error");
    } finally {
      setPdfBusy(false);
    }
  }

  async function rerunAiRefinement(only: "all" | "fallback" = "all") {
    if (!activeJobId || !result) return;
    setMode("ai");
    setStatus("processing");
    setError("");
    setRefineWarning("");
    setProgress({ page: 0, total: result.pageCount });
    setProgressDetail(only === "fallback" ? t("只重跑 {n} 页回退页，其余保留…", { n: fallbackPages.length }) : t("正在复用 Library 中的本地初稿…"));
    try {
      // 现在是原地重跑同一条记录：job.id 就是 activeJobId 本身，不再是新 id
      const job = await refineLibraryEntry(activeJobId, { only });
      const finished = await waitForJob(job.id, (live) => {
        setProgress({ page: live.page, total: live.total });
        if (live.detail) setProgressDetail(live.detail);
      });
      if (finished.status !== "done") throw new Error(finished.error || t("AI 精校未完成。"));
      const { result: refined } = await fetchLibraryEntry(finished.id);
      setResult(refined);
      setActiveJobId(finished.id);
      setTab("compare");
      setRoute({ name: "doc", id: finished.id }, true);
      setStatus("complete");
      // 精校失败时服务端会原样保留旧结果（status 仍是 done），但把原因记在 error 字段——
      // 不能因为"文档还在、没报错屏"就当作真的成功了，得让用户知道这次其实没变化
      setRefineWarning(finished.error || "");
      await refreshLibrary();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("AI 精校失败。");
      setError(message);
      setStatus("error");
      if (message.includes("AI 精校尚未配置")) openSettings();
    }
  }

  // 左侧栏目：搜索框按栏目名过滤
  const navEntries: { pane: PanelPane; label: string }[] = [
    { pane: "reflect", label: t("回顾") }, { pane: "library", label: t("资料库") }, { pane: "usage", label: t("用量") },
    { pane: "settings", label: t("AI 精校设置") }, { pane: "setup", label: t("环境") }, { pane: "about", label: t("关于") },
  ];
  const navMatches = navEntries.filter((e) => !panelQuery.trim() || e.label.toLowerCase().includes(panelQuery.trim().toLowerCase()));
  const navItem = (pane: PanelPane, label: string, icon: React.ReactNode) => {
    if (!navMatches.some((e) => e.pane === pane)) return null;
    return (
      <button type="button" className={`panel-nav-item${panelPane === pane ? " active" : ""}`} onClick={() => openPanel(pane)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
        <span>{label}</span>
      </button>
    );
  };

  return (
    <main className={`app-shell ${status !== "idle" || screen === "library" ? "workspace-open" : ""}`}>
      <nav className="topbar" aria-label={t("主导航")}>
        <button className="brand brand-button" type="button" onClick={reset} aria-label={t("回到首页")} disabled={batchRunning}>
          <span className="brand-mark">{t("墨")}</span><span>{t("墨页")}</span>
        </button>
        <div className="top-actions">
          {activeJobs.length > 0 && (
            // 进行中的任务在哪个界面都看得见，不只是首页
            <ActiveJobsMenu jobs={activeJobs} now={now}
              onOpen={(j) => navigate(j.batch_id ? { name: "batch", id: j.batch_id } : { name: "doc", id: j.id })}
              onCancel={(j) => void cancelJob(j.id)} />
          )}
          <button className={`library-nav ${screen === "library" ? "active" : ""}`} type="button" onClick={showLibrary} disabled={batchRunning}>Library <b>{library.length}</b></button>
          <button className="lang-toggle" type="button" onClick={toggleLang} aria-label="Switch language" title={lang === "en" ? "切换到中文 / Switch to Chinese" : "Switch to English"}>{lang === "en" ? "中文" : "EN"}</button>
          <button className="settings-button" type="button" onClick={openSettings}>{t("⚙ 设置")}</button>
          {status !== "idle" && !batchRunning && <button className="quiet-button" type="button" onClick={reset}>{t("＋ 新转换")}</button>}
          {/* 这颗标签必须说实话：本地模式的正文不上传，但打标签会把开头一小段发给模型——以前这里一律写"文件不上传"。
              文案压短到一行放得下（长句在窄窗口会被截断，隐私提示截了一半等于没说），完整说明放 title。 */}
          {aiWasUsed && aiStaysLocal(settings) ? (
            <span className="privacy-pill" title={t("AI 精校用的是这台电脑上的 Ollama，页面图像不离开本机。")}><i />{t("本机模型 · 不上传")}</span>
          ) : aiWasUsed ? (
            <span className="privacy-pill cloud" title={t("AI 精校 · 页面图像会发送给所选模型")}><i />{t("AI 精校 · 上传页面图像")}</span>
          ) : settings.autoTag !== false && settings.aiConfigured && !aiStaysLocal(settings) ? (
            <button type="button" className="privacy-pill tag" title={t("转换正文全程在本机；完成后会把文档开头约 3000 字发给当前服务商生成主题标签。点此可在设置里关闭。")} onClick={openSettings}><i />{t("本地 · 仅摘要打标签")}</button>
          ) : (
            <span className="privacy-pill" title={t("文件全程在本机处理，不上传。")}><i />{t("本地 · 不上传")}</span>
          )}
        </div>
      </nav>

      {screen === "library" ? (
        <section className="library-view">
          <header className="library-header">
            <div><div className="eyebrow">LOCAL DOCUMENT LIBRARY</div><h1>{t("你的分析资料库")}</h1><p>{t("PDF、Markdown、原始初稿与逐页质量记录都保留在这台设备。")}</p></div>
            <button className="primary-button" type="button" onClick={reset}>{t("＋ 新转换")}</button>
          </header>
          <div className="library-toolbar">
            <label><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => { setQuery(event.target.value); if (event.target.value.trim().length < 2) setTextHits(new Map()); }} placeholder={t("搜索文件名、标签或正文…")} aria-label={t("搜索资料库")} /></label>
            {(qualityCounts.fallback > 0 || qualityCounts.review > 0) && (
              // 只放两个、带数字、为 0 的不出现（Verbatim 每个引擎一颗筛选，手机上折成 5 行——不学）
              <div className="quality-filters" role="group" aria-label={t("按质量筛选")}>
                {qualityCounts.fallback > 0 && <button type="button" className={qualityFilter === "fallback" ? "active" : ""} aria-pressed={qualityFilter === "fallback"} onClick={() => setQualityFilter((f) => (f === "fallback" ? "all" : "fallback"))}>{t("有回退页 {n}", { n: qualityCounts.fallback })}</button>}
                {qualityCounts.review > 0 && <button type="button" className={qualityFilter === "review" ? "active" : ""} aria-pressed={qualityFilter === "review"} onClick={() => setQualityFilter((f) => (f === "review" ? "all" : "review"))}>{t("建议复核 {n}", { n: qualityCounts.review })}</button>}
              </div>
            )}
            <div><strong>{library.length}</strong> {t("份文件 ·")} <strong>{library.reduce((sum, item) => sum + item.page_count, 0)}</strong> {t("页")}</div>
            {library.length > 0 && (
              // 直接用 <a download>：整包由服务端生成并流式下载，不经过 JS 内存
              <a className="secondary-button" href={exportZipUrl()} download>{t("⭳ 全部打包下载")}</a>
            )}
          </div>
          {selectedLibraryIds.size > 0 && (
            <div className="library-selection-bar">
              <span>{t("已选 {n} 份", { n: selectedLibraryIds.size })}</span>
              <div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={mergingLibrary}
                  onClick={() => void downloadMergedMarkdown([...selectedLibraryIds], t("墨页合并"))}
                >
                  {mergingLibrary ? t("合并中…") : t("⭳ 下载合并 .md")}
                </button>
                <button className="quiet-button" type="button" onClick={() => setSelectedLibraryIds(new Set())}>{t("清除选择")}</button>
              </div>
            </div>
          )}
          {libraryError && <div className="library-notice" role="status">{libraryError}</div>}
          {libraryLoading ? (
            <div className="library-empty"><span className="library-empty-mark">{t("墨")}</span><h2>{t("正在读取资料库…")}</h2></div>
          ) : filteredLibrary.length ? (
            <>
              {libraryTimeline.map((row) => (
                <section className="library-batch" key={row.key}>
                  {row.batch && (
                    <div className="library-batch-head">
                      <div>
                        <strong>{row.batch.label || t("批量转换")}</strong>
                        <span>{t("{n} 份 · {pages} 页", { n: row.batch.total, pages: row.batch.pages })}{row.batch.failed ? ` ${t("· {n} 份失败", { n: row.batch.failed })}` : ""}{row.batch.active ? ` ${t("· {n} 份进行中", { n: row.batch.active })}` : ""}</span>
                      </div>
                      <div className="library-batch-actions">
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={mergingLibrary}
                          onClick={() => void downloadMergedMarkdown(row.items.map((item) => item.id), row.batch!.label || t("墨页合集"))}
                        >
                          {mergingLibrary ? t("合并中…") : t("⭳ 下载合并 .md")}
                        </button>
                        <a className="secondary-button" href={exportZipUrl({ batchId: row.batch.id })} download>{t("⭳ 下载这个合集")}</a>
                      </div>
                    </div>
                  )}
                  <div className="library-grid">
                    {row.items.map((record) => renderLibraryCard(record))}
                  </div>
                </section>
              ))}
            </>
          ) : (
            <div className="library-empty"><span className="library-empty-mark">{t("墨")}</span><h2>{query ? t("没有匹配的文件") : t("资料库还是空的")}</h2><p>{query ? t("换个关键词试试。") : t("完成第一次转换后，文件会自动出现在这里。")}</p>{!query && <button className="primary-button" type="button" onClick={reset}>{t("开始第一次转换")}</button>}</div>
          )}
        </section>
      ) : status === "idle" ? (
        <div className={`home-grid ${library.length > 0 ? "" : "single"}`}>
          <div className="home-main">
          {/* 首页是工作台不是落地页：每天用的人不需要每天看一遍大标题和产品卖点 */}
          <section className="home-head">
            <h1>{t("把文档转成 Markdown")}</h1>
            <p>{t("拖进来、选模式、开始。转换在本机服务里排队执行，关掉页面也会继续。")}</p>
          </section>
          <section className="converter-card" aria-label={t("PDF/PPT/Word/图片 转换器")}>
            {/* 有历史记录的人多半是回来找结果的：拖拽区收成一条，把「最近转换」抬进首屏；拖文件进来或还没转过时才撑开 */}
            <button className={`dropzone ${dragging ? "is-dragging" : ""} ${library.length > 0 && staged.length === 0 && !dragging ? "compact" : ""}`} type="button" onClick={() => inputRef.current?.click()} onDragEnter={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              <span className="paper-icon" aria-hidden="true"><em /><i /></span>
              <span className="dropzone-text"><strong>{t("拖放一个或多个 PDF / PPT / Word / 图片 / Markdown")}</strong><span>{t("或点击批量选择文件")}</span></span>
              <small>{mode === "ai" && !aiStaysLocal(settings) ? t("AI 模式会把页面图像发送给你配置的模型") : t("当前模式全程在本机处理")}</small>
            </button>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf,.ppt,.pptx,.doc,.docx,image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,.heic,.heif,.md,.markdown" multiple hidden onChange={(event) => { const selected = Array.from(event.target.files || []); if (selected.length) addStaged(selected); event.target.value = ""; }} />
            <div className="profile-row" aria-label={t("转换模式")}>
              {/* 说明横着放一行，不再挤在左边 130px 的窄列里折成六行 */}
              <div className="profile-head"><span className="field-label">{t("转换模式")}</span><small>{t(modeDescriptions[mode])}</small></div>
              <div className="profile-options">
                {visibleModes.map((item) => (
                  <button key={item} type="button" className={mode === item ? "active" : ""} onClick={() => { setMode(item); if (item === "ai" && !settings.aiConfigured) openSettings(); }}>
                    {t(modeNames[item])}<small>{
                      // 有实测数据就用「最近 50 份的中位数」替换写死的那句速度，其余（费用 / 是否上传）照旧
                      speed[item]?.secPerPage !== null && speed[item]?.secPerPage !== undefined
                        ? `${fmtSecPerPage(speed[item]!.secPerPage!)}${t(modeMetaFor(item, settings)).replace(/^[^·]*·/, " ·")}`
                        : t(modeMetaFor(item, settings))
                    }</small>
                  </button>
                ))}
              </div>
            </div>
            {mdNote && <p className="batch-footnote" role="status">{mdNote}</p>}
            {staged.some(isMarkdownFile) && (
              <p className="batch-footnote">{t("Markdown 文件不进转换队列：点开始后直接转成 PDF 下载（公式会排版好）。")}</p>
            )}
            {stagedHasImage && (
              <p className="batch-footnote">{t("图片还可以不识别，直接按文件名顺序拼成一份多页 PDF（原始画质）。")}</p>
            )}
            {stagedHasImage && mode === "fast" && (
              // 极速模式读的是 PDF 文字层，而图片转出来的 PDF 一个字都没有——
              // 不提示的话用户会拿到一份「每页都未检测到文字」的空文档，还以为是识别失败。
              <p className="batch-footnote">{t("图片没有文字层，「极速」模式读不出内容。请选「均衡」（本机 Surya 识别）或「AI 精校」。")}</p>
            )}
            {mode === "balanced" && setupData && !setupData.components.surya.ok && (
              // 以前没装 Surya 也能选这个模式，提交后才报一句 spawn ENOENT
              <p className="batch-footnote">{t("这台电脑还没装 Surya，「本地高精度」暂时用不了。")} <button type="button" className="inline-link" onClick={() => openPanel("setup")}>{t("去一键安装")}</button></p>
            )}
            {mode === "ai" && settings.aiConfigured && (
              // 精校范围直接影响这次转换花多少钱、多少页过模型，放在模式旁边而不是藏在设置最底下
              <div className="scope-inline" role="group" aria-label={t("精校范围")}>
                <span>{t("精校范围")}</span>
                {([["all", t("全部页面 · 质量最佳")], ["review", t("只精校公式、选项与可疑页 · 更省")]] as const).map(([value, label]) => (
                  <label key={value} className={settings.aiScope === value ? "on" : ""}>
                    <input type="radio" name="scope-inline" checked={settings.aiScope === value} onChange={() => {
                      void patchAiSettings({ aiScope: value }).then(setSettings).catch((caught) => console.warn("[设置] 精校范围保存失败", caught));
                    }} />
                    {label}
                  </label>
                ))}
                {settings.activeChannels?.length ? (
                  <button type="button" className="scope-inline-meta" onClick={openSettings} title={t("点击打开 AI 精校设置")}>{t("模型：{providers}", { providers: settings.activeChannels.map((p) => providerNames[p]).join(" + ") })}</button>
                ) : null}
              </div>
            )}
            {activeJobs.length > 0 && (
              <div className="active-panel" aria-label={t("正在进行的任务")}>
                <div className="staged-head">
                  <strong>{t("服务端进行中 · {n}", { n: activeJobs.length })}</strong>
                  <span className="staged-size">{t("关掉页面也会继续跑")}</span>
                </div>
                <ul className="staged-list">
                  {activeJobs.map((j) => (
                    <li key={j.id}>
                      <button type="button" className="staged-link" onClick={() => navigate(j.batch_id ? { name: "batch", id: j.batch_id } : { name: "doc", id: j.id })} title={t("查看进度")}>{j.filename}</button>
                      <span className="staged-size">
                        {j.status === "queued" ? t("排队中") : j.total ? `${j.page}/${j.total} ${t("页")}` : t("处理中")}
                        {" · ⏱ "}{formatElapsed(now - new Date(j.created_at).getTime())}
                      </span>
                      <button type="button" onClick={() => void cancelJob(j.id)}>{t("取消")}</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {staged.length > 0 && (
              <div className="staged-panel" aria-label={t("待转换文件")}>
                <div className="staged-head">
                  <strong>{t("已选 {n} 份，待转换", { n: staged.length })}</strong>
                  <button type="button" onClick={() => setStaged([])}>{t("清空")}</button>
                </div>
                <ul className="staged-list">
                  {staged.map((f) => {
                    const converted = findConverted(f, library);
                    const pages = stagedPages[stagedKey(f)];
                    return (
                    <li key={stagedKey(f)}>
                      <span>{f.name}</span>
                      {converted && (
                        <button type="button" className="staged-dup" onClick={() => navigate({ name: "doc", id: converted.job.id })} title={t("{date} 转过", { date: converted.job.created_at.slice(0, 10) })}>
                          {converted.exact ? t("已在资料库 · 打开") : t("资料库里有同名文件 · 打开")}
                        </button>
                      )}
                      <span className="staged-size">{typeof pages === "number" ? `${t("{n} 页", { n: pages })} · ` : ""}{formatSize(f.size)}</span>
                      <button type="button" aria-label={t("移除 {name}", { name: f.name })} onClick={() => setStaged((prev) => prev.filter((x) => x !== f))}>{t("移除")}</button>
                    </li>
                    );
                  })}
                </ul>
                <button
                  className="primary-button staged-start"
                  type="button"
                  onClick={() => { const files = staged; setStaged([]); void processFiles(files); }}
                >
                  {t("开始转换 · {mode}", { mode: t(modeNames[mode]) })}
                </button>
                {stagedEstimate.pages > 0 && (
                  // 开始之前就知道来不来得及、要花多少：用时按这台机器最近的实际速度，花费按最近 AI 精校的实际账单
                  <p className="staged-estimate">
                    {stagedEstimate.unknown
                      ? t("至少 {n} 页（{k} 份转换后才知道页数）", { n: stagedEstimate.pages, k: stagedEstimate.unknown })
                      : t("共 {n} 页", { n: stagedEstimate.pages })}
                    {stagedEstimate.seconds !== null && <> · {t("约 {time}", { time: formatElapsed(stagedEstimate.seconds * 1000) })}</>}
                    {stagedEstimate.cost !== null && <> · {t("约 {cost}", { cost: fmtUsd(stagedEstimate.cost) })}</>}
                  </p>
                )}
                {stagedHasImage && (
                  // 图片还有另一种去处：不识别，直接按文件名顺序拼成一份 PDF。
                  // 放在「开始转换」下面而不是换掉它——拖图片进来最常见的还是要识别。
                  <button className="secondary-button staged-start" type="button" disabled={imagesBusy} onClick={() => void mergeStagedImages()}>
                    {imagesBusy
                      ? t("合成中…")
                      : t("合成一份 PDF · {n} 张图片", { n: staged.filter(isImageFile).length })}
                  </button>
                )}
              </div>
            )}
          </section>
          </div>
          {library.length > 0 && (
            // 最近转换直接摆在首页：以前要点进 Library 才能找到几分钟前刚转完的那份。
            // 宽屏上放右栏，和转换区并排——整页跟顶栏同宽，不再是一条 820px 的窄柱子居中浮着
            <section className="recent" aria-label={t("最近转换")}>
              <div className="recent-head">
                <strong>{t("最近转换")}</strong>
                <button type="button" className="quiet-button" onClick={showLibrary}>{t("全部 {n} 份 →", { n: library.length })}</button>
              </div>
              <ul className="recent-list">
                {library.slice(0, 12).map((record) => (
                  <li key={record.id}>
                    <button type="button" className="recent-item" onClick={() => openRecord(record)} title={record.filename}>
                      <span className="recent-name">{recordTitle(record)}</span>
                      {record.ai_one_line ? <span className="recent-line">{record.ai_one_line}</span> : null}
                      <span className="recent-meta">
                        {record.page_count} {t("页")} · {record.ai_pages ? t("AI 精校") : t(modeNames[record.mode]) || t("旧版")} · {formatDate(new Date(record.updated_at).getTime())}
                        {(() => { const q = qualityBadge(record); return <em className={`quality ${q.tone}`}><i />{q.text}</em>; })()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : status === "batch" ? (
        <section className="batch-view" aria-live="polite">
          <header className="batch-header">
            <div>
              <div className="eyebrow">{batchRunning ? "BATCH CONVERSION IN PROGRESS" : "BATCH CONVERSION COMPLETE"}</div>
              <h1>{batchRunning ? t("正在批量转换") : t("批量处理完成")}</h1>
              <p>{t("{n} 份 PDF · {mode} · 已处理 {done} / {total}", { n: batchItems.length, mode: t(modeNames[mode]), done: batchFinished, total: batchItems.length })}</p>
            </div>
            <div className="batch-actions">
              {!batchRunning && batchCompleted > 0 && <button className="secondary-button" type="button" onClick={downloadBatchMarkdown}>{t("下载合并 .md")}</button>}
              {!batchRunning && <button className="primary-button" type="button" onClick={reset}>{t("＋ 新批次")}</button>}
            </div>
          </header>
          <div className="run-timer" aria-live="off">
            <div className="run-timer-clock">
              <span className="run-timer-label">{batchRunning ? t("已用时") : t("总用时")}</span>
              <strong>{formatElapsed(runElapsed)}</strong>
            </div>
            <div className="run-timer-pages">
              <div>
                <strong>{batchDonePages}<em> / {batchPagesUnknown && !batchTotalPages ? "?" : batchTotalPages}</em></strong>
                <span>{t("页")}{batchPagesUnknown && batchTotalPages ? t("（部分未读出）") : ""}</span>
              </div>
              <div>
                <strong>{pagesPerMin ? pagesPerMin.toFixed(0) : "—"}</strong>
                <span>{t("页/分钟")}</span>
              </div>
              {batchRunning && (
                <div>
                  <strong>{etaSeconds === null ? "—" : formatElapsed(etaSeconds * 1000)}</strong>
                  <span>{t("预计剩余")}</span>
                </div>
              )}
              <div>
                <strong>{batchItems.length}</strong>
                <span>{t("份文件")}</span>
              </div>
            </div>
          </div>
          <div className="batch-summary">
            <div><strong>{batchPercent}%</strong><span>{t("总体进度")}</span></div>
            <div><strong>{batchCompleted}</strong><span>{t("转换成功")}</span></div>
            <div className={batchFailed ? "needs-review" : ""}><strong>{batchFailed}</strong><span>{t("处理失败")}</span></div>
            <div className="batch-overall-track"><i style={{ width: `${batchPercent}%` }} /></div>
          </div>
          <div className="batch-list">
            {batchItems.map((item, index) => {
              const itemPercent = item.status === "complete" || item.status === "error" ? 100 : item.total ? Math.round((item.page / item.total) * 100) : 0;
              return (
                <article className={`batch-item ${item.status}`} key={item.id}>
                  <span className="batch-index">{String(index + 1).padStart(2, "0")}</span>
                  <div className="batch-item-main">
                    <div className="batch-item-title">
                      <strong>{item.name}</strong>
                      <span>{formatSize(item.size)}</span>
                      {item.startedAt && (
                        <span className="batch-elapsed">
                          ⏱ {formatElapsed((item.finishedAt ?? now) - item.startedAt)}
                        </span>
                      )}
                    </div>
                    {item.error
                      ? <ExplainedError message={item.error} onOpenSettings={openSettings} />
                      : <p>{tServer(item.detail)}{item.status === "processing" && item.total ? ` · ${Math.floor(item.page)} / ${item.total} ${t("页")}` : ""}</p>}
                    <div className="batch-item-track"><i style={{ width: `${itemPercent}%` }} /></div>
                  </div>
                  <div className="batch-item-status">
                    <span>{item.status === "queued" ? t("等待中") : item.status === "processing" ? `${itemPercent}%` : item.status === "complete" ? t("已完成") : t("失败")}</span>
                    {item.status === "complete" && item.jobId && (
                      <div>
                        <button type="button" onClick={() => void openBatchResult(item)}>{t("查看")}</button>
                        <button type="button" onClick={() => void downloadBatchItem(item)}>{t("下载")}</button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="batch-footnote">{t("可以关掉页面，队列在本机服务里继续跑，回来时从这个地址就能接着看。单个文件失败不会中断后续文件；成功结果已自动存入 Library。")}</p>
        </section>
      ) : status === "processing" ? (
        <section className="processing-view" aria-live="polite">
          <div className="processing-orbit"><span>{percent}%</span><i /></div><div className="eyebrow">{mode === "ai" ? t("视觉模型识别中") : t("正在本机转换")}</div>
          <h1>{activeFilename}</h1><p>{tServer(progressDetail)}</p>
          <div className="run-timer solo">
            <div className="run-timer-clock">
              <span className="run-timer-label">{t("已用时")}</span>
              <strong>{formatElapsed(runElapsed)}</strong>
            </div>
            <div className="run-timer-pages">
              <div><strong>{Math.floor(progress.page)}<em> / {progress.total || "?"}</em></strong><span>{t("页")}</span></div>
              <div>
                <strong>{runElapsed > 3000 && progress.page ? (progress.page / (runElapsed / 60000)).toFixed(0) : "—"}</strong>
                <span>{t("页/分钟")}</span>
              </div>
              <div>
                <strong>{etaSeconds === null ? "—" : formatElapsed(etaSeconds * 1000)}</strong>
                <span>{t("预计剩余")}</span>
              </div>
            </div>
          </div>
          <div className="progress-track"><i style={{ width: `${percent}%` }} /></div>
          <small>{mode === "ai" ? t("页面图像会发送给你在设置中选择的模型；识别失败的页面回退 PDF 文字层。") : t("转换在本机服务里进行，关掉页面也会继续。")}</small>
        </section>
      ) : status === "error" ? (() => {
        const explained = explainError(error);
        const known = explained.kind !== "unknown";
        return (
          <section className="error-card"><span>{t("转换未完成")}</span><h1>{
            /PPT|Office 文档|图片转 PDF/.test(error) ? t("文档没能转成 PDF")
              : /AI 精校/.test(error) ? t("AI 精校还没配置好")
              : /页数/.test(error) ? t("PDF 和记录对不上")
              : /不存在|找不到|已被/.test(error) ? t("找不到这条记录")
              : known ? t(errorCopy[explained.kind].title)
              : t("这个文件暂时没能处理")
          }</h1>{known
            ? <><p>{t(errorCopy[explained.kind].action)}</p><details className="error-raw"><summary>{t("原始报错")}</summary><code>{tServer(error)}</code></details></>
            : <p>{tServer(error)}</p>}<div className="error-actions">{(error.includes("AI 精校") || fixedInSettings(explained.kind)) && <button className="secondary-button" type="button" onClick={openSettings}>{t("打开设置")}</button>}<button className="primary-button" type="button" onClick={reset}>{t("换一个文件")}</button></div></section>
        );
      })() : result ? (
        <section className="result-workspace">
          <header className="result-header">
            <div><span className="success-kicker"><i />{t("转换完成 · 已存入 Library")}</span><h1>{activeFilename}</h1><p>{t("{pages} 页 · {mode} · {seconds} 秒", { pages: result.pageCount, mode: t(modeNames[result.mode]) || t("旧版转换"), seconds: (result.durationMs / 1000).toFixed(1) })}{pageTimeSummary ? ` · ${pageTimeSummary}` : ""}{(() => { const job = activeJob?.id === activeJobId ? activeJob : library.find((j) => j.id === activeJobId); const c = job ? costLabel(job) : null; return c ? ` · ${t("花费 {c}", { c })}` : ""; })()}</p></div>
            <div className="result-actions">
              {cameFrom === "library" ? (
                <button type="button" className="secondary-button" onClick={() => { setCameFrom(null); showLibrary(); }}>{t("← 返回 Library")}</button>
              ) : (cameFrom === "batch" || batchItems.length > 1) && batchId ? (
                <button type="button" className="secondary-button" onClick={() => { setCameFrom(null); navigate({ name: "batch", id: batchId }); }}>{t("← 返回批次")}</button>
              ) : (
                <button type="button" className="secondary-button" onClick={reset}>{t("← 返回首页")}</button>
              )}
              {pdfBusy && <span className="busy-chip" role="status">{t("正在生成 PDF…")}</span>}
              <button type="button" className="secondary-button" onClick={copyMarkdown}>{copied ? t("已复制") : t("复制 Markdown")}</button>
              <button type="button" className="primary-button" onClick={() => download(result.markdown, docDownloadName(activeJob?.id === activeJobId ? activeJob : library.find((j) => j.id === activeJobId), result.title, "md"), "text/markdown;charset=utf-8")}>{t("下载 .md")}</button>
              <MoreMenu label={t("更多操作")}>{(close) => (
                <>
                  <button type="button" role="menuitem" disabled={pdfBusy} onClick={() => { close(); void downloadResultPdf(); }} title={t("把渲染后的 Markdown（含公式）打印成 PDF")}>{t("下载 PDF")}</button>
                  {!batchRunning && <button type="button" role="menuitem" onClick={() => { close(); void rerunAiRefinement("all"); }}>{result.mode === "ai" ? t("重新 AI 精校") : t("用 AI 精校这份")}</button>}
                  <button type="button" role="menuitem" onClick={() => { close(); download(JSON.stringify(result, null, 2), `${result.title}-report.json`, "application/json"); }}>{t("导出完整报告")}</button>
                </>
              )}</MoreMenu>
            </div>
          </header>
          {refineWarning && (
            <div className="result-notice" role="status">
              <p>⚠ {t("重新精校失败，已保留原结果。")}</p>
              <ExplainedError message={refineWarning} onOpenSettings={openSettings} />
            </div>
          )}
          {fallbackPages.length > 0 && (
            <div className={`fallback-notice${fallbackSummary.blockers.length ? " blocked" : ""}`} role="status">
              <p><b>{t("{n} 页 AI 没成功", { n: fallbackPages.length })}</b> · {fallbackSummary.byKind.map(({ kind, pages }) => `${t(errorCopy[kind].short)} ${pages}`).join(" · ")}</p>
              {fallbackSummary.emptyPages > 0 && <p>{t("其中 {n} 页在结果里是空的：扫描页没有文字层可回退", { n: fallbackSummary.emptyPages })}</p>}
              {fallbackSummary.blockers.length > 0 && <p className="fallback-blocker">{t("{kinds}：不先处理，重跑还会失败", { kinds: fallbackSummary.blockers.map(({ kind }) => t(errorCopy[kind].short)).join(" / ") })}</p>}
              <div className="fallback-actions">
                <button type="button" className="secondary-button" onClick={() => openPageCheck(fallbackPages[0].page)}>{t("逐页核对回退页")}</button>
                {!batchRunning && <button type="button" className={fallbackSummary.blockers.length ? "secondary-button" : "primary-button"} onClick={() => void rerunAiRefinement("fallback")} title={t("只把上次 AI 失败或未通过校验的页再交给模型，其余页原样保留")}>{t("只重跑 {n} 页回退页", { n: fallbackPages.length })}</button>}
                {fallbackSummary.blockers.length > 0 && <button type="button" className="primary-button" onClick={openSettings}>{t("打开设置")}</button>}
              </div>
            </div>
          )}
          <div className="score-strip">
            <div><strong>{result.pageCount - reviewPages.length - noTextPages.length}</strong><span>{t("通过校验")}</span></div>
            <div className={reviewPages.length ? "needs-review" : ""}><strong>{reviewPages.length}</strong><span>{t("建议检查")}{noTextPages.length > 0 && <> · {t("另有 {n} 页无文字", { n: noTextPages.length })}</>}</span></div>
            <div><strong>{result.pages.reduce((sum, page) => sum + (page.formulaCount ?? 0), 0)}</strong><span>{t("LaTeX 公式")}</span></div>
          </div>
          <div className="result-tabs" role="tablist">
            <button className={tab === "markdown" ? "active" : ""} onClick={() => selectTab("markdown")} role="tab">Markdown</button>
            <button className={tab === "page" ? "active" : ""} onClick={() => selectTab("page")} role="tab">{t("逐页核对")}</button>
            <button className={tab === "quality" ? "active" : ""} onClick={() => selectTab("quality")} role="tab">{t("逐页质量")} <b>{reviewPages.length}</b></button>
            <button className={tab === "compare" ? "active" : ""} onClick={() => selectTab("compare")} role="tab">{t("AI 前后对照")} <b>{comparedPages.length}</b></button>
            <button className={tab === "source" ? "active" : ""} onClick={() => selectTab("source")} role="tab">{t("原始 PDF")}</button>
          </div>
          <div className="result-panel">
            {tab === "markdown" && (
              <div className="markdown-pane">
                <div className="md-toolbar" role="group" aria-label={t("查看方式")}>
                  <button type="button" className={mdView === "rendered" ? "active" : ""} onClick={() => setMdView("rendered")}>{t("渲染")}</button>
                  <button type="button" className={mdView === "raw" ? "active" : ""} onClick={() => setMdView("raw")}>{t("源码")}</button>
                </div>
                {mdView === "rendered"
                  ? <div className="markdown-rendered" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
                  : <pre className="markdown-preview">{result.markdown}</pre>}
              </div>
            )}
            {tab === "quality" && <div className="quality-list">{result.pages.map((page) => (
              <article key={page.page} className={outcome(page) === "noText" ? "notext-page" : page.status === "good" ? "good-page" : ""}><span><button type="button" className="page-link" onClick={() => openPageCheck(page.page)}>{t("第 {n} 页", { n: page.page })}</button></span><div><strong>{methodLabel(page)}</strong><PageReasons page={page} onOpenSettings={openSettings} /><p>{t("{f} 个公式 · {o} 个选项标签", { f: page.formulaCount ?? 0, o: page.optionCount ?? 0 })}</p></div><small>{t("{n} 字符", { n: page.charCount })}{pageTimeLabel(page) && <><br />{pageTimeLabel(page)}</>}{page.usage && <><br />{t("{i}+{o} token", { i: page.usage.inputTokens, o: page.usage.outputTokens })}{page.usage.costUsd !== null ? ` · ${fmtUsd(page.usage.costUsd)}` : ` · ${t("未计价")}`}</>}</small></article>
            ))}</div>}
            {tab === "compare" && (comparedPages.length ? <div className="compare-list">{comparedPages.map((page) => (
              <article key={page.page}><header><strong><button type="button" className="page-link" onClick={() => openPageCheck(page.page)}>{t("第 {n} 页", { n: page.page })}</button></strong><span className={`method-badge ${outcome(page) === "noText" ? "notext" : page.method === "ai" ? "accepted" : "fallback"}`}>{outcome(page) === "noText" ? t("AI 判定无文字") : page.method === "ai" ? t("采用 {model}", { model: page.model ?? "" }) : fallbackLabel(page)}</span></header><div className="compare-columns"><section><h3>{t("最终 Markdown")}</h3>{outcome(page) === "noText" ? <p className="compare-empty">{page.note ? t("本页没有可提取的文字：{note}", { note: page.note }) : t("本页没有可提取的文字")}</p> : <pre>{page.markdown}</pre>}</section><section><h3>{result.mode === "ai" ? t("PDF 文字层（提示/回退）") : t("Surya 本地初稿")}</h3><pre>{page.rawMarkdown}</pre></section></div></article>
            ))}</div> : <div className="all-clear"><span>↔</span><h2>{t("这次没有 AI 对照记录")}</h2><p>{t("使用“重新 AI 精校”后，这里会保留最终结果与本地初稿。")}</p></div>)}
            {tab === "source" && sourceUrl && <iframe className="pdf-preview" src={sourceUrl} title={t("原始 PDF 预览")} />}
            {tab === "page" && checkTarget && (
              <div className="page-check">
                <div className="page-check-bar">
                  <div className="page-check-nav">
                    <button type="button" className="secondary-button" disabled={checkTarget.page <= 1} onClick={() => goToPage(checkTarget.page - 1)} aria-label={t("上一页")}>‹</button>
                    <strong>{t("第 {n} / {total} 页", { n: checkTarget.page, total: result.pageCount })}</strong>
                    <button type="button" className="secondary-button" disabled={checkTarget.page >= result.pageCount} onClick={() => goToPage(checkTarget.page + 1)} aria-label={t("下一页")}>›</button>
                  </div>
                  <span className={`page-pill ${outcome(checkTarget)}`}>{methodLabel(checkTarget)}</span>
                  {nextProblemPage !== null && <button type="button" className="quiet-button" onClick={() => goToPage(nextProblemPage)}>{t("下一个要检查的页 →")}</button>}
                </div>
                {result.pageCount > 1 && (
                  <div className="page-strip" aria-label={t("全部页面")}>
                    {result.pages.map((page) => {
                      const state = outcome(page) === "fallback" ? "bad" : outcome(page) === "noText" ? "notext" : page.status === "review" ? "warn" : "ok";
                      return <button key={page.page} type="button" className={`page-dot ${state}${page.page === checkTarget.page ? " current" : ""}`} aria-label={t("第 {n} 页", { n: page.page })} aria-current={page.page === checkTarget.page ? "page" : undefined} title={`${t("第 {n} 页", { n: page.page })} · ${methodLabel(page)}`} onClick={() => goToPage(page.page)} />;
                    })}
                  </div>
                )}
                <div className="page-check-body">
                  <figure className="page-check-image">
                    {imageFailedPage === checkTarget.page
                      ? <p>{t("原图载入失败")}</p>
                      : <>
                          <span className="page-check-loading">{t("正在载入原图…")}</span>
                          {/* eslint-disable-next-line @next/next/no-img-element -- 原图来自本机 8765 服务、按需现渲染，next/image 的优化管线用不上 */}
                          <img key={checkTarget.page} src={libraryPageImageUrl(activeJobId, checkTarget.page)} alt={t("第 {n} 页原图", { n: checkTarget.page })} decoding="async" onError={() => setImageFailedPage(checkTarget.page)} />
                        </>}
                  </figure>
                  <div className="page-check-text">
                    <div className="page-check-reasons"><PageReasons page={checkTarget} onOpenSettings={openSettings} /></div>
                    {checkHtml
                      ? <div className="markdown-rendered" dangerouslySetInnerHTML={{ __html: checkHtml }} />
                      : <p className="page-check-empty">{outcome(checkTarget) === "noText"
                          ? (checkTarget.note ? t("本页没有可提取的文字：{note}", { note: checkTarget.note }) : t("本页没有可提取的文字"))
                          : outcome(checkTarget) === "fallback"
                            ? t("这页结果为空：AI 没成功，扫描页也没有文字层可回退。")
                            : t("这页没有识别出文字。扫描页请改用本地高精度或 AI 精校。")}</p>}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      ) : null}

      <footer><span>{t("墨页 · Verifiable document tools")}</span><span>{aiWasUsed ? t("本地初稿 · 可选云端精校 · 逐页留痕") : t("当前处理仅在你的设备完成")}</span></footer>

      {/* 左下角「回顾」入口只在首页和 Library 出现：在结果页它会盖住面板左下角 */}
      {((status === "idle" && screen === "converter") || screen === "library") && <div className="stats-fab">
        <button type="button" className="stats-toggle" onClick={() => openPanel("reflect")}>
          <span className="stats-dot" />{t("回顾")}
        </button>
      </div>}

      {toast && <div className="toast" role="status">{toast}</div>}

      {showSettings && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <section className="settings-modal panel-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <button type="button" className="panel-x" onClick={() => setShowSettings(false)} aria-label={t("关闭")}>×</button>
            <nav className="panel-nav">
              <div className="panel-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                <input type="search" value={panelQuery} placeholder={t("搜索栏目")} aria-label={t("搜索栏目")} onChange={(event) => setPanelQuery(event.target.value)} />
              </div>
              {!panelQuery && <div className="panel-nav-group">{t("你")}</div>}
              {navItem("reflect", t("回顾"), <><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 7v5l3 2" /><path d="M17 3h4v4" /><path d="M21 3l-5 5" /></>)}
              {navItem("library", t("资料库"), <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20V8" /><path d="M2 20h20" /></>)}
              {navItem("usage", t("用量"), <><circle cx="12" cy="12" r="9" /><path d="M14.5 9.5a2.5 2.5 0 0 0-2.5-1.5c-1.5 0-2.5.9-2.5 2s1 1.6 2.5 2 2.5.9 2.5 2-1 2-2.5 2a2.5 2.5 0 0 1-2.5-1.5" /><path d="M12 6v2M12 16v2" /></>)}
              {!panelQuery && <div className="panel-nav-group">{t("设置")}</div>}
              {navItem("settings", t("AI 精校设置"), <><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></>)}
              {navItem("setup", t("环境"), <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /><path d="M8 10l2 2 4-4" /></>)}
              {!panelQuery && <div className="panel-nav-group">{t("平台")}</div>}
              {navItem("about", t("关于"), <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>)}
              {panelQuery && !navMatches.length && <div className="panel-nav-empty">{t("没有匹配的栏目")}</div>}
            </nav>
            <div className="panel-main">
              {panelPane === "reflect" && (
                <section className="panel-pane reflect-pane">
                  <div className="reflect-top">
                    <div><div className="reflect-title" id="settings-title">{t("你的回顾")}</div><div className="reflect-sub">{t("基于你在墨页里转换过的文档。")}</div></div>
                    <div className="reflect-ctl">
                      <label className="reflect-range">
                        <select value={reflectRange} onChange={(event) => setReflectRange(event.target.value as ReflectRange)}>
                          <option value="1m">{t("过去一个月")}</option>
                          <option value="3m">{t("过去三个月")}</option>
                          <option value="6m">{t("过去半年")}</option>
                          <option value="12m">{t("过去一年")}</option>
                        </select>
                        <span className="reflect-range-caret">⌄</span>
                      </label>
                      <button type="button" className={`reflect-refresh${reflectBusy ? " spinning" : ""}`} title={t("重新生成叙事")} onClick={() => void loadReflect(true)}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>
                      </button>
                    </div>
                  </div>
                  <div className="reflect-body">
                    {!reflectData ? (
                      <div className="reflect-loading">{t("正在读取你的资料库…")}</div>
                    ) : !reflectData.totals.count ? (
                      <div className="reflect-empty">{t("这段时间还没有转换记录。")}</div>
                    ) : (
                      <>
                        {reflectData.regenerating && <div className="reflect-updating"><span className="reflect-updating-dot" />{t("上次之后有新的文档，正在后台更新这份回顾。")}</div>}
                        <div className="reflect-headline">{!reflectData.generated && reflectData.regenerating ? t("正在写这份回顾…") : reflectData.headline}</div>
                        <p className={`reflect-narrative${reflectData.generated ? "" : " draft"}`}>{!reflectData.generated && reflectData.regenerating ? t("这个时段是第一次生成，大约半分钟，页面会自己更新。") : reflectData.narrative}</p>
                        <div className="reflect-kpis">
                          <div className="reflect-kpi"><b className="text">{reflectData.most_active_weekday_label || "—"}</b><span>{t("转换最多的星期")}</span></div>
                          <div className="reflect-kpi"><b>{fmtHour(reflectData.peak_hour)}</b><span>{t("最常转换的时段")}</span></div>
                          <div className="reflect-kpi"><b>{reflectData.totals.count}</b><span>{t("份文档已转换")}</span></div>
                          <div className="reflect-kpi"><b>{reflectData.totals.pages}</b><span>{t("页已转换")}</span></div>
                        </div>
                        <div className="reflect-sec">
                          <div className="reflect-sec-head">
                            <span className="reflect-sec-label">{t("每天转换了多少")}</span>
                            <span className="reflect-seg">
                              <button type="button" className={reflectMetric === "count" ? "active" : ""} onClick={() => setReflectMetric("count")}>{t("份数")}</button>
                              <button type="button" className={reflectMetric === "pages" ? "active" : ""} onClick={() => setReflectMetric("pages")}>{t("页数")}</button>
                            </span>
                          </div>
                          <ReflectChart series={reflectData.series} prevSeries={reflectData.prev_series} metric={reflectMetric} />
                          <div className="reflect-legend"><span><i />{t("本期")}</span><span><i className="prev" />{t("上一期")}</span></div>
                        </div>
                        <div className="reflect-sec">
                          <div className="reflect-sec-head"><span className="reflect-sec-label">{t("这些文档在讲什么")}</span></div>
                          <div className="reflect-bar">{reflectData.topics.map((topic, i) => <i key={topic.tag} style={{ flex: topic.percent, background: REFLECT_SHADES[Math.min(i, REFLECT_SHADES.length - 1)] }} />)}</div>
                          <div className="reflect-topics">
                            {reflectData.topics.map((topic, i) => (
                              <div className="reflect-topic" key={topic.tag}>
                                <span className="dot" style={{ background: REFLECT_SHADES[Math.min(i, REFLECT_SHADES.length - 1)] }} />
                                <span className="name">{topic.name}</span>
                                <span className="pct">{topic.percent}%</span>
                                <div className="desc">{topic.desc || t("共 {n} 份文档。", { n: topic.count })}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </section>
              )}
              {panelPane === "library" && (
                <section className="panel-pane reflect-pane">
                  <div className="reflect-top">
                    <div><div className="reflect-title" id="settings-title">{t("资料库")}</div><div className="reflect-sub">{t("你转换过的全部文档，不限时间。")}</div></div>
                  </div>
                  <div className="reflect-body">
                    {!stats ? (
                      <div className="reflect-loading">{t("正在读取你的资料库…")}</div>
                    ) : !stats.totals.transcripts ? (
                      <div className="reflect-empty">{t("还没有转换记录。")}</div>
                    ) : (
                      <>
                        <div className="reflect-kpis" style={{ paddingTop: 8 }}>
                          <div className="reflect-kpi"><b>{stats.totals.pages}</b><span>{t("页已转换")}</span></div>
                          <div className="reflect-kpi"><b>{fmtBig(stats.totals.chars)}</b><span>{t("字")}</span></div>
                          <div className="reflect-kpi"><b>{stats.totals.transcripts}</b><span>{t("份文档")}</span></div>
                          <div className="reflect-kpi"><b>{Math.round(stats.totals.pages / Math.max(1, stats.totals.transcripts))}</b><span>{t("平均每份页数")}</span></div>
                        </div>
                        <div className="reflect-sec">
                          <div className="reflect-sec-head"><span className="reflect-sec-label">{t("累计页数")}</span></div>
                          <CumulativeChart timeline={stats.timeline} />
                        </div>
                        <div className="reflect-sec">
                          <div className="reflect-sec-head">
                            <span className="reflect-sec-label">{t("关注领域")}</span>
                            <button type="button" className="stats-lang" disabled={backfillState?.running} onClick={() => void runBackfill()}>
                              {backfillState?.running ? t("补标签中 {done}/{total}", { done: backfillState.done, total: backfillState.total }) : t("补标签")}
                            </button>
                          </div>
                          {stats.topTags.length ? (
                            <div className="lib-tags">
                              {stats.topTags.map((tag) => (
                                <div className="lib-tag" key={tag.tag}>
                                  <span className="name" title={tag.tag}>{tag.tag}</span>
                                  <span className="bar"><i style={{ width: `${Math.max(3, (tag.count / stats.topTags[0].count) * 100)}%` }} /></span>
                                  <span className="num">{tag.count}</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="reflect-empty">{t("还没有标签 —— 点右上角“补标签”生成")}</div>
                          )}
                        </div>
                        {stats.byMode && Object.keys(stats.byMode).length > 0 && (
                          <div className="reflect-sec">
                            <div className="reflect-sec-head"><span className="reflect-sec-label">{t("按模式")}</span></div>
                            {(() => {
                              const modes = Object.entries(stats.byMode!).sort((a, b) => b[1].count - a[1].count);
                              const total = modes.reduce((sum, [, m]) => sum + m.count, 0) || 1;
                              return (
                                <>
                                  <div className="reflect-bar">{modes.map(([key, m], i) => <i key={key} style={{ flex: m.count, background: REFLECT_SHADES[Math.min(i, REFLECT_SHADES.length - 1)] }} />)}</div>
                                  <div className="reflect-topics">
                                    {modes.map(([key, m], i) => (
                                      <div className="reflect-topic" key={key}>
                                        <span className="dot" style={{ background: REFLECT_SHADES[Math.min(i, REFLECT_SHADES.length - 1)] }} />
                                        <span className="name">{t(modeNames[key as ConversionMode] ?? key)}</span>
                                        <span className="pct">{Math.round((m.count / total) * 100)}%</span>
                                        <div className="desc">{t("共 {n} 份 · {p} 页", { n: m.count, p: m.pages })}</div>
                                      </div>
                                    ))}
                                  </div>
                                </>
                              );
                            })()}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </section>
              )}
              {panelPane === "usage" && (
                <section className="panel-pane reflect-pane usage-pane">
                  <div className="reflect-top">
                    <div><div className="reflect-title" id="settings-title">{t("用量与费用")}</div><div className="reflect-sub">{t("每次模型调用都记一笔：精校、打标签、回顾叙事、测试连接。")}</div></div>
                    <div className="reflect-ctl">
                      <span className="reflect-seg">
                        <button type="button" className={usageScope === "month" ? "active" : ""} onClick={() => setUsageScope("month")}>{t("本月")}</button>
                        <button type="button" className={usageScope === "all" ? "active" : ""} onClick={() => setUsageScope("all")}>{t("累计")}</button>
                      </span>
                    </div>
                  </div>
                  <div className="reflect-body">
                    {usageError ? (
                      <div className="reflect-empty">{usageError}</div>
                    ) : !usageData ? (
                      <div className="reflect-loading">{t("正在读取用量…")}</div>
                    ) : !usageData.all.calls ? (
                      <div className="reflect-empty">{t("还没有模型调用记录。从现在起每次调用都会记在这里。")}</div>
                    ) : (() => {
                      const total = usageData[usageScope];
                      const tables: { key: "provider" | "purpose" | "model"; label: string; name: (k: string) => string }[] = [
                        { key: "provider", label: t("按服务商"), name: (k) => providerNames[k as AiProvider] ?? k },
                        { key: "purpose", label: t("按用途"), name: (k) => ({ refine: t("AI 精校"), card: t("打标签 / 标题"), reflect: t("回顾叙事"), test: t("测试连接") } as Record<string, string>)[k] ?? k },
                        { key: "model", label: t("按模型"), name: (k) => k },
                      ];
                      const renderRows = (rows: UsageRow[], name: (k: string) => string) => (
                        <table className="usage-table">
                          <thead><tr><th /><th>{t("次数")}</th><th>{t("输入 token")}</th><th>{t("输出 token")}</th><th>{t("费用")}</th></tr></thead>
                          <tbody>
                            {rows.map((row) => (
                              <tr key={row.key}>
                                <td className="k" title={row.key}>{name(row.key)}</td>
                                <td>{row.calls}</td>
                                <td>{fmtBig(row.inputTokens)}</td>
                                <td>{fmtBig(row.outputTokens)}</td>
                                <td className="usd">{row.unpriced === row.calls ? <em>{t("未计价")}</em> : <>{fmtUsd(row.costUsd)}{row.unpriced ? <em> +{row.unpriced}</em> : null}</>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                      return (
                        <>
                          <div className="reflect-kpis" style={{ paddingTop: 8 }}>
                            <div className="reflect-kpi"><b>{fmtUsd(total.costUsd)}</b><span>{usageScope === "month" ? t("本月费用") : t("累计费用")}</span></div>
                            <div className="reflect-kpi"><b>{total.calls}</b><span>{t("次调用")}</span></div>
                            <div className="reflect-kpi"><b>{fmtBig(total.inputTokens)}</b><span>{t("输入 token")}</span></div>
                            <div className="reflect-kpi"><b>{fmtBig(total.outputTokens)}</b><span>{t("输出 token")}</span></div>
                          </div>
                          {total.unpriced > 0 && (
                            <p className="usage-note">
                              {t("{n} 次调用没有价格表，只记了 token（上表 +N 就是它们），没算进费用。", { n: total.unpriced })}
                              {usageData.unpricedModels.length > 0 && <> {t("未计价模型：")}{usageData.unpricedModels.join("、")}。</>}
                              {" "}{t("在")} <code>data/prices.json</code> {t("里按模型补价格（美元 / 百万 token，字段 input / output / cached），30 秒内生效。")}
                            </p>
                          )}
                          {tables.map((table) => (
                            <div className="reflect-sec" key={table.key}>
                              <div className="reflect-sec-head"><span className="reflect-sec-label">{table.label}</span></div>
                              {usageData.by[table.key][usageScope].length ? renderRows(usageData.by[table.key][usageScope], table.name) : <div className="reflect-empty">{t("这段时间没有调用。")}</div>}
                            </div>
                          ))}
                          <p className="usage-note">{t("OpenRouter 的费用是它每次响应里报的实价；Gemini 按内置价格表估算。明细在")} <code>data/usage.db</code>。</p>
                        </>
                      );
                    })()}
                  </div>
                </section>
              )}
              {panelPane === "settings" && (
                <section className="panel-pane settings-pane">
                  <h2 id="settings-title">{t("AI 精校设置")}</h2>
                {settingsDraft.provider === "ollama" ? (
                  <div className="settings-warning local"><strong>{t("隐私说明")}</strong><p>{t("本机 Ollama：页面图像只发给这台电脑上的 Ollama（127.0.0.1），不经过任何云端服务，也不需要 API Key。")}</p></div>
                ) : (
                  <div className="settings-warning"><strong>{t("隐私说明")}</strong><p>{t("AI 模式下，页面的 JPEG 图像和 PDF 文字层提示会发送给你选择的模型服务。API Key 仅保存在本项目的本机")} <code>settings.local.json</code>{t("，不会写入 Library 或浏览器页面数据。")}</p></div>
                )}
                {!settings.aiConfigured && settingsDraft.provider !== "ollama" && (
                  // 没有任何 Key 的新用户：第一眼就告诉他有不用注册、不用花钱的路
                  <button type="button" className="settings-local-offer" onClick={() => selectProvider("ollama")}>
                    <strong>{t("没有 API Key？用本机模型")}</strong>
                    <span>{t("Ollama 在这台电脑上运行视觉模型：免费、不上传，一键下载。")}</span>
                  </button>
                )}
                <div className="settings-provider" role="group" aria-label={t("模型服务商")}>
                  <button type="button" className={settingsDraft.provider === "gemini" ? "active" : ""} onClick={() => selectProvider("gemini")}>Google Gemini</button>
                  <button type="button" className={settingsDraft.provider === "kimi" ? "active" : ""} onClick={() => selectProvider("kimi")}>Kimi</button>
                  <button type="button" className={settingsDraft.provider === "qwen" ? "active" : ""} onClick={() => selectProvider("qwen")}>{t("Qwen 百炼")}</button>
                  <button type="button" className={settingsDraft.provider === "openrouter" ? "active" : ""} onClick={() => selectProvider("openrouter")}>OpenRouter</button>
                  <button type="button" className={settingsDraft.provider === "ollama" ? "active" : ""} onClick={() => selectProvider("ollama")}>{t("本机 Ollama")}</button>
                </div>
                <div className="multichannel">
                  <label className="multichannel-main" aria-label={t("多渠道并行")}>
                    <input
                      type="checkbox"
                      checked={Boolean(settingsDraft.multiChannel)}
                      onChange={(event) => setSettingsDraft((value) => ({ ...value, multiChannel: event.target.checked }))}
                    />
                    <span>
                      <strong>{t("多渠道并行")}</strong>
                      <small>
                        {settingsDraft.multiChannel
                          ? t("页面按并发能力分给下面勾选的渠道。上面选的服务商只决定「测试连接」测哪一家。")
                          : t("关闭时只用上面选中的 {provider} 一家。不同渠道打的是不同上游，配额互不占用。", { provider: providerNames[settingsDraft.provider] })}
                      </small>
                    </span>
                  </label>
                  {settingsDraft.multiChannel && (
                    <>
                      <div className="channel-picks">
                        {configuredProviders.length === 0 && <span className="channel-empty">{t("还没有配置任何 API Key")}</span>}
                        {configuredProviders.map((p) => {
                          const picked = !settingsDraft.channels?.length || settingsDraft.channels.includes(p);
                          return (
                            <label key={p} className={`channel-chip ${picked ? "on" : ""}`}>
                              <input
                                type="checkbox"
                                checked={picked}
                                onChange={() => setSettingsDraft((value) => {
                                  // 空数组代表「全选」，第一次取消要先展开成完整列表再减
                                  const current = value.channels?.length ? value.channels : configuredProviders;
                                  const next = current.includes(p) ? current.filter((x) => x !== p) : [...current, p];
                                  return { ...value, channels: next.length ? next : configuredProviders };
                                })}
                              />
                              <b>{providerNames[p]}</b>
                              <i>{t("{n} 路", { n: settings.channelWeights?.[p] ?? "?" })}</i>
                            </label>
                          );
                        })}
                      </div>
                      <div className="channel-total">
                        {t("合计并发")}{" "}
                        <b>
                          {configuredProviders
                            .filter((p) => !settingsDraft.channels?.length || settingsDraft.channels.includes(p))
                            .reduce((sum, p) => sum + (settings.channelWeights?.[p] ?? 0), 0)}
                        </b>{" "}
                        {t("路 · 实测 84 路可靠，再往上会有请求挂死")}
                      </div>
                    </>
                  )}
                </div>
                {settingsDraft.provider === "gemini" ? (
                  <div className="settings-fields">
                    <label><span>Gemini API Key</span><input type="password" value={settingsDraft.geminiKey || ""} onChange={(event) => setSettingsDraft((value) => ({ ...value, geminiKey: event.target.value }))} placeholder={settingsDraft.geminiKeyMasked || "AIza…"} /><small>{settingsDraft.geminiConfigured ? t("已配置 {masked}；留空则保留原值", { masked: settingsDraft.geminiKeyMasked }) : t("尚未配置")}</small></label>
                    <div className="keypool">
                      <div className="keypool-head">
                        <div>
                          <span className="keypool-title">{t("并行密钥")}</span>
                          <small>{t("实测：同一 Google")} <b>{t("账号")}</b>{t("下的 Key（哪怕分属不同项目）共用同一份吞吐，加了不会更快；")}<b>{t("换一个 Google 账号")}</b>{t("的 Key 才是独立配额——实测两个账号并行提速")} <b>{t("3.3 倍")}</b>。</small>
                        </div>
                        <span className="keypool-badge" title={t("并发 = 6 × 独立项目数")}>
                          {t("{n} 把 Key · 并发 {c}", { n: extraKeys.filter((k) => k.masked || k.value.trim()).length + 1, c: 6 * Math.max(1, Math.min(settingsDraft.geminiProjects || 1, extraKeys.filter((k) => k.masked || k.value.trim()).length + 1)) })}
                        </span>
                      </div>
                      <ol className="keypool-list">
                        <li className="keypool-row is-primary">
                          <span className="keypool-index">1</span>
                          <code>{settingsDraft.geminiKeyMasked || t("上方主 Key")}</code>
                          <span className="keypool-tag">{t("主")}</span>
                        </li>
                        {extraKeys.map((key, i) => (
                          <li className="keypool-row" key={i}>
                            <span className="keypool-index">{i + 2}</span>
                            {key.masked && !key.value ? (
                              <>
                                <code>{key.masked}</code>
                                <span className="keypool-tag">{t("已保存")}</span>
                              </>
                            ) : (
                              <input
                                type="password"
                                value={key.value}
                                spellCheck={false}
                                placeholder={key.masked ? t("留空则保留原值") : t("AIza… （另一个 Google 账号的 Key）")}
                                onChange={(event) => updateExtraKey(i, event.target.value)}
                              />
                            )}
                            <button type="button" className="keypool-remove" aria-label={t("移除第 {n} 把 Key", { n: i + 2 })} onClick={() => removeExtraKey(i)}>✕</button>
                          </li>
                        ))}
                      </ol>
                      <div className="keypool-foot">
                        <button type="button" className="keypool-add" onClick={addExtraKey}>{t("＋ 添加一把 Key")}</button>
                        <label className="keypool-projects">
                          <span>{t("其中来自几个独立账号")}</span>
                          <input type="number" min={1} max={20} value={settingsDraft.geminiProjects || 1}
                            onChange={(event) => setSettingsDraft((v) => ({ ...v, geminiProjects: Math.max(1, Number(event.target.value) || 1) }))} />
                        </label>
                      </div>
                    </div>
                    <label htmlFor="gemini-model"><span>{t("主模型")}</span><ModelPicker id="gemini-model" provider="gemini" value={settingsDraft.geminiModel} extra={remoteModels?.provider === "gemini" ? remoteModels.models : []} onChange={(geminiModel) => setSettingsDraft((value) => ({ ...value, geminiModel }))} /></label>
                    <label><span>{t("失败回退模型")}</span><input value={settingsDraft.geminiFallbackModel} onChange={(event) => setSettingsDraft((value) => ({ ...value, geminiFallbackModel: event.target.value }))} /></label>
                    <label className="wide"><span>API Base URL</span><input value={settingsDraft.geminiBaseUrl} onChange={(event) => setSettingsDraft((value) => ({ ...value, geminiBaseUrl: event.target.value }))} /></label>
                  </div>
                ) : settingsDraft.provider === "kimi" ? (
                  <div className="settings-fields">
                    <label><span>Moonshot API Key</span><input type="password" value={settingsDraft.kimiKey || ""} onChange={(event) => setSettingsDraft((value) => ({ ...value, kimiKey: event.target.value }))} placeholder={settingsDraft.kimiKeyMasked || "sk-…"} /><small>{settingsDraft.kimiConfigured ? t("已配置 {masked}；留空则保留原值", { masked: settingsDraft.kimiKeyMasked }) : t("在 Kimi 开放平台创建 API Key")}</small></label>
                    <label className="wide" htmlFor="kimi-model"><span>{t("Kimi 视觉模型")}</span><ModelPicker id="kimi-model" provider="kimi" value={settingsDraft.kimiModel} extra={remoteModels?.provider === "kimi" ? remoteModels.models : []} onChange={(kimiModel) => setSettingsDraft((value) => ({ ...value, kimiModel }))} /></label>
                    <label className="wide"><span>API Base URL</span><input value={settingsDraft.kimiBaseUrl} onChange={(event) => setSettingsDraft((value) => ({ ...value, kimiBaseUrl: event.target.value }))} /></label>
                  </div>
                ) : settingsDraft.provider === "qwen" ? (
                  <div className="settings-fields">
                    <label><span>{t("阿里云百炼 API Key")}</span><input type="password" value={settingsDraft.qwenKey || ""} onChange={(event) => setSettingsDraft((value) => ({ ...value, qwenKey: event.target.value }))} placeholder={settingsDraft.qwenKeyMasked || "sk-…"} /><small>{settingsDraft.qwenConfigured ? t("已配置 {masked}；留空则保留原值", { masked: settingsDraft.qwenKeyMasked }) : t("Key 与调用地域必须一致")}</small></label>
                    <label className="wide" htmlFor="qwen-model"><span>{t("Qwen 视觉 / OCR 模型")}</span><ModelPicker id="qwen-model" provider="qwen" value={settingsDraft.qwenModel} extra={remoteModels?.provider === "qwen" ? remoteModels.models : []} onChange={(qwenModel) => setSettingsDraft((value) => ({ ...value, qwenModel }))} /></label>
                    <label className="wide"><span>API Base URL</span><input value={settingsDraft.qwenBaseUrl} onChange={(event) => setSettingsDraft((value) => ({ ...value, qwenBaseUrl: event.target.value }))} /><small>{t("默认使用北京公共兼容地址；也可替换成百炼业务空间专属 compatible-mode/v1 地址。")}</small></label>
                  </div>
                ) : settingsDraft.provider === "ollama" ? (
                  <div className="settings-fields">
                    <label className="wide" htmlFor="ollama-model"><span>{t("本机视觉模型")}</span><ModelPicker id="ollama-model" provider="ollama" value={settingsDraft.ollamaModel} extra={remoteModels?.provider === "ollama" ? remoteModels.models : []} onChange={(ollamaModel) => setSettingsDraft((value) => ({ ...value, ollamaModel }))} /><small>{t("必须是能看图的模型，并且已经下载到本机。还没有就去")} <button type="button" className="inline-link" onClick={() => openPanel("setup")}>{t("「环境」一键下载")}</button>{t("。本机比云端慢得多，一次只跑一页。")}</small></label>
                    <label className="wide"><span>{t("Ollama 地址")}</span><input value={settingsDraft.ollamaBaseUrl} onChange={(event) => setSettingsDraft((value) => ({ ...value, ollamaBaseUrl: event.target.value }))} /></label>
                  </div>
                ) : (
                  <div className="settings-fields">
                    <label><span>OpenRouter API Key</span><input type="password" value={settingsDraft.openrouterKey || ""} onChange={(event) => setSettingsDraft((value) => ({ ...value, openrouterKey: event.target.value }))} placeholder={settingsDraft.openrouterKeyMasked || "sk-or-…"} /><small>{settingsDraft.openrouterConfigured ? t("已配置 {masked}；留空则保留原值", { masked: settingsDraft.openrouterKeyMasked }) : t("尚未配置")}</small></label>
                    <label className="wide" htmlFor="openrouter-model"><span>{t("视觉模型")}</span><ModelPicker id="openrouter-model" provider="openrouter" value={settingsDraft.openrouterModel} extra={remoteModels?.provider === "openrouter" ? remoteModels.models : []} onChange={(openrouterModel) => setSettingsDraft((value) => ({ ...value, openrouterModel }))} /></label>
                    <label className="wide"><span>API Base URL</span><input value={settingsDraft.openrouterBaseUrl} onChange={(event) => setSettingsDraft((value) => ({ ...value, openrouterBaseUrl: event.target.value }))} /></label>
                  </div>
                )}
                <div className="model-sync-row"><button type="button" className="secondary-button" disabled={settingsBusy} onClick={() => void syncModels()}>{settingsDraft.provider === "ollama" ? t("↻ 读取本机模型") : t("↻ 从服务商同步模型")}</button><span>{settingsDraft.provider === "ollama" ? t("列出本机已下载、能看图的模型。") : t("需要先填写 API Key；只显示可用于图片输入的模型。")}</span></div>
                <fieldset className="scope-field"><legend>{t("精校范围")}</legend><label><input type="radio" checked={settingsDraft.aiScope === "all"} onChange={() => setSettingsDraft((value) => ({ ...value, aiScope: "all" }))} />{t("全部页面（质量最佳）")}</label><label><input type="radio" checked={settingsDraft.aiScope === "review"} onChange={() => setSettingsDraft((value) => ({ ...value, aiScope: "review" }))} />{t("只精校公式、选项与可疑页面（更省费用）")}</label></fieldset>
                <fieldset className="scope-field">
                  <legend>{t("自动打标签")}</legend>
                  <label>
                    <input type="checkbox" checked={settingsDraft.autoTag !== false} onChange={(event) => setSettingsDraft((value) => ({ ...value, autoTag: event.target.checked }))} />
                    {settingsDraft.provider === "ollama"
                      ? t("转换完成后用本机模型给文档打 2–4 个主题标签（不出这台电脑）")
                      : t("转换完成后用当前服务商给文档打 2–4 个主题标签（会把文档开头约 3000 字发出去，本地模式也一样）")}
                  </label>
                </fieldset>
                {settingsStatus && <div className="settings-status" role="status">{settingsStatus}</div>}
                <footer><button type="button" className="secondary-button" disabled={settingsBusy} onClick={() => void testSettings()}>{t("测试连接")}</button><div><button type="button" className="quiet-button" onClick={() => setShowSettings(false)}>{t("取消")}</button><button type="button" className="primary-button" disabled={settingsBusy} onClick={() => void persistSettings()}>{t("保存设置")}</button></div></footer>
                </section>
              )}
              {panelPane === "setup" && (
                <section className="panel-pane reflect-pane setup-pane">
                  <div className="reflect-top">
                    <div><div className="reflect-title" id="settings-title">{t("环境")}</div><div className="reflect-sub">{t("每个组件管一类文件或一个模式。缺的可以在这里一键补装，装在墨页自己的文件夹里。")}</div></div>
                    <div className="reflect-ctl">
                      <button type="button" className="secondary-button" onClick={() => void fetchSetup().then(setSetupData).catch(() => undefined)}>{t("↻ 重新检测")}</button>
                    </div>
                  </div>
                  <div className="reflect-body">
                    {setupError && <div className="settings-status" role="alert">{setupError}</div>}
                    {!setupData ? (
                      <div className="reflect-loading">{t("正在检测…")}</div>
                    ) : (() => {
                      const c = setupData.components;
                      const task = (name: SetupComponent) => setupData.tasks[name];
                      // 一行：状态点 + 名字/用途 + 右侧动作；装过一次就把最后几行输出摆出来（失败原因不能藏）
                      const row = (name: SetupComponent, ok: boolean, title: string, purpose: string, action: React.ReactNode, extra?: React.ReactNode) => {
                        const running = task(name);
                        return (
                          <div className={`setup-row ${ok ? "ok" : "missing"}`} key={name}>
                            <i className="setup-dot" aria-hidden="true" />
                            <div className="setup-main">
                              <strong>{title}</strong>
                              <small>{purpose}</small>
                              {extra}
                              {running && running.lines.length > 0 && (
                                <pre className={`setup-log ${running.ok === false ? "failed" : ""}`}>{running.lines.slice(-4).join("\n")}</pre>
                              )}
                            </div>
                            <div className="setup-action">{ok && !running?.running ? <span className="setup-ok">{t("已就绪")}</span> : action}</div>
                          </div>
                        );
                      };
                      const installButton = (name: SetupComponent, label = t("安装")) => {
                        const current = task(name);
                        return (
                          <button type="button" className="secondary-button" disabled={Boolean(current?.running)} onClick={() => void runInstall(name)}>
                            {current?.running ? t("安装中…") : current?.ok === false ? t("重试") : label}
                          </button>
                        );
                      };
                      const visionModels = c.ollama.models.filter((model) => model.vision);
                      const usableModels = visionModels.filter((model) => !model.thinking);
                      const pull = task("ollama-model");
                      const pickModel = ollamaPick || c.ollama.recommended;
                      const ms = setupData.modelSource;
                      const source: ModelSource = modelSourcePick || ms.recommended;
                      const mirror = ms.mirrors[pickModel];
                      // 真正交给 Ollama 拉取的名字：选了魔搭且这个模型有镜像，就换成镜像名
                      const pullName = source === "modelscope" && mirror ? mirror : pickModel;
                      const have = (id: string) => c.ollama.models.some((model) => model.id === id || model.id === `${id}:latest`);
                      const kb = (n: number | null) => (n === null ? "?" : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB/s` : `${Math.round(n / 1024)}KB/s`);
                      return (
                        <div className="setup-list">
                          {row("python", c.python.ok, t("基础环境"), t("把页面渲染成图片、处理图片文件。AI 精校和图片转换都要它。"), installButton("python"))}
                          {row("ollama", c.ollama.ok, t("本机 AI · Ollama"),
                            t("在这台电脑上跑视觉模型做 AI 精校：不用 API Key、不花钱、页面图像不离开这台电脑。比云端慢，适合页数不多或隐私敏感的材料。"),
                            !c.ollama.installed ? installButton("ollama", t("安装 Ollama"))
                              : !c.ollama.reachable ? installButton("ollama", t("启动 Ollama"))
                                : null,
                            c.ollama.reachable ? (
                              <div className="setup-ollama">
                                {visionModels.length > 0 && (
                                  <div className="setup-models">
                                    {visionModels.map((model) => {
                                      const inUse = settings.provider === "ollama" && settings.ollamaModel === model.id;
                                      return (
                                        <span key={model.id} className={`setup-model ${inUse ? "on" : ""}`}>
                                          <code>{model.id}</code>
                                          {model.thinking ? <em className="warn" title={t("会思考的版本：Ollama 关不掉它的思考，输出会坏掉。请下载 Instruct 版。")}>{t("思考版 · 不能用")}</em> : inUse ? <em>{t("正在使用")}</em> : (
                                            <button type="button" onClick={() => {
                                              void patchAiSettings({ provider: "ollama", ollamaModel: model.id })
                                                .then(setSettings).catch((caught) => setSetupError(caught instanceof Error ? caught.message : t("设置保存失败。")));
                                            }}>{t("设为 AI 精校服务")}</button>
                                          )}
                                        </span>
                                      );
                                    })}
                                  </div>
                                )}
                                <div className="setup-pull">
                                  <select value={pickModel} onChange={(event) => setOllamaPick(event.target.value)} aria-label={t("要下载的模型")}>
                                    {modelPresets.ollama.filter((item) => !item.value.startsWith("modelscope.cn/")).map((item) => <option key={item.value} value={item.value}>{t(item.label)}{item.value === c.ollama.recommended ? t(" · 按你的内存推荐") : ""}</option>)}
                                  </select>
                                  <select className="setup-source" value={mirror ? source : "ollama"} disabled={!mirror} onChange={(event) => setModelSourcePick(event.target.value as ModelSource)} aria-label={t("下载源")}>
                                    <option value="ollama">{t("Ollama 官方")}{ms.probing ? "" : ` · ${kb(ms.official)}`}</option>
                                    <option value="modelscope">{t("魔搭镜像")}{ms.probing ? "" : ` · ${kb(ms.modelscope)}`}</option>
                                  </select>
                                  <button type="button" className="secondary-button" disabled={Boolean(pull?.running) || have(pullName)} onClick={() => void runInstall("ollama-model", pullName)}>
                                    {have(pullName) ? t("已下载") : pull?.running ? t("下载中…") : t("下载模型")}
                                  </button>
                                </div>
                                <small className="setup-hint">{ms.probing ? t("正在测两个下载源的速度…") : ms.recommended === "modelscope" ? t("魔搭镜像在你的网络上够快，默认用它（同一个模型）。官方源在一些网络上开头快、之后会反复断开。") : t("魔搭镜像在你的网络上明显更慢，默认用官方源。")}</small>
                                {pull && (pull.running || pull.ok === false) && (
                                  <div className="setup-progress">
                                    <div><span style={{ width: `${pull.progress ? Math.floor((pull.progress.completed / pull.progress.total) * 100) : 0}%` }} /></div>
                                    <small>{pull.ok === false ? `${t("下载失败：")}${pull.lines.at(-1) ?? ""}` : `${pull.model} · ${pull.progress ? `${(pull.progress.completed / 1e9).toFixed(2)} / ${(pull.progress.total / 1e9).toFixed(2)} GB` : pull.lines.at(-1) ?? ""}`}</small>
                                  </div>
                                )}
                                <small className="setup-hint">{t("这台电脑 {n}GB 内存。", { n: c.ollama.memGb })}{usableModels.length === 0 ? t("还没有能看图的模型，先下载一个。") : ""}</small>
                              </div>
                            ) : undefined)}
                          {row("surya", c.surya.ok, t("Surya 本地高精度识别"),
                            t("「本地高精度」模式用它识别扫描件、公式和表格，全程离线。约 2GB，需要 Homebrew（装 llama.cpp）。"),
                            installButton("surya"),
                            c.surya.package && !c.surya.llamaServer ? <small className="setup-hint">{t("Surya 已装，但缺少 llama.cpp 的 llama-server，点安装会补上。")}</small> : undefined)}
                          {row("libreoffice", c.libreoffice.ok, "LibreOffice", t("转换 PPT / Word 文件。约 700MB；没有 Homebrew 时会给出下载地址。"), installButton("libreoffice"))}
                          {row("browser", c.browser.ok, t("PDF 导出浏览器"), t("结果页「下载 PDF」和拖入 .md 转 PDF 用。约 100MB，独立于你的 Chrome。"), installButton("browser"))}
                          <div className={`setup-row ${c.ai.ok ? "ok" : "missing"}`}>
                            <i className="setup-dot" aria-hidden="true" />
                            <div className="setup-main">
                              <strong>{t("AI 精校服务")}</strong>
                              <small>{c.ai.ok ? t("当前：{provider}", { provider: providerNames[c.ai.provider] + (c.ai.provider === "ollama" ? ` · ${c.ai.ollamaModel}` : "") }) : t("还没配置。用上面的本机 Ollama，或在「AI 精校设置」里填一家云端服务的 API Key。")}</small>
                            </div>
                            <div className="setup-action"><button type="button" className="secondary-button" onClick={() => openPanel("settings")}>{t("去设置")}</button></div>
                          </div>
                          <p className="usage-note">{t("也可以在终端运行")} <code>./install.sh</code>{t("（装全部）或")} <code>./install.sh --only surya</code>{t("。安装日志在")} <code>logs/setup.log</code>。</p>
                        </div>
                      );
                    })()}
                  </div>
                </section>
              )}
              {panelPane === "about" && (
                <section className="panel-pane about-pane">
                  <div className="reflect-top">
                    <div><div className="reflect-title" id="settings-title">{t("墨页")}</div><div className="reflect-sub">{t("PDF/PPT/Word/图片 转 Markdown")}</div></div>
                  </div>
                  <div className="reflect-body">
                    <p>{t("本机运行的 PDF / PPT / Word / 图片 → Markdown 工具。文字层、Surya 版面识别、视觉模型精校三档，扫描件、公式、表格、七百页的书都能转；转换全在这台机器上排队执行，关掉页面也照跑。")}</p>
                    <div className="about-rows">
                      <div className="about-row"><span>{t("版本")}</span><code>0.1.0</code></div>
                      <div className="about-row"><span>{t("数据目录")}<small>{t("文档、原始文件和逐页记录都在这里，删掉即清空。")}</small></span><code>data/</code></div>
                      <div className="about-row"><a href="https://github.com/xyzxinlu-max/moye-pdf-to-markdown" target="_blank" rel="noopener noreferrer">{t("源码在 GitHub ↗")}</a><a href="https://github.com/xyzxinlu-max/moye-pdf-to-markdown#readme" target="_blank" rel="noopener noreferrer">{t("使用说明 ↗")}</a></div>
                    </div>
                  </div>
                </section>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
