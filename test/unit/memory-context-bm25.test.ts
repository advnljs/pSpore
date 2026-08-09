import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { rankBm25 } from "../../src/memory/bm25.js";
import { PinnedContextLoader } from "../../src/memory/context-loader.js";
import { estimateTokens, tokenize } from "../../src/memory/tokenizer.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("memory tokenizer and BM25", () => {
  test("normalizes English and segments Chinese with a deterministic bigram fallback", () => {
    assert.deepEqual(tokenize("Hello HELLO_cache 42"), ["hello", "hello_cache", "42"]);
    assert.deepEqual(tokenize("持久记忆", { forceCjkBigramFallback: true }), ["持久", "久记", "记忆"]);
    assert.ok(estimateTokens("四个中文") >= 4);
  });

  test("ranks the document containing the rarer relevant terms first", () => {
    const scores = rankBm25("durable approval", [
      { id: "a", text: "durable approval is persisted before publish" },
      { id: "b", text: "approval approval approval user interface" },
      { id: "c", text: "unrelated scheduler state" },
    ]);
    assert.equal(scores[0]?.id, "a");
    assert.ok((scores[0]?.score ?? 0) > (scores[1]?.score ?? 0));
  });
});

describe("pinned context loader", () => {
  test("uses stable order, reports missing files, and rejects traversal/symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-context-"));
    roots.push(root);
    await writeFile(join(root, "MEMORY.md"), "memory", { mode: 0o600 });
    await writeFile(join(root, "AGENTS.md"), "agents", { mode: 0o600 });
    await writeFile(join(root, "USER.md"), "user", { mode: 0o600 });
    const loader = new PinnedContextLoader({
      workspaceRoot: root,
      pinnedFiles: ["MEMORY.md", "missing.md", "USER.md", "AGENTS.md"],
      maxPinnedTokens: 100,
    });
    const snapshot = await loader.load();
    assert.deepEqual(snapshot.files.map((file) => file.path.split("/").at(-1)), ["AGENTS.md", "USER.md", "MEMORY.md"]);
    assert.equal(snapshot.diagnostics.find((item) => item.path.endsWith("missing.md"))?.status, "missing");
    assert.equal(snapshot.prefixSha256.length, 64);

    const outside = await mkdtemp(join(tmpdir(), "pspore-context-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.md"), "outside", { mode: 0o600 });
    await symlink(join(outside, "secret.md"), join(root, "linked.md"));
    await assert.rejects(
      new PinnedContextLoader({ workspaceRoot: root, pinnedFiles: ["linked.md"], maxPinnedTokens: 100 }).load(),
      /escapes workspace/,
    );
    await assert.rejects(
      new PinnedContextLoader({ workspaceRoot: root, pinnedFiles: ["../secret.md"], maxPinnedTokens: 100 }).load(),
      /without traversal/,
    );
  });

  test("fails with a per-file budget breakdown instead of truncating", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-context-budget-"));
    roots.push(root);
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes", "large.md"), "token ".repeat(200), { mode: 0o600 });
    await assert.rejects(
      new PinnedContextLoader({ workspaceRoot: root, pinnedFiles: ["notes/large.md"], maxPinnedTokens: 10 }).load(),
      /notes\/large\.md=.*exceeds|maxPinnedTokens/,
    );
  });
});
