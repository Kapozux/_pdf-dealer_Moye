// 给正在跑的墨页页面截图，改 UI 之后对照用（docs/UI_DESIGN.md 的检查清单要求的三个宽度 × 浅色 / 深色）。
//
//   node scripts/screenshot.mjs <输出.png> [网址] [宽] [高] [light|dark] [等待毫秒] [截图前执行的 JS]
//   node scripts/screenshot.mjs /tmp/lib-dark.png "http://localhost:3000/#/library" 1440 900 dark
//   node scripts/screenshot.mjs /tmp/settings.png http://localhost:3000/ 1000 900 light 4000 "document.querySelector('.settings-button').click()"
//
// 用 data/browser/ 里自带的 chrome-headless-shell（npm run browser:install），独立的临时 profile：
// 不碰用户正在用的 Chrome（CLAUDE.md：测试时绝不要启动用户的 Chrome），也不碰 md2pdf 的 profile。
// 走 DevTools 协议而不是 --screenshot 开关：页面上一直开着 SSE，「等网络空闲再截」永远等不到头。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledHeadlessShell } from "../server/md2pdf.mjs";

const [out, url = "http://localhost:3000/", width = "1440", height = "900", scheme = "light", wait = "4000", script = ""] = process.argv.slice(2);
if (!out) {
  console.error("用法：node scripts/screenshot.mjs <输出.png> [网址] [宽] [高] [light|dark] [等待毫秒] [截图前执行的 JS]");
  process.exit(2);
}
const shell = await bundledHeadlessShell();
if (!shell) {
  console.error("没有自带的无头浏览器（data/browser/）。先跑 npm run browser:install——不会去用系统里的 Chrome。");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "moye-shot-"));
const child = spawn(shell, ["--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "about:blank"], {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
});
const cleanup = () => {
  try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) { console.warn(`临时 profile 没删掉：${profile}（${error.message}）`); }
};
const guard = setTimeout(() => { console.error("截图超时（60s）"); cleanup(); process.exit(1); }, 60000);

let nextId = 0;
let buffer = "";
const pending = new Map();
child.stdio[4].on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const waiter = message.id && pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
});

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: Number(width) < 700 }, sessionId);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme === "dark" ? "dark" : "light" }] }, sessionId);
  await send("Page.enable", {}, sessionId);
  // 用中文界面截（用户平时看到的样子）；要英文就在截图前的 JS 里切
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "try { localStorage.setItem('moye_lang', 'zh') } catch {}" }, sessionId);
  await send("Page.navigate", { url }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, Number(wait)));
  if (script) {
    await send("Runtime.evaluate", { expression: script, awaitPromise: true }, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`已保存 ${out}`);
} catch (error) {
  console.error(`截图失败：${error.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(guard);
  cleanup();
}
