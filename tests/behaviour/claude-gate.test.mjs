// 三个应用（Verbatim / Ephemeris / 墨页）共用 Claude 额度的分配器（claude-gate.mjs，2026-10-13）：
// 没设 CLAUDE_GATE 不起作用；设了：起 claude 前占位子、用完还、记一行账；总数到顶时 batch 等着、live 用留着的位子；
// 别的应用撞了上限这边 claudeEnabled 为假；这边撞了写进共用的 pause。claude 是假的 shell 脚本。
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gateStatus, pause, withSlot } from "../../server/claude-gate.mjs";
import { claudeEnabled, claudeText, _resetPause } from "../../server/claude-text.mjs";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "moye-gate-"));
  process.env.CLAUDE_GATE = join(dir, "gate.db");
  return dir;
}

test("占位子、用完还、记账（墨页 = moye，回顾 = normal）", async () => {
  const dir = await setup();
  _resetPause();
  const bin = join(dir, "claude");
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\necho '{"result":"好","is_error":false,"total_cost_usd":0.05,"usage":{"input_tokens":10,"output_tokens":2}}'\n`);
  await chmod(bin, 0o755);
  try {
    assert.equal(await claudeText("写回顾", { bin, record: () => {} }), "好");
    const s = gateStatus();
    assert.deepEqual(s.slots, []);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].app, "moye");
    assert.equal(s.calls[0].usd, 0.05);
  } finally {
    process.env.CLAUDE_GATE = "";
    await rm(dir, { recursive: true, force: true });
  }
});

test("到顶：batch 等着，live 用留着的位子先进", async () => {
  const dir = await setup();
  process.env.CLAUDE_GATE_CAP = "2";
  process.env.CLAUDE_GATE_RESERVE = "1";
  try {
    const order = [];
    let release;
    const hold = new Promise((r) => { release = r; });
    const b1 = withSlot("t", "refine", "batch", async () => { order.push("b1"); await hold; });
    await new Promise((r) => setTimeout(r, 50));
    const b2 = withSlot("t", "refine", "batch", async () => { order.push("b2"); });
    const live = withSlot("t", "test", "live", async () => { order.push("live"); });
    await live;
    assert.deepEqual(order, ["b1", "live"]);          // b2 还在等
    release();
    await Promise.all([b1, b2]);
    assert.deepEqual(order, ["b1", "live", "b2"]);
  } finally {
    delete process.env.CLAUDE_GATE_CAP;
    delete process.env.CLAUDE_GATE_RESERVE;
    process.env.CLAUDE_GATE = "";
    await rm(dir, { recursive: true, force: true });
  }
});

test("一起停：别的应用撞上限这边也停；这边撞了写进共用的", async () => {
  const dir = await setup();
  _resetPause();
  const bin = join(dir, "claude");
  try {
    await writeFile(bin, `#!/bin/sh\ncat > /dev/null\necho '{"result":"Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 900}","is_error":true}'\n`);
    await chmod(bin, 0o755);
    const env = { REFLECT_ENGINE: "claude", CLAUDE_BIN: bin };
    pause(Date.now() / 1000 + 600, "usage limit reached", "verbatim");
    assert.equal(claudeEnabled(env), false);
    await assert.rejects(claudeText("x", { bin, record: () => {} }), /shared pause/);
    const { DatabaseSync } = await import("node:sqlite");
    new DatabaseSync(process.env.CLAUDE_GATE).exec("DELETE FROM pause");
    assert.equal(claudeEnabled(env), true);
    await assert.rejects(claudeText("x", { bin, record: () => {} }), /usage limit/);
    assert.equal(gateStatus().pause.app, "moye");
  } finally {
    _resetPause();
    process.env.CLAUDE_GATE = "";
    await rm(dir, { recursive: true, force: true });
  }
});
