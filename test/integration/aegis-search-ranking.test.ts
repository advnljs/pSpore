import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * Ranking behaviour of the bundled indexer, exercised against the real binary.
 *
 * The binary is fetched at packaging time rather than committed, so these tests
 * skip when it is absent. They exist because the ranking fix is the kind of
 * behaviour that unit tests cannot express: it only appears once real documents
 * are scored by Lucene.
 */
const INDEXER = resolve(
  import.meta.dirname,
  "../../bundled-skills/aegis-search/bin/aegis-search",
);

async function indexerAvailable(): Promise<boolean> {
  try {
    await access(INDEXER, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface SearchHit {
  filename: string;
  score: number;
}

async function buildIndex(documents: Record<string, string>): Promise<{ index: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pspore-rank-"));
  const documentsDir = join(root, "docs");
  const index = join(root, "index");
  await execFileAsync("mkdir", ["-p", documentsDir]);
  for (const [name, content] of Object.entries(documents)) {
    await writeFile(join(documentsDir, name), content, "utf8");
  }
  await execFileAsync(INDEXER, [
    "index", documentsDir, "--index", index, "--db", join(root, "meta.db"), "--ext", "txt", "--quiet",
  ], { maxBuffer: 8 * 1024 * 1024 });
  return { index, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

async function search(index: string, query: string): Promise<SearchHit[]> {
  const { stdout } = await execFileAsync(INDEXER, ["search", query, "--index", index, "--json"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout);
  const results = (parsed as { results?: Array<{ filename: string; score: number }> }).results ?? [];
  return results.map((hit) => ({ filename: hit.filename, score: hit.score }));
}

test("a contiguous match outranks the same characters scattered", { skip: !(await indexerAvailable()) }, async () => {
  // Equal length and equal term frequency, so only adjacency can explain the
  // difference — this isolates the phrase boost from length normalisation.
  const filler = "公司经营情况说明与市场环境分析。".repeat(20);
  const fixture = await buildIndex({
    "a-adjacent.txt": `${filler}授信业务${filler}`,
    "b-separated.txt": `授信${filler}${filler}业务`,
  });
  try {
    const hits = await search(fixture.index, "授信 业务");
    assert.equal(hits.length, 2, "both documents contain both words");
    assert.equal(hits[0]?.filename, "a-adjacent.txt", "the contiguous match must rank first");
    assert.ok(
      (hits[0]?.score ?? 0) > (hits[1]?.score ?? 0) * 10,
      `expected a decisive gap, got ${hits[0]?.score} vs ${hits[1]?.score}`,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("nearby words outrank distant ones", { skip: !(await indexerAvailable()) }, async () => {
  const filler = "公司经营情况说明。".repeat(40);
  const fixture = await buildIndex({
    "near.txt": `${filler}授信额度与相关业务的说明${filler}`,
    "far.txt": `授信额度审批${filler}${filler}业务发展规划`,
  });
  try {
    const hits = await search(fixture.index, "授信 业务");
    assert.equal(hits[0]?.filename, "near.txt", "the proximity clause must lift the closer match");
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0) * 2);
  } finally {
    await fixture.cleanup();
  }
});

test("a single query word requires the whole phrase", { skip: !(await indexerAvailable()) }, async () => {
  const fixture = await buildIndex({
    "whole.txt": "本次授信业务调查报告。",
    // Contains every character of the query, none of them contiguous.
    "scattered.txt": "授权信息说明。工业务实推进。信贷业绩汇总。".repeat(4),
  });
  try {
    const hits = await search(fixture.index, "授信业务");
    assert.deepEqual(hits.map((hit) => hit.filename), ["whole.txt"], "scattered characters must not match");
  } finally {
    await fixture.cleanup();
  }
});

test("results can be ordered by file time instead of relevance", { skip: !(await indexerAvailable()) }, async () => {
  const fixture = await buildIndex({
    "old.txt": "季度报告内容",
    "mid.txt": "季度报告内容",
    "new.txt": "季度报告内容",
  });
  try {
    const documents = join(fixture.index, "..", "docs");
    await execFileAsync("touch", ["-d", "2019-06-15", join(documents, "old.txt")]);
    await execFileAsync("touch", ["-d", "2022-06-15", join(documents, "mid.txt")]);
    await execFileAsync("touch", ["-d", "2026-06-15", join(documents, "new.txt")]);
    // Re-index so the new mtimes are what the sort reads.
    await execFileAsync(INDEXER, [
      "index", documents, "--index", fixture.index, "--db", join(fixture.index, "..", "meta.db"),
      "--ext", "txt", "--full", "--quiet",
    ], { maxBuffer: 8 * 1024 * 1024 });

    const { stdout: newest } = await execFileAsync(INDEXER, [
      "search", "季度报告", "--index", fixture.index, "--sort", "newest", "--json",
    ], { maxBuffer: 8 * 1024 * 1024 });
    const newestOrder = (JSON.parse(newest) as { results: Array<{ filename: string; score: number }> }).results;
    assert.deepEqual(newestOrder.map((hit) => hit.filename), ["new.txt", "mid.txt", "old.txt"]);
    // Lucene leaves scores unset under a field sort; the CLI must still emit
    // valid JSON, which means a finite number rather than NaN.
    for (const hit of newestOrder) assert.ok(Number.isFinite(hit.score), "score must be a finite number");

    const { stdout: oldest } = await execFileAsync(INDEXER, [
      "search", "季度报告", "--index", fixture.index, "--sort", "oldest", "--json",
    ], { maxBuffer: 8 * 1024 * 1024 });
    const oldestOrder = (JSON.parse(oldest) as { results: Array<{ filename: string }> }).results;
    assert.deepEqual(oldestOrder.map((hit) => hit.filename), ["old.txt", "mid.txt", "new.txt"]);
  } finally {
    await fixture.cleanup();
  }
});
