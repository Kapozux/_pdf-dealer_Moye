// 8765 只接本机请求。用例按真实调用方写：Moye 页面、Verbatim、curl / 安装脚本，以及几种攻击。
import assert from "node:assert/strict";
import test from "node:test";
import { foreignRequestReason } from "../../server/request-guard.mjs";

const PORT = 8765;

test("现有的调用方全部放行", () => {
  for (const headers of [
    { host: "127.0.0.1:8765", origin: "http://localhost:3000" },   // Moye 页面
    { host: "127.0.0.1:8765", origin: "http://127.0.0.1:3000" },   // 用 127.0.0.1 打开的 Moye
    { host: "127.0.0.1:8765", origin: "http://127.0.0.1:5001" },   // Verbatim 页面
    { host: "127.0.0.1:8765" },                                     // curl、install.sh、Verbatim 的 Python 服务端
    { host: "localhost:8765" },
    { host: "[::1]:8765", origin: "http://[::1]:3000" },
  ]) {
    assert.equal(foreignRequestReason(headers, PORT), null, JSON.stringify(headers));
  }
});

test("任意网页发来的请求（浏览器跨站 POST 一定带 Origin）拦下", () => {
  assert.match(foreignRequestReason({ host: "127.0.0.1:8765", origin: "https://evil.example" }, PORT), /来源/);
  assert.match(foreignRequestReason({ host: "127.0.0.1:8765", origin: "http://localhost.evil.example:3000" }, PORT), /来源/);
  assert.match(foreignRequestReason({ host: "127.0.0.1:8765", origin: "null" }, PORT), /来源/);   // file:// 页面、沙箱 iframe
});

test("DNS rebinding：Host 是攻击者的域名，连同源 GET 也拦下", () => {
  assert.match(foreignRequestReason({ host: "evil.example:8765" }, PORT), /Host/);
  assert.match(foreignRequestReason({ host: "127.0.0.1.evil.example:8765" }, PORT), /Host/);
  assert.match(foreignRequestReason({ host: "127.0.0.1:9999" }, PORT), /Host/);
  assert.match(foreignRequestReason({}, PORT), /Host/);
});
