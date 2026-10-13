/**
 * 本机几个应用（Verbatim / Ephemeris / 墨页）共用一份 Claude 订阅额度时的分配器（2026-10-13，用户：「有一个监控所有 usage 的分配器」）。
 * Python 版在 Verbatim 的 getAudio/claude_gate.py、Ephemeris 的 claude_gate.py；三份读写同一个 SQLite、表结构一样，改要三处一起改。
 *
 * 没设 CLAUDE_GATE（共用库的路径，作者电脑 ~/.claude-gate/gate.db）就整个不起作用，行为跟以前一样。
 *   · 总并发：三边合计最多 CLAUDE_GATE_CAP（默认 24）个 claude 进程，留 CLAUDE_GATE_RESERVE（默认 4）个只给交互的活（live）
 *   · 给人自己留额度：设了 CLAUDE_GATE_LIMIT_5H（5 小时上限折合等值美元，10-13 实测约 $360），「最近 5 小时三个应用 + 人自己
 *     在 Claude Code 里用的」合计到了 LIMIT - CLAUDE_GATE_KEEP（默认 100）批量和普通的就等着、交互照常。人自己的用量增量读
 *     ~/.claude/projects 的对话记录（CLAUDE_GATE_CC_DIR 可换，一分钟最多读一次），应用自己起的会话（~/.moye-claude 之类）不算
 *   · 谁撞上限谁写 pause，三边一起停到重置时间
 *   · 每次调用记一行账；看用量：python3 ~/Documents/CODEelse/getAudio/claude_gate.py
 * 墨页：AI 精校一页、打标签 = batch，回顾 = normal，测试连接 = live。
 */
import { closeSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (id INTEGER PRIMARY KEY, app TEXT, purpose TEXT, prio TEXT, pid INTEGER, started REAL);
CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, ts REAL, app TEXT, purpose TEXT, prio TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, usd REAL, secs REAL, ok INTEGER);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
CREATE TABLE IF NOT EXISTS pause (k INTEGER PRIMARY KEY CHECK (k = 1), until REAL, reason TEXT, app TEXT);
CREATE TABLE IF NOT EXISTS cc_files (path TEXT PRIMARY KEY, offset INTEGER);
CREATE TABLE IF NOT EXISTS cc_calls (key TEXT PRIMARY KEY, ts REAL, model TEXT, usd REAL);
CREATE INDEX IF NOT EXISTS cc_calls_ts ON cc_calls(ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v REAL);
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

// 等值美元（每百万 token 输入 / 输出），跟 claude_gate.py 的 _PRICE 一样
const PRICE = { haiku: [0.10, 0.50], sonnet: [2.00, 10.00], opus: [4.00, 20.00] };
const APP_DIRS = ["verbatim-claude", "ephemeris-claude", "moye-claude"];

function usdOf(model, u) {
  const fam = Object.keys(PRICE).find((k) => String(model).includes(k)) || "opus";
  const [pi, po] = PRICE[fam];
  const cc = u.cache_creation || null;
  const w1 = (cc && cc.ephemeral_1h_input_tokens) || 0;
  const w5 = cc ? cc.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
  return ((u.input_tokens || 0) * pi + (u.output_tokens || 0) * po + (u.cache_read_input_tokens || 0) * pi * 0.1 + w1 * pi * 2 + w5 * pi * 1.25) / 1e6;
}

function jsonlFiles(dir, out = []) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** 人自己在 Claude Code 里的用量增量读进 cc_calls（同 claude_gate.py 的 sync_cc）。 */
export function syncCC(every = 60) {
  const d = db();
  const t = now();
  const last = d.prepare("SELECT v FROM meta WHERE k = 'cc_scan'").get();
  if (last && t - last.v < every) return;
  d.prepare("INSERT INTO meta (k, v) VALUES ('cc_scan', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(t);
  const root = String(process.env.CLAUDE_GATE_CC_DIR || "").replace(/^~(?=\/)/, homedir()) || join(homedir(), ".claude/projects");
  for (const f of jsonlFiles(root)) {
    if (APP_DIRS.some((a) => f.includes(a))) continue;
    let st;
    try { st = statSync(f); } catch { continue; }
    if (st.mtimeMs / 1000 < t - 8 * 86400) continue;
    const row = d.prepare("SELECT offset FROM cc_files WHERE path = ?").get(f);
    const off = row && row.offset <= st.size ? row.offset : 0;
    if (off === st.size) continue;
    const buf = Buffer.alloc(st.size - off);
    const fd = openSync(f, "r");
    try { readSync(fd, buf, 0, buf.length, off); } finally { closeSync(fd); }
    const end = buf.lastIndexOf(10) + 1;
    const ins = d.prepare("INSERT OR IGNORE INTO cc_calls (key, ts, model, usd) VALUES (?, ?, ?, ?)");
    d.exec("BEGIN");
    try {
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.includes('"usage"')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const m = o.message || {};
        if (!m.usage || m.model === "<synthetic>" || !o.timestamp) continue;
        ins.run(`${m.id}|${o.requestId}`, Date.parse(o.timestamp) / 1000, m.model || "", usdOf(m.model, m.usage));
      }
      d.prepare("INSERT INTO cc_files (path, offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset").run(f, off + end);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
    }
  }
  d.prepare("DELETE FROM cc_calls WHERE ts < ?").run(t - 8 * 86400);
}

function used5h(d) {
  const since = now() - 5 * 3600;
  return d.prepare("SELECT COALESCE(SUM(usd), 0) u FROM calls WHERE ts > ?").get(since).u
    + d.prepare("SELECT COALESCE(SUM(usd), 0) u FROM cc_calls WHERE ts > ?").get(since).u;
}

function may(d, prio) {
  const cap = num("CLAUDE_GATE_CAP", 24), reserve = num("CLAUDE_GATE_RESERVE", 4);
  const n = d.prepare("SELECT COUNT(*) n FROM slots").get().n;
  if (prio === "live") return n < cap;
  if (n >= cap - reserve) return false;
  const limit = num("CLAUDE_GATE_LIMIT_5H", 0);
  return !(limit && used5h(d) >= limit - num("CLAUDE_GATE_KEEP", 100));
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
    if (prio !== "live" && num("CLAUDE_GATE_LIMIT_5H", 0)) {
      try { syncCC(); } catch { /* 读不了就按旧数 */ }
    }
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
