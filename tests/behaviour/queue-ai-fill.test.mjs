// AI 车道按页补满：在跑的文档剩下的页填不满全局预算才再开一份（server/queue.mjs 的 _admits）。
// 真的队列 + 真的任务表（临时目录），run 是假的：报出页数后等测试放行。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore } from "../../server/jobstore.mjs";
import { JobQueue } from "../../server/queue.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withQueue(budget, fn) {
  const dir = await mkdtemp(join(tmpdir(), "moye-fill-"));
  const release = new Map();   // job id → 让它跑完
  const pages = new Map();     // job id → 几页
  const store = new JobStore(dir);
  const run = (job, onProgress) => new Promise((resolve) => {
    const total = pages.get(job.id);
    onProgress(0, total, "开跑");
    release.set(job.id, () => resolve({ title: job.id, mode: "ai", pageCount: total, markdown: "x", pages: [], durationMs: 1 }));
  });
  const queue = new JobQueue({ store, run, aiPageBudget: () => budget });
  const add = (id, n) => {
    pages.set(id, n);
    store.create({ id, filename: `${id}.pdf`, fileSize: 1, mode: "ai" });
    queue.enqueue(id);
  };
  const running = () => queue.status().active.sort();
  try {
    await fn({ add, running, release, queue });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("很多小文档：一起跑到填满预算，而不是一次一份", () =>
  withQueue(20, async ({ add, running }) => {
    for (let i = 0; i < 15; i += 1) add(`s${String(i).padStart(2, "0")}`, 2);
    await sleep(50);
    // 每份 2 页：前 8 份（硬上限）都该开，剩下的排着
    assert.equal(running().length, 8);
  }));

test("大书一份就填满预算：后面的小文档排着，不去摊薄它", () =>
  withQueue(20, async ({ add, running, release }) => {
    add("book", 300);
    add("small", 2);
    await sleep(50);
    assert.deepEqual(running(), ["book"]);
    release.get("book")();
    await sleep(50);
    assert.deepEqual(running(), ["small"]);
  }));

test("剩下的页填不满时才放下一份：18 页 + 2 页刚好满，第三份等", () =>
  withQueue(20, async ({ add, running, release }) => {
    add("a", 18);
    add("b", 2);
    add("c", 2);
    await sleep(50);
    assert.deepEqual(running(), ["a", "b"]);
    release.get("b")();
    await sleep(50);
    assert.deepEqual(running(), ["a", "c"]);
  }));
