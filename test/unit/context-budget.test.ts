import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boundToolResult, estimateTextTokens, MAX_TOOL_RESULT_CHARS } from "../../src/pi/context-budget.js";

test("large multi-block tool output is bounded while full content remains privately readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-context-"));
  try {
    const first = "BEGIN\n" + "汉字与超长行".repeat(20_000);
    const last = "\nEND evidence";
    const image = { type: "image" as const, data: "fixture", mimeType: "image/png" };
    const result = await boundToolResult([{ type: "text", text: first }, image, { type: "text", text: last }], root);
    const excerpt = result.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    assert.ok(excerpt.length <= MAX_TOOL_RESULT_CHARS);
    assert.match(excerpt, /\[Beginning of output\]\nBEGIN/);
    assert.match(excerpt, /END evidence$/);
    assert.match(excerpt, /Full output:/);
    assert.match(excerpt.slice(0, 2_000), /Full output:/);
    assert.match(excerpt.slice(0, 2_000), /END evidence/);
    assert.equal(result[1], image);
    const [name] = await readdir(root);
    assert.ok(name);
    assert.equal(await readFile(join(root, name), "utf8"), `${first}\n${last}`);
    assert.equal((await stat(join(root, name))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("small results are unchanged and non-ASCII fallback does not assume four characters per token", async () => {
  const content = [{ type: "text" as const, text: "small output" }];
  assert.equal(await boundToolResult(content, "/unused/no-files-created"), content);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("中文测试"), 4);
});

test("tool excerpts never cut an emoji in half", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-context-unicode-"));
  try {
    for (const prefix of ["", "x"]) {
      const content = await boundToolResult([{ type: "text", text: prefix + "😀".repeat(20_000) }], root);
      const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      assert.equal(Buffer.from(text, "utf8").toString("utf8"), text, "UTF-8 encoding must not replace a split surrogate");
      assert.ok(text.length <= MAX_TOOL_RESULT_CHARS);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("artifact storage failure is explicit without turning an executed tool into a retryable failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-context-storage-"));
  try {
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "fixture");
    const content = await boundToolResult([{ type: "text", text: "successful tool output ".repeat(2_000) }], blocked);
    const text = content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    assert.ok(text.length <= MAX_TOOL_RESULT_CHARS);
    assert.match(text, /Full output could not be saved \(EEXIST\)/);
    assert.match(text, /tool already completed; do not repeat/);
    assert.match(text, /\[Beginning of output\]\nsuccessful tool output/);
    assert.doesNotMatch(text, /Full output:/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
