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
};

async function asJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || `请求失败（${response.status}）。`);
  }
  return payload as T;
}

/** 提交一份 PDF；立刻返回任务，转换在服务端进行。 */
export async function submitJob(file: File, mode: ConversionMode): Promise<Job> {
  const response = await fetch(`${SERVICE_BASE}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      // HTTP header 只能带 latin-1，中文文件名必须编码后再传
      "x-filename": encodeURIComponent(file.name),
      "x-mode": mode,
    },
    body: file,
  });
  const { job } = await asJson<{ job: Job }>(response);
  return job;
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
