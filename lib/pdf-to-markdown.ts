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
