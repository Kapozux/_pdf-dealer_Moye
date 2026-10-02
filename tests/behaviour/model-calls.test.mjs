// 模型调用的两条底线：超时管到读完正文为止；OpenRouter 换家不超出这一页的总预算。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fetchWithTimeout } from "../../server/fetch-timeout.mjs";
import { failoverChain } from "../../server/openrouter-failover.mjs";

/** 本机起一个假上游，handler 决定怎么回。 */
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("正常响应：读好的正文直接给调用方", () =>
  withServer((req, res) => res.end(JSON.stringify({ ok: true })), async (url) => {
    const response = await fetchWithTimeout(url, {}, 2000);
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), { ok: true });
  }));

test("上游先回响应头、正文迟迟不发完：照样按时超时（以前会一直挂着）", () =>
  withServer((req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"choices":'); }, async (url) => {
    const started = Date.now();
    await assert.rejects(fetchWithTimeout(url, {}, 300), /请求超时/);
    assert.ok(Date.now() - started < 2000, "超时没生效");
  }));

/** 假时钟 + 假调用：调用会把时钟往前拨它花掉的时间。 */
function rig({ behave }) {
  const clock = { t: 0 };
  const calls = [];
  const health = { down: new Set(), failures: [], successes: [], isDown: (m) => health.down.has(m), success: (m) => health.successes.push(m), failure: (m) => health.failures.push(m) };
  const call = async (attempt) => {
    calls.push(attempt);
    assert.ok(attempt.timeoutMs > 0);
    return behave(attempt, clock);
  };
  return { clock, calls, health, call, now: () => clock.t };
}
const providers = ["CoreWeave", "Parasail", "Inceptron", "Baidu", "Cloudflare"];
const timesOut = (attempt, clock) => { clock.t += attempt.timeoutMs; throw new Error("请求超时"); };

test("补救轮（单次 25s、总预算 27s）：只试一家，不会跑到 52 秒", async () => {
  const r = rig({ behave: timesOut });
  await assert.rejects(failoverChain({ models: ["kimi"], providers, perTryMs: 25000, budgetMs: 27000, call: r.call, health: r.health, now: r.now }));
  assert.equal(r.calls.length, 1);
  assert.ok(r.clock.t <= 27000, `花了 ${r.clock.t}ms`);
  assert.deepEqual(r.health.failures, [], "只来得及试一家，不该记模型失败");
});

test("主轮（单次 30s、总预算 150s）全部超时：试满 5 家就停，总耗时不超预算，记一次模型失败", async () => {
  const r = rig({ behave: timesOut });
  await assert.rejects(failoverChain({ models: ["kimi", "glm"], providers, perTryMs: 30000, budgetMs: 150000, call: r.call, health: r.health, now: r.now }));
  assert.equal(r.calls.length, 5);
  assert.ok(r.clock.t <= 150000, `花了 ${r.clock.t}ms`);
  assert.deepEqual(r.health.failures, ["kimi"]);
  for (const attempt of r.calls) assert.ok(attempt.deadline <= 150000, "单次的截止时间超出了整页预算");
});

test("一个模型在所有供应商上都立刻失败：记它一次失败，换下一个模型成功", async () => {
  const r = rig({ behave: (attempt, clock) => { clock.t += 1000; if (attempt.model === "kimi") throw new Error("（404）No endpoints found"); return "好"; } });
  const { result, model } = await failoverChain({ models: ["kimi", "glm"], providers, perTryMs: 30000, budgetMs: 150000, call: r.call, health: r.health, now: r.now });
  assert.equal(result, "好");
  assert.equal(model, "glm");
  assert.equal(r.calls.filter((c) => c.model === "kimi").length, 6);   // 不钉死 1 次 + 5 家
  assert.deepEqual(r.health.failures, ["kimi"]);
  assert.deepEqual(r.health.successes, ["glm"]);
});

test("已熔断的模型直接跳过；全都熔断了就还用它们，不至于一个都不试", async () => {
  const r = rig({ behave: (attempt, clock) => { clock.t += 1000; return attempt.model; } });
  r.health.down.add("kimi");
  assert.equal((await failoverChain({ models: ["kimi", "glm"], providers, perTryMs: 30000, budgetMs: 150000, call: r.call, health: r.health, now: r.now })).model, "glm");
  r.health.down.add("glm");
  assert.equal((await failoverChain({ models: ["kimi", "glm"], providers, perTryMs: 30000, budgetMs: 150000, call: r.call, health: r.health, now: r.now })).model, "kimi");
});
