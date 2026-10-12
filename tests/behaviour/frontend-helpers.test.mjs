// 前端纯函数的行为测试：lib/api.ts、lib/i18n.ts 直接按 .ts 导入（Node 自带的类型擦除），不 build、不碰服务。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { refineCostPerPage } from "../../lib/api.ts";
import { setActiveLang, tServer } from "../../lib/i18n.ts";

const row = (key, calls, costUsd, unpriced = 0) => ({ key, calls, costUsd, unpriced, inputTokens: 0, outputTokens: 0 });
const usage = (month, all) => ({ by: { purpose: { month, all } } });

test("每页花费只看 refine 的账：回顾 / 打标签的费用不算进去", () => {
  const u = usage([], [row("reflect", 100, 7), row("card", 30, 0.5), row("refine", 100, 0.5)]);
  assert.equal(refineCostPerPage(u), 0.005);
});

test("没计价的调用（直连 Kimi / Qwen）不进分母", () => {
  assert.equal(refineCostPerPage(usage([], [row("refine", 120, 0.5, 20)])), 0.005);
});

test("本月样本够就用本月，不够退回累计；都不够不给数", () => {
  assert.equal(refineCostPerPage(usage([row("refine", 40, 0.4)], [row("refine", 400, 0.8)])), 0.01);
  assert.equal(refineCostPerPage(usage([row("refine", 5, 5)], [row("refine", 400, 0.8)])), 0.002);
  assert.equal(refineCostPerPage(usage([], [row("refine", 2, 0.1)])), null);
  assert.equal(refineCostPerPage(usage([], [])), null);
  assert.equal(refineCostPerPage(null), null);
});

test("md2pdf.mjs 里每一条报错在英文界面都有翻译（文案改了这里会挂）", async () => {
  const source = await readFile(new URL("../../server/md2pdf.mjs", import.meta.url), "utf8");
  const messages = [...source.matchAll(/new Error\(`([^`]+)`\)/g)].map((m) => m[1].replace(/\$\{[^}]+\}/g, "1"));
  assert.ok(messages.length >= 3, "没从 md2pdf.mjs 里找到报错文案");
  setActiveLang("en");
  try {
    for (const message of messages) assert.notEqual(tServer(message), message, `没有翻译：${message}`);
  } finally {
    setActiveLang("zh");
  }
});
