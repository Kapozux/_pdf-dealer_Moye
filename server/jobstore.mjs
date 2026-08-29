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
import { appendFile, copyFile, readFile, rename, writeFile, rm } from "node:fs/promises";

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
    const preview = String(result?.markdown ?? "")
      .replace(/[#*`$|<>\\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    // 统计面板要用：字数按每页已经算好的 charCount 求和，不用重新扫一遍全文
    const charCount = pages.reduce((sum, p) => sum + (Number(p?.charCount) || 0), 0);
    this.db
      .prepare("UPDATE jobs SET page_count = ?, review_count = ?, ai_pages = ?, char_count = ?, preview = ? WHERE id = ?")
      .run(
        Number(result?.pageCount ?? 0),
        pages.filter((p) => p?.status === "review").length,
        pages.filter((p) => p?.method === "ai").length,
        charCount,
        preview,
        id
      );
  }

  /** 给某条记录写入 AI 打的主题标签（数组），供统计面板聚合。 */
  setTags(id, tags) {
    this.db.prepare("UPDATE jobs SET tags = ? WHERE id = ?").run(JSON.stringify(tags ?? []), id);
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
}
