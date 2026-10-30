import assert from "node:assert/strict";
import test from "node:test";

import { fileManagerShowItemsArgs, launchCommand, openerFailure } from "../../src/desktop/system-open.js";

test("file manager reveal selects the path and escapes quotes in the URI", () => {
  const args = fileManagerShowItemsArgs("/tmp/a'b file.txt");
  assert.equal(args[0], "call");
  assert.equal(args.at(-2), "['file:///tmp/a\\'b%20file.txt']");
  assert.equal(args.at(-1), "");
  assert.ok(args.includes("org.freedesktop.FileManager1.ShowItems"));
});

test("opener failures stay specific and a clean exit is success", () => {
  assert.equal(openerFailure(0), undefined);
  assert.equal(openerFailure(null), undefined);
  assert.match(openerFailure(4) ?? "", /所在目录/);
  assert.match(openerFailure(2) ?? "", /不存在/);
});

test("a launcher that exits immediately reports success or the exit code", async () => {
  await launchCommand("true", []);
  await assert.rejects(launchCommand("false", []), /无法识别|退出码 1/);
});
