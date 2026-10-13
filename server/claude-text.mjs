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

export function claudeEnabled(env = process.env) {
  return String(env.REFLECT_ENGINE || "").trim().toLowerCase() === "claude" && Date.now() >= pausedUntil && !!findClaude(env);
}

/**
 * 调一次，返回全文。record(行) 记账（usage.record 的参数形状）。失败抛错（原因写在错误里，规矩四：不静默吞）。
 */
export function claudeText(prompt, { bin = findClaude(), effort = "medium", timeoutMs = 180000, record = () => {}, purpose = "reflect" } = {}) {
  if (!bin) return Promise.reject(new Error("找不到 claude 命令（Claude Code 没装？）"));
  const cwd = join(homedir(), ".moye-claude");            // 会话存在这个目录名下，不混进用户自己的 Claude Code 项目
  mkdirSync(cwd, { recursive: true });
  const args = ["-p", "--model", CLAUDE_MODEL, "--effort", effort, "--system-prompt", SYSTEM, "--tools", "",
    "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
    "--output-format", "json"];
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
      let d;
      try {
        d = JSON.parse(out);
      } catch {
        reject(new Error(`Claude Code 输出看不懂：${(out || err).slice(0, 200)}`));
        return;
      }
      const u = d.usage || {};
      record({ provider: "claude-code", model: CLAUDE_MODEL, purpose,
        inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0,
        cachedTokens: u.cache_read_input_tokens || 0, costUsd: 0 });
      const text = String(d.result || "").trim();
      if (d.is_error || !text) {
        if (LIMIT.test(text)) {
          const m = text.match(/\|(\d{10})/);
          pausedUntil = Math.max(m ? Number(m[1]) * 1000 : Date.now() + PAUSE_MS, Date.now() + 60000);
        }
        reject(new Error(`Claude Code：${text.slice(0, 200) || "返回空"}`));
        return;
      }
      resolve(text);
    });
    child.stdin.end(prompt);
  });
}
