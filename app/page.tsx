"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { defaultAiSettings, fetchAiModels, getAiSettings, saveAiSettings, testAiSettings, type AiModelOption, type AiProvider, type AiSettings } from "../lib/ai-settings";
import { convertPdf, refineExistingPdf, type ConversionMode, type ConversionResult, type PageResult } from "../lib/pdf-to-markdown";
import { deleteFromLibrary, listLibrary, saveToLibrary, type LibraryRecord } from "../lib/library";

type Status = "idle" | "processing" | "batch" | "complete" | "error";
type Screen = "converter" | "library";
type ResultTab = "markdown" | "quality" | "compare" | "source";
type BatchItemStatus = "queued" | "processing" | "complete" | "error";
type BatchItem = {
  id: string;
  file: File;
  status: BatchItemStatus;
  page: number;
  total: number;
  detail: string;
  result?: ConversionResult;
  error?: string;
};

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
  ai: "本地初稿后发送选定页面图像给视觉模型精校，公式效果最好。",
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
  openrouter: [
    { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
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

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(timestamp);
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

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<ConversionMode>("balanced");
  const [status, setStatus] = useState<Status>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [progress, setProgress] = useState({ page: 0, total: 0 });
  const [progressDetail, setProgressDetail] = useState("正在读取 PDF 结构…");
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<ResultTab>("markdown");
  const [copied, setCopied] = useState(false);
  const [screen, setScreen] = useState<Screen>("converter");
  const [library, setLibrary] = useState<LibraryRecord[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [query, setQuery] = useState("");
  const [activeFilename, setActiveFilename] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AiSettings>(defaultAiSettings);
  const [settingsDraft, setSettingsDraft] = useState<AiSettings>(defaultAiSettings);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [remoteModels, setRemoteModels] = useState<{ provider: AiProvider; models: AiModelOption[] } | null>(null);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);

  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);
  useEffect(() => {
    void refreshLibrary();
    void getAiSettings().then((loaded) => {
      setSettings(loaded);
      setSettingsDraft({ ...loaded, geminiKey: "", kimiKey: "", qwenKey: "", openrouterKey: "" });
    }).catch(() => undefined);
  }, []);

  const reviewPages = useMemo(() => result?.pages.filter((page) => page.status === "review") ?? [], [result]);
  const comparedPages = useMemo(() => result?.pages.filter((page) => page.rawMarkdown !== undefined) ?? [], [result]);
  const aiWasUsed = mode === "ai" || result?.pages.some((page) => page.method === "ai" || page.aiAttempted);
  const percent = progress.total ? Math.round((progress.page / progress.total) * 100) : 0;
  const filteredLibrary = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? library.filter((item) => item.filename.toLocaleLowerCase().includes(normalized)) : library;
  }, [library, query]);
  const batchCompleted = batchItems.filter((item) => item.status === "complete").length;
  const batchFailed = batchItems.filter((item) => item.status === "error").length;
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
      setLibrary(await listLibrary());
      setLibraryError("");
    } catch (caught) {
      setLibraryError(caught instanceof Error ? caught.message : "资料库读取失败。");
    } finally {
      setLibraryLoading(false);
    }
  }

  function openSettings() {
    setSettingsDraft({ ...settings, geminiKey: "", kimiKey: "", qwenKey: "", openrouterKey: "" });
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
      const saved = await saveAiSettings(settingsDraft);
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
    if (!selected.name.toLowerCase().endsWith(".pdf") && selected.type !== "application/pdf") {
      setError("请选择 PDF 文件。");
      setStatus("error");
      return;
    }
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setSourceUrl(URL.createObjectURL(selected));
    setFile(selected);
    setActiveFilename(selected.name);
    setMode(selectedMode);
    setScreen("converter");
    setResult(null);
    setError("");
    setProgress({ page: 0, total: 0 });
    setProgressDetail("正在读取 PDF 结构…");
    setStatus("processing");
    try {
      const converted = await convertPdf(selected, selectedMode, (page, total, detail) => {
        setProgress({ page, total });
        if (detail) setProgressDetail(detail);
      });
      setResult(converted);
      setTab(selectedMode === "ai" ? "compare" : "markdown");
      setStatus("complete");
      try {
        await saveToLibrary(selected, converted);
        await refreshLibrary();
      } catch (caught) {
        setLibraryError(caught instanceof Error ? caught.message : "转换完成，但未能存入资料库。");
      }
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
    const pdfFiles = selectedFiles.filter((selected) => selected.name.toLowerCase().endsWith(".pdf") || selected.type === "application/pdf");
    if (!pdfFiles.length) {
      setError("请选择 PDF 文件。");
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
      file: selected,
      status: "queued",
      page: 0,
      total: 0,
      detail: "等待处理",
    }));
    setSourceUrl("");
    setFile(null);
    setResult(null);
    setError("");
    setMode(selectedMode);
    setScreen("converter");
    setStatus("batch");
    setBatchItems(queue);
    setBatchRunning(true);

    for (const item of queue) {
      updateBatchItem(item.id, { status: "processing", detail: "正在读取 PDF 结构…" });
      try {
        const converted = await convertPdf(item.file, selectedMode, (page, total, detail) => {
          updateBatchItem(item.id, { page, total, detail: detail || "正在转换…" });
        });
        await saveToLibrary(item.file, converted);
        updateBatchItem(item.id, {
          status: "complete",
          page: converted.pageCount,
          total: converted.pageCount,
          detail: `已完成并存入 Library · ${converted.pageCount} 页`,
          result: converted,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "转换失败。";
        updateBatchItem(item.id, { status: "error", detail: "处理失败，队列将继续", error: message });
      }
    }

    setBatchRunning(false);
    await refreshLibrary();
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const selected = Array.from(event.dataTransfer.files);
    if (selected.length) void processFiles(selected);
  }

  function reset() {
    setScreen("converter");
    setStatus("idle");
    setFile(null);
    setResult(null);
    setProgress({ page: 0, total: 0 });
    setError("");
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setSourceUrl("");
    setActiveFilename("");
    setBatchItems([]);
    setBatchRunning(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function openBatchResult(item: BatchItem) {
    if (!item.result) return;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setFile(item.file);
    setActiveFilename(item.file.name);
    setSourceUrl(URL.createObjectURL(item.file));
    setResult(item.result);
    setMode(item.result.mode);
    setTab(item.result.mode === "ai" ? "compare" : "markdown");
    setStatus("complete");
  }

  function downloadBatchMarkdown() {
    const completed = batchItems.filter((item): item is BatchItem & { result: ConversionResult } => Boolean(item.result));
    if (!completed.length) return;
    const combined = completed.map((item) => `<!-- 来源文件：${item.file.name} -->\n\n${item.result.markdown}`).join("\n\n---\n\n");
    download(combined, `墨页批量转换-${new Date().toISOString().slice(0, 10)}.md`, "text/markdown;charset=utf-8");
  }

  function showLibrary() {
    setScreen("library");
    void refreshLibrary();
  }

  function openRecord(record: LibraryRecord) {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    const restoredFile = new File([record.pdf], record.filename, { type: "application/pdf", lastModified: record.lastModified });
    setFile(restoredFile);
    setActiveFilename(record.filename);
    setSourceUrl(URL.createObjectURL(record.pdf));
    setMode(record.result.mode);
    setResult(record.result);
    setTab("markdown");
    setStatus("complete");
    setScreen("converter");
  }

  async function removeRecord(record: LibraryRecord) {
    if (!window.confirm(`从本机资料库删除“${record.filename}”？此操作无法撤销。`)) return;
    try {
      await deleteFromLibrary(record.id);
      setLibrary((items) => items.filter((item) => item.id !== record.id));
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
    if (!file || !result) return;
    setMode("ai");
    setStatus("processing");
    setError("");
    setProgress({ page: 0, total: result.pageCount });
    setProgressDetail("正在复用 Library 中的本地初稿…");
    try {
      const refined = await refineExistingPdf(file, result, (page, total, detail) => {
        setProgress({ page, total });
        if (detail) setProgressDetail(detail);
      });
      setResult(refined);
      setTab("compare");
      setStatus("complete");
      await saveToLibrary(file, refined);
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
          <span className="brand-mark">墨</span><span>墨页</span><span className="brand-subtitle">PDF 转 Markdown</span>
        </button>
        <div className="top-actions">
          <button className={`library-nav ${screen === "library" ? "active" : ""}`} type="button" onClick={showLibrary} disabled={batchRunning}>Library <b>{library.length}</b></button>
          <button className="settings-button" type="button" onClick={openSettings}>⚙ 设置</button>
          {status !== "idle" && !batchRunning && <button className="quiet-button" type="button" onClick={reset}>＋ 新转换</button>}
          <span className={`privacy-pill ${aiWasUsed ? "cloud" : ""}`}><i />{aiWasUsed ? "AI 精校 · 页面会发送给所选模型" : "本地处理 · 文件不上传"}</span>
        </div>
      </nav>

      {screen === "library" ? (
        <section className="library-view">
          <header className="library-header">
            <div><div className="eyebrow">LOCAL DOCUMENT LIBRARY</div><h1>你的分析资料库</h1><p>PDF、Markdown、原始初稿与逐页质量记录都保留在这台设备。</p></div>
            <button className="primary-button" type="button" onClick={reset}>＋ 新转换</button>
          </header>
          <div className="library-toolbar">
            <label><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名…" aria-label="搜索资料库" /></label>
            <div><strong>{library.length}</strong> 份文件 · <strong>{library.reduce((sum, item) => sum + item.result.pageCount, 0)}</strong> 页</div>
          </div>
          {libraryError && <div className="library-notice" role="status">{libraryError}</div>}
          {libraryLoading ? (
            <div className="library-empty"><span className="library-empty-mark">墨</span><h2>正在读取资料库…</h2></div>
          ) : filteredLibrary.length ? (
            <div className="library-grid">
              {filteredLibrary.map((record) => {
                const needsReview = record.result.pages.filter((page) => page.status === "review").length;
                const aiPages = record.result.pages.filter((page) => page.method === "ai").length;
                const preview = record.result.markdown.replace(/[#*`$|<>\\]/g, "").replace(/\s+/g, " ").trim();
                return (
                  <article className="library-card" key={record.id}>
                    <button className="library-open" type="button" onClick={() => openRecord(record)} aria-label={`打开 ${record.filename}`}>
                      <span className="library-file-icon">MD<i>PDF</i></span>
                      <span className="library-card-body"><span className="library-card-meta">{formatDate(record.updatedAt)}</span><strong>{record.filename}</strong><span className="library-card-preview">{preview || "没有可预览的文字"}</span></span>
                    </button>
                    <div className="library-card-footer">
                      <span>{record.result.pageCount} 页</span><span>{formatSize(record.fileSize)}</span><span>{aiPages ? `${aiPages} 页 AI 精校` : modeNames[record.result.mode] || "旧版转换"}</span>
                      <span className={needsReview ? "review-count" : ""}>{needsReview ? `${needsReview} 页待检查` : "检查通过"}</span>
                      <button type="button" onClick={() => void removeRecord(record)} aria-label={`删除 ${record.filename}`}>删除</button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="library-empty"><span className="library-empty-mark">墨</span><h2>{query ? "没有匹配的文件" : "资料库还是空的"}</h2><p>{query ? "换个关键词试试。" : "完成第一次转换后，文件会自动出现在这里。"}</p>{!query && <button className="primary-button" type="button" onClick={reset}>开始第一次转换</button>}</div>
          )}
        </section>
      ) : status === "idle" ? (
        <>
          <section className="hero">
            <div className="eyebrow">VERIFIABLE PDF CONVERTER</div>
            <h1>让 PDF 变成<br /><em>可靠的 Markdown</em></h1>
            <p>本地识别先产出逐页初稿；需要时再让视觉模型精校公式，并保留前后结果供你核对。</p>
          </section>
          <section className="converter-card" aria-label="PDF 转换器">
            <button className={`dropzone ${dragging ? "is-dragging" : ""}`} type="button" onClick={() => inputRef.current?.click()} onDragEnter={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              <span className="paper-icon"><b>PDF</b><i /></span><strong>拖放一个或多个 PDF</strong><span>或点击批量选择文件</span>
              <small>{mode === "ai" ? "AI 精校会把选定页面图像发送给你配置的模型" : "当前模式全程在本机处理"}</small>
            </button>
            <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => { const selected = Array.from(event.target.files || []); if (selected.length) void processFiles(selected); }} />
            <div className="profile-row" aria-label="转换模式">
              <div><span className="field-label">转换模式</span><strong>{modeNames[mode]}</strong><small>{modeDescriptions[mode]}</small></div>
              <div className="profile-options">
                {visibleModes.map((item) => <button key={item} type="button" className={mode === item ? "active" : ""} onClick={() => { setMode(item); if (item === "ai" && !settings.aiConfigured) openSettings(); }}>{modeNames[item]}</button>)}
              </div>
            </div>
          </section>
          <section className="feature-grid" aria-label="产品特点">
            <article><span>01</span><h2>两阶段识别</h2><p>Surya 做本地初稿，视觉模型只精校需要的页面。</p></article>
            <article><span>02</span><h2>结果可验证</h2><p>程序检查公式与选项是否丢失，失败时自动回退。</p></article>
            <article><span>03</span><h2>批量队列</h2><p>一次加入多份 PDF，逐份处理并自动写入 Library。</p></article>
          </section>
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
                    <div className="batch-item-title"><strong>{item.file.name}</strong><span>{formatSize(item.file.size)}</span></div>
                    <p>{item.error || item.detail}{item.status === "processing" && item.total ? ` · ${Math.floor(item.page)} / ${item.total} 页` : ""}</p>
                    <div className="batch-item-track"><i style={{ width: `${itemPercent}%` }} /></div>
                  </div>
                  <div className="batch-item-status">
                    <span>{item.status === "queued" ? "等待中" : item.status === "processing" ? `${itemPercent}%` : item.status === "complete" ? "已完成" : "失败"}</span>
                    {item.result && <div><button type="button" onClick={() => openBatchResult(item)}>查看</button><button type="button" onClick={() => download(item.result!.markdown, `${item.result!.title}.md`, "text/markdown;charset=utf-8")}>下载</button></div>}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="batch-footnote">请保持页面开启。队列会逐份处理，单个文件失败不会中断后续文件；成功结果已自动存入 Library。</p>
        </section>
      ) : status === "processing" ? (
        <section className="processing-view" aria-live="polite">
          <div className="processing-orbit"><span>{percent}%</span><i /></div><div className="eyebrow">{mode === "ai" ? "本地初稿 + AI 精校" : "正在本机转换"}</div>
          <h1>{activeFilename}</h1><p>{progressDetail}{progress.total ? ` · ${Math.floor(progress.page)} / ${progress.total} 页` : ""}</p>
          <div className="progress-track"><i style={{ width: `${percent}%` }} /></div>
          <small>{mode === "ai" ? "页面图像会发送给你在设置中选择的模型；失败页面会保留本地初稿。" : "请保持页面开启，文件不会离开你的设备。"}</small>
        </section>
      ) : status === "error" ? (
        <section className="error-card"><span>转换未完成</span><h1>这个 PDF 暂时没能读取</h1><p>{error}</p><div className="error-actions">{error.includes("AI 精校") && <button className="secondary-button" type="button" onClick={openSettings}>打开设置</button>}<button className="primary-button" type="button" onClick={reset}>换一个文件</button></div></section>
      ) : result ? (
        <section className="result-workspace">
          <header className="result-header">
            <div><span className="success-kicker"><i />转换完成 · 已存入 Library</span><h1>{activeFilename}</h1><p>{result.pageCount} 页 · {modeNames[result.mode] || "旧版转换"} · {(result.durationMs / 1000).toFixed(1)} 秒</p></div>
            <div className="result-actions">
              {batchItems.length > 1 && <button type="button" className="secondary-button" onClick={() => setStatus("batch")}>← 返回批次</button>}
              {!batchRunning && <button type="button" className="secondary-button" onClick={() => void rerunAiRefinement()}>复用初稿重新 AI 精校</button>}
              <button type="button" className="secondary-button" onClick={copyMarkdown}>{copied ? "已复制" : "复制 Markdown"}</button>
              <button type="button" className="primary-button" onClick={() => download(result.markdown, `${result.title}.md`, "text/markdown;charset=utf-8")}>下载 .md</button>
            </div>
          </header>
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
            {tab === "markdown" && <pre className="markdown-preview">{result.markdown}</pre>}
            {tab === "quality" && <div className="quality-list">{result.pages.map((page) => (
              <article key={page.page} className={page.status === "good" ? "good-page" : ""}><span>第 {page.page} 页</span><div><strong>{methodLabel(page)}</strong>{page.reasons.length ? page.reasons.map((reason) => <p key={reason}>{reason}</p>) : <p>程序校验通过</p>}<p>{page.formulaCount ?? 0} 个公式 · {page.optionCount ?? 0} 个选项标签</p></div><small>{page.charCount} 字符</small></article>
            ))}</div>}
            {tab === "compare" && (comparedPages.length ? <div className="compare-list">{comparedPages.map((page) => (
              <article key={page.page}><header><strong>第 {page.page} 页</strong><span className={`method-badge ${page.method === "ai" ? "accepted" : "fallback"}`}>{page.method === "ai" ? `采用 ${page.model}` : "回退本地初稿"}</span></header><div className="compare-columns"><section><h3>最终 Markdown</h3><pre>{page.markdown}</pre></section><section><h3>Surya 本地初稿</h3><pre>{page.rawMarkdown}</pre></section></div></article>
            ))}</div> : <div className="all-clear"><span>↔</span><h2>这次没有 AI 对照记录</h2><p>使用“重新 AI 精校”后，这里会保留最终结果与本地初稿。</p></div>)}
            {tab === "source" && sourceUrl && <iframe className="pdf-preview" src={sourceUrl} title="原始 PDF 预览" />}
          </div>
        </section>
      ) : null}

      <footer><span>墨页 · Verifiable document tools</span><span>{aiWasUsed ? "本地初稿 · 可选云端精校 · 逐页留痕" : "当前处理仅在你的设备完成"}</span></footer>

      {showSettings && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false); }}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header><div><span className="eyebrow">MODEL SETTINGS</span><h2 id="settings-title">AI 精校设置</h2></div><button type="button" onClick={() => setShowSettings(false)} aria-label="关闭设置">×</button></header>
            <div className="settings-warning"><strong>隐私说明</strong><p>AI 精校时，选定页面的 JPEG 图像和本地初稿会发送给你选择的模型服务。API Key 仅保存在本项目的本机 <code>settings.local.json</code>，不会写入 Library 或浏览器页面数据。</p></div>
            <div className="settings-provider" role="group" aria-label="模型服务商">
              <button type="button" className={settingsDraft.provider === "gemini" ? "active" : ""} onClick={() => selectProvider("gemini")}>Google Gemini</button>
              <button type="button" className={settingsDraft.provider === "kimi" ? "active" : ""} onClick={() => selectProvider("kimi")}>Kimi</button>
              <button type="button" className={settingsDraft.provider === "qwen" ? "active" : ""} onClick={() => selectProvider("qwen")}>Qwen 百炼</button>
              <button type="button" className={settingsDraft.provider === "openrouter" ? "active" : ""} onClick={() => selectProvider("openrouter")}>OpenRouter</button>
            </div>
            {settingsDraft.provider === "gemini" ? (
              <div className="settings-fields">
                <label><span>Gemini API Key</span><input type="password" value={settingsDraft.geminiKey || ""} onChange={(event) => setSettingsDraft((value) => ({ ...value, geminiKey: event.target.value }))} placeholder={settingsDraft.geminiKeyMasked || "AIza…"} /><small>{settingsDraft.geminiConfigured ? `已配置 ${settingsDraft.geminiKeyMasked}；留空则保留原值` : "尚未配置"}</small></label>
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
            {settingsStatus && <div className="settings-status" role="status">{settingsStatus}</div>}
            <footer><button type="button" className="secondary-button" disabled={settingsBusy} onClick={() => void testSettings()}>测试连接</button><div><button type="button" className="quiet-button" onClick={() => setShowSettings(false)}>取消</button><button type="button" className="primary-button" disabled={settingsBusy} onClick={() => void persistSettings()}>保存设置</button></div></footer>
          </section>
        </div>
      )}
    </main>
  );
}
