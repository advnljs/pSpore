import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bundledIndexerPath,
  IndexService,
  type IndexingStatus,
} from "../../src/indexing/index-service.js";

/** A stand-in indexer that speaks the same `--json` protocol as the real CLI. */
async function writeFakeIndexer(root: string, body: string): Promise<string> {
  const path = join(root, "aegis-search");
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

test("a pass reports scanning, progress and completion from the CLI's JSON stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-index-run-"));
  try {
    const binary = await writeFakeIndexer(root, [
      'echo \'{"type":"progress","status":"scanning","total":0,"processed":0,"failed":0,"skipped":0,"currentFile":""}\'',
      'echo \'{"type":"progress","status":"indexing","total":3,"processed":1,"failed":0,"skipped":0,"currentFile":"/docs/a.pdf"}\'',
      'echo \'{"type":"done","total":3,"processed":3,"failed":0,"skipped":1}\'',
      "exit 0",
    ].join("\n"));

    const seen: IndexingStatus[] = [];
    const service = new IndexService({
      binaryPath: binary,
      directories: ["/docs"],
      extensions: ["pdf", "docx"],
      intervalMs: 60_000,
      enabled: true,
      onStatus: (status) => seen.push(status),
    });
    await service.start();
    await service.runNow();
    await service.stop();

    const phases = seen.map((status) => status.phase);
    assert.ok(phases.includes("scanning"), `expected a scanning phase, saw ${phases.join(",")}`);
    assert.ok(phases.includes("indexing"), `expected an indexing phase, saw ${phases.join(",")}`);

    const final = service.status();
    assert.equal(final.phase, "idle");
    assert.equal(final.total, 3);
    assert.equal(final.processed, 3);
    assert.equal(final.skipped, 1);
    assert.ok(final.finishedAt, "a finished pass records when it ended");
    assert.ok(final.nextRunAt, "the next pass is scheduled");

    const midway = seen.find((status) => status.currentFile === "/docs/a.pdf");
    assert.ok(midway, "the current file is surfaced while indexing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the configured directories and extensions reach the indexer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-index-args-"));
  try {
    const argsFile = join(root, "args.txt");
    const binary = await writeFakeIndexer(root, `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nexit 0`);
    const service = new IndexService({
      binaryPath: binary,
      directories: ["/docs", "/notes"],
      extensions: ["pdf", "md"],
      intervalMs: 60_000,
      enabled: true,
      onStatus: () => undefined,
    });
    await service.start();
    await service.runNow();
    await service.stop();

    const { readFile } = await import("node:fs/promises");
    const args = (await readFile(argsFile, "utf8")).trim().split("\n");
    assert.deepEqual(args, ["index", "/docs", "/notes", "--json", "--ext", "pdf,md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing indexer is reported without stopping the schedule", async () => {
  const root = await mkdtemp(join(tmpdir(), "pspore-index-fail-"));
  try {
    const binary = await writeFakeIndexer(root, 'echo "索引目录不可读" >&2\nexit 3');
    const service = new IndexService({
      binaryPath: binary,
      directories: ["/docs"],
      extensions: [],
      intervalMs: 60_000,
      enabled: true,
      onStatus: () => undefined,
    });
    await service.start();
    await service.runNow();
    const status = service.status();
    await service.stop();

    assert.equal(status.phase, "failed");
    assert.match(status.message ?? "", /索引目录不可读/);
    // A failure must still leave a next attempt scheduled.
    assert.ok(status.nextRunAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexing stays disabled until it is switched on and given directories", async () => {
  const off = new IndexService({
    binaryPath: "/nonexistent",
    directories: ["/docs"],
    extensions: [],
    intervalMs: 60_000,
    enabled: false,
    onStatus: () => undefined,
  });
  await off.start();
  assert.equal(off.status().phase, "disabled");
  await off.stop();

  const noDirectories = new IndexService({
    binaryPath: "/nonexistent",
    directories: [],
    extensions: [],
    intervalMs: 60_000,
    enabled: true,
    onStatus: () => undefined,
  });
  await noDirectories.start();
  assert.equal(noDirectories.status().phase, "disabled");
  assert.match(noDirectories.status().message ?? "", /没有配置需要索引的目录/);
  await noDirectories.stop();
});

test("a missing indexer binary is surfaced rather than retried forever", async () => {
  const service = new IndexService({
    binaryPath: "/definitely/not/here/aegis-search",
    directories: ["/docs"],
    extensions: [],
    intervalMs: 60_000,
    enabled: true,
    onStatus: () => undefined,
  });
  await service.start();
  const status = service.status();
  await service.stop();
  assert.equal(status.phase, "unavailable");
  assert.match(status.message ?? "", /未找到索引程序/);
});

test("the indexer lives inside the bundled skill", () => {
  assert.equal(bundledIndexerPath("/w/skills/aegis-search"), "/w/skills/aegis-search/bin/aegis-search");
});
