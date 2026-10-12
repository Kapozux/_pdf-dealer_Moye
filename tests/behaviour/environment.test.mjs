// 外部程序（LibreOffice / Python 渲染环境）找不到时：说人话，而且每次用时现查、不在启动时定死。
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOfficeConverter } from "../../server/office2pdf.mjs";
import { createRenderer } from "../../server/render.mjs";

const pptx = Buffer.from("PK\u0003\u0004 fake pptx");

test("没装 LibreOffice：报「没有安装 LibreOffice」，不是 spawn ENOENT", async () => {
  const converter = createOfficeConverter({ soffice: "/nonexistent/moye-test/soffice" });
  assert.equal(converter.available, false);
  await assert.rejects(converter.convertToPdf(pptx, "a.pptx"), /没有安装 LibreOffice/);
  const bare = createOfficeConverter({ soffice: "moye-test-no-such-soffice" });
  assert.equal(bare.available, false);
});

test("服务跑着时装好的程序，不用重启就认得", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moye-env-"));
  try {
    const soffice = join(dir, "soffice");
    const python = join(dir, "python");
    const office = createOfficeConverter({ soffice });
    const renderer = createRenderer({ python });
    assert.equal(office.available, false);
    assert.equal(renderer.available, false);
    await assert.rejects(renderer.renderPages("x.pdf", [1]), /本机渲染环境不可用/);
    for (const path of [soffice, python]) {
      await writeFile(path, "#!/bin/sh\nexit 1\n");
      await chmod(path, 0o755);
    }
    assert.equal(office.available, true);
    assert.equal(renderer.available, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
