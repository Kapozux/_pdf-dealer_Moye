// 「回顾」可以交给本机 Claude Code 写（REFLECT_ENGINE=claude，2026-10-13）：默认不开；
// 开了用精简模式的 claude -p、记账记 claude-code / $0；撞上限就停着，调用方回落 Gemini。
// claude 是假的：一个临时 shell 脚本，按要求吐 claude -p --output-format json 的样子。
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeEnabled, claudeText, findClaude, CLAUDE_MODEL, _resetPause } from "../../server/claude-text.mjs";

async function fakeClaude(reply) {
  const dir = await mkdtemp(join(tmpdir(), "moye-claude-"));
  const bin = join(dir, "claude");
  // 把收到的参数、标准输入、环境变量记下来，再吐固定的回复
  await writeFile(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\ncat > "${dir}/stdin"\necho "$DISABLE_PROMPT_CACHING" > "${dir}/env"\ncat <<'EOF'\n${JSON.stringify(reply)}\nEOF\n`);
  await chmod(bin, 0o755);
  return { dir, bin };
}

test("默认不开：没设 REFLECT_ENGINE 就不用 Claude", () => {
  assert.equal(claudeEnabled({ CLAUDE_BIN: process.execPath }), false);
});

test("开了：精简模式调 claude -p，拿回全文，记账 claude-code / $0，一次性调用不写缓存", async () => {
  _resetPause();
  const { dir, bin } = await fakeClaude({ result: "{\"zh\":{\"headline\":\"在刷题\"}}", is_error: false,
    usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  try {
    const env = { REFLECT_ENGINE: "claude", CLAUDE_BIN: bin };
    assert.equal(claudeEnabled(env), true);
    const records = [];
    const text = await claudeText("清单……", { bin, record: (r) => records.push(r) });
    assert.equal(text, "{\"zh\":{\"headline\":\"在刷题\"}}");
    const args = await readFile(join(dir, "args"), "utf8");
    assert.match(args, /--model claude-opus-5-5/);
    assert.match(args, /--tools {2}--disable-slash-commands|--tools\s+--disable-slash-commands/);
    assert.match(args, /--no-session-persistence/);
    assert.equal((await readFile(join(dir, "stdin"), "utf8")), "清单……");
    assert.equal((await readFile(join(dir, "env"), "utf8")).trim(), "1");
    assert.deepEqual(records, [{ provider: "claude-code", model: CLAUDE_MODEL, purpose: "reflect", inputTokens: 900, outputTokens: 60, cachedTokens: 0, costUsd: 0 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("撞上限：报错、停到重置时间，期间 claudeEnabled 为假（调用方回落 Gemini）", async () => {
  _resetPause();
  const until = Math.floor(Date.now() / 1000) + 3600;
  const { dir, bin } = await fakeClaude({ result: `Claude AI usage limit reached|${until}`, is_error: true });
  try {
    await assert.rejects(claudeText("清单", { bin, record: () => {} }), /usage limit/);
    assert.equal(claudeEnabled({ REFLECT_ENGINE: "claude", CLAUDE_BIN: bin }), false);
  } finally {
    _resetPause();
    await rm(dir, { recursive: true, force: true });
  }
});

test("找 claude：CLAUDE_BIN 优先；launchd 的 PATH 里没有也去 ~/.local/bin 等常见位置找", () => {
  assert.equal(findClaude({ CLAUDE_BIN: process.execPath, PATH: "" }), process.execPath);
  assert.equal(findClaude({ CLAUDE_BIN: "/nonexistent/claude", PATH: "/nonexistent", HOME: "/nonexistent" }), null);
});
