/**
 * AI 设置的存储：settings.local.json 的读、合并、写。
 *
 * 从 local-ocr-server.mjs 搬出来，是因为那个文件一 import 就 listen 8765，
 * 「保存不会误覆盖 Key」这条最贵的教训一直没法用测试钉住。
 *
 * 接口：
 *   createSettingsStore(path) → { load(), save(patch) }
 *     save 收的是「部分设置」：没传的字段沿用已存的值（只改精校范围、只写 Ollama 模型
 *     这种局部保存不能把 Key / Base URL 冲掉）。多处同时保存会排队，不会互相覆盖。
 *   normalizeSettings(input, previous)  合并规则本体（测试连接、同步模型也用它，但不写盘）
 *   providerConfigured(settings, provider)  「这家能用了吗」的唯一判断
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { mergeExtraKeys } from "../lib/key-pool.mjs";

export const ALL_PROVIDERS = ["gemini", "kimi", "qwen", "openrouter", "ollama"];

export const defaultSettings = {
  provider: "gemini",
  geminiKey: "",
  geminiModel: "gemini-2.5-flash",
  geminiFallbackModel: "gemini-flash-latest",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  kimiKey: "",
  kimiModel: "kimi-k2.6",
  kimiBaseUrl: "https://api.moonshot.ai/v1",
  qwenKey: "",
  qwenModel: "qwen3.7-plus",
  qwenBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openrouterKey: "",
  // 默认走 Kimi 而不是 gemini-2.5-flash：后者跟直连 Gemini 抢的是同一个 Google
  // 配额池，用 OpenRouter 绕一圈不会更快。实测 64 并发下（关推理、同一份数学 PDF）：
  //   kimi-k2.6      1.9 页/s  $0.0028/页  LaTeX 71 ← 公式最全
  //   glm-5v-turbo   1.8 页/s  $0.0055/页  LaTeX 64 ← 同速但贵一倍，淘汰
  //   qwen3.7-flash  4.2 页/s  $0.00013/页 LaTeX 36 ← 快且极便宜，但公式会掉
  // 数学/理科 PDF 用 kimi，纯文字文档换 qwen3.7-flash 可以快一倍、便宜 20 倍。
  openrouterModel: "moonshotai/kimi-k2.6",
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
  // 本机 Ollama：不要 Key、图片不出这台机器。模型为空 = 没配置（用户得先下一个视觉模型）。
  // 地址是 Ollama 的根地址（走它的原生 /api/chat，不走 /v1 兼容层，理由见 callOllama）。
  ollamaModel: "",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  aiScope: "all",
  // 转换完成后自动打标签（会把文档开头约 3000 字发给模型，本地模式也一样）。
  // 用户可关：顶栏的隐私标签按这个值说话，关了才能诚实地写"文件不上传"。
  autoTag: true,
  // 关掉时：一份文档只走 provider 选的那一家。开了：所有配了 Key 的渠道
  // 同时用，按各自并发上限加权轮询分配页面——独立的上游（Gemini 服务器
  // 和 OpenRouter/Kimi/Qwen）互不占用配额，同时开是纯加法，没有下限。
  multiChannel: false,
  // multiChannel 打开时，参与分流的渠道白名单。空数组 = 所有配了 Key 的都用。
  // 有了它才能选「Gemini + Qwen 但不要 OpenRouter」这种组合。
  channels: [],
};

const cleanString = (value) => (typeof value === "string" ? value.trim() : "");

/** 这家能用了吗：云端看有没有 Key，本机 Ollama 没有 Key，看选没选模型。 */
export function providerConfigured(settings, provider) {
  const credential = {
    gemini: settings.geminiKey,
    kimi: settings.kimiKey,
    qwen: settings.qwenKey,
    openrouter: settings.openrouterKey,
    ollama: settings.ollamaModel,
  }[provider];
  return Boolean(credential);
}

export function normalizeSettings(input, previous = defaultSettings) {
  const provider = ALL_PROVIDERS.includes(input.provider) ? input.provider : (previous.provider || "gemini");
  // 没传就沿用：只带几个字段的 partial 请求（一键安装写 Ollama 模型）不该把「只精校可疑页」冲回「全部」
  const aiScope = input.aiScope === "review" || input.aiScope === "all" ? input.aiScope : (previous.aiScope === "review" ? "review" : "all");
  return {
    provider,
    geminiKey: cleanString(input.geminiKey) || previous.geminiKey || "",
    // 多个 Gemini key（不同 Google 账号 = 各自独立配额）。
    //
    // 这里曾经是 `cleanString(input) || previous`，配上「页面永远看不到已存的
    // key」，就成了一条静默丢数据的路：用户打开设置看到空列表 → 以为没存上 →
    // 补一把新的 → 保存时新值非空，直接把旧的整串覆盖掉，旧 key 无声消失。
    // 现在页面拿到的是打码列表，回传时用占位符表示「这一把别动」（协议见 lib/key-pool.mjs）。
    geminiKeysExtra: mergeExtraKeys(input.geminiKeysExtra, previous.geminiKeysExtra),
    // 这些 key 分属几个**独立 Google 项目**（同项目的 key 共用配额，加了不提速）
    geminiProjects: Math.max(1, Number(input.geminiProjects) || Number(previous.geminiProjects) || 1),
    // 模型/BaseURL 曾经跟 Key 不一样：传不全就退回硬编码默认值，而不是「上次保存的值」。
    // 实测踩过一次——一个只带 {provider} 的请求（比如"测试连接"传了不完整的草稿）
    // 会把用户已经存好的自定义 Base URL（比如 Kimi 的 .cn 地域）悄悄换回默认的 .ai，
    // 认证接着莫名其妙失败。跟上面 Key 字段一样退回 previous，才不会被partial 请求冲掉。
    geminiModel: cleanString(input.geminiModel) || previous.geminiModel || defaultSettings.geminiModel,
    geminiFallbackModel: cleanString(input.geminiFallbackModel) || previous.geminiFallbackModel || defaultSettings.geminiFallbackModel,
    geminiBaseUrl: cleanString(input.geminiBaseUrl) || previous.geminiBaseUrl || defaultSettings.geminiBaseUrl,
    kimiKey: cleanString(input.kimiKey) || previous.kimiKey || "",
    kimiModel: cleanString(input.kimiModel) || previous.kimiModel || defaultSettings.kimiModel,
    kimiBaseUrl: cleanString(input.kimiBaseUrl) || previous.kimiBaseUrl || defaultSettings.kimiBaseUrl,
    qwenKey: cleanString(input.qwenKey) || previous.qwenKey || "",
    qwenModel: cleanString(input.qwenModel) || previous.qwenModel || defaultSettings.qwenModel,
    qwenBaseUrl: cleanString(input.qwenBaseUrl) || previous.qwenBaseUrl || defaultSettings.qwenBaseUrl,
    openrouterKey: cleanString(input.openrouterKey) || previous.openrouterKey || "",
    openrouterModel: cleanString(input.openrouterModel) || previous.openrouterModel || defaultSettings.openrouterModel,
    openrouterBaseUrl: cleanString(input.openrouterBaseUrl) || previous.openrouterBaseUrl || defaultSettings.openrouterBaseUrl,
    // 模型名跟 Key 一样「没传就沿用」：partial 请求不能把已选的模型冲掉
    ollamaModel: cleanString(input.ollamaModel) || previous.ollamaModel || "",
    ollamaBaseUrl: cleanString(input.ollamaBaseUrl) || previous.ollamaBaseUrl || defaultSettings.ollamaBaseUrl,
    aiScope,
    autoTag: input.autoTag === undefined ? previous.autoTag !== false : Boolean(input.autoTag),
    multiChannel: Boolean(input.multiChannel ?? previous.multiChannel ?? defaultSettings.multiChannel),
    channels: (Array.isArray(input.channels) ? input.channels : previous.channels ?? [])
      .filter((p) => ALL_PROVIDERS.includes(p)),
  };
}

export function createSettingsStore(path) {
  async function load() {
    try {
      return normalizeSettings(JSON.parse(await readFile(path, "utf8")), defaultSettings);
    } catch (error) {
      if (error?.code === "ENOENT") return { ...defaultSettings };
      throw error;
    }
  }

  // 保存排队：每次都是「读 → 合并 → 写」，两处同时保存（用户点保存的同时 Ollama 模型刚下完、
  // 回调也在写设置）时，后写的那份是基于旧快照合并的，会把先写的改动冲掉。
  let tail = Promise.resolve();

  /** 部分保存：没传的字段沿用已存的值。返回保存后的完整设置。 */
  function save(patch) {
    const run = tail.then(async () => {
      const settings = normalizeSettings(patch, await load());
      // 临时文件各用各的名字：就算有别的进程也在写，也不会把对方的半成品 rename 走
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return settings;
    });
    // 一次失败不能卡住后面的保存；失败本身照样抛给这次的调用方
    tail = run.catch(() => undefined);
    return run;
  }

  return { load, save };
}
