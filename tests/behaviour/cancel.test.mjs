// 「取消」的行为测试：真的队列 + 真的任务表（临时目录）+ 真的转换管线，模型和渲染是假的。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { JobCancelled, createConverter } from "../../server/convert.mjs";
import { JobStore } from "../../server/jobstore.mjs";
import { JobQueue } from "../../server/queue.mjs";
import { aiOk } from "../../lib/page-result.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "moye-cancel-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`等不到：${what}`);
}

const page = (n) => ({ page: n, markdown: `第 ${n} 页初稿，有一些文字`, charCount: 10, lineCount: 1, method: "text", status: "good", reasons: [], formulaCount: 0, optionCount: 0 });

test("管线：取消之后不再领新页，只把在途的那几页跑完", () =>
  withDir(async (dir) => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 20; i += 1) pdf.addPage([100, 100]);
    const pdfPath = join(dir, "source.pdf");
    await writeFile(pdfPath, await pdf.save());
    const previous = { pageCount: 20, pages: Array.from({ length: 20 }, (_, i) => page(i + 1)) };
    const signal = { cancelled: false };
    let calls = 0;
    const converter = createConverter({
      loadSettings: async () => ({ aiConfigured: true, aiScope: "all" }),
      renderer: { renderPages: async (_path, pages) => Object.fromEntries(pages.map((p) => [String(p), "jpeg"])) },
      refinePage: async ({ draft }) => {
        calls += 1;
        if (calls === 3) signal.cancelled = true;   // 第 3 页时用户点了取消
        await sleep(20);
        return { markdown: `${draft}（模型）`, model: "m" };
      },
      runSurya: async () => ({ pages: [] }),
      aiPageConcurrency: 2,
    });
    await assert.rejects(converter.refineExisting(pdfPath, "测试", previous, () => {}, null, { signal }), JobCancelled);
    assert.ok(calls <= 4, `取消后还调了 ${calls} 次模型（20 页里最多该是 3 + 在途 1）`);
  }));

/** 一个假的「跑一份文档」：每页之前看一眼 token，和 convert.mjs 的约定一样。 */
async function fakeRun(job, onProgress, token) {
  for (let i = 1; i <= 50; i += 1) {
    if (token.cancelled) throw new JobCancelled();
    await sleep(5);
    onProgress(i, 50, `第 ${i} 页`);
  }
  return { title: "新", mode: "ai", pageCount: 3, markdown: "新结果", pages: [1, 2, 3].map((n) => aiOk(page(n), { markdown: "新" })), durationMs: 1 };
}

async function doneJob(store, id) {
  store.create({ id, filename: `${id}.pdf`, fileSize: 1, mode: "ai" });
  await store.saveResult(id, { title: "旧", mode: "ai", pageCount: 3, markdown: "旧结果", pages: [1, 2, 3].map((n) => aiOk(page(n), { markdown: "旧" })), durationMs: 1 });
  store.update(id, { status: "done", page: 3, total: 3 });
}

test("新转换跑到一半被取消：记录标成已取消，没有结果", () =>
  withDir(async (dir) => {
    const store = new JobStore(dir);
    const queue = new JobQueue({ store, run: fakeRun });
    store.create({ id: "fresh", filename: "fresh.pdf", fileSize: 1, mode: "ai" });
    queue.enqueue("fresh");
    await waitFor(() => store.get("fresh").page >= 3, "跑起来");
    assert.equal(queue.cancel("fresh"), true);
    await waitFor(() => store.get("fresh").status === "cancelled", "标成已取消");
    assert.equal(await store.hasResult("fresh"), false);
  }));

test("重新精校跑到一半被取消：记录退回完成，旧结果原样不动（不再从 Library 消失）", () =>
  withDir(async (dir) => {
    const store = new JobStore(dir);
    const queue = new JobQueue({ store, run: fakeRun });
    await doneJob(store, "refine");
    store.update("refine", { status: "queued" });      // /refine 路由就是这么把它重新排队的
    queue.enqueue("refine");
    await waitFor(() => store.get("refine").status === "running" && store.get("refine").page >= 3, "跑起来");
    queue.cancel("refine");
    const job = await waitFor(() => (store.get("refine").status === "done" ? store.get("refine") : null), "退回完成");
    assert.match(job.detail, /保留原结果/);
    assert.equal((await store.readResult("refine")).markdown, "旧结果");
  }));

test("重新精校还在排队就被取消：同样退回完成", () =>
  withDir(async (dir) => {
    const store = new JobStore(dir);
    const queue = new JobQueue({ store, run: fakeRun });   // AI 模式默认一次只跑一份
    store.create({ id: "first", filename: "first.pdf", fileSize: 1, mode: "ai" });
    await doneJob(store, "waiting");
    queue.enqueue("first");
    store.update("waiting", { status: "queued" });
    queue.enqueue("waiting");
    await waitFor(() => store.get("first").status === "running", "第一份跑起来");
    assert.equal(store.get("waiting").status, "queued");
    queue.cancel("waiting");
    await waitFor(() => store.get("waiting").status === "done", "排队中的精校退回完成");
    assert.equal((await store.readResult("waiting")).markdown, "旧结果");
    queue.cancel("first");
    await waitFor(() => store.get("first").status === "cancelled", "第一份也停下");
  }));
