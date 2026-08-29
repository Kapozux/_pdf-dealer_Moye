"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { defaultAiSettings, fetchAiModels, getAiSettings, saveAiSettings, testAiSettings, type AiModelOption, type AiProvider, type AiSettings } from "../lib/ai-settings";
import { type ConversionMode, type ConversionResult, type PageResult } from "../lib/pdf-to-markdown";
import {
  cancelJob, deleteLibraryEntry, fetchLibraryEntry, fetchStats, fetchTagBackfillStatus, libraryPdfUrl, listJobs,
  exportZipUrl, listBatches, listLibraryItems, refineLibraryEntry, startTagBackfill, submitJob, subscribeJobs,
  type Batch, type Job, type Stats, type TagBackfillState,
} from "../lib/api";
import { marked } from "marked";
import katex from "katex";
import "katex/dist/katex.min.css";

// PPT/PPTX 先在服务端转成 PDF 再走原来那套管线（见 server/office2pdf.mjs），
// 前端这边只需要放宽"只认 PDF"的校验，不用关心转换细节。
const ACCEPTED_EXTENSIONS = [".pdf", ".ppt", ".pptx"];
function isAcceptedFile(f: File) {
  return f.type === "application/pdf" || ACCEPTED_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext));
}
// 只有真正的 PDF 才能直接拿浏览器本地的 blob URL 预览；PPT 要等服务端转完
// 才有 PDF 可看，本地文件本身塞进 <iframe> 是空白的。
function isPdfFile(f: File) {
  return f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
}

type Status = "idle" | "processing" | "batch" | "complete" | "error";
type Screen = "converter" | "library";
type ResultTab = "markdown" | "quality" | "compare" | "source";
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
  | { name: "doc"; id: string }
  | { name: "batch"; id: string };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  if (path === "library") return { name: "library" };
  const doc = path.match(/^doc\/([\w-]+)$/);
  if (doc) return { name: "doc", id: doc[1] };
  const batch = path.match(/^batch\/([\w-]+)$/);
  if (batch) return { name: "batch", id: batch[1] };
  return { name: "home" };
}

function routeHash(route: Route): string {
  switch (route.name) {
    case "library": return "#/library";
    case "doc": return `#/doc/${route.id}`;
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
 * 原文里的裸 HTML 一律转义——内容来自 PDF 和模型，不可信。
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
  const html = marked.parse(withPlaceholders, { renderer, gfm: true, async: false }) as string;
  return html.replace(/\uE000(\d+)\uE001/g, (_, index: string) => formulas[Number(index)] ?? "");
}

const providerNames: Record<AiProvider, string> = {
  gemini: "Gemini",
  kimi: "Kimi",
  qwen: "Qwen",
  openrouter: "OpenRouter",
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
};

function ModelPicker({ id, provider, value, extra = [], onChange }: { id: string; provider: AiProvider; value: string; extra?: AiModelOption[]; onChange: (value: string) => void }) {
  const presets = [...modelPresets[provider]];
  for (const model of extra) {
    if (!presets.some((item) => item.value === model.id)) presets.push({ value: model.id, label: `${model.label} · 服务商返回` });
  }
  const isCustom = !presets.some((item) => item.value === value);
  return (
    <div className="model-picker">
      <select id={id} value={isCustom ? "__custom__" : value} onChange={(event) => { if (event.target.value !== "__custom__") onChange(event.target.value); }} aria-label="选择模型预设">
        {presets.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
        <option value="__custom__">自定义 Model ID</option>
      </select>
      <input value={value} onChange={(event) => onChange(event.target.value)} aria-label="模型 ID" placeholder="输入 Model ID" />
    </div>
  );
}

function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 把毫秒变成「1 分 04 秒」这种好读的形式。 */
function formatElapsed(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${String(minutes % 60).padStart(2, "0")} 分`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(timestamp);
}

/** 大数字缩写成「12.3K」这种形式，给统计面板的字数用。 */
function fmtBig(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * 自绘 SVG 折线（面积填充 + 端点强调），不依赖外部图表库——
 * 照抄 getAudio 统计面板的手法，这里只是换了配色跟着墨页自己的 --green。
 */
function sparkline(values: number[], w = 272, h = 78) {
  if (values.length < 2) return <div className="spark-empty">数据还不够画图</div>;
  const pad = 6;
  const maxY = Math.max(...values, 1);
  const x = (i: number) => pad + (i / (values.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - (v / maxY) * (h - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${x(0)},${h - pad} ${pts} ${x(values.length - 1)},${h - pad}`;
  const last = values.length - 1;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--green)" stopOpacity="0.18" />
          <stop offset="1" stopColor="var(--green)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#sparkfill)" />
      <polyline points={pts} fill="none" stroke="var(--green)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(values[last])} r={3} fill="var(--green)" />
    </svg>
  );
}

function methodLabel(page: PageResult) {
  if (page.method === "ai") {
    const providerName = { gemini: "Gemini", kimi: "Kimi", qwen: "Qwen", openrouter: "OpenRouter" }[page.provider || "gemini"];
    return `${providerName} · ${page.model || "视觉模型"}`;
  }
  if (page.aiAttempted) return "AI 未通过校验 · 已回退 Surya";
  if (page.method === "surya") return "Surya 本地视觉识别";
  if (page.method === "ocr") return "本地 OCR";
  if (page.method === "text") return "PDF 文字层";
  return "未识别";
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
              reject(new Error("任务不存在或已被清除。"));
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
  const [progressDetail, setProgressDetail] = useState("正在读取 PDF 结构…");
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [error, setError] = useState("");
  // 重新精校失败时服务端会保留旧结果（不是空白报错屏），但要让用户知道这次其实没有真的变化
  const [refineWarning, setRefineWarning] = useState("");
  const [tab, setTab] = useState<ResultTab>("markdown");
  // Markdown 标签页：默认看渲染结果（公式、表格、标题都成形），要核对原文再切源码
  const [mdView, setMdView] = useState<"rendered" | "raw">("rendered");
  const [copied, setCopied] = useState(false);
  const [screen, setScreen] = useState<Screen>("converter");
  const [library, setLibrary] = useState<Job[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [activeJobId, setActiveJobId] = useState<string>("");
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [query, setQuery] = useState("");
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
   */
  type KeyRow = { masked: string | null; value: string };
  const [extraKeys, setExtraKeys] = useState<KeyRow[]>([]);
  const updateExtraKey = (index: number, next: string) =>
    setExtraKeys((keys) => keys.map((k, i) => (i === index ? { ...k, value: next } : k)));
  const addExtraKey = () => setExtraKeys((keys) => [...keys, { masked: null, value: "" }]);
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
  // 左下角「你的墨页数据」统计面板：开的时候才拉一次，不常驻轮询
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [backfillState, setBackfillState] = useState<TagBackfillState | null>(null);

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
      setSettingsDraft({ ...loaded, geminiKey: "", kimiKey: "", qwenKey: "", openrouterKey: "" });
    }).catch(() => undefined);
  }, []);

  const reviewPages = useMemo(() => result?.pages.filter((page) => page.status === "review") ?? [], [result]);
  const comparedPages = useMemo(() => result?.pages.filter((page) => page.rawMarkdown !== undefined) ?? [], [result]);
  // 渲染一次缓存住：几百页的文档有上千个公式，切标签页不该每次重算
  const renderedMarkdown = useMemo(() => (result && mdView === "rendered" ? renderMarkdown(result.markdown) : ""), [result, mdView]);
  // 统计面板的累计页数走势：时间线是按天的增量，前端自己滚成累计和
  const cumPages = useMemo(() => {
    let sum = 0;
    return (stats?.timeline ?? []).map((point) => (sum += point.pages));
  }, [stats]);
  const aiWasUsed = mode === "ai" || result?.pages.some((page) => page.method === "ai" || page.aiAttempted);
  // 哪些渠道已经有 Key（多渠道分流时实际参与的就是这几家）。
  // 用已保存的 settings 而不是 draft：draft 里的 Key 输入框是空的（留空=保留原值）。
  const configuredProviders = useMemo(
    () => (["gemini", "kimi", "qwen", "openrouter"] as AiProvider[]).filter(
      (p) => settings[`${p}Configured` as const]
    ),
    [settings]
  );
  const percent = progress.total ? Math.round((progress.page / progress.total) * 100) : 0;
  const filteredLibrary = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return library;
    // 文件名和 AI 打的标签都搜：标签本来只在统计面板里露过面，这才有入口
    return library.filter((item) =>
      item.filename.toLocaleLowerCase().includes(normalized)
      || parseTags(item.tags).some((tag) => tag.toLocaleLowerCase().includes(normalized))
    );
  }, [library, query]);
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
      setLibraryError(caught instanceof Error ? caught.message : "资料库读取失败。");
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
    if (route.name === "doc") { await loadDoc(route.id); return; }
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

  /**
   * 按任务 id 打开一份文档——Library 点开、批次里点"查看"、直接输入地址、刷新，全走这里。
   * 任务还在跑就先显示进度页，跑完自动切到结果；已完成就直接取结果。
   */
  async function loadDoc(id: string) {
    try {
      const job = (await listJobs()).find((item) => item.id === id) ?? null;
      setScreen("converter");
      setActiveJobId(id);
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      setSourceUrl(libraryPdfUrl(id));
      setError("");
      setRefineWarning("");
      if (job) setActiveFilename(job.filename);
      if (job && (job.status === "queued" || job.status === "running")) {
        setMode(job.mode);
        setProgress({ page: job.page, total: job.total });
        setProgressDetail(job.detail || "正在处理…");
        setRunStartedAt(new Date(job.created_at).getTime());
        setRunEndedAt(null);
        setStatus("processing");
        const finished = await waitForJob(id, (live) => {
          setProgress({ page: live.page, total: live.total });
          if (live.detail) setProgressDetail(live.detail);
        });
        setRunEndedAt(Date.now());
        if (finished.status !== "done") throw new Error(finished.error || "转换未完成。");
      } else if (job && job.status !== "done") {
        throw new Error(job.error || "这份任务没有完成。");
      }
      // listJobs 只取最近 200 条；更老的记录直接按 id 取结果
      const { job: storedJob, result: stored } = await fetchLibraryEntry(id);
      setActiveFilename(storedJob.filename);
      setMode(stored.mode);
      setResult(stored);
      setTab(stored.mode === "ai" ? "compare" : "markdown");
      setStatus("complete");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法打开这份记录。");
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
          detail: live.detail || "正在转换…",
          status: live.status === "queued" ? "queued" : "processing",
        });
      });
      if (finished.status !== "done") throw new Error(finished.error || "转换未完成。");
      updateBatchItem(itemId, {
        status: "complete",
        jobId: finished.id,
        page: finished.total,
        total: finished.total,
        detail: `已完成并存入 Library · ${finished.total} 页`,
        finishedAt: Date.now(),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "转换失败。";
      updateBatchItem(itemId, { status: "error", detail: "处理失败，其余文件继续", error: message, finishedAt: Date.now() });
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
      if (!jobs.length) throw new Error("找不到这个批次，可能已被删除。");
      const toMs = (iso: string | null) => (iso ? new Date(iso).getTime() : undefined);
      const items: BatchItem[] = jobs.map((job) => ({
        id: job.id,
        jobId: job.id,
        name: job.filename,
        size: job.file_size,
        status: job.status === "done" ? "complete" : job.status === "queued" ? "queued" : job.status === "running" ? "processing" : "error",
        page: job.page,
        total: job.total,
        detail: job.status === "done" ? `已完成并存入 Library · ${job.total} 页` : job.status === "failed" ? "处理失败，其余文件继续" : job.detail,
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
        await refreshLibrary();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法打开这个批次。");
      setStatus("error");
    }
  }

  /** 点开统计面板；只在第一次展开时拉数据，避免每次点开都请求一遍。 */
  function toggleStats() {
    setStatsOpen((wasOpen) => {
      const next = !wasOpen;
      if (next && !statsLoaded) {
        void fetchStats()
          .then((loaded) => { setStats(loaded); setStatsLoaded(true); })
          .catch(() => undefined);
      }
      return next;
    });
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

  function openSettings() {
    setSettingsDraft({ ...settings, geminiKey: "", kimiKey: "", qwenKey: "", openrouterKey: "" });
    // 已存的 key 以打码行呈现，明文留在服务端；保存时用 __KEEP__ 占位
    setExtraKeys((settings.geminiKeysExtraMasked ?? []).map((masked) => ({ masked, value: "" })));
    setSettingsStatus("");
    setShowSettings(true);
  }

  function selectProvider(provider: AiProvider) {
    setSettingsDraft((value) => ({ ...value, provider }));
    setRemoteModels(null);
    setSettingsStatus("");
  }

  async function persistSettings() {
    setSettingsBusy(true);
    setSettingsStatus("正在保存…");
    try {
      const saved = await saveAiSettings({
        ...settingsDraft,
        // 已存在且未改动的传占位符（服务端沿用原值），新填的传明文，空行丢弃
        geminiKeysExtra: extraKeys
          .map((k) => (k.value.trim() ? k.value.trim() : k.masked ? "__KEEP__" : ""))
          .filter(Boolean),
      });
      setSettings(saved);
      setSettingsDraft({ ...saved, geminiKey: "", kimiKey: "", qwenKey: "", openrouterKey: "" });
      setSettingsStatus("已保存到本机。密钥不会出现在网页数据或 Library 中。");
    } catch (caught) {
      setSettingsStatus(caught instanceof Error ? caught.message : "设置保存失败。");
    } finally {
      setSettingsBusy(false);
    }
  }

  async function testSettings() {
    setSettingsBusy(true);
    setSettingsStatus("正在连接模型…");
    try {
      const tested = await testAiSettings(settingsDraft);
      setSettingsStatus(`连接成功：${tested.provider} / ${tested.model}`);
    } catch (caught) {
      setSettingsStatus(caught instanceof Error ? caught.message : "连接测试失败。");
    } finally {
      setSettingsBusy(false);
    }
  }

  async function syncModels() {
    setSettingsBusy(true);
    setSettingsStatus("正在从服务商读取可用模型…");
    try {
      const loaded = await fetchAiModels(settingsDraft);
      setRemoteModels(loaded);
      setSettingsStatus(`已同步 ${loaded.models.length} 个支持图片的模型。`);
    } catch (caught) {
      setSettingsStatus(caught instanceof Error ? caught.message : "模型列表同步失败。");
    } finally {
      setSettingsBusy(false);
    }
  }

  async function processFile(selected: File, selectedMode: ConversionMode = mode) {
    if (!isAcceptedFile(selected)) {
      setError("请选择 PDF 或 PPT 文件。");
      setStatus("error");
      return;
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    // PPT 还没转换完，没有 PDF 可预览；等下面转换完了再指到服务端转出的那份。
    setSourceUrl(isPdfFile(selected) ? URL.createObjectURL(selected) : "");
    setActiveFilename(selected.name);
    setMode(selectedMode);
    setScreen("converter");
    setResult(null);
    setError("");
    setProgress({ page: 0, total: 0 });
    setProgressDetail("正在读取 PDF 结构…");
    setStatus("processing");
    setRunStartedAt(Date.now());
    setRunEndedAt(null);
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
        throw new Error(finished.error || "转换未完成。");
      }
      const { result: converted } = await fetchLibraryEntry(finished.id);
      setResult(converted);
      setActiveJobId(finished.id);
      if (!isPdfFile(selected)) {
        // 上面校验通过时不是 PDF 就是 PPT——服务端此刻已经把它转成 PDF 了，
        // 换成服务端那份，「源文件」标签页才有东西可看。
        if (sourceUrl) URL.revokeObjectURL(sourceUrl);
        setSourceUrl(libraryPdfUrl(finished.id));
      }
      setTab(selectedMode === "ai" ? "compare" : "markdown");
      setStatus("complete");
      await refreshLibrary();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "转换失败，请换一个 PDF 再试。";
      setError(message);
      setStatus("error");
      if (message.includes("AI 精校尚未配置")) openSettings();
    }
  }

  function updateBatchItem(id: string, patch: Partial<BatchItem>) {
    setBatchItems((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function processFiles(selectedFiles: File[], selectedMode: ConversionMode = mode) {
    const pdfFiles = selectedFiles.filter(isAcceptedFile);
    if (!pdfFiles.length) {
      setError("请选择 PDF 或 PPT 文件。");
      setStatus("error");
      return;
    }
    if (selectedMode === "ai" && !settings.aiConfigured) {
      setError("AI 精校尚未配置。请先在设置中选择服务商、模型并保存 API Key。");
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
      detail: "等待处理",
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
      label: `${queue.length} 份 · ${new Date().toLocaleString("zh-CN", {
        month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      })}`,
    };
    setBatchId(batch.id);
    setRoute({ name: "batch", id: batch.id });   // 批次页有了地址：刷新后从服务端重建，任务照跑

    // 整批一次性提交给服务端；排队和并发由服务端统一控制，
    // 浏览器只负责显示进度（关掉页面这批也会继续跑完）。
    await Promise.all(
      queue.map(async (item) => {
        try {
          const job = await submitJob(item.file!, selectedMode, batch);
          updateBatchItem(item.id, { jobId: job.id, status: "processing", detail: "已提交，等待服务端处理…", startedAt: Date.now() });
          await trackBatchJob(item.id, job.id);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : "转换失败。";
          updateBatchItem(item.id, { status: "error", detail: "处理失败，其余文件继续", error: message, finishedAt: Date.now() });
        }
      })
    );

    setBatchRunning(false);
    setRunEndedAt(Date.now());   // 计时定格，不再跳
    await refreshLibrary();
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const selected = Array.from(event.dataTransfer.files);
    if (selected.length) addStaged(selected);
  }

  function addStaged(incoming: File[]) {
    const pdfs = incoming.filter(isAcceptedFile);
    if (!pdfs.length) { setError("请选择 PDF 或 PPT 文件。"); setStatus("error"); return; }
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
    download(stored.markdown, `${stored.title}.md`, "text/markdown;charset=utf-8");
  }

  async function downloadBatchMarkdown() {
    const completed = batchItems.filter((item) => item.status === "complete" && item.jobId);
    if (!completed.length) return;
    const parts = await Promise.all(
      completed.map(async (item) => {
        const { result: stored } = await fetchLibraryEntry(item.jobId!);
        return `<!-- 来源文件：${item.name} -->\n\n${stored.markdown}`;
      })
    );
    download(parts.join("\n\n---\n\n"), `墨页批量转换-${new Date().toISOString().slice(0, 10)}.md`, "text/markdown;charset=utf-8");
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
          return `<!-- 来源文件：${record?.filename ?? id} -->\n\n${stored.markdown}`;
        })
      );
      const safeName = filenameHint.replace(/[\\/:*?"<>|]/g, "_");
      download(parts.join("\n\n---\n\n"), `${safeName}-${new Date().toISOString().slice(0, 10)}.md`, "text/markdown;charset=utf-8");
    } catch (caught) {
      setLibraryError(caught instanceof Error ? caught.message : "合并下载失败，请稍后再试。");
    } finally {
      setMergingLibrary(false);
    }
  }

  function renderLibraryCard(record: Job) {
    return (
      <article className="library-card" key={record.id}>
        <label className="library-select" title="选中用于合并下载">
          <input
            type="checkbox"
            checked={selectedLibraryIds.has(record.id)}
            onChange={() => toggleLibrarySelect(record.id)}
            aria-label={`选中 ${record.filename} 用于合并下载`}
          />
        </label>
        <button className="library-open" type="button" onClick={() => openRecord(record)} aria-label={`打开 ${record.filename}`}>
          <span className="library-file-icon">MD<i>PDF</i></span>
          <span className="library-card-body">
            <span className="library-card-meta">{formatDate(new Date(record.updated_at).getTime())}</span>
            <strong>{record.filename}</strong>
            <span className="library-card-preview">{record.preview || "没有可预览的文字"}</span>
            {parseTags(record.tags).length > 0 && (
              <span className="card-tags">{parseTags(record.tags).map((tag) => <i key={tag}>{tag}</i>)}</span>
            )}
          </span>
        </button>
        <div className="library-card-footer">
          <span>{record.page_count} 页</span>
          <span>{formatSize(record.file_size)}</span>
          <span>{record.ai_pages ? `${record.ai_pages} 页 AI 精校` : modeNames[record.mode] || "旧版转换"}</span>
          <span className={record.review_count ? "review-count" : ""}>
            {record.review_count ? `${record.review_count} 页待检查` : "检查通过"}
          </span>
          <a href={exportZipUrl({ ids: [record.id] })} download aria-label={`下载 ${record.filename}`}>下载</a>
          <button type="button" onClick={() => void removeRecord(record)} aria-label={`删除 ${record.filename}`}>删除</button>
        </div>
      </article>
    );
  }

  function openRecord(record: Job) {
    setCameFrom("library");
    navigate({ name: "doc", id: record.id });   // 结果和原始 PDF 都由 loadDoc 从服务端取
  }

  async function removeRecord(record: Job) {
    if (!window.confirm(`从本机资料库删除“${record.filename}”？此操作无法撤销。`)) return;
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
      setLibraryError(caught instanceof Error ? caught.message : "删除失败。请稍后再试。");
    }
  }

  async function copyMarkdown() {
    if (!result) return;
    await navigator.clipboard.writeText(result.markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function rerunAiRefinement() {
    if (!activeJobId || !result) return;
    setMode("ai");
    setStatus("processing");
    setError("");
    setRefineWarning("");
    setProgress({ page: 0, total: result.pageCount });
    setProgressDetail("正在复用 Library 中的本地初稿…");
    try {
      // 现在是原地重跑同一条记录：job.id 就是 activeJobId 本身，不再是新 id
      const job = await refineLibraryEntry(activeJobId);
      const finished = await waitForJob(job.id, (live) => {
        setProgress({ page: live.page, total: live.total });
        if (live.detail) setProgressDetail(live.detail);
      });
      if (finished.status !== "done") throw new Error(finished.error || "AI 精校未完成。");
      const { result: refined } = await fetchLibraryEntry(finished.id);
      setResult(refined);
      setActiveJobId(finished.id);
      setTab("compare");
      setStatus("complete");
      // 精校失败时服务端会原样保留旧结果（status 仍是 done），但把原因记在 error 字段——
      // 不能因为"文档还在、没报错屏"就当作真的成功了，得让用户知道这次其实没变化
      setRefineWarning(finished.error || "");
      await refreshLibrary();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "AI 精校失败。";
      setError(message);
      setStatus("error");
      if (message.includes("AI 精校尚未配置")) openSettings();
    }
  }

  return (
    <main className={`app-shell ${status !== "idle" || screen === "library" ? "workspace-open" : ""}`}>
      <nav className="topbar" aria-label="主导航">
        <button className="brand brand-button" type="button" onClick={reset} aria-label="回到首页" disabled={batchRunning}>
          <span className="brand-mark">墨</span><span>墨页</span><span className="brand-subtitle">PDF/PPT 转 Markdown</span>
        </button>
        <div className="top-actions">
          {activeJobs.length > 0 && (
            // 进行中的任务在哪个界面都看得见，不只是首页
            <button className="library-nav running-nav" type="button" title="查看进度" onClick={() => { const j = activeJobs[0]; navigate(j.batch_id ? { name: "batch", id: j.batch_id } : { name: "doc", id: j.id }); }}>
              <i />进行中 <b>{activeJobs.length}</b>
            </button>
          )}
          <button className={`library-nav ${screen === "library" ? "active" : ""}`} type="button" onClick={showLibrary} disabled={batchRunning}>Library <b>{library.length}</b></button>
          <button className="settings-button" type="button" onClick={openSettings}>⚙ 设置</button>
          {status !== "idle" && !batchRunning && <button className="quiet-button" type="button" onClick={reset}>＋ 新转换</button>}
          {/* 这颗标签必须说实话：本地模式的正文不上传，但打标签会把开头一小段发给模型——以前这里一律写"文件不上传" */}
          {aiWasUsed ? (
            <span className="privacy-pill cloud"><i />AI 精校 · 页面图像会发送给所选模型</span>
          ) : settings.autoTag !== false && settings.aiConfigured ? (
            <button type="button" className="privacy-pill tag" title="转换正文全程在本机；完成后会把文档开头约 3000 字发给当前服务商生成主题标签。点此可在设置里关闭。" onClick={openSettings}><i />本地转换 · 仅摘要用于 AI 打标签</button>
          ) : (
            <span className="privacy-pill"><i />本地处理 · 文件不上传</span>
          )}
        </div>
      </nav>

      {screen === "library" ? (
        <section className="library-view">
          <header className="library-header">
            <div><div className="eyebrow">LOCAL DOCUMENT LIBRARY</div><h1>你的分析资料库</h1><p>PDF、Markdown、原始初稿与逐页质量记录都保留在这台设备。</p></div>
            <button className="primary-button" type="button" onClick={reset}>＋ 新转换</button>
          </header>
          <div className="library-toolbar">
            <label><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名或标签…" aria-label="搜索资料库" /></label>
            <div><strong>{library.length}</strong> 份文件 · <strong>{library.reduce((sum, item) => sum + item.page_count, 0)}</strong> 页</div>
            {library.length > 0 && (
              // 直接用 <a download>：整包由服务端生成并流式下载，不经过 JS 内存
              <a className="secondary-button" href={exportZipUrl()} download>⭳ 全部打包下载</a>
            )}
          </div>
          {selectedLibraryIds.size > 0 && (
            <div className="library-selection-bar">
              <span>已选 {selectedLibraryIds.size} 份</span>
              <div>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={mergingLibrary}
                  onClick={() => void downloadMergedMarkdown([...selectedLibraryIds], "墨页合并")}
                >
                  {mergingLibrary ? "合并中…" : "⭳ 下载合并 .md"}
                </button>
                <button className="quiet-button" type="button" onClick={() => setSelectedLibraryIds(new Set())}>清除选择</button>
              </div>
            </div>
          )}
          {libraryError && <div className="library-notice" role="status">{libraryError}</div>}
          {libraryLoading ? (
            <div className="library-empty"><span className="library-empty-mark">墨</span><h2>正在读取资料库…</h2></div>
          ) : filteredLibrary.length ? (
            <>
              {libraryTimeline.map((row) => (
                <section className="library-batch" key={row.key}>
                  {row.batch && (
                    <div className="library-batch-head">
                      <div>
                        <strong>{row.batch.label || "批量转换"}</strong>
                        <span>{row.batch.total} 份 · {row.batch.pages} 页{row.batch.failed ? ` · ${row.batch.failed} 份失败` : ""}{row.batch.active ? ` · ${row.batch.active} 份进行中` : ""}</span>
                      </div>
                      <div className="library-batch-actions">
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={mergingLibrary}
                          onClick={() => void downloadMergedMarkdown(row.items.map((item) => item.id), row.batch!.label || "墨页合集")}
                        >
                          {mergingLibrary ? "合并中…" : "⭳ 下载合并 .md"}
                        </button>
                        <a className="secondary-button" href={exportZipUrl({ batchId: row.batch.id })} download>⭳ 下载这个合集</a>
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
            <div className="library-empty"><span className="library-empty-mark">墨</span><h2>{query ? "没有匹配的文件" : "资料库还是空的"}</h2><p>{query ? "换个关键词试试。" : "完成第一次转换后，文件会自动出现在这里。"}</p>{!query && <button className="primary-button" type="button" onClick={reset}>开始第一次转换</button>}</div>
          )}
        </section>
      ) : status === "idle" ? (
        <>
          {/* 首页是工作台不是落地页：每天用的人不需要每天看一遍大标题和产品卖点 */}
          <section className="home-head">
            <h1>PDF/PPT 转 Markdown</h1>
            <p>拖进来、选模式、开始。转换在本机服务里排队执行，关掉页面也会继续。</p>
          </section>
          <section className="converter-card" aria-label="PDF/PPT 转换器">
            <button className={`dropzone ${dragging ? "is-dragging" : ""}`} type="button" onClick={() => inputRef.current?.click()} onDragEnter={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              <span className="paper-icon"><b>PDF</b><i /></span><strong>拖放一个或多个 PDF / PPT</strong><span>或点击批量选择文件</span>
              <small>{mode === "ai" ? "AI 模式会把页面图像发送给你配置的模型" : "当前模式全程在本机处理"}</small>
            </button>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf,.ppt,.pptx" multiple hidden onChange={(event) => { const selected = Array.from(event.target.files || []); if (selected.length) addStaged(selected); event.target.value = ""; }} />
            <div className="profile-row" aria-label="转换模式">
              <div><span className="field-label">转换模式</span><strong>{modeNames[mode]}</strong><small>{modeDescriptions[mode]}</small></div>
              <div className="profile-options">
                {visibleModes.map((item) => (
                  <button key={item} type="button" className={mode === item ? "active" : ""} onClick={() => { setMode(item); if (item === "ai" && !settings.aiConfigured) openSettings(); }}>
                    {modeNames[item]}<small>{modeMeta[item]}</small>
                  </button>
                ))}
              </div>
            </div>
            {mode === "ai" && settings.aiConfigured && (
              // 精校范围直接影响这次转换花多少钱、多少页过模型，放在模式旁边而不是藏在设置最底下
              <div className="scope-inline" role="group" aria-label="精校范围">
                <span>精校范围</span>
                {([["all", "全部页面 · 质量最佳"], ["review", "只精校公式、选项与可疑页 · 更省"]] as const).map(([value, label]) => (
                  <label key={value} className={settings.aiScope === value ? "on" : ""}>
                    <input type="radio" name="scope-inline" checked={settings.aiScope === value} onChange={() => {
                      void saveAiSettings({ ...settings, aiScope: value, geminiKey: "", kimiKey: "", qwenKey: "", openrouterKey: "" }).then(setSettings).catch(() => undefined);
                    }} />
                    {label}
                  </label>
                ))}
                <span className="scope-inline-meta">{settings.activeChannels?.length ? `通过 ${settings.activeChannels.map((p) => providerNames[p]).join(" + ")}` : ""}</span>
              </div>
            )}
            {activeJobs.length > 0 && (
              <div className="active-panel" aria-label="正在进行的任务">
                <div className="staged-head">
                  <strong>服务端进行中 · {activeJobs.length}</strong>
                  <span className="staged-size">关掉页面也会继续跑</span>
                </div>
                <ul className="staged-list">
                  {activeJobs.map((j) => (
                    <li key={j.id}>
                      <button type="button" className="staged-link" onClick={() => navigate(j.batch_id ? { name: "batch", id: j.batch_id } : { name: "doc", id: j.id })} title="查看进度">{j.filename}</button>
                      <span className="staged-size">
                        {j.status === "queued" ? "排队中" : j.total ? `${j.page}/${j.total} 页` : "处理中"}
                        {" · ⏱ "}{formatElapsed(now - new Date(j.created_at).getTime())}
                      </span>
                      <button type="button" onClick={() => void cancelJob(j.id)}>取消</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {staged.length > 0 && (
              <div className="staged-panel" aria-label="待转换文件">
                <div className="staged-head">
                  <strong>已选 {staged.length} 份，待转换</strong>
                  <button type="button" onClick={() => setStaged([])}>清空</button>
                </div>
                <ul className="staged-list">
                  {staged.map((f) => (
                    <li key={`${f.name}:${f.size}:${f.lastModified}`}>
                      <span>{f.name}</span>
                      <span className="staged-size">{formatSize(f.size)}</span>
                      <button type="button" aria-label={`移除 ${f.name}`} onClick={() => setStaged((prev) => prev.filter((x) => x !== f))}>移除</button>
                    </li>
                  ))}
                </ul>
                <button
                  className="primary-button staged-start"
                  type="button"
                  onClick={() => { const files = staged; setStaged([]); void processFiles(files); }}
                >
                  开始转换 · {modeNames[mode]}
                </button>
              </div>
            )}
          </section>
          {library.length > 0 && (
            // 最近转换直接摆在首页：以前要点进 Library 才能找到几分钟前刚转完的那份
            <section className="recent" aria-label="最近转换">
              <div className="recent-head">
                <strong>最近转换</strong>
                <button type="button" className="quiet-button" onClick={showLibrary}>全部 {library.length} 份 →</button>
              </div>
              <ul className="recent-list">
                {library.slice(0, 5).map((record) => (
                  <li key={record.id}>
                    <button type="button" className="recent-item" onClick={() => openRecord(record)}>
                      <span className="recent-name">{record.filename}</span>
                      <span className="recent-meta">
                        {record.page_count} 页 · {record.ai_pages ? "AI 精校" : modeNames[record.mode] || "旧版"} · {formatDate(new Date(record.updated_at).getTime())}
                        {record.review_count ? <em> · {record.review_count} 页待检查</em> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : status === "batch" ? (
        <section className="batch-view" aria-live="polite">
          <header className="batch-header">
            <div>
              <div className="eyebrow">{batchRunning ? "BATCH CONVERSION IN PROGRESS" : "BATCH CONVERSION COMPLETE"}</div>
              <h1>{batchRunning ? "正在批量转换" : "批量处理完成"}</h1>
              <p>{batchItems.length} 份 PDF · {modeNames[mode]} · 已处理 {batchFinished} / {batchItems.length}</p>
            </div>
            <div className="batch-actions">
              {!batchRunning && batchCompleted > 0 && <button className="secondary-button" type="button" onClick={downloadBatchMarkdown}>下载合并 .md</button>}
              {!batchRunning && <button className="primary-button" type="button" onClick={reset}>＋ 新批次</button>}
            </div>
          </header>
          <div className="run-timer" aria-live="off">
            <div className="run-timer-clock">
              <span className="run-timer-label">{batchRunning ? "已用时" : "总用时"}</span>
              <strong>{formatElapsed(runElapsed)}</strong>
            </div>
            <div className="run-timer-pages">
              <div>
                <strong>{batchDonePages}<em> / {batchPagesUnknown && !batchTotalPages ? "?" : batchTotalPages}</em></strong>
                <span>页{batchPagesUnknown && batchTotalPages ? "（部分未读出）" : ""}</span>
              </div>
              <div>
                <strong>{pagesPerMin ? pagesPerMin.toFixed(0) : "—"}</strong>
                <span>页/分钟</span>
              </div>
              <div>
                <strong>{batchItems.length}</strong>
                <span>份文件</span>
              </div>
            </div>
          </div>
          <div className="batch-summary">
            <div><strong>{batchPercent}%</strong><span>总体进度</span></div>
            <div><strong>{batchCompleted}</strong><span>转换成功</span></div>
            <div className={batchFailed ? "needs-review" : ""}><strong>{batchFailed}</strong><span>处理失败</span></div>
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
                    <p>{item.error || item.detail}{item.status === "processing" && item.total ? ` · ${Math.floor(item.page)} / ${item.total} 页` : ""}</p>
                    <div className="batch-item-track"><i style={{ width: `${itemPercent}%` }} /></div>
                  </div>
                  <div className="batch-item-status">
                    <span>{item.status === "queued" ? "等待中" : item.status === "processing" ? `${itemPercent}%` : item.status === "complete" ? "已完成" : "失败"}</span>
                    {item.status === "complete" && item.jobId && (
                      <div>
                        <button type="button" onClick={() => void openBatchResult(item)}>查看</button>
                        <button type="button" onClick={() => void downloadBatchItem(item)}>下载</button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="batch-footnote">可以关掉页面，队列在本机服务里继续跑，回来时从这个地址就能接着看。单个文件失败不会中断后续文件；成功结果已自动存入 Library。</p>
        </section>
      ) : status === "processing" ? (
        <section className="processing-view" aria-live="polite">
          <div className="processing-orbit"><span>{percent}%</span><i /></div><div className="eyebrow">{mode === "ai" ? "视觉模型识别中" : "正在本机转换"}</div>
          <h1>{activeFilename}</h1><p>{progressDetail}</p>
          <div className="run-timer solo">
            <div className="run-timer-clock">
              <span className="run-timer-label">已用时</span>
              <strong>{formatElapsed(runElapsed)}</strong>
            </div>
            <div className="run-timer-pages">
              <div><strong>{Math.floor(progress.page)}<em> / {progress.total || "?"}</em></strong><span>页</span></div>
              <div>
                <strong>{runElapsed > 3000 && progress.page ? (progress.page / (runElapsed / 60000)).toFixed(0) : "—"}</strong>
                <span>页/分钟</span>
              </div>
            </div>
          </div>
          <div className="progress-track"><i style={{ width: `${percent}%` }} /></div>
          <small>{mode === "ai" ? "页面图像会发送给你在设置中选择的模型；识别失败的页面回退 PDF 文字层。" : "转换在本机服务里进行，关掉页面也会继续。"}</small>
        </section>
      ) : status === "error" ? (
        <section className="error-card"><span>转换未完成</span><h1>{
          /PPT/.test(error) ? "PPT 没能转成 PDF"
            : /AI 精校/.test(error) ? "AI 精校还没配置好"
            : /页数/.test(error) ? "PDF 和记录对不上"
            : /不存在|找不到|已被/.test(error) ? "找不到这条记录"
            : "这个文件暂时没能处理"
        }</h1><p>{error}</p><div className="error-actions">{error.includes("AI 精校") && <button className="secondary-button" type="button" onClick={openSettings}>打开设置</button>}<button className="primary-button" type="button" onClick={reset}>换一个文件</button></div></section>
      ) : result ? (
        <section className="result-workspace">
          <header className="result-header">
            <div><span className="success-kicker"><i />转换完成 · 已存入 Library</span><h1>{activeFilename}</h1><p>{result.pageCount} 页 · {modeNames[result.mode] || "旧版转换"} · {(result.durationMs / 1000).toFixed(1)} 秒</p></div>
            <div className="result-actions">
              {cameFrom === "library" ? (
                <button type="button" className="secondary-button" onClick={() => { setCameFrom(null); showLibrary(); }}>← 返回 Library</button>
              ) : (cameFrom === "batch" || batchItems.length > 1) && batchId ? (
                <button type="button" className="secondary-button" onClick={() => { setCameFrom(null); navigate({ name: "batch", id: batchId }); }}>← 返回批次</button>
              ) : (
                <button type="button" className="secondary-button" onClick={reset}>← 返回首页</button>
              )}
              {!batchRunning && <button type="button" className="secondary-button" onClick={() => void rerunAiRefinement()}>{result.mode === "ai" ? "重新 AI 精校" : "用 AI 精校这份"}</button>}
              <button type="button" className="secondary-button" onClick={copyMarkdown}>{copied ? "已复制" : "复制 Markdown"}</button>
              <button type="button" className="primary-button" onClick={() => download(result.markdown, `${result.title}.md`, "text/markdown;charset=utf-8")}>下载 .md</button>
            </div>
          </header>
          {refineWarning && (
            <div className="result-notice" role="status">
              ⚠ 重新精校失败，已保留原结果：{refineWarning}
            </div>
          )}
          <div className="score-strip">
            <div><strong>{result.pageCount - reviewPages.length}</strong><span>通过校验</span></div>
            <div className={reviewPages.length ? "needs-review" : ""}><strong>{reviewPages.length}</strong><span>建议检查</span></div>
            <div><strong>{result.pages.reduce((sum, page) => sum + (page.formulaCount ?? 0), 0)}</strong><span>LaTeX 公式</span></div>
            <button type="button" onClick={() => download(JSON.stringify(result, null, 2), `${result.title}-report.json`, "application/json")}>导出完整报告 ↗</button>
          </div>
          <div className="result-tabs" role="tablist">
            <button className={tab === "markdown" ? "active" : ""} onClick={() => setTab("markdown")} role="tab">Markdown</button>
            <button className={tab === "quality" ? "active" : ""} onClick={() => setTab("quality")} role="tab">逐页质量 <b>{reviewPages.length}</b></button>
            <button className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")} role="tab">AI 前后对照 <b>{comparedPages.length}</b></button>
            <button className={tab === "source" ? "active" : ""} onClick={() => setTab("source")} role="tab">原始 PDF</button>
          </div>
          <div className="result-panel">
            {tab === "markdown" && (
              <div className="markdown-pane">
                <div className="md-toolbar" role="group" aria-label="查看方式">
                  <button type="button" className={mdView === "rendered" ? "active" : ""} onClick={() => setMdView("rendered")}>渲染</button>
                  <button type="button" className={mdView === "raw" ? "active" : ""} onClick={() => setMdView("raw")}>源码</button>
                </div>
                {mdView === "rendered"
                  ? <div className="markdown-rendered" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
                  : <pre className="markdown-preview">{result.markdown}</pre>}
              </div>
            )}
            {tab === "quality" && <div className="quality-list">{result.pages.map((page) => (
              <article key={page.page} className={page.status === "good" ? "good-page" : ""}><span>第 {page.page} 页</span><div><strong>{methodLabel(page)}</strong>{page.reasons.length ? page.reasons.map((reason) => <p key={reason}>{reason}</p>) : <p>程序校验通过</p>}<p>{page.formulaCount ?? 0} 个公式 · {page.optionCount ?? 0} 个选项标签</p></div><small>{page.charCount} 字符</small></article>
            ))}</div>}
            {tab === "compare" && (comparedPages.length ? <div className="compare-list">{comparedPages.map((page) => (
              <article key={page.page}><header><strong>第 {page.page} 页</strong><span className={`method-badge ${page.method === "ai" ? "accepted" : "fallback"}`}>{page.method === "ai" ? `采用 ${page.model}` : mode === "ai" ? "AI 未通过 · 回退文字层" : "回退本地初稿"}</span></header><div className="compare-columns"><section><h3>最终 Markdown</h3><pre>{page.markdown}</pre></section><section><h3>{mode === "ai" ? "PDF 文字层（提示/回退）" : "Surya 本地初稿"}</h3><pre>{page.rawMarkdown}</pre></section></div></article>
            ))}</div> : <div className="all-clear"><span>↔</span><h2>这次没有 AI 对照记录</h2><p>使用“重新 AI 精校”后，这里会保留最终结果与本地初稿。</p></div>)}
            {tab === "source" && sourceUrl && <iframe className="pdf-preview" src={sourceUrl} title="原始 PDF 预览" />}
          </div>
        </section>
      ) : null}

      <footer><span>墨页 · Verifiable document tools</span><span>{aiWasUsed ? "本地初稿 · 可选云端精校 · 逐页留痕" : "当前处理仅在你的设备完成"}</span></footer>

      {/* 统计悬浮球只在首页和 Library 出现：在结果页它会盖住面板左下角 */}
      {((status === "idle" && screen === "converter") || screen === "library") && <div className="stats-fab">
        {statsOpen && (
          <div className="stats-panel" role="dialog" aria-label="你的墨页数据">
            <div className="stats-head">你的墨页数据</div>
            <div className="stats-nums">
              <div className="stat-num"><b>{stats ? stats.totals.pages : "—"}</b><span>页已转换</span></div>
              <div className="stat-num"><b>{stats ? fmtBig(stats.totals.chars) : "—"}</b><span>字</span></div>
              <div className="stat-num"><b>{stats ? stats.totals.transcripts : "—"}</b><span>份文档</span></div>
            </div>
            <div className="stats-block">
              <div className="stats-label">累计页数</div>
              {stats ? sparkline(cumPages) : <div className="spark-empty">正在读取…</div>}
            </div>
            <div className="stats-block">
              <div className="stats-label-row">
                <span className="stats-label">关注领域</span>
                <button type="button" className="stats-lang" disabled={backfillState?.running} onClick={() => void runBackfill()}>
                  {backfillState?.running ? `补标签中 ${backfillState.done}/${backfillState.total}` : "补标签"}
                </button>
              </div>
              {stats?.topTags.length ? (
                <div>
                  {stats.topTags.map((t) => (
                    <div className="stat-tag" key={t.tag}>
                      <span className="stat-tag-name" title={t.tag}>{t.tag}</span>
                      <span className="stat-tag-bar"><i style={{ width: `${Math.max(6, (t.count / stats.topTags[0].count) * 100)}%` }} /></span>
                      <span className="stat-tag-num">{t.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="spark-empty">还没有标签 —— 点右上角&ldquo;补标签&rdquo;生成</div>
              )}
            </div>
          </div>
        )}
        <button type="button" className="stats-toggle" onClick={toggleStats} aria-expanded={statsOpen}>
          <span className="stats-dot" />我的统计
        </button>
      </div>}

      {showSettings && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header><div><span className="eyebrow">MODEL SETTINGS</span><h2 id="settings-title">AI 精校设置</h2></div><button type="button" onClick={() => setShowSettings(false)} aria-label="关闭设置">×</button></header>
            <div className="settings-warning"><strong>隐私说明</strong><p>AI 模式下，页面的 JPEG 图像和 PDF 文字层提示会发送给你选择的模型服务。API Key 仅保存在本项目的本机 <code>settings.local.json</code>，不会写入 Library 或浏览器页面数据。</p></div>
            <div className="settings-provider" role="group" aria-label="模型服务商">
              <button type="button" className={settingsDraft.provider === "gemini" ? "active" : ""} onClick={() => selectProvider("gemini")}>Google Gemini</button>
              <button type="button" className={settingsDraft.provider === "kimi" ? "active" : ""} onClick={() => selectProvider("kimi")}>Kimi</button>
              <button type="button" className={settingsDraft.provider === "qwen" ? "active" : ""} onClick={() => selectProvider("qwen")}>Qwen 百炼</button>
              <button type="button" className={settingsDraft.provider === "openrouter" ? "active" : ""} onClick={() => selectProvider("openrouter")}>OpenRouter</button>
            </div>
            <div className="multichannel">
              <label className="multichannel-main" aria-label="多渠道并行">
                <input
                  type="checkbox"
                  checked={Boolean(settingsDraft.multiChannel)}
                  onChange={(event) => setSettingsDraft((value) => ({ ...value, multiChannel: event.target.checked }))}
                />
                <span>
                  <strong>多渠道并行</strong>
                  <small>
                    {settingsDraft.multiChannel
                      ? "页面按并发能力分给下面勾选的渠道。上面选的服务商只决定「测试连接」测哪一家。"
                      : `关闭时只用上面选中的 ${providerNames[settingsDraft.provider]} 一家。不同渠道打的是不同上游，配额互不占用。`}
                  </small>
                </span>
              </label>
              {settingsDraft.multiChannel && (
                <>
                  <div className="channel-picks">
                    {configuredProviders.length === 0 && <span className="channel-empty">还没有配置任何 API Key</span>}
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
                          <i>{settings.channelWeights?.[p] ?? "?"} 路</i>
                        </label>
                      );
                    })}
                  </div>
                  <div className="channel-total">
                    合计并发{" "}
                    <b>
                      {configuredProviders
                        .filter((p) => !settingsDraft.channels?.length || settingsDraft.channels.includes(p))
                        .reduce((sum, p) => sum + (settings.channelWeights?.[p] ?? 0), 0)}
                    </b>{" "}
                    路 · 实测 84 路可靠，再往上会有请求挂死
                  </div>
                </>
              )}
            </div>
            {settingsDraft.provider === "gemini" ? (
              <div className="settings-fields">
                <label><span>Gemini API Key</span><input type="password" value={settingsDraft.geminiKey || ""} onChange={(event) => setSettingsDraft((value) => ({ ...value, geminiKey: event.target.value }))} placeholder={settingsDraft.geminiKeyMasked || "AIza…"} /><small>{settingsDraft.geminiConfigured ? `已配置 ${settingsDraft.geminiKeyMasked}；留空则保留原值` : "尚未配置"}</small></label>
                <div className="keypool">
                  <div className="keypool-head">
                    <div>
                      <span className="keypool-title">并行密钥</span>
                      <small>实测：同一 Google <b>账号</b>下的 Key（哪怕分属不同项目）共用同一份吞吐，加了不会更快；<b>换一个 Google 账号</b>的 Key 才是独立配额——实测两个账号并行提速 <b>3.3 倍</b>。</small>
                    </div>
                    <span className="keypool-badge" title="并发 = 6 × 独立项目数">
                      <b>{extraKeys.filter((k) => k.masked || k.value.trim()).length + 1}</b> 把 Key · 并发 {6 * Math.max(1, Math.min(settingsDraft.geminiProjects || 1, extraKeys.filter((k) => k.masked || k.value.trim()).length + 1))}
                    </span>
                  </div>
                  <ol className="keypool-list">
                    <li className="keypool-row is-primary">
                      <span className="keypool-index">1</span>
                      <code>{settingsDraft.geminiKeyMasked || "上方主 Key"}</code>
                      <span className="keypool-tag">主</span>
                    </li>
                    {extraKeys.map((key, i) => (
                      <li className="keypool-row" key={i}>
                        <span className="keypool-index">{i + 2}</span>
                        {key.masked && !key.value ? (
                          <>
                            <code>{key.masked}</code>
                            <span className="keypool-tag">已保存</span>
                          </>
                        ) : (
                          <input
                            type="password"
                            value={key.value}
                            spellCheck={false}
                            placeholder={key.masked ? "留空则保留原值" : "AIza… （另一个 Google 账号的 Key）"}
                            onChange={(event) => updateExtraKey(i, event.target.value)}
                          />
                        )}
                        <button type="button" className="keypool-remove" aria-label={`移除第 ${i + 2} 把 Key`} onClick={() => removeExtraKey(i)}>✕</button>
                      </li>
                    ))}
                  </ol>
                  <div className="keypool-foot">
                    <button type="button" className="keypool-add" onClick={addExtraKey}>＋ 添加一把 Key</button>
                    <label className="keypool-projects">
                      <span>其中来自几个独立账号</span>
                      <input type="number" min={1} max={20} value={settingsDraft.geminiProjects || 1}
                        onChange={(event) => setSettingsDraft((v) => ({ ...v, geminiProjects: Math.max(1, Number(event.target.value) || 1) }))} />
                    </label>
                  </div>
                </div>
                <label htmlFor="gemini-model"><span>主模型</span><ModelPicker id="gemini-model" provider="gemini" value={settingsDraft.geminiModel} extra={remoteModels?.provider === "gemini" ? remoteModels.models : []} onChange={(geminiModel) => setSettingsDraft((value) => ({ ...value, geminiModel }))} /></label>
                <label><span>失败回退模型</span><input value={settingsDraft.geminiFallbackModel} onChange={(event) => setSettingsDraft((value) => ({ ...value, geminiFallbackModel: event.target.value }))} /></label>
                <label className="wide"><span>API Base URL</span><input value={settingsDraft.geminiBaseUrl} onChange={(event) => setSettingsDraft((value) => ({ ...value, geminiBaseUrl: event.target.value }))} /></label>
              </div>
            ) : settingsDraft.provider === "kimi" ? (
              <div className="settings-fields">
                <label><span>Moonshot API Key</span><input type="password" value={settingsDraft.kimiKey || ""} onChange={(event) => setSettingsDraft((value) => ({ ...value, kimiKey: event.target.value }))} placeholder={settingsDraft.kimiKeyMasked || "sk-…"} /><small>{settingsDraft.kimiConfigured ? `已配置 ${settingsDraft.kimiKeyMasked}；留空则保留原值` : "在 Kimi 开放平台创建 API Key"}</small></label>
                <label className="wide" htmlFor="kimi-model"><span>Kimi 视觉模型</span><ModelPicker id="kimi-model" provider="kimi" value={settingsDraft.kimiModel} extra={remoteModels?.provider === "kimi" ? remoteModels.models : []} onChange={(kimiModel) => setSettingsDraft((value) => ({ ...value, kimiModel }))} /></label>
                <label className="wide"><span>API Base URL</span><input value={settingsDraft.kimiBaseUrl} onChange={(event) => setSettingsDraft((value) => ({ ...value, kimiBaseUrl: event.target.value }))} /></label>
              </div>
            ) : settingsDraft.provider === "qwen" ? (
              <div className="settings-fields">
                <label><span>阿里云百炼 API Key</span><input type="password" value={settingsDraft.qwenKey || ""} onChange={(event) => setSettingsDraft((value) => ({ ...value, qwenKey: event.target.value }))} placeholder={settingsDraft.qwenKeyMasked || "sk-…"} /><small>{settingsDraft.qwenConfigured ? `已配置 ${settingsDraft.qwenKeyMasked}；留空则保留原值` : "Key 与调用地域必须一致"}</small></label>
                <label className="wide" htmlFor="qwen-model"><span>Qwen 视觉 / OCR 模型</span><ModelPicker id="qwen-model" provider="qwen" value={settingsDraft.qwenModel} extra={remoteModels?.provider === "qwen" ? remoteModels.models : []} onChange={(qwenModel) => setSettingsDraft((value) => ({ ...value, qwenModel }))} /></label>
                <label className="wide"><span>API Base URL</span><input value={settingsDraft.qwenBaseUrl} onChange={(event) => setSettingsDraft((value) => ({ ...value, qwenBaseUrl: event.target.value }))} /><small>默认使用北京公共兼容地址；也可替换成百炼业务空间专属 compatible-mode/v1 地址。</small></label>
              </div>
            ) : (
              <div className="settings-fields">
                <label><span>OpenRouter API Key</span><input type="password" value={settingsDraft.openrouterKey || ""} onChange={(event) => setSettingsDraft((value) => ({ ...value, openrouterKey: event.target.value }))} placeholder={settingsDraft.openrouterKeyMasked || "sk-or-…"} /><small>{settingsDraft.openrouterConfigured ? `已配置 ${settingsDraft.openrouterKeyMasked}；留空则保留原值` : "尚未配置"}</small></label>
                <label className="wide" htmlFor="openrouter-model"><span>视觉模型</span><ModelPicker id="openrouter-model" provider="openrouter" value={settingsDraft.openrouterModel} extra={remoteModels?.provider === "openrouter" ? remoteModels.models : []} onChange={(openrouterModel) => setSettingsDraft((value) => ({ ...value, openrouterModel }))} /></label>
                <label className="wide"><span>API Base URL</span><input value={settingsDraft.openrouterBaseUrl} onChange={(event) => setSettingsDraft((value) => ({ ...value, openrouterBaseUrl: event.target.value }))} /></label>
              </div>
            )}
            <div className="model-sync-row"><button type="button" className="secondary-button" disabled={settingsBusy} onClick={() => void syncModels()}>↻ 从服务商同步模型</button><span>需要先填写 API Key；只显示可用于图片输入的模型。</span></div>
            <fieldset className="scope-field"><legend>精校范围</legend><label><input type="radio" checked={settingsDraft.aiScope === "all"} onChange={() => setSettingsDraft((value) => ({ ...value, aiScope: "all" }))} />全部页面（质量最佳）</label><label><input type="radio" checked={settingsDraft.aiScope === "review"} onChange={() => setSettingsDraft((value) => ({ ...value, aiScope: "review" }))} />只精校公式、选项与可疑页面（更省费用）</label></fieldset>
            <fieldset className="scope-field">
              <legend>自动打标签</legend>
              <label>
                <input type="checkbox" checked={settingsDraft.autoTag !== false} onChange={(event) => setSettingsDraft((value) => ({ ...value, autoTag: event.target.checked }))} />
                转换完成后用当前服务商给文档打 2–4 个主题标签（会把文档开头约 3000 字发出去，本地模式也一样）
              </label>
            </fieldset>
            {settingsStatus && <div className="settings-status" role="status">{settingsStatus}</div>}
            <footer><button type="button" className="secondary-button" disabled={settingsBusy} onClick={() => void testSettings()}>测试连接</button><div><button type="button" className="quiet-button" onClick={() => setShowSettings(false)}>取消</button><button type="button" className="primary-button" disabled={settingsBusy} onClick={() => void persistSettings()}>保存设置</button></div></footer>
          </section>
        </div>
      )}
    </main>
  );
}
