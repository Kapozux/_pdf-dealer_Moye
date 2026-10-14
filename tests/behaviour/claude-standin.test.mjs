// Claude 停着（撞 5 小时上限、或三个应用共用的额度停了）时，精校不再整页退回文字层，
// 而是换一家配了 Key 的（Kimi → OpenRouter → Gemini → Qwen）。2026-10-14 用户点头。
import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_STANDINS, claudeStandIn } from "../../server/claude-text.mjs";

const has = (...ok) => (p) => ok.includes(p);

test("Claude 没停：渠道原样", () => {
  assert.deepEqual(claudeStandIn(["claude"], has("kimi"), false), ["claude"]);
});

test("只有 Claude 一路、它停着：换第一家配了 Key 的", () => {
  assert.deepEqual(claudeStandIn(["claude"], has("gemini", "kimi"), true), ["kimi"]);
  assert.deepEqual(claudeStandIn(["claude"], has("gemini"), true), ["gemini"]);
});

test("多渠道：去掉 Claude，剩下的照跑，不额外加", () => {
  assert.deepEqual(claudeStandIn(["kimi", "claude", "qwen"], has("kimi", "qwen", "gemini"), true), ["kimi", "qwen"]);
});

test("一家都没配：还是交给 Claude（让它照常报错、回退文字层）", () => {
  assert.deepEqual(claudeStandIn(["claude"], has(), true), ["claude"]);
});

test("顺序：Kimi 公式最全排第一", () => {
  assert.deepEqual(CLAUDE_STANDINS, ["kimi", "openrouter", "gemini", "qwen"]);
});
