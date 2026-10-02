// 渲染 Markdown 时链接 / 图片地址的白名单。
import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import { safeImageSrc, safeLinkHref, safeLinkRenderers } from "../../lib/safe-url.mjs";

test("能执行脚本、读本机文件的链接一律不给 href", () => {
  for (const href of [
    "javascript:alert(1)",
    " JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:fetch('http://127.0.0.1:8765/api/settings')",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///Users/someone/settings.local.json",
  ]) {
    assert.equal(safeLinkHref(href), null, JSON.stringify(href));
  }
});

test("普通网页、邮件、文内锚点照常是链接", () => {
  assert.equal(safeLinkHref("https://example.com/a b"), "https://example.com/a%20b");
  assert.equal(safeLinkHref("http://example.com"), "http://example.com/");
  assert.equal(safeLinkHref("mailto:teacher@example.com"), "mailto:teacher@example.com");
  assert.equal(safeLinkHref("#section-2"), "#section-2");
});

test("相对路径在这个页面里没有意义，当普通文字", () => {
  assert.equal(safeLinkHref("chapter2.md"), null);
  assert.equal(safeLinkHref("/api/settings"), null);
  assert.equal(safeLinkHref(""), null);
  assert.equal(safeLinkHref(undefined), null);
});

test("图片只直接显示内嵌位图，外链和 svg 不自动加载", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(safeImageSrc(png), png);
  assert.equal(safeImageSrc("https://tracker.example/pixel.gif"), null);
  assert.equal(safeImageSrc("data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4="), null);
  assert.equal(safeImageSrc("/Users/someone/photo.jpg"), null);
});

/** 和页面同一套配置：裸 HTML 转义 + 安全的链接 / 图片 */
function render(markdown) {
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => text.replace(/</g, "&lt;");
  Object.assign(renderer, safeLinkRenderers("图片"));
  return marked.parse(markdown, { renderer, gfm: true, async: false });
}

test("用真的 marked 渲染：危险链接只剩文字，正常链接新窗口打开", () => {
  const html = render("[点我](javascript:alert(1)) 和 [官网](https://example.com) 和 <https://example.org>");
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /点我/);
  assert.match(html, /<a href="https:\/\/example\.com\/" target="_blank" rel="noopener noreferrer">官网<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.org\/"[^>]*>https:\/\/example\.org<\/a>/);
});

test("用真的 marked 渲染：外链图片不加载，只给一个链接；链接里的格式照常渲染", () => {
  const html = render("![追踪像素](https://tracker.example/p.gif) [**粗体**链接](https://example.com)");
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /\[图片：追踪像素\]/);
  assert.match(html, /<strong>粗体<\/strong>链接<\/a>/);
});
