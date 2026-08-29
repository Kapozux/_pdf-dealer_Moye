/**
 * 读 PDF 文字层的子进程入口（由 server/convert.mjs 的 runTextLayerWorker 启动）。
 *
 * 为什么单独一个进程：pdfjs 解析大书时堆会涨到 3GB 且释放不掉（见 convert.mjs
 * 顶部的说明）。这里只做一件事——打开 PDF、逐页提取文字层、把结果 JSON 写到
 * stdout、退出。进程一退，内存整体还给系统。
 *
 * 用法：node textlayer-worker.mjs <pdfPath> [--count]
 *   默认      stdout: {"total": N, "pages": [...]}；stderr 每页一行 `progress <page> <total>`
 *   --count   stdout: {"total": N}
 */

import { __textlayer__ } from "./convert.mjs";

const [, , pdfPath, flag] = process.argv;
if (!pdfPath) {
  process.stderr.write("用法：textlayer-worker.mjs <pdfPath> [--count]\n");
  process.exit(2);
}

const { openPdf, extractFastPages } = __textlayer__;

/**
 * 写完再退出。stdout 接的是管道时 write 是异步的，紧跟一个 process.exit 会把
 * 还没刷出去的部分截断——698 页的结果有几 MB，远超管道缓冲，实测父进程只收到半截。
 * 不能不 exit：pdfjs 的 fake worker 挂着定时器，进程不会自己结束。
 */
function writeAndExit(payload, code) {
  process.stdout.write(payload, () => process.exit(code));
}

try {
  const pdfDoc = await openPdf(pdfPath);
  if (flag === "--count") {
    writeAndExit(JSON.stringify({ total: pdfDoc.numPages }), 0);
  } else {
    const pages = await extractFastPages(pdfDoc, (page, total) => {
      process.stderr.write(`progress ${page} ${total}\n`);
    });
    writeAndExit(JSON.stringify({ total: pdfDoc.numPages, pages }), 0);
  }
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`, () => process.exit(1));
}
