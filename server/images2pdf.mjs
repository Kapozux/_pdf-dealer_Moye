/**
 * 多张图片 → 一份 PDF（反方向的旁路，跟 server/md2pdf.mjs 同一类）：
 * 不进队列、不进 Library、不做任何识别，拖进来几张图就下载一份多页 PDF。
 *
 * 跟 server/image2pdf.mjs 的区别（两个文件长得像，别改错）：
 *   image2pdf.mjs  图片 → PDF 是「为了喂给识别管线」：按 resolution=144 存、长边压到
 *                  4000px，都是为了配合 render.mjs 的 scale=2 和上传体积。
 *   images2pdf.mjs 图片 → PDF 是「成品」：用户要的就是这份 PDF，所以
 *                  **一个像素都不缩、JPEG 能原样嵌就原样嵌**（不重新编码）。
 *
 * 为什么不像 image2pdf 那样直接用 Pillow 的 save(PDF)：Pillow 存 PDF 会把每张图
 * 按默认质量重新编码成 JPEG——用户拿到的成品会比原图糊一档。这里改成
 * pdf-lib 嵌入：JPEG/PNG 原字节直接 embed，其余格式（webp/heic/tiff/bmp/gif）
 * 才过一道 Pillow 转成 JPEG(q95)/PNG。
 *
 * 页面尺寸不影响存进去的像素（PDF 里是矢量坐标），所以按「图片自身比例，长边 A4 长边」
 * 排版：每页都被图片填满，没有白边，打印时缩放到纸张即可。比原图小的图不放大
 * （长边最多 = 原始像素数，即 72dpi），免得一张小截图被拉成一整页糊图。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { looksLikeImage } from "./image2pdf.mjs";

const LONG_SIDE_PT = 842;        // A4 长边（pt）

// Pillow 一次把所有文件看一遍：能原样嵌的（单帧、无 EXIF 旋转的 JPEG/PNG）标成 verbatim，
// 其余就地转成 JPEG(q95)/PNG 再交回来。多页 TIFF / 多帧 GIF 铺成多页。
// 单个文件坏掉只记 error 不中断——一批 80 张里坏一张，不该让另外 79 张也拿不到。
const PY_SCRIPT = `
import sys, json, os
from PIL import Image, ImageOps, ImageSequence

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
out_dir = manifest["outDir"]
results = []

for idx, item in enumerate(manifest["inputs"]):
    entry = {"index": idx}
    try:
        with Image.open(item["path"]) as raw:
            fmt = (raw.format or "").upper()
            frames = getattr(raw, "n_frames", 1)
            try:
                orientation = int(raw.getexif().get(274, 1) or 1)
            except Exception:
                orientation = 1
            if frames == 1 and orientation == 1 and not item.get("force") and fmt in ("JPEG", "PNG"):
                entry.update(pages=[{
                    "kind": fmt.lower(), "path": item["path"],
                    "width": raw.width, "height": raw.height,
                }])
            else:
                pages = []
                lossy = item.get("force") == "jpeg" or fmt in ("JPEG", "MPO", "WEBP")
                for n, frame in enumerate(ImageSequence.Iterator(raw)):
                    # 手机照片普遍带 EXIF 旋转标记，不摆正的话成品是躺着的
                    im = ImageOps.exif_transpose(frame)
                    if lossy:
                        # 源本来就是有损的，再存一遍 q95 基本看不出差别，体积却远小于 PNG
                        im = im.convert("RGB")
                        out = os.path.join(out_dir, "n%d-%d.jpg" % (idx, n))
                        im.save(out, "JPEG", quality=95, subsampling=0)
                        kind = "jpeg"
                    else:
                        im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
                        out = os.path.join(out_dir, "n%d-%d.png" % (idx, n))
                        im.save(out, "PNG")
                        kind = "png"
                    pages.append({"kind": kind, "path": out, "width": im.width, "height": im.height})
                if not pages:
                    raise ValueError("图片里没有可用的帧")
                entry.update(pages=pages)
    except Exception as err:
        entry.update(error="%s: %s" % (type(err).__name__, err))
    results.append(entry)

json.dump({"results": results}, sys.stdout)
`;

function run(command, args, timeoutMs, timeoutLabel) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(timeoutLabel));
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `${command} 退出码 ${code}`));
      resolve(stdout);
    });
  });
}

/** 一页的尺寸：保持比例，长边最多 A4 长边，也不把小图放大（上限 = 原始像素数 @72dpi）。 */
function pageSize(width, height) {
  const long = Math.max(width, height) || 1;
  const scale = Math.min(LONG_SIDE_PT, long) / long;
  return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
}

export function createImageBookBuilder({ python, sips = "/usr/bin/sips", timeoutMs = 300000 } = {}) {
  const available = Boolean(python && existsSync(python));

  /**
   * @param {{path: string, name: string}[]} files 已经落在磁盘上的图片，顺序就是页序
   * @returns {Promise<{pdf: Buffer, pages: number, skipped: {name: string, reason: string}[]}>}
   */
  async function buildPdf(files) {
    if (!available) throw new Error("本机没有可用的图像环境（找不到 Surya 的 Python），无法把图片合成 PDF。");
    if (!files.length) throw new Error("没有可合成的图片。");

    const work = await mkdtemp(join(tmpdir(), "moye-imgbook-"));
    const skipped = [];
    try {
      // 先按文件头挡掉「名字对、内容不对」的（仓库规矩第四条：失败要留下原因），
      // HEIC 顺手用 macOS 自带的 sips 转成 PNG——Pillow 不带 HEIF 解码器。
      const inputs = [];
      for (const file of files) {
        let head = Buffer.alloc(0);
        try {
          const handle = await open(file.path, "r");
          try {
            const buf = Buffer.alloc(32);
            const { bytesRead } = await handle.read(buf, 0, 32, 0);
            head = buf.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        } catch (error) {
          skipped.push({ name: file.name, reason: error instanceof Error ? error.message : "读不到文件" });
          continue;
        }
        if (!looksLikeImage(head)) {
          skipped.push({ name: file.name, reason: `文件头对不上 ${extname(file.name) || "图片"} 格式，可能不是有效的图片（或者已损坏）` });
          continue;
        }
        const ext = extname(file.name).toLowerCase();
        if (ext === ".heic" || ext === ".heif") {
          const converted = join(work, `heic-${inputs.length}.png`);
          try {
            await run(sips, ["-s", "format", "png", file.path, "--out", converted], timeoutMs, "HEIC 转换超时。");
            if (!existsSync(converted)) throw new Error("sips 没能把 HEIC 转成 PNG。");
          } catch (error) {
            skipped.push({ name: file.name, reason: error instanceof Error ? error.message : "HEIC 转换失败" });
            continue;
          }
          // sips 出来的 PNG 是无损但极大的（12MP 照片能到 30MB），成品 PDF 存 JPEG(q95) 就够
          inputs.push({ path: converted, name: file.name, force: "jpeg" });
        } else {
          inputs.push({ path: file.path, name: file.name, force: null });
        }
      }
      if (!inputs.length) throw new Error(`这些文件都不是能用的图片：${skipped.map((s) => `${s.name}（${s.reason}）`).join("；")}`);

      const manifestPath = join(work, "manifest.json");
      await writeFile(manifestPath, JSON.stringify({ outDir: work, inputs: inputs.map((i) => ({ path: i.path, force: i.force })) }), "utf8");
      const stdout = await run(python, ["-c", PY_SCRIPT, manifestPath], timeoutMs, "图片合成 PDF 超时。");
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(`图像进程返回了读不懂的结果：${stdout.slice(0, 200)}`);
      }

      const pdf = await PDFDocument.create();
      for (const result of parsed.results ?? []) {
        const source = inputs[result.index];
        const name = source?.name ?? `第 ${result.index + 1} 张`;
        if (result.error || !result.pages?.length) {
          skipped.push({ name, reason: result.error || "没有产出页面" });
          continue;
        }
        for (const page of result.pages) {
          try {
            const bytes = await readFile(page.path);
            const image = page.kind === "png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
            const size = pageSize(image.width, image.height);
            const sheet = pdf.addPage([size.width, size.height]);
            sheet.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
          } catch (error) {
            skipped.push({ name, reason: error instanceof Error ? error.message : "嵌入 PDF 失败" });
          }
        }
      }
      if (pdf.getPageCount() === 0) {
        throw new Error(`没有一张图片能放进 PDF：${skipped.map((s) => `${s.name}（${s.reason}）`).join("；")}`);
      }
      const bytes = await pdf.save();
      console.log(`[图片合成PDF] ${files.length} 个文件 → ${pdf.getPageCount()} 页${skipped.length ? `，跳过 ${skipped.length} 个` : ""}`);
      for (const item of skipped) console.warn(`[图片合成PDF] 跳过 ${item.name}：${item.reason}`);
      return { pdf: Buffer.from(bytes), pages: pdf.getPageCount(), skipped };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  return { buildPdf, available };
}

/** 上传分片的文件名里塞了页序和原名，这里解回来（见 local-ocr-server 的 /api/images2pdf/part）。 */
export function decodePartName(fileName) {
  const raw = basename(fileName);
  const index = Number(raw.slice(0, 4));
  let name = raw.slice(5);
  try {
    name = decodeURIComponent(name);
  } catch {
    /* 解不开就用原样，文件名只用于报错和排序显示 */
  }
  return { index: Number.isFinite(index) ? index : 0, name };
}
