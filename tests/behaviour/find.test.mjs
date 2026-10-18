// 「问」（server/find.mjs）：目录怎么交给模型、模型的回答怎么对回真实文档。模型是假的。
import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, findDocuments } from "../../server/find.mjs";

const job = (id, title, extra = {}) => ({
  id, status: "done", filename: `${id}.pdf`, ai_title: title, ai_one_line: `${title}的简介`,
  tags: JSON.stringify(["物理"]), created_at: "2026-10-01T00:00:00Z", page_count: 3, ...extra,
});
const jobs = [job("a", "热传导作业"), job("b", "鲁迅小说精读"), job("c", "还在跑", { status: "running" })];

test("只把已完成的交给模型，模型选的编号对回真实任务", async () => {
  let prompt = "";
  const found = await findDocuments("热学那份作业", {
    listJobs: () => jobs,
    ask: async (p) => { prompt = p; return '好的：{"results":[{"n":1,"why":"讲热传导"}]}'; },
  });
  assert.match(prompt, /热学那份作业/);
  assert.match(prompt, /热传导作业/);
  assert.doesNotMatch(prompt, /还在跑/);
  assert.deepEqual(found, { results: [{ id: "a", why: "讲热传导" }], considered: 2 });
});

test("模型编出来的编号、重复的编号都丢掉", async () => {
  const found = await findDocuments("随便", {
    listJobs: () => jobs,
    ask: async () => '{"results":[{"n":9,"why":"编的"},{"n":2,"why":"是它"},{"n":2,"why":"又一次"}]}',
  });
  assert.deepEqual(found.results, [{ id: "b", why: "是它" }]);
});

test("一份都不像：空结果，不报错", async () => {
  const found = await findDocuments("量子力学", { listJobs: () => jobs, ask: async () => '{"results":[]}' });
  assert.deepEqual(found.results, []);
});

test("模型没回 JSON：报错并带上原文开头（不静默当成没找到）", async () => {
  await assert.rejects(
    findDocuments("x", { listJobs: () => jobs, ask: async () => "抱歉我无法完成" }),
    /没有返回 JSON：抱歉我无法完成/,
  );
});

test("空问题：400，不去调模型", async () => {
  await assert.rejects(
    findDocuments("   ", { listJobs: () => jobs, ask: async () => { throw new Error("不该调"); } }),
    (error) => error.httpStatus === 400,
  );
});

test("目录太长：先去掉简介和标签，标题都留着", () => {
  const many = Array.from({ length: 50 }, (_, i) => job(`j${i}`, `标题${i}`, { ai_one_line: "很长的简介".repeat(20) }));
  const { text } = buildCatalog(many, 3000);
  assert.ok(text.length <= 3000 + 200, `目录 ${text.length} 字`);
  assert.match(text, /标题49/);
  assert.doesNotMatch(text, /很长的简介/);
});
