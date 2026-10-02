/**
 * 把图片（png/jpg/webp/bmp/tiff/gif/heic）转成 PDF，转完完全复用现有的
 * PDF→图片→AI 管线（server/render.mjs + server/convert.mjs），
 * 跟 office2pdf.mjs 是同一个思路：不给图片单开一条存储和转换路径。
 *
 * 为什么不把图片直接喂给模型：AI 模式本来就是「PDF 页 → JPEG(scale=2) → 模型」，
 * 而这里按 resolution=144 存 PDF，页面尺寸(pt) 正好是像素的一半，
 * convert.mjs 再按 scale=2 渲染回来就是原始像素，一个像素不差（2026-09-04 实测
 * 1600×900 → PDF 800×450pt → 渲染 1600×900）。绕这一道不掉画质，
 * 却能让 Library 重开、「源文件」预览、refineExisting 的页数校验、ZIP 导出、
 * 逐页 checkpoint 全部照旧——这些全都假设 data/jobs/<id>/source.pdf 存在。
 *
 * 用 Surya 那个 venv 里的 Pillow（Surya 自己的依赖，不用另装东西）。
 * HEIC 是例外：Pillow 不带 HEIF 解码，走 macOS 自带的 sips 先转成 PNG。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif",
]);

export function isImageFile(filename) {
  return IMAGE_EXTENSIONS.has(extname(String(filename ?? "")).toLowerCase());
}

/**
 * 跟 office2pdf 同一条规矩（仓库规矩第四条：不静默吞错误）：先按文件头挡掉
 * 名字对、内容不对的文件。否则 Pillow 只会抛一句 "cannot identify image file"，
 * 跑批量的人看到的是「这一份失败了」，查不出是文件坏了还是识别炸了。
 */
const SIGNATURES = [
  { name: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { name: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },              // "GIF8"
  { name: "BMP", bytes: [0x42, 0x4d] },                          // "BM"
  { name: "TIFF-LE", bytes: [0x49, 0x49, 0x2a, 0x00] },          // "II*\0"
  { name: "TIFF-BE", bytes: [0x4d, 0x4d, 0x00, 0x2a] },          // "MM\0*"
];

// 导出给 server/images2pdf.mjs（合成成品 PDF 那条路）共用：签名表只留一份，
// 以后加一种格式不会出现「识别这条认、合成那条不认」。
export function looksLikeImage(buffer) {
  for (const sig of SIGNATURES) {
    if (buffer.subarray(0, sig.bytes.length).equals(Buffer.from(sig.bytes))) return true;
  }
  // WebP 和 HEIC 的签名都不在开头：WebP 是 RIFF....WEBP，
  // HEIC 是 ISO-BMFF，第 5-8 字节为 "ftyp"（品牌在其后，heic/heix/mif1/msf1 都算）。
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return true;
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") return true;
  return false;
}

// 长边上限。手机随手拍是 4000-8000px，原样转进 PDF 后 AI 模式要按 scale=2 渲染回来，
// base64 体积翻四倍，白白把渲染超时和上传都撑爆；而视觉模型自己就会缩到 1500px 上下，
// 留 4000 已经远超模型能吃进去的分辨率。
const MAX_LONG_SIDE = 4000;

const PY_SCRIPT = `
import sys, json
from PIL import Image, ImageOps, ImageSequence

src, out, max_side = sys.argv[1], sys.argv[2], int(sys.argv[3])

def prepare(frame):
    # 手机照片普遍带 EXIF 旋转标记，不摆正的话模型读到的是躺着的文字
    im = ImageOps.exif_transpose(frame).convert("RGB")
    if max(im.size) > max_side:
        ratio = max_side / max(im.size)
        im = im.resize((max(1, round(im.width * ratio)), max(1, round(im.height * ratio))), Image.LANCZOS)
    return im

with Image.open(src) as raw:
    # 多页 TIFF / 多帧 GIF 直接铺成多页 PDF，后面的管线本来就是按页跑的
    frames = [prepare(f) for f in ImageSequence.Iterator(raw)]

if not frames:
    raise SystemExit("图片里没有可用的帧。")

# resolution=144 → 页面尺寸(pt) = 像素/2，配 convert.mjs 的 scale=2 正好还原原始像素
frames[0].save(out, "PDF", resolution=144.0, save_all=True, append_images=frames[1:])
json.dump({"pages": len(frames), "size": list(frames[0].size)}, sys.stdout)
`;

export function createImageConverter({ python, sips = "/usr/bin/sips", timeoutMs = 120000 } = {}) {
  const available = Boolean(python && existsSync(python));

  // 不设 cwd：临时目录里跑会让相对路径的解释器（本机是 ../.venv-marker/bin/python）解析不到
  function run(command, args, timeoutLabel) {
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

  /**
   * @param {Buffer} buffer 原始图片字节
   * @param {string} originalName 只用来取扩展名
   * @returns {Promise<Buffer>} 转换出的 PDF 字节
   */
  async function convertToPdf(buffer, originalName) {
    if (!available) {
      throw new Error("本机没有可用的图像环境（找不到 Surya 的 Python），无法把图片转成 PDF。");
    }
    const ext = extname(originalName || "").toLowerCase() || ".png";
    if (!looksLikeImage(buffer)) {
      throw new Error(`文件头对不上 ${ext} 格式，可能不是有效的图片（或者已损坏）。`);
    }
    const dir = await mkdtemp(join(tmpdir(), "moye-image-"));
    try {
      let input = join(dir, `image${ext}`);
      await writeFile(input, buffer);
      if (ext === ".heic" || ext === ".heif") {
        // Pillow 没有 HEIF 解码器（venv 里没装 pillow-heif），macOS 自带的 sips 有
        const converted = join(dir, "image.png");
        await run(sips, ["-s", "format", "png", input, "--out", converted], "HEIC 转换超时。");
        if (!existsSync(converted)) throw new Error("sips 没能把 HEIC 转成 PNG。");
        input = converted;
      }
      const out = join(dir, "image.pdf");
      const stdout = await run(python, ["-c", PY_SCRIPT, input, out, String(MAX_LONG_SIDE)], "图片转 PDF 超时。");
      if (!existsSync(out)) throw new Error("图片转换没有产出 PDF。");
      let info = null;
      try {
        info = JSON.parse(stdout);
      } catch {
        info = null; // 拿不到页数不影响结果本身，别为了一行日志把整份任务判死
      }
      if (info) console.log(`[图片转PDF] ${originalName} → ${info.pages} 页，${info.size?.[0]}×${info.size?.[1]}`);
      return await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return { convertToPdf, available };
}
