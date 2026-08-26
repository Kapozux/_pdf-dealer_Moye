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
  ai_pages: number;
  preview: string;
  /** 同一次批量提交共享一个 batch_id；单份转换为 null */
  batch_id: string | null;
  batch_label: string | null;
  /** 统计面板用：全文字数（求和自每页 charCount） */
  char_count: number;
  /** AI 打的主题标签，JSON 数组字符串；没打过是 null */
  tags: string | null;
};

/** 个人数据统计面板：/api/stats 的返回结构。 */
export type Stats = {
  totals: { transcripts: number; pages: number; chars: number };
  /** 按天聚合的页数，前端据此画累计折线图 */
  timeline: { day: string; pages: number; count: number }[];
  topTags: { tag: string; count: number }[];
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

/** 重跑 AI 精校：服务端复用已存的本地初稿，不重跑 Surya。 */
export async function refineLibraryEntry(id: string): Promise<Job> {
  const { job } = await asJson<{ job: Job }>(
    await fetch(`${SERVICE_BASE}/api/library/${id}/refine`, { method: "POST" })
  );
  return job;
}

export function libraryPdfUrl(id: string): string {
  return `${SERVICE_BASE}/api/library/${id}/pdf`;
}

/** 个人数据统计面板的聚合数据。 */
export async function fetchStats(): Promise<Stats> {
  return asJson(await fetch(`${SERVICE_BASE}/api/stats`));
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
