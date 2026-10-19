// 「问」查正文（server/find.mjs 的 findDeep + server/look.mjs）：look 在临时数据目录上真跑；Claude 是假的。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { findDeep, parseDeepAnswer, stepOf } from "../../server/find.mjs";

const LOOK = join(import.meta.dirname, "../../server/look.mjs");
const A = "aaaa1111-0000-0000-0000-000000000001";
const B = "bbbb2222-0000-0000-0000-000000000002";

function makeLibrary() {
  const dir = mkdtempSync(join(tmpdir(), "moye-look-"));
  const db = new DatabaseSync(join(dir, "moye.db"));
  db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, filename TEXT, created_at TEXT, page_count INTEGER, tags TEXT, ai_title TEXT, ai_one_line TEXT, mode TEXT, fallback_count INTEGER, review_count INTEGER, status TEXT)");
  const add = db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', 0, 0, ?)");
  add.run(A, "B.1.3.pdf", "2026-09-23T10:00:00Z", 2, '["物理"]', "比热容练习", "测汽化潜热", "done");
  add.run(B, "notes.pdf", "2026-10-01T10:00:00Z", 1, "[]", "英语笔记", "", "running");
  db.close();
  mkdirSync(join(dir, "jobs", A), { recursive: true });
  writeFileSync(join(dir, "jobs", A, "result.json"), JSON.stringify({ pages: [
    { page: 1, markdown: "# Question 1\nA heater boils water." },
    { page: 2, markdown: "Plot power against mass lost; the gradient gives the latent heat." },
  ] }));
  return dir;
}

const look = (dir, ...args) => execFileSync(process.execPath, [LOOK, ...args], { env: { ...process.env, MOYE_DATA_DIR: dir }, encoding: "utf8" });

test("look：search 查正文和标题、只列已完成的；hits / read 带页码；info 列小标题", () => {
  const dir = makeLibrary();
  try {
    const found = look(dir, "search", "latent heat", "heater");
    assert.match(found, /\[\[d:aaaa1111\]\] 比热容练习/);
    assert.match(found, /\[\[d:aaaa1111@p2\]\]/);
    assert.doesNotMatch(look(dir, "list"), /英语笔记/);
    assert.match(look(dir, "search", "latent", "不存在的词"), /没有同时提到/);
    assert.match(look(dir, "search", "latent", "不存在的词", "--any"), /比热容练习/);
    assert.match(look(dir, "hits", "aaaa1111", "gradient"), /@p2\]\] .*gradient/);
    assert.match(look(dir, "read", "aaaa", "--at", "gradient"), /第 2\/2 页/);
    assert.match(look(dir, "info", "aaaa1111"), /p1 Question 1/);
    assert.match(look(dir, "read", "zzzz9999"), /认不出短号/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("look 打开数据库是只读的：拿它写不进去", () => {
  const dir = makeLibrary();
  try {
    const db = new DatabaseSync(join(dir, "moye.db"), { readOnly: true });
    assert.throws(() => db.exec("DELETE FROM jobs"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const jobs = [
  { id: A, status: "done", filename: "B.1.3.pdf", ai_title: "比热容练习", page_count: 2 },
  { id: "aaaa1111-ffff", status: "done", filename: "同前缀.pdf", ai_title: "另一份", page_count: 1 },
  { id: B, status: "running", filename: "notes.pdf", ai_title: "英语笔记", page_count: 1 },
];

test("stepOf：命令认成一步，短号换成标题；不是 look 的命令不算", () => {
  assert.deepEqual(stepOf(`/x/node /y/server/look.mjs search "latent heat" 潜热 --n 10`), { k: "search", d: "latent heat 潜热" });
  assert.deepEqual(stepOf(`node /y/server/look.mjs read ${A.slice(0, 12)} --page 2`, jobs), { k: "read", d: "比热容练习 · p2" });
  assert.equal(stepOf("ls -la"), null);
});

test("parseDeepAnswer：有歧义的短号、没完成的、重复的丢掉；页码越界当没说", () => {
  const { results, note } = parseDeepAnswer(JSON.stringify({ results: [
    { d: "aaaa1111", page: 2, why: "短号前 8 位有两份同前缀，认不准" },
    { d: A.slice(0, 13), page: 9, why: "页码越界" },
    { d: A.slice(0, 13), page: 1, why: "重复" },
    { d: "bbbb2222", page: 1, why: "还在跑" },
  ], note: "查了潜热" }), jobs);
  assert.deepEqual(results.map((r) => [r.job.id, r.page, r.why]), [[A, null, "页码越界"]]);
  assert.equal(note, "查了潜热");
});

test("findDeep：步骤一条条报出来，提示里写着放行的命令和问题", async () => {
  const steps = [];
  let prompt = "";
  const found = await findDeep("那道测汽化潜热的题", {
    listJobs: () => jobs,
    look: "/x/node /y/server/look.mjs",
    onStep: (s) => steps.push(s),
    agent: async (p, onTool) => {
      prompt = p;
      onTool('/x/node /y/server/look.mjs search "latent heat"');
      onTool("rm -rf /");
      return `{"results":[{"d":"${A.slice(0, 13)}","page":2,"why":"第 2 页是功率-质量图像"}],"note":""}`;
    },
  });
  assert.match(prompt, /那道测汽化潜热的题/);
  assert.match(prompt, /\/x\/node \/y\/server\/look\.mjs <命令>/);
  assert.deepEqual(steps, [{ k: "search", d: "latent heat" }]);
  assert.deepEqual(found, { results: [{ id: A, why: "第 2 页是功率-质量图像", page: 2 }], considered: 2, mode: "deep", note: "", steps: 1 });
});
