/**
 * 最小 ZIP 打包器（无第三方依赖）。
 *
 * 只为一件事存在：把一个批次里的 Markdown 打成一个包让浏览器下载。
 * 为此引入 archiver/jszip 不值当——ZIP 的「多个 deflate 块 + 中央目录」结构
 * 本身很简单，用 node:zlib 直接拼即可，这个项目的依赖也就 linkedom 一个。
 *
 * 生成的是标准 ZIP（store 或 deflate），macOS 归档工具、Windows 资源管理器
 * 和 unzip 都能直接打开。文件名统一按 UTF-8 写并置 EFS 标志位（bit 11），
 * 否则中文名在部分解压工具里会乱码。
 */

import { deflateRawSync } from "node:zlib";

// CRC32 查表法。ZIP 的每条记录都要带校验和，解压工具会核对。
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** DOS 时间格式（ZIP 沿用至今）：日期和时间各压进 16 位。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * @param {Array<{name: string, content: string | Buffer, date?: Date}>} entries
 * @returns {Buffer} 完整的 .zip 内容
 */
export function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(raw);
    // 压不小就原样存（纯文本一般能压到 1/3，但空文件之类会反而变大）
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { time, date } = dosDateTime(entry.date ?? new Date());

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    localHeader.writeUInt16LE(20, 4);           // 解压所需版本 2.0
    localHeader.writeUInt16LE(0x0800, 6);       // bit 11：文件名是 UTF-8
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);           // 无 extra 字段

    chunks.push(localHeader, nameBuffer, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    centralHeader.writeUInt16LE(20, 4);         // 创建版本
    centralHeader.writeUInt16LE(20, 6);         // 解压所需版本
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);         // extra 长度
    centralHeader.writeUInt16LE(0, 32);         // 注释长度
    centralHeader.writeUInt16LE(0, 34);         // 所属磁盘号
    centralHeader.writeUInt16LE(0, 36);         // 内部属性
    centralHeader.writeUInt32LE(0, 38);         // 外部属性
    centralHeader.writeUInt32LE(offset, 42);    // 本地头在文件中的偏移
    central.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);             // 中央目录结束记录
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                     // 无注释

  return Buffer.concat([...chunks, centralBuffer, end]);
}

/** 去掉路径分隔符和 Windows 非法字符，避免解压时跑到目录外或直接失败。 */
export function safeEntryName(name, fallback = "document") {
  const cleaned = String(name || "")
    .replace(/\.pdf$/i, "")
    .replace(/[/\\]/g, "_")
    // eslint-disable-next-line no-control-regex -- 控制字符正是要过滤的对象
    .replace(/[:*?"<>|\x00-\x1f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || fallback;
}
