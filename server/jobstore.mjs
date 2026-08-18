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
import { appendFile, readFile, writeFile, rm } from "node:fs/promises";
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

  async saveResult(id, result) {
    await writeFile(join(this.dir(id), "result.json"), JSON.stringify(result), "utf8");
    if (typeof result?.markdown === "string") {
      await writeFile(join(this.dir(id), "document.md"), result.markdown, "utf8");
    }
    // 摘要写进库：Library 列表只查 SQLite，不用逐份读 result.json
    const pages = Array.isArray(result?.pages) ? result.pages : [];
    const preview = String(result?.markdown ?? "")
      .replace(/[#*`$|<>\\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    this.db
      .prepare("UPDATE jobs SET page_count = ?, review_count = ?, ai_pages = ?, preview = ? WHERE id = ?")
      .run(
        Number(result?.pageCount ?? 0),
        pages.filter((p) => p?.status === "review").length,
        pages.filter((p) => p?.method === "ai").length,
        preview,
        id
      );
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
