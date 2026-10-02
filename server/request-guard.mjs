/**
 * 8765 只接本机的请求：本机页面（Moye 自己的 3000、Verbatim 等任意 localhost 端口），
 * 以及不带 Origin 的本机程序（curl、安装脚本、Verbatim 的 Python 服务端）。
 *
 * 为什么要拦：CORS 只挡「读响应」，挡不住「执行」。任意网页都能对 127.0.0.1:8765
 * 发一个 text/plain 的 POST（浏览器不预检），服务端照样执行——改 AI 服务地址
 * 让之后每次转换都把 Key 发出去、触发一键安装、刷模型费用。浏览器发跨站 POST 一定带
 * Origin，所以按 Origin 拦得住；DNS rebinding（攻击者域名解析到 127.0.0.1）连同源
 * GET 都能读到 Library，它的 Host 头是攻击者的域名，所以再按 Host 拦一道。
 *
 * 纯函数，见 tests/behaviour/request-guard.test.mjs。
 */

/** 本机页面的来源：localhost / 127.0.0.1 / [::1] 的任意端口（3000 的 Moye、5001 的 Verbatim……）。 */
export const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * 这个请求是不是外来的：是就返回原因（给日志和 403 响应用），本机请求返回 null。
 * @param {{ host?: string, origin?: string }} headers  原样传 request.headers 即可
 * @param {number} port  服务自己监听的端口
 */
export function foreignRequestReason({ host, origin }, port) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!allowedHosts.has(String(host ?? "").toLowerCase())) return `Host「${host ?? ""}」不是本机地址`;
  // 没有 Origin = 不是浏览器里的跨站请求（curl、脚本、服务端调用）。有就必须是本机页面；
  // 「null」（file:// 页面、沙箱 iframe）也不算
  if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) return `来源「${origin}」不是本机页面`;
  return null;
}
