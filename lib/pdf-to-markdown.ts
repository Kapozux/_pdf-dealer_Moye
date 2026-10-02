/**
 * 转换结果的类型定义。
 *
 * 实现已经搬到服务端（server/convert.mjs）——浏览器不再自己跑转换，
 * 只负责提交任务、看进度、展示结果。这里只留下前后端共用的类型。
 */

import type { AiProvider } from "./ai-settings";

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
  /** 交给过模型（不管结果用没用上）。「这页最后算什么」见 lib/page-result.mjs 的 outcome() */
  aiAttempted?: boolean;
  /** 模型判定这页本来就没有可提取的文字（照片、空白页）——算成功，不算回退 */
  noText?: boolean;
  /** noText 时模型说这张图是什么，例如「photo of a cat」 */
  note?: string;
  /** 这一页的墙钟耗时（毫秒）：AI 页含等渲染、等并发闸门；文字层页就是解析时间 */
  durationMs?: number;
  /** AI 页真正打向模型那次调用的耗时（毫秒），不含本机排队 */
  modelMs?: number;
  /** 这一页那次模型调用的用量；costUsd 为 null 表示模型没有价格表（未计价） */
  usage?: { inputTokens: number; outputTokens: number; costUsd: number | null };
};

export type ConversionResult = {
  title: string;
  mode: ConversionMode;
  pageCount: number;
  markdown: string;
  pages: PageResult[];
  durationMs: number;
};
