// AI 设置的行为测试：页面的 Key 行 → 保存请求 → 服务端合并写盘，整条走一遍。
// 钉住的是 CLAUDE.md 第四节那条：用户看得见已存的 Key，保存不会误覆盖、误删。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { maskedKey, mergeExtraKeys, newRow, rowsFromSaved, rowsToPayload, splitKeys } from "../../lib/key-pool.mjs";
import { createSettingsStore, defaultSettings, providerConfigured } from "../../server/settings.mjs";

const A = "AIzaSy-aaaa-1111";
const B = "AIzaSy-bbbb-2222";
const C = "AIzaSy-cccc-3333";

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "moye-settings-"));
  try {
    return await fn(createSettingsStore(join(dir, "settings.local.json")), join(dir, "settings.local.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 模拟一次「打开设置面板 → 改 Key 行 → 保存」：页面只拿得到打码列表。 */
async function editKeys(store, edit) {
  const saved = splitKeys((await store.load()).geminiKeysExtra).map(maskedKey);
  const rows = edit(rowsFromSaved(saved));
  return store.save({ geminiKeysExtra: rowsToPayload(rows) });
}

test("删掉第一把：剩下的是 B、C，不是 A、B", () =>
  withStore(async (store) => {
    await store.save({ geminiKeysExtra: [A, B, C] });
    const saved = await editKeys(store, (rows) => rows.filter((_, i) => i !== 0));
    assert.deepEqual(splitKeys(saved.geminiKeysExtra), [B, C]);
  }));

test("删掉中间一把、末尾加一把新的", () =>
  withStore(async (store) => {
    await store.save({ geminiKeysExtra: [A, B, C] });
    const saved = await editKeys(store, (rows) => [...rows.filter((_, i) => i !== 1), { ...newRow(), value: "AIzaSy-dddd-4444" }]);
    assert.deepEqual(splitKeys(saved.geminiKeysExtra), [A, C, "AIzaSy-dddd-4444"]);
  }));

test("在已存的那一行填新值 = 替换那一把，其余不动", () =>
  withStore(async (store) => {
    await store.save({ geminiKeysExtra: [A, B] });
    const saved = await editKeys(store, (rows) => rows.map((row, i) => (i === 0 ? { ...row, value: C } : row)));
    assert.deepEqual(splitKeys(saved.geminiKeysExtra), [C, B]);
  }));

test("同一次打开面板里连续保存两次，按服务端回传重置行后不会错位", () =>
  withStore(async (store) => {
    await store.save({ geminiKeysExtra: [A, B, C] });
    const first = await editKeys(store, (rows) => rows.slice(1));            // 删掉 A
    const rows = rowsFromSaved(splitKeys(first.geminiKeysExtra).map(maskedKey)); // 页面按回传重置
    const second = await store.save({ geminiKeysExtra: rowsToPayload(rows.slice(0, 1)) }); // 再删掉 C
    assert.deepEqual(splitKeys(second.geminiKeysExtra), [B]);
  }));

test("页面打开后列表在别处变了：占位符按末 4 位找回原来那把，不会配到别人头上", () => {
  const rows = rowsFromSaved([A, B, C].map(maskedKey));
  const payload = rowsToPayload(rows.slice(1));             // 页面想留 B、C
  const changedElsewhere = [B, C].join("\n");               // 另一个标签页已经删掉了 A
  assert.deepEqual(splitKeys(mergeExtraKeys(payload, changedElsewhere)), [B, C]);
  assert.deepEqual(splitKeys(mergeExtraKeys(payload, [C].join("\n"))), [C]);   // B 已经不在了，就不凭空造
});

test("老页面发来的不带出处的 __KEEP__ 仍按位置处理（部署前已打开的页面不至于报错）", () => {
  assert.deepEqual(splitKeys(mergeExtraKeys(["__KEEP__", "__KEEP__"], [A, B, C].join("\n"))), [A, B]);
});

test("重复的 Key 只留一把；空数组 = 用户确实清空了", () => {
  assert.deepEqual(splitKeys(mergeExtraKeys([A, A, B], "")), [A, B]);
  assert.equal(mergeExtraKeys([], [A, B].join("\n")), "");
});

test("只改一个字段的部分保存，不会冲掉 Key、Base URL、精校范围", () =>
  withStore(async (store) => {
    await store.save({ provider: "kimi", kimiKey: "sk-kimi-9999", kimiBaseUrl: "https://api.moonshot.cn/v1", aiScope: "review", geminiKeysExtra: [A, B] });
    await store.save({ ollamaModel: "qwen3-vl:8b-instruct" });
    await store.save({ aiScope: "all" });
    const settings = await store.load();
    assert.equal(settings.provider, "kimi");
    assert.equal(settings.kimiKey, "sk-kimi-9999");
    assert.equal(settings.kimiBaseUrl, "https://api.moonshot.cn/v1");
    assert.equal(settings.ollamaModel, "qwen3-vl:8b-instruct");
    assert.equal(settings.aiScope, "all");
    assert.deepEqual(splitKeys(settings.geminiKeysExtra), [A, B]);
  }));

test("几处同时保存，每一处的改动都留下来", () =>
  withStore(async (store) => {
    await store.save({ geminiKey: A });
    await Promise.all([
      store.save({ aiScope: "review" }),
      store.save({ ollamaModel: "qwen3-vl:8b-instruct" }),
      store.save({ geminiProjects: 3 }),
      store.save({ kimiKey: "sk-kimi-9999" }),
    ]);
    const settings = await store.load();
    assert.equal(settings.aiScope, "review");
    assert.equal(settings.ollamaModel, "qwen3-vl:8b-instruct");
    assert.equal(settings.geminiProjects, 3);
    assert.equal(settings.kimiKey, "sk-kimi-9999");
    assert.equal(settings.geminiKey, A);
  }));

test("设置文件只有本人可读写（0600），写完不留临时文件", () =>
  withStore(async (store, path) => {
    await store.save({ geminiKey: A });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(path, "utf8"), /"geminiKey": "AIzaSy-aaaa-1111"/);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")), []);
  }));

test("打码只露末 4 位", () => {
  assert.equal(maskedKey(A), "••••••••1111");
  assert.equal(maskedKey(""), "");
});

test("「这家能用了吗」：云端看 Key，本机 Ollama 看选没选模型", () => {
  assert.equal(providerConfigured({ kimiKey: "sk" }, "kimi"), true);
  assert.equal(providerConfigured({ kimiKey: "" }, "kimi"), false);
  assert.equal(providerConfigured({ ollamaModel: "qwen3-vl:8b-instruct" }, "ollama"), true);
  assert.equal(providerConfigured({ ollamaModel: "" }, "ollama"), false);
});

test("没存过设置时用默认值：Kimi 走国际站、百炼走北京兼容地址、本机 Ollama 默认端口", () =>
  withStore(async (store) => {
    const settings = await store.load();
    assert.equal(settings.kimiBaseUrl, "https://api.moonshot.ai/v1");
    assert.equal(settings.qwenBaseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
    assert.equal(settings.ollamaBaseUrl, "http://127.0.0.1:11434");
    assert.deepEqual(settings, { ...defaultSettings });
  }));
