/**
 * 「问」：用一句话描述要找的文件 → 资料库里最像的几份 + 为什么是它。不是聊天，不写回答。
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
  if (!byNumber.size) return { results: [], considered: 0 };
  const raw = await ask(findPrompt(q, text));
  return {
    results: parseFindAnswer(raw, byNumber).map(({ job, why }) => ({ id: job.id, why })),
    considered: byNumber.size,
  };
}
