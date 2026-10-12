// 任务表的行为测试：真的 JobStore（临时目录），只经过它的接口。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore } from "../../server/jobstore.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "moye-jobstore-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function doneJob(store, id, mode, secPerPage) {
  store.create({ id, filename: `${id}.pdf`, fileSize: 1, mode });
  await store.saveResult(id, { mode, pageCount: 2, markdown: "x", pages: [], durationMs: secPerPage * 2000 });
  store.update(id, { status: "done" });
}

test("预计速度按模式各取最近的样本：冷门模式不会被热门模式挤出窗口", () =>
  withDir(async (dir) => {
    const store = new JobStore(dir);
    for (let i = 0; i < 3; i += 1) await doneJob(store, `fast${i}`, "fast", 4);
    await sleep(5);
    for (let i = 0; i < 420; i += 1) await doneJob(store, `ai${i}`, "ai", 9);
    const table = store.speedTable();
    assert.deepEqual(table.fast, { n: 3, secPerPage: 4 });
    assert.deepEqual(table.ai, { n: 50, secPerPage: 9 });
  }));

test("重启恢复：源文件在就重新排队，不在就标失败", () =>
  withDir(async (dir) => {
    const store = new JobStore(dir);
    store.create({ id: "has", filename: "has.pdf", fileSize: 1, mode: "fast" });
    store.create({ id: "lost", filename: "lost.pdf", fileSize: 1, mode: "fast" });
    await writeFile(store.sourcePath("has"), "%PDF-1.4");
    const requeued = [];
    const summary = await store.recover((job) => requeued.push(job.id));
    assert.deepEqual(summary, { requeued: 1, failed: 1 });
    assert.deepEqual(requeued, ["has"]);
    assert.equal(store.get("lost").status, "failed");
  }));
