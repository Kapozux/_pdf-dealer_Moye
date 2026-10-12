/**
 * 把 PPT/PPTX/Word（doc/docx）转成 PDF，转完之后完全复用现有的 PDF→图片→AI 管线
 * （server/render.mjs + server/convert.mjs），不用给 PPT 单独写一套。
 *
 * 用 brew 装的 LibreOffice headless 模式（soffice --headless --convert-to pdf）。
 * 每次转换都给一个独立的 -env:UserInstallation 临时目录：LibreOffice 的用户
 * profile 默认是单例锁，两份 PPT 同时提交、共用 profile 会互相锁死，
 * 隔离开才能让批量提交真正并发跑，不用退化成排队等 soffice。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { findSoffice, which } from "./setup.mjs";

const OFFICE_EXTENSIONS = new Set([".ppt", ".pptx", ".doc", ".docx"]);

export function isOfficeFile(filename) {
  return OFFICE_EXTENSIONS.has(extname(String(filename ?? "")).toLowerCase());
}

/**
 * 实测教训：soffice 对认不出的输入不会报错，而是当成纯文本"转换成功"，
 * 吐出一份只有那段乱码文字的一页 PDF（自测过：拿一段随手写的字符串喂给它，
 * 退出码 0，正常产出 PDF）。这正是仓库规矩第四条要防的"静默吞错误"——
 * 不提前挡住格式不对的文件，跑批量的人只会在结果里看到一页乱码，
 * 却查不出哪一步错了。这里用文件头签名挡在 soffice 之前：
 *   .pptx/.docx 是 zip 包（Office Open XML），头两字节是 "PK"；
 *   .ppt/.doc 是旧版 OLE 复合文档，头 8 字节是固定的 OLE 签名。
 */
const OOXML_MAGIC = Buffer.from([0x50, 0x4b]); // "PK"
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function looksLikeOfficeFile(buffer, ext) {
  if (ext === ".pptx" || ext === ".docx") return buffer.subarray(0, 2).equals(OOXML_MAGIC);
  if (ext === ".ppt" || ext === ".doc") return buffer.subarray(0, 8).equals(OLE_MAGIC);
  return false;
}

export function createOfficeConverter({ soffice = "soffice", timeoutMs = 120000 } = {}) {
  /**
   * 真正要 spawn 的 soffice 路径，找不到就是 null。每次转换现查（不在构造时定死）：
   * 调用方找不到时会传光秃秃的 "soffice"，服务跑着时装好 LibreOffice 也要能直接用上。
   * 以前 available 恒为 true，没装时用户看到的是 spawn ENOENT，而不是下面那句「没装 LibreOffice」。
   */
  function resolveSoffice() {
    if (!soffice) return null;
    if (soffice.includes("/")) return existsSync(soffice) ? soffice : null;
    return which(soffice, ["/opt/homebrew/bin", "/usr/local/bin"]) ?? (soffice === "soffice" ? findSoffice() : null);
  }

  /**
   * @param {Buffer} buffer 原始 PPT/PPTX/Word 字节
   * @param {string} originalName 只用来取扩展名，soffice 靠它判断源格式
   * @returns {Promise<Buffer>} 转换出的 PDF 字节
   */
  async function convertToPdf(buffer, originalName) {
    const command = resolveSoffice();
    if (!command) {
      throw new Error("本机没有安装 LibreOffice（找不到 soffice），无法把 Office 文档转成 PDF。");
    }
    const ext = extname(originalName || "").toLowerCase() || ".pptx";
    if (!looksLikeOfficeFile(buffer, ext)) {
      throw new Error(`文件头对不上 ${ext} 格式，可能不是有效的 Office 文档（或者已损坏）。`);
    }
    const dir = await mkdtemp(join(tmpdir(), "moye-office-"));
    try {
      const input = join(dir, `slide${ext}`);
      await writeFile(input, buffer);
      await new Promise((resolve, reject) => {
        const child = spawn(
          command,
          [
            `-env:UserInstallation=file://${dir}/profile`,
            "--headless",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            dir,
            input,
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Office 文档转 PDF 超时。"));
        }, timeoutMs);
        child.stdout.on("data", () => {}); // soffice 会往 stdout 打进度，不用管
        child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(stderr || `soffice 退出码 ${code}`));
          resolve();
        });
      });
      const outPath = join(dir, "slide.pdf");
      if (!existsSync(outPath)) {
        throw new Error("soffice 没有产出 PDF（转换失败但没留下错误信息，文件可能已损坏）。");
      }
      return await readFile(outPath);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    convertToPdf,
    get available() {
      return Boolean(resolveSoffice());
    },
  };
}
