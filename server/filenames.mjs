/**
 * 源文件名 → 文档标题的唯一一份规则。
 *
 * 单独拎出来是因为这条正则原先在三个地方各写了一遍（队列里的标题、自动标签、
 * ZIP 条目名），加 Word 支持时只改了前两处，ZIP 里就出现了「报告.docx.md」。
 * 以后再加格式只动这里。
 */
const SOURCE_EXTENSION = /\.(pdf|pptx?|docx?|png|jpe?g|webp|bmp|gif|tiff?|hei[cf])$/i;

export function stripSourceExtension(name) {
  return String(name ?? "").replace(SOURCE_EXTENSION, "");
}
