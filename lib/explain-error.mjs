/**
 * 报错 → 「哪一类、重跑有没有用」。页面按类别给一句人话和下一步（文案在 page.tsx，要走 i18n），
 * 原始报错收进可展开的「原始报错」里，不再整段贴给用户。
 *
 * 思路借鉴 Verbatim（getAudio/static/app.js 的 shortChainError）。类别和顺序按墨页库里
 * 真实出现过的报错定（2026-10-02 统计全部 AI 失败页）：
 *   超时 791 · fetch failed 292 · 额度用完 98（其中 96 条是 429，所以「额度」必须排在「限流」前）
 *   · 百炼 JSON 输出异常 37 · 没过校验 21 · 模型 404 13 · 输出坏 13 · Key 无效 8
 *
 * retryHelps：false = 不先处理就重跑也会失败（额度、Key、模型、拦截、空文件）；
 * true = 偶发的，重跑多半能好；null = 说不准。
 *
 * 纯函数、无依赖，浏览器和 Node 都能直接跑。
 */

/**
 * @typedef {"credits" | "auth" | "rateLimit" | "timeout" | "network" | "model" | "blocked"
 *   | "badOutput" | "rejected" | "emptyFile" | "unknown"} ErrorKind
 */

/** @type {Array<[ErrorKind, RegExp]>} 先匹配先用 */
const RULES = [
  ["credits", /prepayment credits|credits are depleted|insufficient[_ ]quota|exceeded your current quota|quota exceeded|Payment Required|（402）|余额不足|欠费/i],
  ["auth", /（40[13]）|Invalid Authentication|Incorrect API key|API key not valid|API_KEY_INVALID|invalid[_ ]api[_ ]key|unauthori[sz]ed|permission denied|未配置 Key|请先在设置[中里]填写/i],
  ["rateLimit", /（429）|rate.?limit|too many requests|RESOURCE_EXHAUSTED|请求过于频繁|限流/i],
  ["timeout", /超时|timed? ?out|ETIMEDOUT|时间预算已用尽/i],
  ["network", /fetch failed|ECONN(?:REFUSED|RESET)|ENOTFOUND|EAI_AGAIN|socket hang up|network error|连不上/i],
  ["model", /（404）|No endpoints found|model[^。]*(?:not found|does not exist)|不支持图片输入|还没有模型/i],
  ["blocked", /content[_ ]?filter|data_inspection_failed|\bsafety\b|inappropriate|RECITATION|PROHIBITED_CONTENT/i],
  ["badOutput", /有效 JSON|in JSON at position|Unexpected token|JSON response|output became abnormal|空白 Markdown|被截断|「思考」字段/i],
  ["emptyFile", /PDF file is empty|size is zero bytes/i],
];

/** @type {Record<ErrorKind, boolean | null>} */
const RETRY_HELPS = {
  credits: false,
  auth: false,
  model: false,
  blocked: false,
  emptyFile: false,
  rateLimit: true,
  timeout: true,
  network: true,
  badOutput: true,
  rejected: true,
  unknown: null,
};

/**
 * @param {unknown} message  原始报错
 * @param {"call" | "check"} [stage]  "check" = 模型回答了但没过程序校验（见 page-result.mjs 的 parseAiReason）
 * @returns {{ kind: ErrorKind, retryHelps: boolean | null, detail: string }}
 */
export function explainError(message, stage = "call") {
  const detail = String(message ?? "").trim();
  if (stage === "check") return { kind: "rejected", retryHelps: RETRY_HELPS.rejected, detail };
  const hit = RULES.find(([, pattern]) => pattern.test(detail));
  /** @type {ErrorKind} */
  const kind = hit ? hit[0] : "unknown";
  return { kind, retryHelps: RETRY_HELPS[kind], detail };
}

/**
 * 一批回退页的原因汇总：每类几页、其中几页结果为空、哪些类别不先处理重跑也没用。
 * @param {Array<{ stage: "call" | "check", message: string, pageEmpty: boolean } | null>} causes
 */
export function summarizeCauses(causes) {
  /** @type {Map<ErrorKind, number>} */
  const counts = new Map();
  let emptyPages = 0;
  for (const cause of causes) {
    const kind = cause ? explainError(cause.message, cause.stage).kind : "unknown";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (cause?.pageEmpty) emptyPages += 1;
  }
  const byKind = [...counts].sort((a, b) => b[1] - a[1]).map(([kind, pages]) => ({ kind, pages }));
  return { byKind, emptyPages, blockers: byKind.filter(({ kind }) => RETRY_HELPS[kind] === false) };
}
