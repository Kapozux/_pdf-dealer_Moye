/**
 * 服务端把 PDF 页渲染成 JPEG（AI 精校的输入）。
 *
 * 浏览器版用的是 canvas.toDataURL，服务端没有 canvas。这里复用 Surya 那个
 * Python venv 里已经装好的 pypdfium2（Surya 自己的依赖，不用另装东西），
 * 一次调用渲染多页，避免每页起一个进程。
 * scale=2 与原浏览器实现一致，保证喂给模型的图像质量不变。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PY_SCRIPT = `
import sys, json, io, base64
import pypdfium2 as pdfium

path = sys.argv[1]
pages = [int(p) for p in sys.argv[2].split(",") if p]
scale = float(sys.argv[3])
quality = int(sys.argv[4])

pdf = pdfium.PdfDocument(path)
out = {}
for n in pages:
    bitmap = pdf[n - 1].render(scale=scale)          # 1-based → 0-based
    buf = io.BytesIO()
    bitmap.to_pil().convert("RGB").save(buf, format="JPEG", quality=quality)
    out[str(n)] = base64.b64encode(buf.getvalue()).decode()
json.dump(out, sys.stdout)
`;

export function createRenderer({ python, timeoutMs = 120000 }) {
  const available = Boolean(python && existsSync(python));

  /**
   * @param {string} pdfPath
   * @param {number[]} pages 1-based 页码
   * @returns {Promise<Record<string, string>>} 页码 → base64 JPEG
   */
  async function renderPages(pdfPath, pages, { scale = 2, quality = 90 } = {}) {
    if (!pages.length) return {};
    if (!available) {
      throw new Error("本机渲染环境不可用：找不到 Surya 的 Python 环境，无法为 AI 精校生成页面图像。");
    }
    // 超时按页数放大：一次渲染几十页时固定 120s 够用，但调用方若一次塞几百页
    // （老代码就是这么干的），固定值必超。实测 31ms/页渲染 + 每页 ~500KB base64
    // 经 stdout 传回，按每页 1s 预算给足余量。
    const budgetMs = Math.max(timeoutMs, 20000 + pages.length * 1000);
    return new Promise((resolve, reject) => {
      const child = spawn(
        python,
        ["-c", PY_SCRIPT, pdfPath, pages.join(","), String(scale), String(quality)],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      // 用 Buffer 数组攒 stdout，最后一次 concat。以前是 `stdout += chunk` 字符串拼接：
      // 698 页 ≈ 350MB 时每来一块就复制一次已有内容，O(n²)，本身就能把 120s 烧光。
      const stdoutChunks = [];
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`页面渲染超时（${pages.length} 页，${Math.round(budgetMs / 1000)}s 未完成）。`));
      }, budgetMs);
      child.stdout.on("data", (c) => stdoutChunks.push(c));
      child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(stderr || `渲染进程退出码 ${code}`));
        try {
          resolve(JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")));
        } catch {
          reject(new Error("渲染结果解析失败。"));
        }
      });
    });
  }

  return { renderPages, available };
}
