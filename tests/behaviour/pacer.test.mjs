// 自适应节流器：只经过 AdaptivePacer 的接口。
import assert from "node:assert/strict";
import test from "node:test";
import { AdaptivePacer } from "../../server/pacer.mjs";

test("configure 把上限降到 min 以下后，失败退让也不会超过新上限", async () => {
  const pacer = new AdaptivePacer({ minPerChannel: 2 });
  pacer.configure([{ provider: "p", weight: 8 }]);
  pacer.configure([{ provider: "p", weight: 1 }]);
  await assert.rejects(pacer.run(async () => { throw new Error("boom"); }));
  const [lane] = pacer.stats().lanes;
  assert.ok(lane.limit <= lane.max, `limit ${lane.limit} > max ${lane.max}`);
});
