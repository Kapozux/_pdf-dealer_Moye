/**
 * Markdown 里链接 / 图片地址的白名单。内容来自 PDF 文字层和模型输出，不可信：
 *   - javascript: 链接在页面里一点就执行——页面和本机 8765 服务同源放行，
 *     一段脚本就能改掉 AI 服务地址，之后每次转换都把 Key 发出去；
 *   - 外链图片一渲染就发请求，等于告诉别人「这份文档被打开了」。
 * 判断用 URL 解析后的协议，不靠字符串前缀：`JaVaScRiPt:`、`java\tscript:` 这类变形一样拦住。
 *
 * 纯函数、无依赖，浏览器和 Node 都能直接跑。
 */

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** 能放进 <a href> 的地址；不安全或在这里没意义的（相对路径、file:、data:…）返回 null，调用方只留文字。 */
export function safeLinkHref(/** @type {unknown} */ href) {
  const value = String(href ?? "").trim();
  if (/^#[^\s"'<>]*$/.test(value)) return value;   // 文内锚点
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;   // 不是绝对地址：相对路径在这个页面里指不到任何东西，当普通文字
  }
  return LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
}

/** 能直接 <img> 显示的地址：只有内嵌的位图 data:image（不发请求；svg 能带脚本，不算）。 */
export function safeImageSrc(/** @type {unknown} */ src) {
  const value = String(src ?? "").trim();
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value) ? value : null;
}

const escapeHtml = (/** @type {string} */ s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * marked 渲染器里链接和图片的输出：`Object.assign(renderer, safeLinkRenderers(t("图片")))`。
 * 不安全的链接只留文字；外链图片默认不自动加载，换成一个自己点的链接。
 * 本机路径（file:、/Users/…）的图片永远不加载：打成 PDF 等于把本机文件嵌进一份可以发给别人的文件。
 * @param {string} imageLabel  图片占位文字（「图片」，按界面语言传进来）
 * @param {{ remoteImages?: boolean }} [options]  remoteImages：网上的图片照常显示（用户自己拖进来的 .md 打 PDF 时用）
 */
export function safeLinkRenderers(imageLabel, { remoteImages = false } = {}) {
  return {
    /** @this {{ parser: { parseInline: (tokens: unknown[]) => string } }} @param {{ href: string, title?: string | null, tokens: unknown[] }} token */
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = safeLinkHref(href);
      if (!safe) return text;
      return `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ""} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    /** @param {{ href: string, title?: string | null, text: string }} token */
    image({ href, title, text }) {
      const external = safeLinkHref(href);
      const src = safeImageSrc(href) ?? (remoteImages && external && /^https?:/.test(external) ? external : null);
      if (src) return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""}>`;
      const label = `[${escapeHtml(imageLabel)}${text ? `：${escapeHtml(text)}` : ""}]`;
      return external ? `<a href="${escapeHtml(external)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    },
  };
}
