// 报错分类的行为测试。用例全部取自墨页库里真实出现过的报错原文（2026-10-02 统计）。
import assert from "node:assert/strict";
import test from "node:test";
import { explainError, summarizeCauses } from "../../lib/explain-error.mjs";
import { aiFailed, aiNoText, aiOk, aiRejected, fallbackCause, parseAiReason } from "../../lib/page-result.mjs";

const real = [
  ["请求超时（34s 未返回）。", "timeout", true],
  ["fetch failed", "network", true],
  ["模型请求失败（429）：Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.", "credits", false],
  ["模型请求失败（402）：Your prepayment credits are depleted. Please go to AI Studio", "credits", false],
  ["模型请求失败（400）：<400> InternalError.Algo.InvalidParameter: Model output became abnormal while generating a JSON response for response_format.", "badOutput", true],
  ["模型请求失败（404）：No endpoints found for qwen/qwen3.7-flash.", "model", false],
  ["模型没有返回有效 JSON。", "badOutput", true],
  ["Unterminated string in JSON at position 1920 (line 1 column 1921)", "badOutput", true],
  ["模型返回了空白 Markdown。", "badOutput", true],
  ["模型请求失败（401）：Invalid Authentication", "auth", false],
  ["模型请求失败（401）：Incorrect API key provided", "auth", false],
  ["The PDF file is empty, i.e. its size is zero bytes.", "emptyFile", false],
  ["页面渲染超时（48 页，68s 未完成）。", "timeout", true],
  ["连不上本机 Ollama（http://127.0.0.1:11434）：ECONNREFUSED。请确认 Ollama 已经打开（菜单栏有它的图标）。", "network", true],
  ["请先在设置中填写 Kimi API Key。", "auth", false],
];

test("库里真实出现过的报错都归到对的类别，重跑有没有用也对", () => {
  for (const [message, kind, retryHelps] of real) {
    const explained = explainError(message);
    assert.equal(explained.kind, kind, message);
    assert.equal(explained.retryHelps, retryHelps, message);
    assert.equal(explained.detail, message.trim());
  }
});

test("Gemini 额度用完时回的是 429：算「额度用完」（重跑没用），不算「限流」（重跑有用）", () => {
  assert.equal(explainError("模型请求失败（429）：Your prepayment credits are depleted.").kind, "credits");
  assert.equal(explainError("模型请求失败（429）：Resource has been exhausted (e.g. check quota). RESOURCE_EXHAUSTED").kind, "rateLimit");
});

test("没见过的报错不瞎猜：归为「原因不明」，原文照样留着", () => {
  const explained = explainError("Something odd happened upstream");
  assert.equal(explained.kind, "unknown");
  assert.equal(explained.retryHelps, null);
  assert.equal(explained.detail, "Something odd happened upstream");
});

test("没过程序校验的不按报错文本分类", () => {
  assert.deepEqual(explainError("模型结果比本地初稿短太多", "check"), { kind: "rejected", retryHelps: true, detail: "模型结果比本地初稿短太多" });
});

const draft = { page: 7, markdown: "第七页文字层", charCount: 6, lineCount: 1, method: "text", status: "good", reasons: ["文字层过少；扫描页或公式页请改用本地高精度"], formulaCount: 0, optionCount: 0 };

test("从页结果里读回原始报错：和写进去的一字不差", () => {
  const failed = aiFailed(draft, new Error("请求超时（34s 未返回）。"));
  assert.deepEqual(fallbackCause(failed), { stage: "call", message: "请求超时（34s 未返回）。", pageEmpty: false });
  const blank = aiFailed({ ...draft, markdown: "" }, new Error("fetch failed"));
  assert.deepEqual(fallbackCause(blank), { stage: "call", message: "fetch failed", pageEmpty: true });
  const rejected = aiRejected(draft, { model: "m" }, ["模型结果丢失了本地已识别公式", "模型结果丢失了选项标签"]);
  assert.deepEqual(fallbackCause(rejected), { stage: "check", message: "模型结果丢失了本地已识别公式；模型结果丢失了选项标签", pageEmpty: false });
});

test("不是 AI 失败的原因、不是回退页，都返回 null", () => {
  assert.equal(parseAiReason("文字层过少；扫描页或公式页请改用本地高精度"), null);
  assert.equal(parseAiReason("模型标记不确定：第二行"), null);
  assert.equal(fallbackCause(aiOk(draft, { markdown: "好" })), null);
  assert.equal(fallbackCause(aiNoText(draft, { note: "photo" })), null);
});

test("汇总一批回退页：按页数排序，标出结果为空的页和重跑没用的类别", () => {
  const pages = [
    aiFailed(draft, new Error("请求超时（34s 未返回）。")),
    aiFailed(draft, new Error("请求超时（30s 未返回）。")),
    aiFailed({ ...draft, markdown: "" }, new Error("模型请求失败（402）：Your prepayment credits are depleted.")),
  ];
  const summary = summarizeCauses(pages.map(fallbackCause));
  assert.deepEqual(summary.byKind, [{ kind: "timeout", pages: 2 }, { kind: "credits", pages: 1 }]);
  assert.equal(summary.emptyPages, 1);
  assert.deepEqual(summary.blockers, [{ kind: "credits", pages: 1 }]);
});
