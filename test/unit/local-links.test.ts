import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { decodeOpenLocalPath } from "../../src/desktop/local-path.js";
import { localTextParts } from "../../src/ui/shared/local-links.js";

test("assistant prose exposes local file and directory paths without linking web URLs", () => {
  assert.deepEqual(localTextParts("文件 /tmp/report.txt，目录 /tmp/results/。"), [
    { text: "文件 " },
    { text: "/tmp/report.txt", href: "/tmp/report.txt" },
    { text: "，目录 " },
    { text: "/tmp/results/", href: "/tmp/results/" },
    { text: "。" },
  ]);
  assert.deepEqual(localTextParts("见 file:///tmp/a%20b.txt 和 https://example.com/a"), [
    { text: "见 " },
    { text: "file:///tmp/a%20b.txt", href: "file:///tmp/a%20b.txt" },
    { text: " 和 https://example.com/a" },
  ]);
  assert.deepEqual(localTextParts("在 `code` 中的路径由 Markdown code 节点隔离"), [
    { text: "在 `code` 中的路径由 Markdown code 节点隔离" },
  ]);
});

test("open-local-path resolves real files and directories and rejects invalid targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pspore-link-"));
  const file = join(directory, "example file.txt");
  const desktopLauncher = join(directory, "open.desktop");
  try {
    await writeFile(file, "open me");
    await writeFile(desktopLauncher, "[Desktop Entry]\nType=Application\nExec=echo\n");
    assert.equal(await decodeOpenLocalPath(file), file);
    assert.equal(await decodeOpenLocalPath(pathToFileURL(file).href), file);
    assert.equal(await decodeOpenLocalPath(directory), directory);
    await assert.rejects(decodeOpenLocalPath("../example file.txt"), /绝对/);
    await assert.rejects(decodeOpenLocalPath("https://example.com/x"), /绝对/);
    await assert.rejects(decodeOpenLocalPath("file://remote-host/tmp/x"), /本机/);
    await assert.rejects(decodeOpenLocalPath(join(directory, "gone.txt")), /不存在/);
    await assert.rejects(decodeOpenLocalPath("/tmp/line\nbreak"), /无效/);
    await chmod(file, 0o700);
    await assert.rejects(decodeOpenLocalPath(file), /可执行/);
    await assert.rejects(decodeOpenLocalPath(desktopLauncher), /可执行/);
    assert.equal(await decodeOpenLocalPath({ path: file, action: "reveal" }), file);
    assert.equal(await decodeOpenLocalPath({ path: desktopLauncher, action: "reveal" }), desktopLauncher);
    await assert.rejects(decodeOpenLocalPath({ path: file, action: "open" }), /可执行/);
    await assert.rejects(decodeOpenLocalPath({ path: file, action: "run" }), /打开方式/);
    await assert.rejects(decodeOpenLocalPath({ path: file, extra: true, action: "reveal" }), /无效/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
