import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { MemoryService } from "../../src/memory/memory-service.js";
import { createMemoryTools } from "../../src/memory/memory-tools.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("memory service", () => {
  test("appends a sourced daily fact and rejects credential-like content", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-memory-"));
    roots.push(root);
    const memory = new MemoryService({
      workspaceRoot: root,
      clock: () => new Date("2026-08-09T12:00:00.000Z"),
      idFactory: () => "entry-1",
      timeZone: "Asia/Shanghai",
    });
    const result = await memory.append("用户明确选择 Electron 43。", { sessionId: "main", runId: "run-1" });
    assert.equal(result.path, join(root, "memory", "2026", "08", "09.md"));
    const content = await readFile(result.path, "utf8");
    assert.match(content, /session:main run:run-1/);
    assert.match(content, /Electron 43/);
    await assert.rejects(memory.append("api_key = abcdefghijklmnopqrstuvwxyz", { sessionId: "main" }), /Credential-like/);
  });

  test("curates only against the expected hash, requires sources, and rejects duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-curate-"));
    roots.push(root);
    const initial = "# Curated Memory\n";
    await writeFile(join(root, "MEMORY.md"), initial, { mode: 0o600 });
    const memory = new MemoryService({ workspaceRoot: root });
    const expected = createHash("sha256").update(initial).digest("hex");
    const result = await memory.curate(expected, [
      { fact: "桌面客户端使用 Electron 43。", sources: ["session:main", "run:decision-1"] },
    ]);
    assert.equal(result.added, 1);
    const curated = await readFile(join(root, "MEMORY.md"), "utf8");
    assert.match(curated, /sources: `run:decision-1`, `session:main`/);
    await assert.rejects(
      memory.curate(result.sha256, [{ fact: "桌面客户端使用 Electron 43。", sources: ["session:main"] }]),
      /Duplicate curated/,
    );
    await assert.rejects(memory.curate(expected, [{ fact: "new fact", sources: ["session:main"] }]), /Memory conflict/);
  });

  test("publishes the strict source-reference contract in the model-facing tool schema", () => {
    const memory = new MemoryService({ workspaceRoot: "/workspace" });
    const curate = createMemoryTools("main", memory).find((tool) => tool.name === "memory_curate");
    assert.ok(curate);
    const contract = JSON.stringify({
      description: curate.description,
      promptGuidelines: curate.promptGuidelines,
      parameters: curate.parameters,
    });
    assert.match(contract, /session:ID/);
    assert.match(contract, /run:ID/);
    assert.match(contract, /file:workspace\/path\.md/);
    assert.match(contract, /\^\(\?:session\|run\|file\)/);
  });
});
