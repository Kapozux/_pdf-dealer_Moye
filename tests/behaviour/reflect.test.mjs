// 「回顾」叙事缓存的行为测试：只经过 createReflect 的接口，模型是假的。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReflect } from "../../server/reflect.mjs";

const reply = JSON.stringify({ zh: { headline: "在刷题", narrative: "……" }, en: { headline: "Drilling", narrative: "..." }, topics: [] });
const silent = { warn: () => undefined };

test("补完标题或标签后，缓存的叙事算过期（不会因为文档 id 没变就一直用旧的）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moye-reflect-"));
  try {
    const now = new Date().toISOString();
    const rows = [{ id: "a", created_at: now, page_count: 3, char_count: 100, mode: "ai", filename: "scan_001.pdf", tags: "[]", ai_title: null, ai_one_line: null }];
    const reflect = createReflect({ rows: () => rows, generate: async () => reply, dataDir: dir, log: silent });
    await reflect.build("1m", "zh", true);
    assert.equal((await reflect.build("1m", "zh")).stale, false);

    rows[0] = { ...rows[0], ai_title: "IB 物理试卷", tags: JSON.stringify(["物理"]) };
    assert.equal((await reflect.build("1m", "zh")).stale, true);
    // 过期会在后台重算；等它写完缓存再删临时目录
    while (reflect.isRegenerating("1m")) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await reflect.build("1m", "zh")).stale, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
