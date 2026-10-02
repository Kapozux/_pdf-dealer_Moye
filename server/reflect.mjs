/**
 * 回顾（Reflect）：这段时间你在转换 / 读什么。
 *
 * 纯统计（转换最多的星期、最常转换的时段、按日曲线、主题占比）每次现算，
 * 从 jobstore 拿几百行不到 1ms；叙事标题 + 一段话 + 每个主题的一句说明由模型写。
 * 中英两份在同一个请求里一起写出来（清单很长，分两次发等于白传一遍），
 * 拆开写入 data/reflect-cache.json（按 时段:语言 存）。
 *
 * 生成是提前做的，打开面板不用等：
 *   - 服务启动 90 秒后、之后每 6 小时，把四个时段里数据变了的重算一遍；
 *   - 每有转换完成，10 分钟防抖后再算一次（一批 100 份只触发一次）；
 *   - 打开面板时缓存已过期就先返回旧的（stale=true）并排后台重算，前端轮询到新的再替换；
 *     只有手动点刷新才同步等待。
 *
 * 模型调用由 local-ocr-server 注入（generate(prompt) → 文本），本模块不碰 key。
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { stripSourceExtension } from "./filenames.mjs";

export const RANGES = { "1m": 1, "3m": 3, "6m": 6, "12m": 12 };
const TOP_N = 5;
const MAX_ITEMS_FOR_LLM = 220;
const TOUCH_DELAY_MS = 10 * 60 * 1000;
const PERIODIC_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 90 * 1000;

const WEEKDAYS = {
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  zh: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
};

// ---------- 读数据 ----------

function loadItems(rows) {
  const items = [];
  for (const r of rows) {
    const dt = new Date(r.created_at);
    if (Number.isNaN(dt.getTime())) continue;
    let tags = [];
    try {
      const parsed = JSON.parse(r.tags || "[]");
      if (Array.isArray(parsed)) tags = parsed.map((t) => String(t)).filter(Boolean);
    } catch {
      /* 坏 JSON 当没标签 */
    }
    items.push({
      id: r.id,
      dt,
      pages: Number(r.page_count) || 0,
      chars: Number(r.char_count) || 0,
      mode: r.mode,
      title: (r.ai_title || stripSourceExtension(r.filename) || "").trim(),
      oneLine: (r.ai_one_line || "").trim(),
      tags,
    });
  }
  return items;
}

function monthsAgo(now, months) {
  const d = new Date(now);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() - months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

function localDay(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------- 统计 ----------

function dailySeries(items, start, end) {
  const count = new Map();
  const pages = new Map();
  for (const it of items) {
    const k = localDay(it.dt);
    count.set(k, (count.get(k) ?? 0) + 1);
    pages.set(k, (pages.get(k) ?? 0) + it.pages);
  }
  const out = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const stop = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= stop) {
    const k = localDay(cur);
    out.push({ date: k, count: count.get(k) ?? 0, pages: pages.get(k) ?? 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/**
 * 主题占比（按页数）。每份文档有 2-4 个标签，直接均分会被长尾标签摊薄，
 * 所以先按总权重给标签排名，再把每份整体计入它所带标签里排名最高的那个。
 */
function topicShares(items) {
  const freq = new Map();
  for (const it of items) {
    const w = it.pages > 0 ? it.pages : 1;
    const tags = it.tags.length ? it.tags : ["未分类"];
    for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + w / tags.length);
  }
  const rank = new Map([...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t], i) => [t, i]));
  const weight = new Map();
  const count = new Map();
  let total = 0;
  for (const it of items) {
    const w = it.pages > 0 ? it.pages : 1;
    total += w;
    const tags = it.tags.length ? it.tags : ["未分类"];
    const t = tags.reduce((best, x) => ((rank.get(x) ?? 1e9) < (rank.get(best) ?? 1e9) ? x : best), tags[0]);
    weight.set(t, (weight.get(t) ?? 0) + w);
    count.set(t, (count.get(t) ?? 0) + 1);
  }
  if (total <= 0) return [];
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, TOP_N);
  const rest = ranked.slice(TOP_N);
  const topics = top.map(([tag, w]) => ({ tag, pages: Math.round(w), count: count.get(tag) ?? 0, share: w / total }));
  if (rest.length) {
    const rw = rest.reduce((s, [, w]) => s + w, 0);
    topics.push({ tag: "__other__", pages: Math.round(rw), count: rest.reduce((s, [t]) => s + (count.get(t) ?? 0), 0), share: rw / total });
  }
  const pcts = topics.map((t) => Math.round(t.share * 100));
  if (pcts.length) pcts[0] += 100 - pcts.reduce((a, b) => a + b, 0);
  topics.forEach((t, i) => { t.percent = Math.max(pcts[i], 0); delete t.share; });
  return topics;
}

export function compute(rows, rangeKey = "1m", now = new Date()) {
  const months = RANGES[rangeKey] ?? 1;
  const start = monthsAgo(now, months);
  const prevStart = monthsAgo(now, months * 2);
  const all = loadItems(rows);
  const cur = all.filter((i) => i.dt >= start && i.dt <= now).sort((a, b) => a.dt - b.dt);
  const prev = all.filter((i) => i.dt >= prevStart && i.dt < start);

  const wd = new Array(7).fill(0);
  const hr = new Array(24).fill(0);
  for (const it of cur) {
    wd[(it.dt.getDay() + 6) % 7] += 1;   // 0=周一
    hr[it.dt.getHours()] += 1;
  }
  const argmax = (arr) => (arr.some((v) => v > 0) ? arr.indexOf(Math.max(...arr)) : null);

  const series = dailySeries(cur, start, now);
  let prevSeries = dailySeries(prev, prevStart, new Date(start.getTime() - 86400000));
  if (prevSeries.length >= series.length) prevSeries = prevSeries.slice(prevSeries.length - series.length);

  return {
    range: rangeKey,
    period: { start: localDay(start), end: localDay(now) },
    totals: {
      count: cur.length,
      pages: cur.reduce((s, i) => s + i.pages, 0),
      chars: cur.reduce((s, i) => s + i.chars, 0),
      prev_count: prev.length,
      prev_pages: prev.reduce((s, i) => s + i.pages, 0),
    },
    most_active_weekday: argmax(wd),
    peak_hour: argmax(hr),
    weekday_counts: wd,
    hour_counts: hr,
    series,
    prev_series: prevSeries,
    topics: topicShares(cur),
    _items: cur,
  };
}

// ---------- 叙事 ----------

const PROMPT = ({ period, topics, n, truncated, items }) => `下面是一个人在 ${period} 期间用「墨页」转成 Markdown 的文档清单（每行：日期 | 页数 | 标题 | 一句话简介 | 标签），
以及按页数算出的主题占比。这些文档是他在读、在做、在整理的材料。请写一份简短的回顾，中文、英文各一份。

风格要求（两种语言一样）：直接、具体、说人话。像朋友看完你这段时间转的文件后直接告诉你"你这段时间主要在弄什么"。
不要比喻，不要抒情，不要评价好坏，不要给建议，不要罗列数字。可以直接点名科目、课程、书名、考试、具体题型。
英文那份是照着清单独立写一遍，不是把中文逐句翻译过去。

每种语言都输出三部分：
1. headline：一句话概括这段时间在弄什么，直接陈述，不要冒号、感叹号、书名号。
   中文不超过 20 个字，例如「主要在刷 IB 数学试卷和整理物理讲义」；
   英文不超过 12 个词，例如 "Mostly IB math past papers and physics lecture notes"。
2. narrative：一段话。第一句说最主要的材料是什么；然后说第二、第三大块；如果有明显变化
   （比如后半段转向了别的科目）说一句；最后可以提一个反复出现的具体主题。
   中文 80-130 字，英文 60-100 词。
3. topics：对下面每个主题标签，说清在这个标签下实际是什么材料——
   name 不要照抄标签本身（标签是"数学"就别再写"数学"），要比标签更具体，
   例如「IB 数学 HL 真题卷」、"IB math HL past papers"。
   name_zh 不超过 10 个字，name_en 不超过 5 个词；desc_zh 不超过 35 字，desc_en 不超过 16 词，直接说内容。
   tag 一栏必须原样抄下面的标签，包括 "__other__" 这个写法本身，不要翻译、不要换成别的词。
   "__other__" 这项 name_zh 固定写「其它」、name_en 固定写 "Everything else"，desc 说剩下零散的是什么。

主题占比：
${topics}

文档清单（共 ${n} 份${truncated}）：
${items}

严格按以下 JSON 输出，不要输出其他任何内容：
{"zh": {"headline": "...", "narrative": "..."},
 "en": {"headline": "...", "narrative": "..."},
 "topics": [{"tag": "原标签", "name_zh": "...", "desc_zh": "...", "name_en": "...", "desc_en": "..."}]}`;

function fingerprint(items) {
  const h = createHash("sha1");
  for (const it of items) h.update(String(it.id));
  return h.digest("hex").slice(0, 16);
}

function extractJsonObject(raw) {
  let text = String(raw ?? "").trim();
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1];
  const start = text.indexOf("{");
  if (start > 0) text = text.slice(start);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fallbackText(data, lang) {
  const lead = data.topics.filter((t) => t.tag !== "__other__").slice(0, 2).map((t) => t.tag);
  const zh = lang === "zh";
  return {
    headline: lead.length
      ? (zh ? `这段时间主要在弄${lead.join("和")}` : `A stretch of ${lead.join(" and ")}`)
      : (zh ? "这段时间还没有转换记录" : "Nothing converted yet"),
    narrative: zh
      ? "还没有生成回顾。在设置里配好任意一家模型的 Key，再点右上角刷新。"
      : "No recap yet. Add a model key in Settings, then hit refresh.",
    topics: Object.fromEntries(data.topics.map((t) => [t.tag, { name: t.tag === "__other__" ? (zh ? "其它" : "Everything else") : t.tag, desc: "" }])),
    generated: false,
  };
}

/**
 * @param {object} deps  { rows: () => jobstore rows, generate: (prompt) => Promise<string>, dataDir, log }
 */
export function createReflect({ rows, generate, dataDir, log = console }) {
  const cachePath = join(dataDir, "reflect-cache.json");
  let cacheWrite = Promise.resolve();      // 串行化读-改-写，几个时段同时算完不互相覆盖
  const inflight = new Set();
  let queue = Promise.resolve();           // 后台任务串行跑：一次一个时段，一个时段一个请求
  let touchTimer = null;

  async function readCache() {
    try {
      return JSON.parse(await readFile(cachePath, "utf8"));
    } catch {
      return {};
    }
  }

  function updateCache(mutate) {
    cacheWrite = cacheWrite.then(async () => {
      const cache = await readCache();
      mutate(cache);
      const tmp = `${cachePath}.tmp`;
      await writeFile(tmp, JSON.stringify(cache, null, 1));
      await rename(tmp, cachePath);
    }).catch((error) => log.warn(`[回顾] 缓存写入失败：${String(error?.message ?? error).slice(0, 120)}`));
    return cacheWrite;
  }

  /**
   * 一次请求写出中英两份叙事。
   *
   * 中英分两次发，等于把那份上万 token 的清单原样传两遍，而两份叙事读的是同一批文档，
   * 所以合成一个请求：清单只传一次，topics 里中英两套名字并排放。
   * 返回 { zh, en }，某种语言没写出来就是 null。
   */
  async function generatePair(data) {
    const items = data._items;
    if (!items.length) return { zh: null, en: null };
    let sample = items;
    let truncated = "";
    if (items.length > MAX_ITEMS_FOR_LLM) {
      const step = items.length / MAX_ITEMS_FOR_LLM;
      sample = Array.from({ length: MAX_ITEMS_FOR_LLM }, (_, i) => items[Math.floor(i * step)]);
      truncated = "，已均匀抽样";
    }
    const lines = sample.map((it) => `${localDay(it.dt).slice(5)} | ${it.pages} | ${it.title.slice(0, 40)} | ${it.oneLine.slice(0, 60)} | ${it.tags.slice(0, 4).join("/")}`);
    const topicLines = data.topics.map((t) => `${t.tag}: ${t.percent}% (${t.count} docs, ${t.pages} pages)`).join("\n");
    const prompt = PROMPT({
      period: `${data.period.start} ~ ${data.period.end}`, topics: topicLines, n: items.length, truncated, items: lines.join("\n"),
    });
    let raw;
    try {
      raw = await generate(prompt);
    } catch (error) {
      log.warn(`[回顾] 叙事生成失败：${String(error?.message ?? error).slice(0, 160)}`);
      return { zh: null, en: null };
    }
    const obj = extractJsonObject(raw);
    if (!obj || typeof obj !== "object") {
      log.warn(`[回顾] 叙事 JSON 解析失败：${String(raw).slice(0, 120)}`);
      return { zh: null, en: null };
    }
    const out = { zh: null, en: null };
    for (const lang of ["zh", "en"]) {
      const part = obj[lang];
      if (!part || typeof part !== "object" || !part.headline) {
        log.warn(`[回顾] 叙事缺少 ${lang} 那份，先写另一种语言。`);
        continue;                                   // 只塌一种语言就只写另一种，下次重算再补
      }
      const topics = {};
      for (const t of Array.isArray(obj.topics) ? obj.topics : []) {
        if (t && t.tag) {
          topics[String(t.tag)] = {
            name: String(t[`name_${lang}`] || t.tag).trim().slice(0, 40),
            desc: String(t[`desc_${lang}`] || "").trim().slice(0, 120),
          };
        }
      }
      out[lang] = {
        // 中文 20 字以内，英文 12 个词——英文按 60 字符切会从词中间断掉
        headline: String(part.headline).trim().replace(/[。.]+$/, "").slice(0, lang === "zh" ? 60 : 120),
        narrative: String(part.narrative || "").trim().slice(0, 800),
        topics,
        generated: true,
      };
    }
    return out;
  }

  /** 同步重算某个时段的中英叙事并写缓存。 */
  async function regenerate(rangeKey, data = compute(rows(), rangeKey)) {
    const fp = fingerprint(data._items);
    const results = await generatePair(data);
    const { zh, en } = results;
    if (zh || en) {
      const at = new Date().toISOString();
      await updateCache((cache) => {
        for (const [lang, text] of Object.entries(results)) if (text) cache[`${rangeKey}:${lang}`] = { fp, text, at };
      });
    }
    return results;
  }

  function scheduleRegenerate(rangeKey) {
    if (inflight.has(rangeKey)) return false;
    inflight.add(rangeKey);
    queue = queue.then(() => regenerate(rangeKey)).catch(() => undefined).finally(() => inflight.delete(rangeKey));
    return true;
  }

  async function refreshStale() {
    const cache = await readCache();
    const all = rows();
    for (const rk of Object.keys(RANGES)) {
      const data = compute(all, rk);
      if (!data._items.length) continue;
      const fp = fingerprint(data._items);
      const fresh = ["zh", "en"].every((l) => cache[`${rk}:${l}`]?.fp === fp);
      if (!fresh) scheduleRegenerate(rk);
    }
  }

  function touch() {
    if (touchTimer) clearTimeout(touchTimer);
    touchTimer = setTimeout(() => { touchTimer = null; void refreshStale(); }, TOUCH_DELAY_MS);
    touchTimer.unref?.();
  }

  function startScheduler() {
    const first = setTimeout(() => {
      void refreshStale();
      const every = setInterval(() => void refreshStale(), PERIODIC_MS);
      every.unref?.();
    }, STARTUP_DELAY_MS);
    first.unref?.();
  }

  async function build(rangeKey = "1m", lang = "zh", refresh = false) {
    lang = lang === "zh" ? "zh" : "en";
    if (!RANGES[rangeKey]) rangeKey = "1m";
    const data = compute(rows(), rangeKey);
    const fp = fingerprint(data._items);
    const hit = (await readCache())[`${rangeKey}:${lang}`];
    const fresh = Boolean(hit) && hit.fp === fp;
    let text = null;
    let stale = false;
    if (refresh) {
      const results = await regenerate(rangeKey, data);
      text = results[lang] || hit?.text || null;
    } else if (fresh) {
      text = hit.text;
    } else {
      if (data._items.length) scheduleRegenerate(rangeKey);
      text = hit?.text || null;
      stale = Boolean(hit);
    }
    if (!text) text = fallbackText(data, lang);

    const otherName = lang === "zh" ? "其它" : "Everything else";
    for (const t of data.topics) {
      const info = text.topics?.[t.tag] || {};
      t.name = info.name || (t.tag === "__other__" ? otherName : t.tag);
      t.desc = info.desc || "";
    }
    const wd = data.most_active_weekday;
    const { _items, ...rest } = data;
    void _items;
    return {
      ...rest,
      most_active_weekday_label: wd === null ? null : WEEKDAYS[lang][wd],
      headline: text.headline,
      narrative: text.narrative,
      generated: Boolean(text.generated),
      stale,
      regenerating: inflight.has(rangeKey),
      lang,
    };
  }

  return { build, regenerate, refreshStale, touch, startScheduler, isRegenerating: (rk) => inflight.has(rk) };
}
