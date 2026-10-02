// 「一页最后算什么」的行为测试：只经过 lib/page-result.mjs 的接口，不看实现。
import assert from "node:assert/strict";
import test from "node:test";
import { aiFailed, aiNoText, aiOk, aiRejected, countFallback, isFallback, outcome, toDraft } from "../../lib/page-result.mjs";

const draft = {
  page: 3,
  markdown: "1. 已知 $x^2=4$，求 x。\nA. 2\nB. -2",
  charCount: 20,
  lineCount: 3,
  method: "text",
  status: "good",
  reasons: [],
  formulaCount: 1,
  optionCount: 2,
};
const reply = { markdown: "1. 已知 $x^2=4$，求 $x$。\nA. 2\nB. -2", model: "m", provider: "gemini", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } };

test("四种结局：采用、没有文字、回退、没交给模型", () => {
  assert.equal(outcome(aiOk(draft, reply)), "ai");
  assert.equal(outcome(aiNoText(draft, { note: "photo of a cat" })), "noText");
  assert.equal(outcome(aiRejected(draft, reply, ["模型结果比本地初稿短太多"])), "fallback");
  assert.equal(outcome(aiFailed(draft, new Error("timeout"))), "fallback");
  assert.equal(outcome(draft), "local");
});

test("noText 不算回退——风景照不该记成「识别失败」", () => {
  const photo = aiNoText(draft, { note: "photo of a cat" });
  assert.equal(isFallback(photo), false);
  assert.equal(photo.markdown, "");
  assert.deepEqual(photo.reasons, ["AI 检测：未发现可提取的文字（photo of a cat）"]);
});

test("没有 aiAttempted / noText 字段的老记录照样判对", () => {
  const legacy = [
    { page: 1, method: "ai" },
    { page: 2, method: "text", aiAttempted: true },
    { page: 3, method: "surya", aiAttempted: true },
    { page: 4, method: "text" },
    null,
  ];
  assert.deepEqual(legacy.map(outcome), ["ai", "fallback", "fallback", "local", "local"]);
  assert.equal(countFallback(legacy), 2);
});

test("调用失败：回退初稿，带上原因和补救轮标记", () => {
  const failed = aiFailed(draft, new Error("上游超时"));
  assert.equal(failed.markdown, draft.markdown);
  assert.equal(failed.aiFailed, true);
  assert.equal(failed.status, "review");
  assert.deepEqual(failed.reasons, ["AI 识别失败，已回退 PDF 文字层：上游超时"]);
  const blank = aiFailed({ ...draft, markdown: "" }, new Error("x"));
  assert.match(blank.reasons[0], /没有文字层可回退/);
});

test("采用模型结果：模型自己标的不确定进 reasons，用量只在有时才写", () => {
  const ok = aiOk(draft, { ...reply, markdown: "看不清 [unclear]", uncertain: ["第二行"] });
  assert.equal(ok.status, "review");
  assert.deepEqual(ok.reasons, ["模型标记不确定：第二行", "结果中仍有无法辨认的符号"]);
  assert.equal(ok.rawMarkdown, draft.markdown);
  assert.equal("usage" in aiOk(draft, { markdown: "好", model: "m" }), false);
  assert.equal(aiOk(draft, reply).status, "good");
});

test("toDraft：上一轮 AI 留下的字段一个都不带进新初稿", () => {
  const previous = { ...aiNoText(draft, { note: "photo", usage: reply.usage }), durationMs: 900, modelMs: 800 };
  const next = toDraft(previous);
  for (const key of ["noText", "note", "uncertain", "usage", "durationMs", "modelMs", "model", "provider", "rawMarkdown", "aiFailed"]) {
    assert.equal(key in next, false, `${key} 不该带进初稿`);
  }
  assert.equal(next.markdown, draft.markdown);   // 用的是交给模型的那份初稿，不是模型输出
  assert.equal(next.aiAttempted, false);
  assert.equal(outcome(next), "local");
});

test("toDraft：剥掉 AI 写的原因，保留初稿自己的；重跑多次不叠加", () => {
  const ownReason = "文字层过少；扫描页或公式页请改用本地高精度";
  let page = aiFailed({ ...draft, reasons: [ownReason] }, new Error("429"));
  for (let round = 0; round < 3; round += 1) page = aiFailed(toDraft(page), new Error("429"));
  assert.deepEqual(toDraft(page).reasons, [ownReason]);
  assert.equal(page.reasons.length, 2);
});

test("toDraft：status 沿用上一轮——回退页仍是 review，AI 范围不是全部页时也会被重跑", () => {
  assert.equal(toDraft(aiFailed(draft, new Error("x"))).status, "review");
});
