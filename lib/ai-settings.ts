const serviceBase = "http://127.0.0.1:8765";

export type AiProvider = "gemini" | "kimi" | "qwen" | "openrouter";
export type AiScope = "all" | "review";
export type AiModelOption = { id: string; label: string };

export type AiSettings = {
  provider: AiProvider;
  geminiConfigured: boolean;
  geminiKeyMasked: string;
  geminiKey?: string;
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
};

export const defaultAiSettings: AiSettings = {
  provider: "gemini",
  geminiConfigured: false,
  geminiKeyMasked: "",
  geminiKey: "",
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
