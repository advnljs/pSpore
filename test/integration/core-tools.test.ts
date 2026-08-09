import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { ShellService } from "../../src/shell/shell-service.js";
import { createCoreTools } from "../../src/tools/core-tools.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("core tools", () => {
  test("reads, rejects stale edits, atomically edits, searches, and runs shell with an artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-tools-"));
    roots.push(root);
    const file = join(root, "notes.txt");
    await writeFile(file, "alpha\nbeta\n", { mode: 0o600 });
    const shell = new ShellService({ artifactRoot: join(root, "artifacts"), configuredShell: "/bin/bash" });
    await shell.initialize();
    const tools = createCoreTools({
      workspaceRoot: root,
      shell,
      defaultShellTimeoutMs: 2_000,
      maxShellOutputBytes: 16_384,
    });
    const byName = (name: string): ToolDefinition => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool);
      return tool;
    };

    const read = await execute(byName("read"), { path: file });
    const originalHash = createHash("sha256").update("alpha\nbeta\n").digest("hex");
    assert.match(text(read), new RegExp(originalHash));
    await assert.rejects(execute(byName("edit"), { path: file, expectedSha256: "missing", content: "wrong" }), /conflict/);
    await execute(byName("edit"), { path: file, expectedSha256: originalHash, content: "alpha\ngamma\n" });
    assert.equal(await readFile(file, "utf8"), "alpha\ngamma\n");

    const search = await execute(byName("search"), { query: "gamma", path: root });
    assert.match(text(search), /notes\.txt:2:gamma/);
    const command = await execute(byName("shell"), { command: "printf tool-ok", cwd: root });
    assert.match(text(command), /tool-ok/);
    const details = command.details as { artifactPath: string };
    assert.match(await readFile(details.artifactPath, "utf8"), /tool-ok/);
  });
});

async function execute(tool: ToolDefinition, params: Record<string, unknown>) {
  return tool.execute("tool-test", params, undefined, undefined, {} as never);
}

function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}
