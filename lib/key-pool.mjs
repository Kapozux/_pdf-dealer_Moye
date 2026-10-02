/**
 * 「额外 Gemini Key 列表」在页面和服务端之间的协议——两半写在同一个文件里。
 *
 * 页面永远拿不到已存 Key 的明文，只有打码文本。所以保存时，已存且没动的那几把
 * 要用占位符告诉服务端「这一把别动」。以前占位符只有一个 "__KEEP__"，服务端
 * 按数组位置去配旧值：页面删掉第一行，后面的行整体前移，第 N 个占位符就配到了
 * 第 N 把旧 Key 上——想删的 A 还在，想留的 C 被静默丢掉。
 *
 * 现在每个占位符自带出处：`__KEEP__:<当初在已存列表里的位置>:<末 4 位>`，
 * 服务端按位置取、用末 4 位核对，对不上就按末 4 位找，找不到说明那把已经不在了。
 *
 *   页面：rowsFromSaved(打码列表) → 用户增删改 → rowsToPayload(rows) → POST
 *   服务端：mergeExtraKeys(payload, 已存的值) → 写盘 → 回传新的打码列表
 *
 * 纯函数、无依赖，浏览器和 Node 都能直接跑。
 */

export const KEEP_KEY = "__KEEP__";

/**
 * 设置面板里的一行。savedIndex 不为 null = 这行对应已存列表里的第几把（只有打码文本）；
 * value 非空 = 用户填了新明文（填在已存行上就是替换那一把）。
 * @typedef {{ masked: string | null, value: string, savedIndex: number | null }} KeyRow
 */

/** 已存 Key 列表：换行或逗号分隔，去空白、去空项。 */
export function splitKeys(/** @type {unknown} */ value) {
  return String(value || "").split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
}

/** 只露末 4 位。页面、日志、Library 里出现的 Key 都只能是这个样子。 */
export function maskedKey(/** @type {string | undefined} */ value) {
  if (!value) return "";
  return `••••••••${value.slice(-4)}`;
}

// ---- 页面这一半 ----

/** 服务端回传的打码列表 → 设置面板的行。打开面板、保存成功后都要按它重置。 */
export function rowsFromSaved(/** @type {string[] | undefined} */ maskedList) {
  return (maskedList ?? []).map((masked, savedIndex) => /** @type {KeyRow} */ ({ masked, value: "", savedIndex }));
}

/** 新加的一行（还没有明文）。 */
export function newRow() {
  return /** @type {KeyRow} */ ({ masked: null, value: "", savedIndex: null });
}

/** 设置面板的行 → 保存请求里的 geminiKeysExtra。新填的传明文，已存没动的传占位符，空行丢弃。 */
export function rowsToPayload(/** @type {KeyRow[]} */ rows) {
  return rows
    .map((row) => {
      const typed = row.value.trim();
      if (typed) return typed;
      if (row.savedIndex === null || row.masked === null) return "";
      return `${KEEP_KEY}:${row.savedIndex}:${row.masked.slice(-4)}`;
    })
    .filter(Boolean);
}

// ---- 服务端这一半 ----

/** 占位符 → 它指的那把旧 Key；那把已经不在了就是 undefined。 */
function resolveKeep(/** @type {string} */ entry, /** @type {string[]} */ previousKeys, /** @type {number} */ position) {
  // 老页面（这次改动之前加载的 JS）还会发不带出处的 "__KEEP__"：只能按位置配，行为同以前
  if (entry === KEEP_KEY) return previousKeys[position];
  const [, index, suffix] = entry.split(":");
  const atIndex = previousKeys[Number(index)];
  if (atIndex !== undefined && atIndex.slice(-4) === suffix) return atIndex;
  // 页面打开之后列表在别处变过（另一个标签页也保存了）：位置不可信，按末 4 位找唯一的那把
  const bySuffix = previousKeys.filter((key) => key.slice(-4) === suffix);
  return bySuffix.length === 1 ? bySuffix[0] : undefined;
}

/**
 * 合并额外 key，返回换行分隔的字符串（settings.local.json 里的存法）。
 * - 传数组：逐项处理，占位符沿用旧值，其余为新明文；空数组 = 用户确实想清空。重复的只留一把。
 * - 传非空字符串：老格式，整串替换（向后兼容）。
 * - 没传 / 空字符串：保持原样（只改了别的字段的部分保存，不能把 Key 冲掉）。
 */
export function mergeExtraKeys(/** @type {unknown} */ input, /** @type {unknown} */ previousValue) {
  const previousKeys = splitKeys(previousValue);
  if (Array.isArray(input)) {
    const merged = input.map((entry, position) => {
      const text = String(entry ?? "").trim();
      return text === KEEP_KEY || text.startsWith(`${KEEP_KEY}:`) ? resolveKeep(text, previousKeys, position) : text;
    });
    return [...new Set(merged.filter(Boolean))].join("\n");
  }
  if (typeof input === "string" && input.trim()) return splitKeys(input).join("\n");
  return previousKeys.join("\n");
}
