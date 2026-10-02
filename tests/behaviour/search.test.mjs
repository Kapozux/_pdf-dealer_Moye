// 资料库全文搜索和卡片预览。
import assert from "node:assert/strict";
import test from "node:test";
import { createSearchIndex, previewOf } from "../../server/search.mjs";

function library(docs) {
  const store = new Map(Object.entries(docs).map(([id, pages]) => [id, { updated_at: "t1", pages }]));
  let loads = 0;
  const index = createSearchIndex({
    listDone: () => [...store].map(([id, doc]) => ({ id, updated_at: doc.updated_at })),
    loadPages: async (id) => { loads += 1; return store.get(id).pages; },
  });
  return { index, store, loads: () => loads };
}

test("中文两个字的词也搜得到，命中带页码和前后文", async () => {
  const { index } = library({
    a: [{ page: 1, markdown: "# 标题" }, { page: 2, markdown: "这是鲁迅在《呐喊》自序里写的一段话。" }],
    b: [{ page: 1, markdown: "和鲁迅无关" }],
  });
  const results = await index.search("鲁迅");
  assert.deepEqual(results.map((r) => r.id).sort(), ["a", "b"]);
  const hit = results.find((r) => r.id === "a").hits[0];
  assert.equal(hit.page, 2);
  assert.equal(hit.match, "鲁迅");
  assert.match(hit.before + hit.match + hit.after, /这是鲁迅在《呐喊》自序/);
});

test("英文不分大小写，原文的大小写照原样显示；按命中次数排", async () => {
  const { index } = library({
    one: [{ page: 1, markdown: "Integration by parts" }],
    many: [{ page: 3, markdown: "integration, INTEGRATION, Integration" }],
  });
  const results = await index.search("integration");
  assert.deepEqual(results.map((r) => [r.id, r.count]), [["many", 3], ["one", 1]]);
  assert.equal(results[1].hits[0].match, "Integration");
});

test("片段去掉 Markdown 记号，太长的两头用省略号", async () => {
  const { index } = library({ d: [{ page: 1, markdown: `${"甲".repeat(80)} **重点** ${"乙".repeat(80)}` }] });
  const [{ hits: [hit] }] = await index.search("重点");
  assert.ok(hit.before.startsWith("…") && hit.after.endsWith("…"));
  assert.doesNotMatch(hit.before + hit.after, /\*/);
});

test("一个字不搜（太泛）；没有命中返回空", async () => {
  const { index } = library({ d: [{ page: 1, markdown: "鲁迅" }] });
  assert.deepEqual(await index.search("鲁"), []);
  assert.deepEqual(await index.search("周树人"), []);
});

test("删掉的文档搜不到了，重新精校过的读新内容，没变的不重读", async () => {
  const { index, store, loads } = library({ keep: [{ page: 1, markdown: "旧内容" }], gone: [{ page: 1, markdown: "旧内容" }] });
  assert.equal((await index.search("旧内容")).length, 2);
  store.delete("gone");
  store.set("keep", { updated_at: "t2", pages: [{ page: 1, markdown: "新内容" }] });
  assert.deepEqual(await index.search("旧内容"), []);
  assert.equal((await index.search("新内容")).length, 1);
  const before = loads();
  await index.search("新内容");
  assert.equal(loads(), before, "没变的文档不该重读");
});

test("卡片预览跳过墨页自己写的标题、说明、分页标题和空页提示", () => {
  const md = "# 鲁迅作业\n\n> 由墨页转换，共 3 页。由视觉模型直接识别 3/3 页。\n\n## PDF 第 1 页\n\n小说文体的阅读方法\n\n---\n\n## PDF 第 2 页\n\n_[此页未检测到文字，请查看原始 PDF。]_\n\n---\n\n## 第 3 张图\n\n**细读**《祝福》";
  assert.equal(previewOf(md), "小说文体的阅读方法 细读《祝福》");
});

test("卡片预览里的图片和链接只留文字", () => {
  assert.equal(previewOf("# t\n\n![《如何阅读一本小说》封面](images/p1.png) 见[官网](https://example.com)"), "《如何阅读一本小说》封面 见官网");
});
