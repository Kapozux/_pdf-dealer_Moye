/**
 * 服务端任务 API 客户端。
 *
 * 浏览器不再自己跑转换：提交文件 → 服务端排队执行 → SSE 看进度。
 * 关掉页面任务照跑，重开页面还能接着看（进度来自服务端，不是内存里的 state）。
 */

import type { ConversionMode, ConversionResult } from "./pdf-to-markdown";

export const SERVICE_BASE = "http://127.0.0.1:8765";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type Job = {
  id: string;
  filename: string;
  file_size: number;
  mode: ConversionMode;
  status: JobStatus;
  page: number;
  total: number;
  detail: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  /** 完成时写入的摘要，Library 列表直接用，不必逐份读 result.json */
  page_count: number;
  review_count: number;
  /** 其中真正回退到文字层的页数（AI 试过但没采用）；老记录启动时补算，补算前是 null */
  fallback_count?: number | null;
  ai_pages: number;
  preview: string;
  /** 同一次批量提交共享一个 batch_id；单份转换为 null */
  batch_id: string | null;
  batch_label: string | null;
  /** 统计面板用：全文字数（求和自每页 charCount） */
  char_count: number;
  /** AI 打的主题标签，JSON 数组字符串；没打过是 null */
  tags: string | null;
  /** AI 起的标题 / 一句话简介（回顾和下载文件名用）；老记录没跑过补标签时为 null */
  ai_title?: string | null;
  ai_one_line?: string | null;
  /** 原文件名本身是否像个标题（AI 判断）：1/0；还没判过是 null */
  filename_meaningful?: number | null;
  /** 费用摘要（明细在服务端 usage.db）：这份任务名下所有模型调用的合计。没调用过模型是 null */
  cost_usd?: number | null;
  cost_calls?: number | null;
  /** 其中没有价格表、只记了 token 的调用次数 */
  cost_unpriced?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  /** 转换本身的墙钟毫秒（不含排队），预计剩余时间按它算 */
  duration_ms?: number | null;
};

/** /api/usage：模型用量与费用汇总。 */
export type UsageTotal = { calls: number; costUsd: number; unpriced: number; inputTokens: number; outputTokens: number };
export type UsageRow = UsageTotal & { key: string };
export type Usage = {
  since: string | null;
  month: UsageTotal;
  all: UsageTotal;
  by: Record<"provider" | "purpose" | "model", { month: UsageRow[]; all: UsageRow[] }>;
  daily: { date: string; costUsd: number; calls: number }[];
  unpricedModels: string[];
  pricesPath: string;
};

/** /api/speed：按模式的每页秒数中位数；样本不足 3 份时 secPerPage 为 null（不猜） */
export type SpeedTable = Record<string, { n: number; secPerPage: number | null }>;

/** 个人数据统计面板：/api/stats 的返回结构。 */
export type Stats = {
  totals: { transcripts: number; pages: number; chars: number };
  /** 按天聚合的页数，前端据此画累计折线图 */
  timeline: { day: string; pages: number; count: number }[];
  topTags: { tag: string; count: number }[];
  /** 按转换模式的份数 / 页数 */
  byMode?: Record<string, { count: number; pages: number }>;
};

export type ReflectRange = "1m" | "3m" | "6m" | "12m";
export type ReflectTopic = { tag: string; pages: number; count: number; percent: number; name: string; desc: string };
export type ReflectPoint = { date: string; count: number; pages: number };
/** 回顾面板：统计 + 模型写的叙事（服务端提前算好并缓存） */
export type Reflect = {
  range: ReflectRange;
  period: { start: string; end: string };
  totals: { count: number; pages: number; chars: number; prev_count: number; prev_pages: number };
  most_active_weekday: number | null;
  most_active_weekday_label: string | null;
  peak_hour: number | null;
  series: ReflectPoint[];
  prev_series: ReflectPoint[];
  topics: ReflectTopic[];
  headline: string;
  narrative: string;
  generated: boolean;
  /** 缓存过期：给的是上一份，后台正在重算 */
  stale: boolean;
  regenerating: boolean;
  lang: "zh" | "en";
};

export type TagBackfillState = { running: boolean; done: number; total: number; failed: number };

/** 一次批量提交的汇总（服务端 SQL 聚合，不用逐份读任务）。 */
export type Batch = {
  id: string;
  label: string | null;
  total: number;
  done: number;
  active: number;
  failed: number;
  pages: number;
  created_at: string;
  updated_at: string;
};

async function asJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || `请求失败（${response.status}）。`);
  }
  return payload as T;
}

/**
 * 提交一份 PDF；立刻返回任务，转换在服务端进行。
 * 传 batch 时，这份会归到同一个合集里（Library 可整包下载）。
 */
export async function submitJob(
  file: File,
  mode: ConversionMode,
  batch?: { id: string; label: string }
): Promise<Job> {
  const response = await fetch(`${SERVICE_BASE}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      // HTTP header 只能带 latin-1，中文文件名/批次名必须编码后再传
      "x-filename": encodeURIComponent(file.name),
      "x-mode": mode,
      ...(batch ? { "x-batch-id": batch.id, "x-batch-label": encodeURIComponent(batch.label) } : {}),
    },
    body: file,
  });
  const { job } = await asJson<{ job: Job }>(response);
  return job;
}

export async function listBatches(): Promise<Batch[]> {
  const { batches } = await asJson<{ batches: Batch[] }>(await fetch(`${SERVICE_BASE}/api/batches`));
  return batches;
}

/**
 * 整包下载地址。传 batchId 下一个合集，传 ids 下指定几份，都不传就是全部。
 * 直接给 <a href> 用——让浏览器自己下载，不用先把整个 zip 读进内存。
 */
export function exportZipUrl(options: { batchId?: string; ids?: string[] } = {}): string {
  const query = new URLSearchParams();
  if (options.batchId) query.set("batch", options.batchId);
  if (options.ids?.length) query.set("ids", options.ids.join(","));
  const suffix = query.toString();
  return `${SERVICE_BASE}/api/export/zip${suffix ? `?${suffix}` : ""}`;
}

export async function listJobs(): Promise<Job[]> {
  const { jobs } = await asJson<{ jobs: Job[] }>(await fetch(`${SERVICE_BASE}/api/jobs`));
  return jobs;
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(`${SERVICE_BASE}/api/jobs/${id}/cancel`, { method: "POST" });
}

export async function listLibraryItems(): Promise<Job[]> {
  const { items } = await asJson<{ items: Job[] }>(await fetch(`${SERVICE_BASE}/api/library`));
  return items;
}

export async function fetchLibraryEntry(id: string): Promise<{ job: Job; result: ConversionResult }> {
  return asJson(await fetch(`${SERVICE_BASE}/api/library/${id}`));
}

export async function deleteLibraryEntry(id: string): Promise<void> {
  await asJson(await fetch(`${SERVICE_BASE}/api/library/${id}`, { method: "DELETE" }));
}

/**
 * 重跑 AI 精校：服务端复用已存的本地初稿，不重跑 Surya。
 * only="fallback" 时只重跑上次 AI 没成功（回退文字层 / 没过校验）的页，其余原样保留。
 */
export async function refineLibraryEntry(id: string, { only = "all" }: { only?: "all" | "fallback" } = {}): Promise<Job> {
  const { job } = await asJson<{ job: Job }>(
    await fetch(`${SERVICE_BASE}/api/library/${id}/refine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ only }),
    })
  );
  return job;
}

/** 读回一个二进制响应；出错时服务端回的是 JSON {error}，把原因带出来 */
async function asBlob(response: Response): Promise<Blob> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error((payload as { error?: string }).error || `请求失败（${response.status}）。`);
  }
  return response.blob();
}

/** Library 里这份的 Markdown → PDF（服务端用 Chrome 无头打印，公式已排版）。 */
export async function fetchLibraryDocumentPdf(id: string): Promise<Blob> {
  return asBlob(await fetch(`${SERVICE_BASE}/api/library/${id}/document.pdf`));
}

/** 任意 Markdown 文本 → PDF。 */
export async function markdownToPdf(markdown: string, title: string): Promise<Blob> {
  return asBlob(
    await fetch(`${SERVICE_BASE}/api/md2pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown, title }),
    })
  );
}

/**
 * 很多图片 → 一份 PDF。逐张流式上传到同一个会话，再让服务端按上传顺序合成
 * （一次性把几十张照片塞进一个请求体会先把浏览器内存撑爆）。
 * 返回值里的 skipped 是服务端跳过的图片和原因，必须显示出来，不能默默少几页。
 */
export async function imagesToPdf(
  files: File[],
  title: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ blob: Blob; pages: number; skipped: { name: string; reason: string }[] }> {
  const session = crypto.randomUUID().replace(/-/g, "");
  for (const [index, file] of files.entries()) {
    const response = await fetch(`${SERVICE_BASE}/api/images2pdf/part`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-session": session,
        "x-index": String(index),
        "x-filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error((payload as { error?: string }).error || `${file.name} 上传失败（${response.status}）。`);
    }
    onProgress?.(index + 1, files.length);
  }
  const response = await fetch(`${SERVICE_BASE}/api/images2pdf/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, title }),
  });
  const blob = await asBlob(response);
  let skipped: { name: string; reason: string }[] = [];
  try {
    skipped = JSON.parse(decodeURIComponent(response.headers.get("X-Moye-Skipped") || "[]"));
  } catch {
    skipped = [];
  }
  return { blob, pages: Number(response.headers.get("X-Moye-Pages")) || 0, skipped };
}

export function libraryPdfUrl(id: string): string {
  return `${SERVICE_BASE}/api/library/${id}/pdf`;
}

/** 个人数据统计面板的聚合数据。 */
/** 用量与费用汇总（面板「用量」栏）。 */
export async function fetchUsage(): Promise<Usage> {
  return asJson(await fetch(`${SERVICE_BASE}/api/usage`));
}

/** 按模式的每页秒数（模式说明里的「约 X 秒/页」和预计剩余时间）。 */
export async function fetchSpeed(): Promise<SpeedTable> {
  return asJson(await fetch(`${SERVICE_BASE}/api/speed`));
}

export async function fetchStats(): Promise<Stats> {
  return asJson(await fetch(`${SERVICE_BASE}/api/stats`));
}

/** 回顾：refresh=true 强制同步重写叙事（手动点刷新才用）。 */
export async function fetchReflect(range: ReflectRange, lang: "zh" | "en", refresh = false): Promise<Reflect> {
  return asJson(await fetch(`${SERVICE_BASE}/api/reflect?range=${range}&lang=${lang}${refresh ? "&refresh=1" : ""}`));
}

/** 给还没打标签的旧记录批量生成标签（新完成的任务已经自动打过了，这个只补历史）。 */
export async function startTagBackfill(): Promise<TagBackfillState> {
  return asJson(await fetch(`${SERVICE_BASE}/api/tags/backfill`, { method: "POST" }));
}

export async function fetchTagBackfillStatus(): Promise<TagBackfillState> {
  return asJson(await fetch(`${SERVICE_BASE}/api/tags/backfill/status`));
}

/**
 * 订阅所有任务的进度。返回取消订阅函数。
 * 断线由 EventSource 自动重连，服务端每 15s 发心跳保活。
 */
export function subscribeJobs(onJob: (job: Job) => void): () => void {
  const source = new EventSource(`${SERVICE_BASE}/api/events`);
  source.addEventListener("job", (event) => {
    try {
      onJob(JSON.parse((event as MessageEvent).data) as Job);
    } catch {
      /* 忽略坏帧 */
    }
  });
  return () => source.close();
}
