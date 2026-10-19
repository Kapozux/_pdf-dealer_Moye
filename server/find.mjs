/**
 * 「问」：用一句话描述要找的文件 → 资料库里最像的几份 + 为什么是它（+ 在第几页）。不是聊天，不写回答。
 *
 * 两条路（2026-10-19 起）：
 *   · 查正文（findDeep）：本机有 Claude Code 就让它自己跑只读的 server/look.mjs 搜正文、看某一页再挑——
 *     人记得的常常是里面的一道题、一个公式、一段话，标题和简介里没有。照 Verbatim 的 libask.py（它照 Ephemeris）。
 *   · 只看目录（findDocuments）：没有 Claude Code、或它失败了，退回下面这个原来的做法。
 *
 * 参考 Ephemeris 的「问」找资料那一步，但简单得多：墨页每份文档打标签时已经有
 * AI 标题、一句话、标签（generateCardMeta），整库目录约 300～500 行、几万字，
 * 一次全交给模型就行，不用检索、不用向量。编号用短的 1..N 而不是任务 id：
 * 省 token，也让模型编不出一个「看起来像」的 id——不在目录里的编号直接丢掉。
 */

const MAX_RESULTS = 8;
// 目录总长上限：超了就先截一句话、再截标签，保证每份至少有标题（几千份才会碰到）
const CATALOG_BUDGET = 60000;

const clip = (value, max) => {
  const text = String(value ?? "").replace(/[|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function parseTags(raw) {
  try {
    const tags = JSON.parse(raw || "[]");
    return Array.isArray(tags) ? tags.map(String) : [];
  } catch {
    return [];
  }
}

/** 已完成的任务 → 目录行（编号从 1 开始，返回编号 → 任务的对照表） */
export function buildCatalog(jobs, budget = CATALOG_BUDGET) {
  const done = jobs.filter((job) => job.status === "done");
  const line = (job, n, full) => [
    n,
    String(job.created_at ?? "").slice(0, 10),
    clip(job.ai_title || job.filename, 40),
    full ? clip(job.ai_one_line || job.preview, 70) : "",
    full ? clip(parseTags(job.tags).join("、"), 40) : "",
    clip(job.filename, 60),
    `${job.page_count ?? 0}页`,
  ].join(" | ");
  let lines = done.map((job, i) => line(job, i + 1, true));
  if (lines.join("\n").length > budget) lines = done.map((job, i) => line(job, i + 1, false));
  return { text: lines.join("\n"), byNumber: new Map(done.map((job, i) => [i + 1, job])) };
}

export function findPrompt(question, catalog) {
  return `你在帮用户从他自己的文档库里找文件。下面是全部文档的目录，每行：编号 | 转换日期 | 标题 | 一句话简介 | 标签 | 原文件名 | 页数。

${catalog}

用户要找：「${question}」

从目录里挑出最可能是他要找的文档，最多 ${MAX_RESULTS} 份，最像的排前面。一份都不像就返回空数组，不要硬凑。
编号只能用目录里出现过的。"why" 用一句话说为什么是它（不超过 30 个字，用用户提问的语言）。
只输出 JSON，不要别的文字：{"results":[{"n":编号,"why":"…"}]}`;
}

/** 模型的回答 → [{ job, why }]；目录里没有的编号、重复的编号都丢掉 */
export function parseFindAnswer(raw, byNumber) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`模型没有返回 JSON：${text.slice(0, 120)}`);
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`模型返回的 JSON 解析不了：${error.message}`);
  }
  const seen = new Set();
  const results = [];
  for (const item of Array.isArray(parsed?.results) ? parsed.results : []) {
    const job = byNumber.get(Number(item?.n));
    if (!job || seen.has(job.id)) continue;
    seen.add(job.id);
    results.push({ job, why: clip(item?.why, 60) });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/**
 * @param {string} question
 * @param {{ listJobs: () => object[], ask: (prompt: string) => Promise<string> }} deps
 * @returns {Promise<{ results: { id: string, why: string }[], considered: number }>}
 */
export async function findDocuments(question, { listJobs, ask }) {
  const q = clip(question, 300);
  if (!q) throw Object.assign(new Error("先写一句你要找什么。"), { httpStatus: 400 });
  const { text, byNumber } = buildCatalog(listJobs());
  if (!byNumber.size) return { results: [], considered: 0, mode: "catalog" };
  const raw = await ask(findPrompt(q, text));
  return {
    results: parseFindAnswer(raw, byNumber).map(({ job, why }) => ({ id: job.id, why, page: null })),
    considered: byNumber.size,
    mode: "catalog",
  };
}

const DEEP_PROMPT = `你在帮一个人从他自己的墨页资料库里找文件（他转换过的 PDF、课件、Word、照片，现在都是 Markdown）。今天是 {today}。
资料库一共 {total} 份。他要找：「{question}」

用 Bash 运行 \`{look} <命令>\` 查（别的命令都会被拒）：
  search <词> [词…] [--any] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--n 20]   哪些文档提到（默认几个词都要出现；标题 / 标签 / 一句话 / 正文）
  hits   <短号> <词> [--n 20]                 一份文档里这个词出现的每一处，带页码
  read   <短号> [--page N | --at 词] [--chars 2500]   读某一页
  info   <短号>                                标题、一句话、标签、页数、各页的小标题
  list   [--since …] [--until …] [--n 50]      按时间列
  stats                                        总量、按月

怎么找：
- 他记得的多半是片段：一道题、一个公式、一个概念、哪门课、大概哪天、是照片还是课件。拆开、换几种说法搜：中英文都试
  （正文常是英文：「潜热 / latent heat」「导数 / derivative」），简称、近义词也试。
- 说了时间（「上周」「九月」）就按今天推算加 --since / --until。
- 候选多时用 info 看小标题、用 hits / read 看原文再判断，别只凭标题。找的是某一道题或某一段，就用 hits 定位到那一页。
- 每次只跑一条完整的命令（照上面原样写全路径）：不要用 shell 变量、不要用 ; && | 把几条连起来——那样会被拒。
- 找到把握大的就可以停，不用把整个库翻遍。

最后只输出 JSON，不要别的文字：
{"results": [{"d": "短号", "page": 页码或 0, "why": "一句话说为什么是它"}], "note": "可空：一句话补充（比如没找到时说查了什么）"}
- 最多 {n} 份，最像的排前面；一份都不像就给空数组，不要硬凑。
- 短号只能用查到的（输出里 [[d:短号]] 那串）；page 写他要找的那部分在第几页（工具输出里 @p 后面那个），说不准写 0。
- why 不超过 40 个字，用他提问的语言，说出跟他描述对得上的地方（「第 3 页就是比热容的实验设计题」）。
- why 和 note 里提到哪份文档都用标题，不要写短号（他看不懂那串字）。`;

/** 它跑的那条命令 → { k: "search", d: "latent heat" }（前端把 k 翻成「搜」「读」……）。认不出返回 null。 */
export function stepOf(command, jobs = []) {
  const parts = String(command ?? "").match(/"[^"]*"|'[^']*'|\S+/g)?.map((x) => x.replace(/^["']|["']$/g, "")) ?? [];
  const at = parts.findIndex((x) => x.endsWith("look.mjs"));
  const [k, ...rest] = at === -1 ? [] : parts.slice(at + 1);
  if (!["search", "hits", "read", "info", "list", "stats"].includes(k)) return null;
  const args = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--any") continue;
    if (rest[i].startsWith("--")) { if (rest[i] === "--page") args.push(`p${rest[i + 1]}`); i += 1; continue; }
    args.push(rest[i]);
  }
  if (["hits", "read", "info"].includes(k)) {
    const job = args[0] && args[0].length >= 4 ? jobs.find((j) => j.id.startsWith(args[0].toLowerCase())) : null;
    const name = job ? clip(job.ai_title || job.filename, 40) : args[0] ?? "";
    return { k, d: clip([name, ...args.slice(1)].join(" · "), 80) };
  }
  return { k, d: clip(args.join(" "), 80) };
}

/** 查正文那条的回答 → [{ job, why, page }]：短号认不出 / 有歧义 / 重复的丢掉，页码不在 1..页数 的当没说 */
export function parseDeepAnswer(raw, jobs) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`模型没有返回 JSON：${text.slice(0, 120)}`);
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`模型返回的 JSON 解析不了：${error.message}`);
  }
  const done = jobs.filter((job) => job.status === "done");
  const seen = new Set();
  const results = [];
  for (const item of Array.isArray(parsed?.results) ? parsed.results : []) {
    const ref = String(item?.d ?? "").toLowerCase();
    const hit = ref.length >= 4 ? done.filter((job) => job.id.startsWith(ref)) : [];
    if (hit.length !== 1 || seen.has(hit[0].id)) continue;
    const job = hit[0];
    seen.add(job.id);
    const page = Number(item?.page);
    results.push({ job, why: clip(item?.why, 80), page: Number.isInteger(page) && page >= 1 && page <= (job.page_count || 0) ? page : null });
    if (results.length >= MAX_RESULTS) break;
  }
  return { results, note: clip(parsed?.note, 200) };
}

/**
 * @param {string} question
 * @param {{ listJobs: () => object[], agent: (prompt: string, onTool: (cmd: string) => void) => Promise<string>, look: string, onStep?: (step: object) => void, today?: string }} deps
 *   look：放行的命令前缀（「node 的路径 look.mjs 的路径」），也原样写进提示
 */
export async function findDeep(question, { listJobs, agent, look, onStep = () => {}, today = new Date().toISOString().slice(0, 10) }) {
  const q = clip(question, 300);
  if (!q) throw Object.assign(new Error("先写一句你要找什么。"), { httpStatus: 400 });
  const jobs = listJobs();
  const total = jobs.filter((job) => job.status === "done").length;
  if (!total) return { results: [], considered: 0, mode: "deep", note: "", steps: 0 };
  let steps = 0;
  const prompt = DEEP_PROMPT.replaceAll("{today}", today).replaceAll("{total}", String(total)).replaceAll("{question}", q)
    .replaceAll("{look}", look).replaceAll("{n}", String(MAX_RESULTS));
  const raw = await agent(prompt, (command) => {
    const step = stepOf(command, jobs);
    if (!step) return;
    steps += 1;
    onStep(step);
  });
  const { results, note } = parseDeepAnswer(raw, jobs);
  return { results: results.map(({ job, why, page }) => ({ id: job.id, why, page })), considered: total, mode: "deep", note, steps };
}
