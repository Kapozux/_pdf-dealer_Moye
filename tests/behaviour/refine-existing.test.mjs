// 「只重跑回退页」端到端：真 PDF + 注入的假模型 / 假渲染器，经 createConverter 的接口跑。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { createConverter } from "../../server/convert.mjs";
import { aiFailed, aiNoText, aiOk, outcome } from "../../lib/page-result.mjs";

async function threePagePdf(dir) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i += 1) pdf.addPage([200, 200]);
  const path = join(dir, "source.pdf");
  await writeFile(path, await pdf.save());
  return path;
}

const page = (n, markdown) => ({ page: n, markdown, charCount: 0, lineCount: 1, method: "text", status: "good", reasons: [], formulaCount: 0, optionCount: 0 });

test("只重跑回退页：成功页和 noText 页原样保留，只给回退页调模型", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moye-test-"));
  try {
    const pdfPath = await threePagePdf(dir);
    const previous = {
      pageCount: 3,
      pages: [
        { ...aiOk(page(1, "初稿一"), { markdown: "模型一", model: "m" }), durationMs: 100 },
        { ...aiNoText(page(2, ""), { note: "blank page", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }), modelMs: 50 },
        { ...aiFailed(page(3, "第三页文字层"), new Error("上游超时")), modelMs: 999, usage: { inputTokens: 9, outputTokens: 9, costUsd: 9 } },
      ],
    };
    const calls = [];
    const converter = createConverter({
      loadSettings: async () => ({ aiConfigured: true, aiScope: "all" }),
      renderer: { renderPages: async (_path, pages) => Object.fromEntries(pages.map((p) => [String(p), "jpeg-base64"])) },
      refinePage: async ({ page: n, draft }) => {
        calls.push({ n, draft });
        return { markdown: "第三页模型结果，比初稿更完整一些", model: "m2", provider: "gemini" };
      },
      runSurya: async () => { throw new Error("AI 模式不该调 Surya"); },
      aiPageConcurrency: 2,
    });

    const result = await converter.refineExisting(pdfPath, "测试", previous, () => {}, null, { only: "fallback" });

    assert.deepEqual(calls.map((c) => c.n), [3]);
    assert.equal(calls[0].draft, "第三页文字层");                       // 交给模型的是初稿，不是上一轮的输出
    assert.deepEqual(result.pages.map(outcome), ["ai", "noText", "ai"]);
    assert.equal(result.pages[0].markdown, "模型一");
    assert.equal(result.pages[2].markdown, "第三页模型结果，比初稿更完整一些");
    assert.equal(result.pages[2].usage, undefined);                      // 上一轮的 9 美元不能冒充这次的用量
    assert.deepEqual(result.pages[2].reasons, []);                       // 上一轮的「AI 识别失败」不再带着
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("重跑又失败：上一轮的用量和 noText 不能冒充这一轮的", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moye-test-"));
  try {
    const pdfPath = await threePagePdf(dir);
    const staleUsage = { inputTokens: 9, outputTokens: 9, costUsd: 9 };
    const previous = {
      pageCount: 3,
      pages: [
        { ...aiFailed(page(1, "第一页文字层"), new Error("429")), usage: staleUsage },
        { ...aiNoText(page(2, "第二页文字层"), { note: "photo", usage: staleUsage }) },
        { ...aiFailed(page(3, "第三页文字层"), new Error("429")), uncertain: ["旧的不确定"] },
      ],
    };
    const converter = createConverter({
      loadSettings: async () => ({ aiConfigured: true, aiScope: "all" }),
      renderer: { renderPages: async (_path, pages) => Object.fromEntries(pages.map((p) => [String(p), "jpeg-base64"])) },
      refinePage: async () => { throw new Error("上游还是超时"); },
      runSurya: async () => ({ pages: [] }),
      aiPageConcurrency: 3,
    });
    const result = await converter.refineExisting(pdfPath, "测试", previous, () => {}, null, { only: "all" });
    assert.deepEqual(result.pages.map(outcome), ["fallback", "fallback", "fallback"]);
    for (const p of result.pages) {
      assert.equal(p.usage, undefined, `第 ${p.page} 页带着上一轮的用量`);
      assert.equal(p.noText, undefined, `第 ${p.page} 页带着上一轮的 noText`);
      assert.equal(p.uncertain, undefined, `第 ${p.page} 页带着上一轮的 uncertain`);
      assert.equal(p.reasons.filter((r) => r.startsWith("AI 识别失败")).length, 1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("没有回退页时拒绝重跑，不白花一次模型调用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moye-test-"));
  try {
    const pdfPath = await threePagePdf(dir);
    const previous = { pageCount: 3, pages: [1, 2, 3].map((n) => aiOk(page(n, `初稿${n}`), { markdown: `模型${n}`, model: "m" })) };
    const converter = createConverter({
      loadSettings: async () => ({ aiConfigured: true, aiScope: "all" }),
      renderer: { renderPages: async () => ({}) },
      refinePage: async () => { throw new Error("不该调用模型"); },
      runSurya: async () => ({ pages: [] }),
    });
    await assert.rejects(converter.refineExisting(pdfPath, "测试", previous, () => {}, null, { only: "fallback" }), /没有回退的页面需要重跑/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
