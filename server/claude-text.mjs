/**
 * 本机 Claude Code 写字（2026-10-13，用户：墨页的「回顾」交给 Claude）。
 *
 * 只在设了 REFLECT_ENGINE=claude、又找得到 `claude` 命令时用；别人装的墨页没有 Claude Code，默认行为不变。
 * 走的是用户的 Claude 订阅额度（不是 API key），所以记账记 claude-code / $0（费用记 0 不是 null，否则界面显示「未计价」）。
 * 回顾原来用过 OpenRouter 上的 Claude Opus 4.6，吃掉了 usage.db 里 99% 的花销（见 local-ocr-server.mjs 的 REFLECT_GEMINI_MODEL）；
 * 这条路不花 API 的钱。
 *
 * 精简模式：自己的系统提示、不给工具、不读设置和 MCP、不留会话；一次性的调用设 DISABLE_PROMPT_CACHING=1——
 * Claude Code 默认把输入写进 1 小时缓存，写的价钱是普通输入的 2 倍，之后又没人读（Ephemeris 10-13 实测贵一倍）。
 * 撞上限 / 没登录：停到重置时间（读得到的话）或 30 分钟，期间 claudeEnabled() 为假，调用方回落 Gemini。
 * 跟 Ephemeris 的 llm.claude、Verbatim 的 claude_cli 是同一个路子，各自一份（项目之间不互相 import）。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pause as gatePause, pausedUntil as gatePausedUntil, record as gateRecord, withSlot } from "./claude-gate.mjs";

export const CLAUDE_MODEL = "claude-opus-5-5";
const SYSTEM = "你是墨页（一个本机 PDF 转 Markdown 工具）里的文字程序。只按用户消息里的要求输出，不寒暄、不加说明。";
const PAUSE_MS = 30 * 60 * 1000;
const LIMIT = /usage limit|limit reached|rate limit|resets?|Not logged in|\/login|credit balance/i;
let pausedUntil = 0;

/** 测试用：清掉「撞上限停着」。 */
export function _resetPause() {
  pausedUntil = 0;
}

/**
 * claude 在哪：CLAUDE_BIN → PATH → 常见安装位置。
 * launchd 起的服务 PATH 很短，没有 ~/.local/bin（Claude Code 默认装在那），所以要自己去找。
 */
export function findClaude(env = process.env) {
  const home = env.HOME || homedir();
  const cands = [
    env.CLAUDE_BIN,
    ...String(env.PATH || "").split(delimiter).filter(Boolean).map((d) => join(d, "claude")),
    join(home, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return cands.find((p) => p && existsSync(p)) ?? null;
}

/** Claude 现在停着吗（本进程撞了上限，或三个应用共用的额度停了）。 */
export function claudePaused() {
  return Date.now() < pausedUntil || !!gatePausedUntil();
}

// Claude 停着时精校换哪家（2026-10-14 用户：别整页退回文字层）：Kimi 公式最全排第一，其次 OpenRouter、Gemini、Qwen
export const CLAUDE_STANDINS = ["kimi", "openrouter", "gemini", "qwen"];

/**
 * 精校的渠道列表（provider 名字）→ Claude 停着时实际该用的。多渠道就去掉 Claude；只剩它一路就换第一家配了 Key 的；
 * 一家都没配就原样（让 Claude 照常报错、回退文字层）。
 */
export function claudeStandIn(providers, isConfigured, paused = claudePaused()) {
  if (!paused || !providers.includes("claude")) return providers;
  const rest = providers.filter((p) => p !== "claude");
  if (rest.length) return rest;
  const sub = CLAUDE_STANDINS.find((p) => isConfigured(p));
  return sub ? [sub] : providers;
}

export function claudeEnabled(env = process.env) {
  return String(env.REFLECT_ENGINE || "").trim().toLowerCase() === "claude" && Date.now() >= pausedUntil && !gatePausedUntil() && !!findClaude(env);
}

// 三个应用共用额度的分配器（claude-gate.mjs）：精校一页、打标签 = batch，测试连接 = live，其余（回顾）normal
const GATE_APP = "moye";
// 「问」（find）是用户在页面上等着的，跟测试连接一样算交互
const prioOf = (purpose) => (purpose === "test" || purpose === "find" ? "live" : purpose === "refine" || purpose === "card" ? "batch" : "normal");

function run(bin, args, input, opts) {
  const prio = prioOf(opts.purpose);
  return withSlot(GATE_APP, opts.purpose, prio, () => runOnce(bin, args, input, { ...opts, prio }));
}

function runOnce(bin, args, input, { timeoutMs, record, purpose, model, page, prio }) {
  const cwd = join(homedir(), ".moye-claude");            // 会话存在这个目录名下，不混进用户自己的 Claude Code 项目
  mkdirSync(cwd, { recursive: true });
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, DISABLE_PROMPT_CACHING: "1" } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Claude Code ${Math.round(timeoutMs / 1000)}s 没写完`));
    }, timeoutMs);
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { err += b; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      clearTimeout(timer);
      // --output-format json 是一个对象；stream-json 是一行一个事件，要的是最后那个 result
      let d = null;
      try {
        d = JSON.parse(out);
      } catch {
        const last = out.split("\n").filter((l) => l.includes('"type":"result"')).pop();
        try { d = last ? JSON.parse(last) : null; } catch { d = null; }
      }
      if (!d) {
        reject(new Error(`Claude Code 输出看不懂：${(out || err).slice(0, 200)}`));
        return;
      }
      gateRecord(GATE_APP, purpose, prio, model, d, (Date.now() - t0) / 1000);
      const u = d.usage || {};
      const used = record({ provider: "claude-code", model, purpose, ...(Number.isFinite(page) ? { page } : {}),
        inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0,
        cachedTokens: u.cache_read_input_tokens || 0, costUsd: 0 });
      const text = String(d.result || "").trim();
      if (d.is_error || !text) {
        if (LIMIT.test(text)) {
          const m = text.match(/\|(\d{10})/);
          pausedUntil = Math.max(m ? Number(m[1]) * 1000 : Date.now() + PAUSE_MS, Date.now() + 60000);
          gatePause(pausedUntil / 1000, text, GATE_APP);
        }
        reject(new Error(`Claude Code：${text.slice(0, 200) || "返回空"}`));
        return;
      }
      resolve({ text, used });
    });
    child.stdin.end(input);
  });
}

const BASE_ARGS = (model, effort) => ["-p", "--model", model, "--effort", effort, "--system-prompt", SYSTEM, "--tools", "",
  "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"];

/**
 * 调一次，返回全文。record(行) 记账（usage.record 的参数形状）。失败抛错（原因写在错误里，规矩四：不静默吞）。
 */
export async function claudeText(prompt, { bin = findClaude(), model = CLAUDE_MODEL, effort = "medium", timeoutMs = 180000,
  record = () => {}, purpose = "reflect" } = {}) {
  if (!bin) throw new Error("找不到 claude 命令（Claude Code 没装？）");
  const { text } = await run(bin, [...BASE_ARGS(model, effort), "--output-format", "json"], prompt, { timeoutMs, record, purpose, model });
  return text;
}

/**
 * 看图（AI 精校的一页）：图片和提示词作为一条用户消息从标准输入进去（--input-format stream-json），不用给它读文件的工具。
 * 返回 { text, used }（used = record 的返回值，结果页逐页显示用量用）。
 * 2026-10-13 实测（Haiku 5.5、40 页手机拍的作业）：每页中位 18s、最慢 35s；5 / 10 / 20 / 40 路并发全部成功、没有限流，
 * 吞吐随并发线性涨（40 路 80 页/分钟），每个进程约 230MB 内存。
 */
export async function claudeVision(prompt, imageBase64, mimeType, { bin = findClaude(), model = "claude-haiku-5-5", effort = "low",
  timeoutMs = 90000, record = () => {}, purpose = "refine", page } = {}) {
  if (!bin) throw new Error("找不到 claude 命令（Claude Code 没装？）");
  const msg = { type: "user", message: { role: "user", content: [
    { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: imageBase64 } },
    { type: "text", text: prompt }] } };
  const args = [...BASE_ARGS(model, effort), "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  return run(bin, args, JSON.stringify(msg) + "\n", { timeoutMs, record, purpose, model, page });
}
