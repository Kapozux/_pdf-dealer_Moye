/**
 * 资料库全文搜索 + 卡片预览。
 *
 * 不用 SQLite FTS5：它的默认分词不切中文，trigram 分词又搜不了两个字的词（「鲁迅」「函数」），
 * 而全库 Markdown 只有约 9MB（2026-10-02：244 份），整份放进内存逐页做子串查找，几十毫秒。
 * 第一次搜索时载入；之后每次搜索前对一遍任务表，新完成 / 重新精校过（updated_at 变了）/ 删掉的跟着变。
 */

/** 只把 ASCII 字母转小写：长度不变，命中位置在原文里照样对得上（中文不受影响）。 */
const fold = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** 片段里的 Markdown 记号去掉、空白合成一个，读起来像句子。 */
const tidy = (text) => text
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")     // 图片只留说明文字
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")      // 链接只留文字
  .replace(/[#*_`>|\\]+/g, " ").replace(/\s+/g, " ");

/**
 * @param {object} deps
 * @param {() => Array<{ id: string, updated_at: string }>} deps.listDone  已完成的任务
 * @param {(id: string) => Promise<Array<{ page: number, markdown?: string }>>} deps.loadPages  一份文档的逐页结果
 */
export function createSearchIndex({ listDone, loadPages }) {
  /** @type {Map<string, { stamp: string, pages: Array<{ page: number, text: string, folded: string }> }>} */
  const docs = new Map();
  let syncing = null;

  async function syncOnce() {
    const jobs = listDone();
    const alive = new Set(jobs.map((job) => job.id));
    for (const id of docs.keys()) if (!alive.has(id)) docs.delete(id);
    for (const job of jobs) {
      if (docs.get(job.id)?.stamp === job.updated_at) continue;
      try {
        const pages = (await loadPages(job.id)).map((p) => {
          const text = String(p.markdown ?? "");
          return { page: p.page, text, folded: fold(text) };
        });
        docs.set(job.id, { stamp: job.updated_at, pages });
      } catch (error) {
        // 一份读不出来不拖累整个搜索；记下来，下次搜索再试
        docs.delete(job.id);
        console.warn(`[搜索] 读不出 ${job.id} 的结果，这次搜不到它：${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
  }
  /** 同时来的几次搜索共用一次同步，不重复读文件。 */
  function sync() {
    syncing ??= syncOnce().finally(() => { syncing = null; });
    return syncing;
  }

  /**
   * @param {string} query  至少两个字符
   * @returns {Promise<Array<{ id: string, count: number, hits: Array<{ page: number, before: string, match: string, after: string }> }>>}
   */
  async function search(query, { limit = 60, hitsPerDoc = 3, context = 36 } = {}) {
    const needle = fold(String(query ?? "").trim());
    if (needle.length < 2) return [];
    await sync();
    const results = [];
    for (const [id, doc] of docs) {
      let count = 0;
      const hits = [];
      for (const page of doc.pages) {
        let from = 0;
        let at;
        while ((at = page.folded.indexOf(needle, from)) !== -1) {
          count += 1;
          if (hits.length < hitsPerDoc) {
            const start = Math.max(0, at - context);
            const end = Math.min(page.text.length, at + needle.length + context);
            hits.push({
              page: page.page,
              before: (start > 0 ? "…" : "") + tidy(page.text.slice(start, at)).trimStart(),
              match: page.text.slice(at, at + needle.length),
              after: tidy(page.text.slice(at + needle.length, end)).trimEnd() + (end < page.text.length ? "…" : ""),
            });
          }
          from = at + needle.length;
        }
      }
      if (count) results.push({ id, count, hits });
    }
    return results.sort((a, b) => b.count - a.count).slice(0, limit);
  }

  return { search };
}

/**
 * Library 卡片上的预览：正文开头约 240 字。跳过墨页自己写进去的东西——
 * 标题行、「由墨页转换，共 N 页……」那行说明、「## PDF 第 N 页」分页标题、分隔线、空页提示——
 * 以前每张卡都以「由墨页转换，共 10 页」开头，等于没有预览。
 */
export function previewOf(markdown) {
  const lines = String(markdown ?? "").split("\n");
  let titleSkipped = false;
  const body = lines.filter((line) => {
    const trimmed = line.trim();
    if (!titleSkipped && /^#\s/.test(trimmed)) {
      titleSkipped = true;
      return false;
    }
    return !(/^>\s*由墨页转换/.test(trimmed)
      || /^##\s+(PDF 第 \d+ 页|第 \d+ 张图)\s*$/.test(trimmed)
      || /^-{3,}$/.test(trimmed)
      || /^_\[.*\]_$/.test(trimmed));
  });
  return body.join(" ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")      // 图片只留说明文字
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")       // 链接只留文字
    .replace(/[#*`$|<>\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 240);
}
