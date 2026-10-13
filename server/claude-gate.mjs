/**
 * 本机几个应用（Verbatim / Ephemeris / 墨页）共用一份 Claude 订阅额度时的分配器（2026-10-13，用户：「有一个监控所有 usage 的分配器」）。
 * Python 版在 Verbatim 的 getAudio/claude_gate.py、Ephemeris 的 claude_gate.py；三份读写同一个 SQLite、表结构一样，改要三处一起改。
 *
 * 没设 CLAUDE_GATE（共用库的路径，作者电脑 ~/.claude-gate/gate.db）就整个不起作用，行为跟以前一样。
 *   · 总并发：三边合计最多 CLAUDE_GATE_CAP（默认 24）个 claude 进程，留 CLAUDE_GATE_RESERVE（默认 4）个只给交互的活（live）
 *   · 设了 CLAUDE_GATE_BATCH_5H（最近 5 小时三边合计等值美元）就在超过后让 batch 等着
 *   · 谁撞上限谁写 pause，三边一起停到重置时间
 *   · 每次调用记一行账；看用量：python3 ~/Documents/CODEelse/getAudio/claude_gate.py
 * 墨页：AI 精校一页、打标签 = batch，回顾 = normal，测试连接 = live。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (id INTEGER PRIMARY KEY, app TEXT, purpose TEXT, prio TEXT, pid INTEGER, started REAL);
CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, ts REAL, app TEXT, purpose TEXT, prio TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, usd REAL, secs REAL, ok INTEGER);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
CREATE TABLE IF NOT EXISTS pause (k INTEGER PRIMARY KEY CHECK (k = 1), until REAL, reason TEXT, app TEXT);
`;
const STALE_S = 2 * 3600;
const now = () => Date.now() / 1000;

export function gatePath(env = process.env) {
  const p = String(env.CLAUDE_GATE || "").trim();
  return p ? p.replace(/^~(?=\/)/, homedir()) : "";
}

const dbs = new Map();
function db() {
  const p = gatePath();
  if (!dbs.has(p)) {
    mkdirSync(dirname(p), { recursive: true });
    const d = new DatabaseSync(p, { timeout: 30000 });
    d.exec("PRAGMA journal_mode=WAL");
    d.exec(SCHEMA);
    dbs.set(p, d);
  }
  return dbs.get(p);
}

const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] != null ? v : dflt;
};

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}

export function pausedUntil() {
  if (!gatePath()) return 0;
  try {
    const row = db().prepare("SELECT until FROM pause WHERE k = 1").get();
    return row && row.until > now() ? row.until : 0;
  } catch {
    return 0;
  }
}

export function pause(until, reason = "", app = "") {
  if (!gatePath()) return;
  db().prepare("INSERT INTO pause (k, until, reason, app) VALUES (1, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET until = MAX(until, excluded.until), reason = excluded.reason, app = excluded.app")
    .run(Number(until), String(reason).slice(0, 300), app);
}

function may(d, prio) {
  const cap = num("CLAUDE_GATE_CAP", 24), reserve = num("CLAUDE_GATE_RESERVE", 4);
  const n = d.prepare("SELECT COUNT(*) n FROM slots").get().n;
  if (prio === "live") return n < cap;
  if (n >= cap - reserve) return false;
  const budget = num("CLAUDE_GATE_BATCH_5H", 0);
  if (prio === "batch" && budget) {
    const used = d.prepare("SELECT COALESCE(SUM(usd), 0) u FROM calls WHERE ts > ?").get(now() - 5 * 3600).u;
    if (used >= budget) return false;
  }
  return true;
}

function tryTake(app, purpose, prio) {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const t = now();
    for (const r of d.prepare("SELECT id, pid, started FROM slots").all()) {
      if (r.started < t - STALE_S || !alive(r.pid)) d.prepare("DELETE FROM slots WHERE id = ?").run(r.id);
    }
    const p = d.prepare("SELECT until, reason FROM pause WHERE k = 1").get();
    if (p && p.until > t) {
      const err = new Error(`Claude usage limit (shared pause until ${new Date(p.until * 1000).toLocaleTimeString()}): ${p.reason}`);
      err.paused = true;
      throw err;
    }
    if (!may(d, prio)) return null;
    return Number(d.prepare("INSERT INTO slots (app, purpose, prio, pid, started) VALUES (?, ?, ?, ?, ?)").run(app, purpose, prio, process.pid, t).lastInsertRowid);
  } finally {
    d.exec("COMMIT");
  }
}

/** 占一个位子跑 fn（返回 Promise），跑完还。停着就抛（err.paused）；等了 waitMs 还没轮到也抛。 */
export async function withSlot(app, purpose, prio, fn, { waitMs = 1800000 } = {}) {
  if (!gatePath()) return fn();
  const deadline = Date.now() + waitMs;
  let id = null;
  while (id == null) {
    id = tryTake(app, purpose, prio);
    if (id == null) {
      if (Date.now() > deadline) throw Object.assign(new Error(`Claude gate busy for ${Math.round(waitMs / 1000)}s`), { paused: true });
      await new Promise((r) => setTimeout(r, prio === "live" ? 500 : 1500));
    }
  }
  try {
    return await fn();
  } finally {
    db().prepare("DELETE FROM slots WHERE id = ?").run(id);
  }
}

/** d：claude -p 的 result 对象。 */
export function record(app, purpose, prio, model, d, secs = 0) {
  if (!gatePath()) return;
  const u = (d && d.usage) || {};
  try {
    db().prepare("INSERT INTO calls (ts, app, purpose, prio, model, input_tokens, output_tokens, cache_read, cache_write, usd, secs, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(now(), app, purpose, prio, model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0,
        u.cache_creation_input_tokens || 0, Number((d && d.total_cost_usd) || 0), Math.round(secs * 10) / 10, d && d.is_error ? 0 : 1);
  } catch { /* 记账失败不影响结果 */ }
}

export function gateStatus() {
  const d = db();
  return {
    slots: d.prepare("SELECT app, purpose, prio FROM slots ORDER BY started").all(),
    pause: d.prepare("SELECT until, reason, app FROM pause WHERE k = 1 AND until > ?").get(now()) || null,
    calls: d.prepare("SELECT app, model, COUNT(*) n, SUM(usd) usd FROM calls WHERE ts > ? GROUP BY app, model").all(now() - 5 * 3600),
  };
}
