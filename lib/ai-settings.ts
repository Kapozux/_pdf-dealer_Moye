const serviceBase = "http://127.0.0.1:8765";

export type AiProvider = "gemini" | "kimi" | "qwen" | "openrouter";
export type AiScope = "all" | "review";
export type AiModelOption = { id: string; label: string };

export type AiSettings = {
  provider: AiProvider;
  /**
   * 关：一份文档只走 provider 选的那一家。
   * 开：所有配了 Key 的渠道同时用，按各自并发权重加权轮询分配页面。
   * 不同渠道打的是不同上游主机，互不占用配额，所以同时开是纯加法。
   */
  multiChannel: boolean;
  /** 参与分流的渠道白名单。空 = 所有配了 Key 的都用。 */
  channels: AiProvider[];
  /** 服务端回传：当前实际参与分流的渠道（multiChannel 关时就是 provider 一家）。 */
  activeChannels?: AiProvider[];
  /** 服务端回传：各渠道的并发权重，用来显示合计并发。 */
  channelWeights?: Partial<Record<AiProvider, number>>;
  geminiConfigured: boolean;
  geminiKeyMasked: string;
  geminiKey?: string;
  /**
   * 额外的 Gemini key。保存时传数组：`"__KEEP__"` 表示这一把保持原样
   * （页面拿不到明文），其余为新填入的明文。空数组 = 清空全部。
   */
  geminiKeysExtra: string | string[];
  /** 服务端回传的打码列表，让页面能显示「已存了哪几把」 */
  geminiKeysExtraMasked?: string[];
  /** 这些 Key 分属几个独立 Google 项目（同项目共用配额） */
  geminiProjects: number;
  geminiModel: string;
  geminiFallbackModel: string;
  geminiBaseUrl: string;
  kimiConfigured: boolean;
  kimiKeyMasked: string;
  kimiKey?: string;
  kimiModel: string;
  kimiBaseUrl: string;
  qwenConfigured: boolean;
  qwenKeyMasked: string;
  qwenKey?: string;
  qwenModel: string;
  qwenBaseUrl: string;
  openrouterConfigured: boolean;
  openrouterKeyMasked: string;
  openrouterKey?: string;
  openrouterModel: string;
  openrouterBaseUrl: string;
  aiScope: AiScope;
  aiConfigured: boolean;
  /** 可用的 Gemini key 数量（每把=独立配额，并发按此放大） */
  geminiKeyCount?: number;
};

export const defaultAiSettings: AiSettings = {
  provider: "gemini",
  multiChannel: false,
  channels: [],
  activeChannels: [],
  geminiConfigured: false,
  geminiKeyMasked: "",
  geminiKey: "",
  geminiKeysExtra: "",
  geminiProjects: 1,
  geminiModel: "gemini-2.5-flash",
  geminiFallbackModel: "gemini-flash-latest",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  kimiConfigured: false,
  kimiKeyMasked: "",
  kimiKey: "",
  kimiModel: "kimi-k2.6",
  kimiBaseUrl: "https://api.moonshot.ai/v1",
  qwenConfigured: false,
  qwenKeyMasked: "",
  qwenKey: "",
  qwenModel: "qwen3.7-plus",
  qwenBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openrouterConfigured: false,
  openrouterKeyMasked: "",
  openrouterKey: "",
  openrouterModel: "google/gemini-2.5-flash",
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
  aiScope: "all",
  aiConfigured: false,
};

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "本地模型服务请求失败。");
  return payload;
}

export async function getAiSettings() {
  try {
    const response = await fetch(`${serviceBase}/api/settings`);
    return await parseResponse<AiSettings>(response);
  } catch (error) {
    if (error instanceof TypeError) throw new Error("本地识别服务没有启动，请重新运行 start.command。");
    throw error;
  }
}

export async function saveAiSettings(settings: AiSettings) {
  const response = await fetch(`${serviceBase}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return parseResponse<AiSettings>(response);
}

export async function testAiSettings(settings: AiSettings) {
  const response = await fetch(`${serviceBase}/api/settings/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return parseResponse<{ ok: boolean; provider: AiProvider; model: string }>(response);
}

export async function fetchAiModels(settings: AiSettings) {
  const response = await fetch(`${serviceBase}/api/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return parseResponse<{ provider: AiProvider; models: AiModelOption[] }>(response);
}
