/**
 * 任务持久化（SQLite）+ 磁盘布局 + 重启恢复。
 *
 * 参考 Verbatim 的 taskdb.py：真相存在服务端，不存在浏览器里。
 * 浏览器关掉、刷新、甚至服务重启，任务和产物都还在。
 *
 * 磁盘布局：
 *   data/moye.db                     任务状态
 *   data/jobs/<id>/source.pdf        原始 PDF（Library 里还能重新打开）
 *   data/jobs/<id>/result.json       完整转换结果（含逐页质量记录）
 *   data/jobs/<id>/document.md       导出的 Markdown
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { access, appendFile, copyFile, readFile, rename, writeFile, rm } from "node:fs/promises";
import { countFallback } from "../lib/page-result.mjs";
import { previewOf } from "./search.mjs";

/**
 * 先写临时文件再 rename 覆盖。rename 在同一文件系统上是原子的：要么是完整的新文件，
 * 要么还是旧的，不会出现"写到一半被杀、留下半截 JSON"的第三种状态。
 * settings.local.json 早就是这么写的，结果文件却一直是裸 writeFile——补齐。
 */
async function writeFileAtomic(path, content) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}
import { join } from "node:path";

export const JOB_STATES = ["queued", "running", "done", "failed", "cancelled"];

export class JobStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.jobsDir = join(dataDir, "jobs");
    mkdirSync(this.jobsDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "moye.db"));
    // 撞锁时等最多 5 秒再报错：服务跑着的时候用 sqlite3 命令行查库（CLAUDE.md 让人这么查）
    // 会短暂持锁，没有这一句写库会立刻抛 SQLITE_BUSY
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id           TEXT PRIMARY KEY,
        filename     TEXT NOT NULL,
        file_size    INTEGER NOT NULL DEFAULT 0,
        mode         TEXT NOT NULL,
        status       TEXT NOT NULL,
        page         INTEGER NOT NULL DEFAULT 0,
        total        INTEGER NOT NULL DEFAULT 0,
        detail       TEXT NOT NULL DEFAULT '',
        error        TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        finished_at  TEXT,
        page_count   INTEGER NOT NULL DEFAULT 0,
        review_count INTEGER NOT NULL DEFAULT 0,
        ai_pages     INTEGER NOT NULL DEFAULT 0,
        preview      TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
    `);
    // 批次字段是后加的：老库里没有这两列，ALTER 一下即可（老任务留空 = 未分组）
    const columns = new Set(this.db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name));
    if (!columns.has("batch_id")) this.db.exec("ALTER TABLE jobs ADD COLUMN batch_id TEXT");
    if (!columns.has("batch_label")) this.db.exec("ALTER TABLE jobs ADD COLUMN batch_label TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id)");
    // 同样是后加的：char_count 给统计面板算总字数，tags 是 AI 打的主题标签（JSON 数组字符串）
    if (!columns.has("char_count")) this.db.exec("ALTER TABLE jobs ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("tags")) this.db.exec("ALTER TABLE jobs ADD COLUMN tags TEXT");
    // 再后加的三列（回顾 / 下载文件名用）：AI 标题、一句话简介、原文件名是否本身像个标题（NULL = 还没判过）
    if (!columns.has("ai_title")) this.db.exec("ALTER TABLE jobs ADD COLUMN ai_title TEXT");
    if (!columns.has("ai_one_line")) this.db.exec("ALTER TABLE jobs ADD COLUMN ai_one_line TEXT");
    if (!columns.has("filename_meaningful")) this.db.exec("ALTER TABLE jobs ADD COLUMN filename_meaningful INTEGER");
    // 首页/资料库用来区分「真回退了」和「只是建议复核」：review_count 把 noText、可疑符号、
    // 回退文字层全混在一起，AI 模式下笔记类文档几乎每页命中，红字等于没标。
    // NULL = 老记录还没算过，启动时 backfillFallbackCounts 从 result.json 补。
    if (!columns.has("fallback_count")) this.db.exec("ALTER TABLE jobs ADD COLUMN fallback_count INTEGER");
    // 费用摘要（明细在 data/usage.db，见 server/usage.mjs）：任务跑完时从 usage.costFor 抄一份进来，
    // Library 列表和结果页只查 jobs 表就够。NULL = 这份没有过模型调用（fast/本地模式）或老记录。
    if (!columns.has("cost_usd")) this.db.exec("ALTER TABLE jobs ADD COLUMN cost_usd REAL");
    if (!columns.has("cost_calls")) this.db.exec("ALTER TABLE jobs ADD COLUMN cost_calls INTEGER");
    if (!columns.has("cost_unpriced")) this.db.exec("ALTER TABLE jobs ADD COLUMN cost_unpriced INTEGER");
    if (!columns.has("tokens_in")) this.db.exec("ALTER TABLE jobs ADD COLUMN tokens_in INTEGER");
    if (!columns.has("tokens_out")) this.db.exec("ALTER TABLE jobs ADD COLUMN tokens_out INTEGER");
    // 转换本身的墙钟（result.durationMs，不含排队），给「预计剩余时间」按模式算每页秒数用。
    // NULL = 老记录还没从 result.json 补过，启动时 backfillDurations 补。
    if (!columns.has("duration_ms")) this.db.exec("ALTER TABLE jobs ADD COLUMN duration_ms INTEGER");
  }

  dir(id) {
    return join(this.jobsDir, id);
  }

  create({ id, filename, fileSize, mode, batchId = null, batchLabel = null }) {
    const now = new Date().toISOString();
    mkdirSync(this.dir(id), { recursive: true });
    this.db
      .prepare(
        `INSERT INTO jobs (id, filename, file_size, mode, status, created_at, updated_at, batch_id, batch_label)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
      )
      .run(id, filename, fileSize, mode, now, now, batchId, batchLabel);
    return this.get(id);
  }

  /** 只更新传进来的字段；status 进终态时自动补 finished_at。 */
  update(id, fields = {}) {
    const allowed = ["status", "page", "total", "detail", "error"];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
    if (!sets.length) return this.get(id);
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    if (["done", "failed", "cancelled"].includes(fields.status)) {
      sets.push("finished_at = ?");
      values.push(new Date().toISOString());
    } else if (fields.status === "queued") {
      // 重新精校会把一份已经 done 过的任务原地重新排队：finished_at 要清掉，
      // 否则"完成时间"会一直停在上一次，看着比"重新开始"还早，很奇怪。
      sets.push("finished_at = ?");
      values.push(null);
    }
    values.push(id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  get(id) {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) ?? null;
  }

  list({ limit = 500 } = {}) {
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  /**
   * 批次汇总：一次批量提交 = 一个合集。
   * 聚合放在 SQL 里做，Library 打开时不用把每份任务都读出来再在 JS 里数。
   */
  listBatches({ limit = 200 } = {}) {
    return this.db
      .prepare(
        `SELECT batch_id AS id,
                MAX(batch_label)                                   AS label,
                COUNT(*)                                           AS total,
                SUM(status = 'done')                               AS done,
                SUM(status IN ('queued','running'))                AS active,
                SUM(status IN ('failed','cancelled'))              AS failed,
                SUM(page_count)                                    AS pages,
                MIN(created_at)                                    AS created_at,
                MAX(updated_at)                                    AS updated_at
           FROM jobs
          WHERE batch_id IS NOT NULL
          GROUP BY batch_id
          ORDER BY created_at DESC
          LIMIT ?`
      )
      .all(limit);
  }

  listByBatch(batchId) {
    return this.db.prepare("SELECT * FROM jobs WHERE batch_id = ? ORDER BY created_at").all(batchId);
  }

  /** 还没跑完的（用于重启恢复和「活跃任务」视图）。 */
  unfinished() {
    return this.db
      .prepare("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at")
      .all();
  }

  async delete(id) {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    await rm(this.dir(id), { recursive: true, force: true });
  }

  // ---- 产物读写 ----
  sourcePath(id) {
    return join(this.dir(id), "source.pdf");
  }

  /**
   * 重新精校前留一份"上一版"的备份（只留一层，不是完整版本历史）。
   *
   * 以前"重新精校"会整个新建一份 Library 记录，旧的原样留着——好处是绝不丢数据，
   * 坏处是 Library 无限增殖，而且新记录不带原来的 batch_id，会从合集里"消失"
   * （实测就找不到了）。现在改成原地覆盖同一条记录，为了不让"新结果比旧的差"
   * 变成没有后悔药，覆盖前顺手拷一份 .prev 文件——不接入 Library/UI，纯粹是
   * 万一需要时能手动把 result.prev.json 改回 result.json 抢救回来。
   */
  async backupResult(id) {
    const dir = this.dir(id);
    await copyFile(join(dir, "result.json"), join(dir, "result.prev.json")).catch(() => undefined);
    await copyFile(join(dir, "document.md"), join(dir, "document.prev.md")).catch(() => undefined);
  }

  async saveResult(id, result) {
    await writeFileAtomic(join(this.dir(id), "result.json"), JSON.stringify(result));
    if (typeof result?.markdown === "string") {
      await writeFileAtomic(join(this.dir(id), "document.md"), result.markdown);
    }
    // 摘要写进库：Library 列表只查 SQLite，不用逐份读 result.json
    const pages = Array.isArray(result?.pages) ? result.pages : [];
    const preview = previewOf(result?.markdown);
    // 统计面板要用：字数按每页已经算好的 charCount 求和，不用重新扫一遍全文
    const charCount = pages.reduce((sum, p) => sum + (Number(p?.charCount) || 0), 0);
    this.db
      .prepare("UPDATE jobs SET page_count = ?, review_count = ?, ai_pages = ?, char_count = ?, preview = ?, fallback_count = ?, duration_ms = ? WHERE id = ?")
      .run(
        Number(result?.pageCount ?? 0),
        pages.filter((p) => p?.status === "review").length,
        pages.filter((p) => p?.method === "ai").length,
        charCount,
        preview,
        countFallback(pages),
        Number.isFinite(result?.durationMs) ? Math.round(result.durationMs) : null,
        id
      );
  }

  /** 把这份任务的费用摘要抄进 jobs 表（明细在 usage.db）。传 null 表示没有过模型调用。 */
  setCost(id, cost) {
    this.db
      .prepare("UPDATE jobs SET cost_usd = ?, cost_calls = ?, cost_unpriced = ?, tokens_in = ?, tokens_out = ? WHERE id = ?")
      .run(
        cost ? cost.costUsd : null,
        cost ? cost.calls : null,
        cost ? cost.unpriced : null,
        cost ? cost.inputTokens : null,
        cost ? cost.outputTokens : null,
        id
      );
  }

  /**
   * 按模式的「每页秒数」中位数，给预计剩余时间用。
   *
   * 数据源是每份已完成任务的 duration_ms ÷ page_count（转换本身的墙钟，不含排队），
   * 各模式只取最近 50 份；样本少于 3 份就不给数（返回 null，前端只显示已用时）。
   * 用整份文档的吞吐而不是逐页 modelMs：AI 模式几十路并发，单次调用 13 秒
   * 不等于每页 13 秒，按文档算出来的才是用户真正等的时间。
   */
  speedTable() {
    const rows = this.db
      .prepare(
        `SELECT mode, duration_ms, page_count FROM jobs
          WHERE status = 'done' AND duration_ms > 0 AND page_count > 0
          ORDER BY finished_at DESC LIMIT 400`
      )
      .all();
    const byMode = new Map();
    for (const row of rows) {
      const list = byMode.get(row.mode) || [];
      if (list.length < 50) list.push(row.duration_ms / 1000 / row.page_count);
      byMode.set(row.mode, list);
    }
    const table = {};
    for (const [mode, list] of byMode) {
      const sorted = [...list].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      table[mode] = { n: sorted.length, secPerPage: sorted.length >= 3 ? Math.round(median * 100) / 100 : null };
    }
    return table;
  }

  /** duration_ms 列是后加的：老记录从 result.json 里的 durationMs 补一次。读不到的记 0，不再重试。 */
  async backfillDurations() {
    const rows = this.db.prepare("SELECT id FROM jobs WHERE status = 'done' AND duration_ms IS NULL").all();
    const write = this.db.prepare("UPDATE jobs SET duration_ms = ? WHERE id = ?");
    for (const { id } of rows) {
      const result = await this.readResult(id);
      write.run(Number.isFinite(result?.durationMs) ? Math.round(result.durationMs) : 0, id);
    }
    return rows.length;
  }

  /** 给某条记录写入 AI 打的主题标签（数组），供统计面板聚合。 */
  setTags(id, tags) {
    this.db.prepare("UPDATE jobs SET tags = ? WHERE id = ?").run(JSON.stringify(tags ?? []), id);
  }

  /** 一次写入 AI 生成的整套卡片元数据：标签 + 标题 + 一句话 + 原文件名是否有意义。 */
  setCardMeta(id, { tags, title, oneLine, filenameMeaningful }) {
    this.db
      .prepare("UPDATE jobs SET tags = ?, ai_title = ?, ai_one_line = ?, filename_meaningful = ? WHERE id = ?")
      .run(JSON.stringify(tags ?? []), title ?? null, oneLine ?? null,
        filenameMeaningful === null || filenameMeaningful === undefined ? null : (filenameMeaningful ? 1 : 0), id);
  }

  /** 回顾 / 资料库统计用的精简行：不带 preview 这种大字段。 */
  reflectRows() {
    return this.db
      .prepare(
        `SELECT id, filename, mode, created_at, page_count, char_count, tags, ai_title, ai_one_line
           FROM jobs WHERE status = 'done' ORDER BY created_at`
      )
      .all();
  }

  /**
   * 统计面板用的三块聚合，全部走 SQL，不逐份读 result.json——
   * 跟 listBatches() 是同一个思路：列表页要快，聚合交给数据库。
   */
  statsTotals() {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS transcripts, COALESCE(SUM(page_count),0) AS pages, COALESCE(SUM(char_count),0) AS chars
           FROM jobs WHERE status = 'done'`
      )
      .get();
  }

  /** 按天聚合的页数时间线，前端拿去画累计折线图。 */
  statsTimeline() {
    return this.db
      .prepare(
        `SELECT date(created_at) AS day, SUM(page_count) AS pages, COUNT(*) AS count
           FROM jobs WHERE status = 'done' GROUP BY day ORDER BY day`
      )
      .all();
  }

  /** 已经打过标签的记录（标签本身是 JSON 数组字符串，聚合计数交给调用方在 JS 里做）。 */
  statsTagRows() {
    return this.db
      .prepare("SELECT tags FROM jobs WHERE status = 'done' AND tags IS NOT NULL AND tags != ''")
      .all();
  }

  /**
   * 逐页存档。
   *
   * 原本进度只在整份文档跑完时才落盘（saveResult），所以中途重启 = 全部重来：
   * 实测一批 15 份 537 页的任务，因为三次重启白跑了 800 多页，比整批还多。
   * 一页 AI 调用要十几秒且要花钱，重跑的代价远高于追加一行 JSON。
   *
   * 用 JSONL 追加而不是重写整个 JSON：几十页的文档每页都重写一次整份数组，
   * 既慢又会在写到一半时被杀掉导致文件损坏；追加写天然是原子的，
   * 坏掉的最后一行读的时候跳过即可。
   */
  checkpoint(id) {
    const path = join(this.dir(id), "pages.jsonl");
    return {
      /** @returns {Promise<Map<number, object>>} 已完成的页 → 该页结果 */
      async load() {
        const done = new Map();
        let raw;
        try {
          raw = await readFile(path, "utf8");
        } catch {
          return done;   // 没有存档 = 全新任务
        }
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry && typeof entry.page === "number" && entry.result) done.set(entry.page, entry.result);
          } catch {
            // 上次被杀时写了半行，跳过即可——正是用 JSONL 的原因
          }
        }
        return done;
      },
      async save(page, result) {
        await appendFile(path, `${JSON.stringify({ page, result })}\n`, "utf8");
      },
      async clear() {
        await rm(path, { force: true });
      },
    };
  }

  /** 磁盘上有没有已完成的结果（重新精校被取消时据此退回「完成」）。 */
  async hasResult(id) {
    try {
      await access(join(this.dir(id), "result.json"));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async readResult(id) {
    try {
      return JSON.parse(await readFile(join(this.dir(id), "result.json"), "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * 启动时收尾：上次没跑完的任务，源文件还在就重新排队，不在就标失败。
   * 对应 Verbatim 的 recover_unfinished_tasks —— 服务重启不该让工作凭空消失。
   */
  async recover(requeue) {
    const pending = this.unfinished();
    const requeued = [];
    for (const job of pending) {
      let hasSource = false;
      try {
        await readFile(this.sourcePath(job.id));
        hasSource = true;
      } catch {
        hasSource = false;
      }
      if (hasSource) {
        this.update(job.id, { status: "queued", detail: "服务重启，已重新排队", error: null });
        requeued.push(this.get(job.id));
      } else {
        this.update(job.id, { status: "failed", error: "服务重启时源文件已丢失。" });
      }
    }
    for (const job of requeued) requeue(job);
    return { requeued: requeued.length, failed: pending.length - requeued.length };
  }

  /**
   * fallback_count 列是后加的，老记录是 NULL。逐份读 result.json 算一次写回去，
   * 之后就只走 SQL。读不到 result.json 的记为 0，别每次启动都再试一遍。
   */
  /**
   * 预览以前直接取 Markdown 开头，每张卡都是「标题 由墨页转换，共 N 页……」。
   * 启动时把这种老预览按 previewOf 的规则从 document.md 重算一遍（只动这一列）。
   */
  async backfillPreviews() {
    // 老预览是「标题 由墨页转换，共 N 页……」：标题在前，所以按「包含」找，不是按开头
    const rows = this.db.prepare("SELECT id FROM jobs WHERE status = 'done' AND (preview IS NULL OR preview LIKE '%由墨页转换，共%' OR preview LIKE '%](%')").all();
    const write = this.db.prepare("UPDATE jobs SET preview = ? WHERE id = ?");
    let updated = 0;
    for (const { id } of rows) {
      const markdown = await readFile(join(this.dir(id), "document.md"), "utf8").catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (markdown === null) continue;
      write.run(previewOf(markdown), id);
      updated += 1;
    }
    return updated;
  }

  async backfillFallbackCounts() {
    const rows = this.db.prepare("SELECT id FROM jobs WHERE status = 'done' AND fallback_count IS NULL").all();
    const write = this.db.prepare("UPDATE jobs SET fallback_count = ? WHERE id = ?");
    for (const { id } of rows) {
      const result = await this.readResult(id);
      const pages = Array.isArray(result?.pages) ? result.pages : [];
      write.run(countFallback(pages), id);
    }
    return rows.length;
  }
}
