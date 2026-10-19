#!/usr/bin/env node
/**
 * 只读的资料库查询命令：「问」让本机 Claude Code 自己跑它，搜正文、看某一页，再挑出要找的文件。
 * 照 Verbatim 的 look.py（再往上是 Ephemeris 的 look.py）：Claude 只被放行这一条命令，别的一律拒。
 *
 *   node server/look.mjs search <词> [词…] [--any] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--n 20]
 *   node server/look.mjs hits   <短号> <词> [--n 20]
 *   node server/look.mjs read   <短号> [--page N | --at 词] [--chars 2500]
 *   node server/look.mjs info   <短号>
 *   node server/look.mjs list   [--since …] [--until …] [--n 50]
 *   node server/look.mjs stats
 *
 * 出处记号 [[d:短号@p页]]，短号是任务 id 前 8 位。只读：moye.db 用 readOnly 打开，正文读 data/jobs/<id>/result.json。
 * 数据目录默认仓库里的 data/，MOYE_DATA_DIR 可改（测试用）。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMANDS = ["search", "hits", "read", "info", "list", "stats"];
const DATA = process.env.MOYE_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "data");

const fold = (s) => String(s ?? "").toLowerCase();
const flat = (s) => String(s ?? "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/[#*_`>|\\]+/g, " ").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const short = (id) => String(id).slice(0, 8);

function tagsOf(raw) {
  try {
    const tags = JSON.parse(raw || "[]");
    return Array.isArray(tags) ? tags.map(String) : [];
  } catch {
    return [];
  }
}

/** 命令行 → { cmd, args: 位置参数, opts: { any, since, until, n, page, at, chars } } */
export function parse(argv) {
  const [cmd, ...rest] = argv;
  const args = [];
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--any") opts.any = true;
    else if (a.startsWith("--")) opts[a.slice(2)] = rest[++i];
    else args.push(a);
  }
  return { cmd, args, opts };
}

function openDb() {
  return new DatabaseSync(join(DATA, "moye.db"), { readOnly: true });
}

function docs() {
  const db = openDb();
  try {
    return db.prepare("SELECT id, filename, created_at, page_count, tags, ai_title, ai_one_line, mode, fallback_count, review_count FROM jobs WHERE status = 'done' ORDER BY created_at DESC").all();
  } finally {
    db.close();
  }
}

function pagesOf(id) {
  const file = join(DATA, "jobs", id, "result.json");
  if (!existsSync(file)) return [];
  try {
    return (JSON.parse(readFileSync(file, "utf8")).pages ?? []).map((p) => ({ page: p.page, text: String(p.markdown ?? "") }));
  } catch {
    return [];
  }
}

const titleOf = (d) => d.ai_title || d.filename;
const head = (d) => [`[[d:${short(d.id)}]] ${titleOf(d)}`, String(d.created_at).slice(0, 10), `${d.page_count}页`,
  tagsOf(d.tags).map((t) => `#${t}`).join(" "), d.filename !== titleOf(d) ? d.filename : ""].filter(Boolean).join(" | ");

function snippet(text, at, len, width = 60) {
  const start = Math.max(0, at - width);
  const end = Math.min(text.length, at + len + width);
  return `${start > 0 ? "…" : ""}${flat(text.slice(start, end))}${end < text.length ? "…" : ""}`;
}

function resolve(list, ref) {
  const r = fold(ref);
  if (r.length < 4) return null;
  const hit = list.filter((d) => d.id.startsWith(r));
  return hit.length === 1 ? hit[0] : null;
}

function inRange(d, opts) {
  const day = String(d.created_at).slice(0, 10);
  return (!opts.since || day >= opts.since) && (!opts.until || day <= opts.until);
}

function search(list, words, opts) {
  const needles = words.map(fold).filter(Boolean);
  if (!needles.length) return "用法：search <词> [词…]";
  const n = Number(opts.n) || 20;
  const out = [];
  for (const d of list) {
    if (!inRange(d, opts)) continue;
    const meta = fold([d.ai_title, d.filename, d.ai_one_line, tagsOf(d.tags).join(" ")].join(" "));
    const pages = pagesOf(d.id);
    const body = pages.map((p) => ({ ...p, folded: fold(p.text) }));
    const found = needles.map((w) => meta.includes(w) || body.some((p) => p.folded.includes(w)));
    if (opts.any ? !found.some(Boolean) : !found.every(Boolean)) continue;
    let count = 0;
    const shown = [];
    for (const p of body) {
      for (const w of needles) {
        let at = p.folded.indexOf(w);
        while (at !== -1) {
          count += 1;
          if (shown.length < 2) shown.push(`   [[d:${short(d.id)}@p${p.page}]] ${snippet(p.text, at, w.length)}`);
          at = p.folded.indexOf(w, at + w.length);
        }
      }
    }
    out.push({ count: count + (needles.some((w) => meta.includes(w)) ? 50 : 0), lines: [head(d), ...shown] });
  }
  out.sort((a, b) => b.count - a.count);
  if (!out.length) return `没有同时提到 ${needles.join("、")} 的文档（试试换说法、拆开、或加 --any）`;
  return [`${out.length} 份`, ...out.slice(0, n).flatMap((o) => o.lines)].join("\n");
}

function hits(list, ref, word, opts) {
  const d = resolve(list, ref);
  if (!d) return `认不出短号 ${ref}`;
  const w = fold(word);
  if (!w) return "用法：hits <短号> <词>";
  const n = Number(opts.n) || 20;
  const lines = [];
  for (const p of pagesOf(d.id)) {
    const f = fold(p.text);
    let at = f.indexOf(w);
    while (at !== -1 && lines.length < n) {
      lines.push(`[[d:${short(d.id)}@p${p.page}]] ${snippet(p.text, at, w.length)}`);
      at = f.indexOf(w, at + w.length);
    }
  }
  return [head(d), ...(lines.length ? lines : [`正文里没有「${word}」`])].join("\n");
}

function read(list, ref, opts) {
  const d = resolve(list, ref);
  if (!d) return `认不出短号 ${ref}`;
  const pages = pagesOf(d.id);
  if (!pages.length) return `${head(d)}\n（没有正文）`;
  const chars = Number(opts.chars) || 2500;
  let page = pages.find((p) => p.page === Number(opts.page)) ?? pages[0];
  let from = 0;
  if (opts.at) {
    const w = fold(opts.at);
    const p = pages.find((x) => fold(x.text).includes(w));
    if (!p) return `${head(d)}\n正文里没有「${opts.at}」`;
    page = p;
    from = Math.max(0, fold(p.text).indexOf(w) - Math.floor(chars / 3));
  }
  const text = page.text.slice(from, from + chars);
  return `${head(d)}\n[[d:${short(d.id)}@p${page.page}]] 第 ${page.page}/${d.page_count} 页${from ? "（从中间开始）" : ""}\n${text}${from + chars < page.text.length ? "\n…（这页还有）" : ""}`;
}

function info(list, ref) {
  const d = resolve(list, ref);
  if (!d) return `认不出短号 ${ref}`;
  const outline = [];
  for (const p of pagesOf(d.id)) {
    for (const line of p.text.split("\n")) {
      const m = line.match(/^#{1,3}\s+(.+)/);
      if (m && outline.length < 40) outline.push(`  p${p.page} ${clip(flat(m[1]), 60)}`);
    }
  }
  return [head(d), `一句话：${d.ai_one_line || "（无）"}`, `模式：${d.mode} · 回退页 ${d.fallback_count ?? 0} · 建议复核 ${d.review_count ?? 0}`,
    "标题：", ...(outline.length ? outline : ["  （没有标题行）"])].join("\n");
}

function listDocs(list, opts) {
  const n = Number(opts.n) || 50;
  const rows = list.filter((d) => inRange(d, opts));
  return [`${rows.length} 份`, ...rows.slice(0, n).map(head)].join("\n");
}

function stats(list) {
  const byMonth = new Map();
  for (const d of list) byMonth.set(String(d.created_at).slice(0, 7), (byMonth.get(String(d.created_at).slice(0, 7)) ?? 0) + 1);
  return [`${list.length} 份 · ${list.reduce((s, d) => s + d.page_count, 0)} 页`,
    ...[...byMonth].map(([m, c]) => `${m}: ${c} 份`)].join("\n");
}

export function run(argv) {
  const { cmd, args, opts } = parse(argv);
  if (!COMMANDS.includes(cmd)) return `命令只有：${COMMANDS.join(" / ")}`;
  const list = docs();
  if (cmd === "search") return search(list, args, opts);
  if (cmd === "hits") return hits(list, args[0], args.slice(1).join(" "), opts);
  if (cmd === "read") return read(list, args[0], opts);
  if (cmd === "info") return info(list, args[0]);
  if (cmd === "list") return listDocs(list, opts);
  return stats(list);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(`${run(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stdout.write(`出错：${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
