/**
 * 「设置 → 环境」：检测每个组件装没装、能不能用，并在页面里一键补装。
 *
 * 为什么要有它：墨页的门槛从来不是转换本身，是安装——Node、Python、Surya（还得有 llama.cpp）、
 * LibreOffice、无头浏览器、AI Key，缺一样就有一类文件转不了，而以前只会在真转的时候报一句
 * spawn ENOENT。这里把「缺什么、缺了影响什么、怎么补」摆到页面上。
 *
 * 安装动作一律交给 install.sh --only <组件>（跟命令行一键安装是同一份逻辑，不写第二份），
 * 只有 Ollama 拉模型直接走 Ollama 的 /api/pull——那样能拿到字节级进度画进度条。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { delimiter, join } from "node:path";

/** 在 PATH 里找可执行文件（launchd 给的 PATH 很短，调用方可以补几个目录）。 */
export function which(binary, extraDirs = []) {
  const dirs = [...String(process.env.PATH || "").split(delimiter), ...extraDirs];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, binary))) return join(dir, binary);
  }
  return null;
}

/**
 * soffice：brew 装的在 PATH 里；从官网下 .dmg 装的只在 LibreOffice.app 里面，不在 PATH 上。
 * 以前只认 PATH，官网版装了也被当成「没装」。
 */
export function findSoffice() {
  return which("soffice", ["/opt/homebrew/bin", "/usr/local/bin"])
    ?? ["/Applications/LibreOffice.app/Contents/MacOS/soffice", join(process.env.HOME || "", "Applications/LibreOffice.app/Contents/MacOS/soffice")]
      .find((path) => existsSync(path))
    ?? null;
}

/** 按内存推荐 Ollama 视觉模型（跟 install.sh 的 recommended_model 同一条规则）。 */
export function recommendedOllamaModel() {
  return totalmem() >= 15.5 * 1024 ** 3 ? "qwen3-vl:8b-instruct" : "qwen3-vl:4b-instruct";
}

/**
 * 模型下载源。官方库的模型文件在 Cloudflare R2 上，2026-09-24 在用户网络上实测约 100KB/s、
 * 分块反复断开后 "max retries exceeded" 放弃；魔搭有同一模型的 Ollama 格式（本体 + 视觉投影），
 * 实测约 1MB/s。跟 install.sh 的 mirror_model 是同一张表。
 */
export const OLLAMA_MIRRORS = {
  "qwen3-vl:8b-instruct": "modelscope.cn/Qwen/Qwen3-VL-8B-Instruct-GGUF:Q4_K_M",
  "qwen3-vl:4b-instruct": "modelscope.cn/Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M",
  "qwen3-vl:2b-instruct": "modelscope.cn/Qwen/Qwen3-VL-2B-Instruct-GGUF:Q4_K_M",
};

/** 从一个源取同一个文件的前 3MB，量字节/秒；任何失败都算 0。 */
async function probeSpeed(manifestUrl, blobPrefix) {
  try {
    const manifest = await (await fetch(manifestUrl, {
      headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" },
      signal: AbortSignal.timeout(8000),
    })).json();
    const digest = manifest?.layers?.[0]?.digest;
    if (!digest) return 0;
    const started = Date.now();
    // 手动逐跳跟随跳转（最多 5 跳）。魔搭的链是 modelscope.cn → ollama.modelscope.cn → CDN，
    // 第一跳的 307 在头里谎报 content-length（等于文件分片大小），undici 自动跟随时会一直等那段
    // 不存在的 body，最后 "Request was cancelled"——实测测出 0KB/s，而 curl 同一地址 900KB/s。
    let url = `${blobPrefix}/${digest}`;
    let response;
    for (let hop = 0; hop < 5; hop += 1) {
      response = await fetch(url, { headers: { Range: "bytes=0-3000000" }, redirect: "manual", signal: AbortSignal.timeout(10000) });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) break;
      await response.body?.cancel().catch(() => {});
      url = new URL(location, url).href;
    }
    let bytes = 0;
    try {
      for await (const chunk of response.body) bytes += chunk.length;
    } catch { /* 超时：按已经收到的算 */ }
    return Math.round(bytes / Math.max(0.001, (Date.now() - started) / 1000));
  } catch {
    return 0;
  }
}

const COMPONENTS = new Set(["python", "surya", "browser", "libreoffice", "ollama"]);
const LOG_LINES = 40;

export function createSetup({ root, venv, logFile, ollamaBase, listOllamaModels, onInstalled = () => {} }) {
  /** component → { running, ok, lines[], startedAt, finishedAt, progress? } */
  const tasks = new Map();
  // 下载源测速：第一次打开「环境」时在后台测一次，一小时内复用（测一次要十几秒，不能卡住页面）
  let sourceProbe = { at: 0, running: false, official: null, modelscope: null };
  function probeSources() {
    if (sourceProbe.running || Date.now() - sourceProbe.at < 3600_000) return;
    sourceProbe.running = true;
    void Promise.all([
      probeSpeed("https://registry.ollama.ai/v2/library/qwen3-vl/manifests/4b", "https://registry.ollama.ai/v2/library/qwen3-vl/blobs"),
      probeSpeed("https://modelscope.cn/v2/Qwen/Qwen3-VL-4B-Instruct-GGUF/manifests/Q4_K_M", "https://modelscope.cn/v2/Qwen/Qwen3-VL-4B-Instruct-GGUF/blobs"),
    ]).then(([official, modelscope]) => {
      sourceProbe = { at: Date.now(), running: false, official, modelscope };
      console.log(`[环境] 模型下载源测速：Ollama 官方 ${Math.round(official / 1024)}KB/s，魔搭 ${Math.round(modelscope / 1024)}KB/s`);
    });
  }

  function taskView(name) {
    const task = tasks.get(name);
    if (!task) return null;
    const view = { ...task };
    delete view.child;
    return view;
  }

  function pushLine(task, line) {
    // install.sh 在终端里会上色；去掉 ANSI 转义再给页面看
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    if (!clean) return;
    task.lines.push(clean);
    if (task.lines.length > LOG_LINES) task.lines.splice(0, task.lines.length - LOG_LINES);
    void appendFile(logFile, `[${task.name}] ${clean}\n`).catch(() => {});
  }

  function finish(task, ok, reason = "") {
    task.running = false;
    task.ok = ok;
    task.finishedAt = Date.now();
    if (reason) pushLine(task, reason);
    // 失败原因要落进日志（规矩四），不只是在页面上闪一下
    console[ok ? "log" : "warn"](`[环境] ${task.name} ${ok ? "安装完成" : `安装失败：${reason || task.lines.at(-1) || "未知原因"}`}`);
    if (ok) void Promise.resolve(onInstalled(task.name, task)).catch((error) => console.warn(`[环境] 装完后的收尾失败：${error?.message ?? error}`));
  }

  function runInstaller(name) {
    const task = { name, running: true, ok: null, lines: [], startedAt: Date.now(), finishedAt: null };
    tasks.set(name, task);
    const child = spawn("/bin/zsh", [join(root, "install.sh"), "--only", name, "--yes"], {
      cwd: root,
      // brew 装的 llama.cpp / LibreOffice 要能被找到；MOYE_YES 让脚本不提问
      env: { ...process.env, MOYE_YES: "1", PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    task.child = child;
    let partial = "";
    const onData = (chunk) => {
      // 进度条用 \r 覆盖同一行：按 \r 和 \n 都切开，只留完整的行
      partial += chunk.toString();
      const pieces = partial.split(/[\r\n]/);
      partial = pieces.pop() ?? "";
      for (const piece of pieces) pushLine(task, piece);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => finish(task, false, `无法启动安装脚本：${error.message}`));
    child.on("close", (code) => {
      if (partial) pushLine(task, partial);
      if (task.running) finish(task, code === 0, code === 0 ? "" : `安装脚本退出码 ${code}`);
    });
  }

  /** Ollama 拉模型：直接读 /api/pull 的流，拿到 completed/total 画进度条。 */
  async function pullOllamaModel(model) {
    const name = `ollama-model`;
    const task = { name, model, running: true, ok: null, lines: [], startedAt: Date.now(), finishedAt: null, progress: null };
    tasks.set(name, task);
    try {
      const response = await fetch(`${ollamaBase()}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
      });
      if (!response.ok || !response.body) throw new Error(`Ollama 拒绝了下载请求（${response.status}）：${(await response.text()).slice(0, 200)}`);
      const decoder = new TextDecoder();
      let buffer = "";
      let lastStatus = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.error) throw new Error(message.error);
          if (message.total) task.progress = { completed: message.completed || 0, total: message.total };
          if (message.status && message.status !== lastStatus) {
            lastStatus = message.status;
            pushLine(task, message.status);
          }
        }
      }
      if (lastStatus !== "success") throw new Error(`下载没有正常结束（最后状态：${lastStatus || "无"}）`);
      finish(task, true);
    } catch (error) {
      const cause = error?.cause?.code === "ECONNREFUSED" ? "连不上 Ollama，请先打开它" : String(error?.message ?? error);
      finish(task, false, cause);
    }
  }

  function install(component, { model } = {}) {
    if (component === "ollama-model") {
      const name = String(model || "").trim();
      if (!/^[\w./-]+(:[\w.-]+)?$/.test(name)) throw new Error("模型名不合法。");
      if (tasks.get("ollama-model")?.running) throw new Error("已经有一个模型在下载。");
      void pullOllamaModel(name);
      return taskView("ollama-model");
    }
    if (!COMPONENTS.has(component)) throw new Error(`不认识的组件：${component}`);
    if (tasks.get(component)?.running) throw new Error("这个组件正在安装。");
    runInstaller(component);
    return taskView(component);
  }

  async function status({ bundledBrowser, ai }) {
    const python = join(venv, "bin/python");
    const pythonOk = existsSync(python) && await new Promise((resolvePromise) => {
      const child = spawn(python, ["-c", "import pypdfium2, PIL"], { stdio: "ignore" });
      child.on("error", () => resolvePromise(false));
      child.on("close", (code) => resolvePromise(code === 0));
    });
    const llamaServer = which("llama-server", ["/opt/homebrew/bin", "/usr/local/bin"]);
    const soffice = findSoffice();

    let ollama = { reachable: false, version: null, models: [], error: null };
    try {
      const response = await fetch(`${ollamaBase()}/api/version`, { signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        ollama = { reachable: true, version: (await response.json())?.version ?? null, models: await listOllamaModels(), error: null };
      }
    } catch (error) {
      ollama.error = String(error?.cause?.code || error?.message || error);
    }
    const ollamaApp = ["/Applications/Ollama.app", join(process.env.HOME || "", "Applications/Ollama.app")].some((path) => existsSync(path))
      || Boolean(which("ollama", ["/opt/homebrew/bin", "/usr/local/bin"]));

    if (ollama.reachable) probeSources();
    const probed = sourceProbe.at > 0;
    return {
      modelSource: {
        probing: !probed,
        official: sourceProbe.official,
        modelscope: sourceProbe.modelscope,
        // 魔搭只要不比官方慢一半以上就用它。只测前 3MB 抓不到官方源的真实问题：2026-09-24 实测
        // 官方前 3MB 有 1.7MB/s，可持续下载一小时平均只有约 100KB/s、分块反复断开；而海外网络上魔搭
        // 通常慢得多，会被测速刷掉。两边都没测出来（都是 0）就用官方。
        recommended: probed && sourceProbe.modelscope > 0 && sourceProbe.modelscope * 2 >= sourceProbe.official ? "modelscope" : "ollama",
        mirrors: OLLAMA_MIRRORS,
      },
      components: {
        python: { ok: pythonOk, path: venv },
        surya: { ok: existsSync(join(venv, "bin/surya_ocr")) && Boolean(llamaServer), package: existsSync(join(venv, "bin/surya_ocr")), llamaServer },
        browser: { ok: Boolean(bundledBrowser) },
        libreoffice: { ok: Boolean(soffice), path: soffice },
        ollama: { ...ollama, ok: ollama.reachable && ollama.models.some((model) => model.vision && !model.thinking), installed: ollamaApp || ollama.reachable, recommended: recommendedOllamaModel(), memGb: Math.round(totalmem() / 1024 ** 3) },
        ai,
      },
      tasks: Object.fromEntries([...tasks.keys()].map((name) => [name, taskView(name)])),
    };
  }

  return { install, status };
}
