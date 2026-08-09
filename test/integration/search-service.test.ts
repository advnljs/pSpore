import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { SearchService } from "../../src/memory/search-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("incremental exact and BM25 search", () => {
  test("indexes memory/workspace/session text, excludes secrets and symlinks, then refreshes changed sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-search-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    const cache = join(root, "cache", "index.json");
    await mkdir(join(workspace, "memory"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "hidden"), { recursive: true });
    await mkdir(sessions, { recursive: true });
    await mkdir(join(root, "cache"), { recursive: true });
    await writeFile(join(workspace, "MEMORY.md"), "# Decisions\n\n桌面客户端固定使用 Electron 43。\n", { mode: 0o600 });
    const notes = join(workspace, "notes.md");
    await writeFile(notes, "# Runtime\n\nThe durable approval is persisted before publish.\n", { mode: 0o600 });
    await writeFile(join(workspace, ".env"), "SEARCH_SECRET_NEVER=visible", { mode: 0o600 });
    await writeFile(join(workspace, "node_modules", "hidden", "secret.md"), "SEARCH_SECRET_NEVER", { mode: 0o600 });
    const outside = join(root, "outside.md");
    await writeFile(outside, "SEARCH_SECRET_NEVER", { mode: 0o600 });
    await symlink(outside, join(workspace, "linked.md"));
    await writeFile(
      join(sessions, "session.jsonl"),
      `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "remember protocol cursor" }] } })}\n`,
      { mode: 0o600 },
    );

    const search = new SearchService({ workspaceRoot: workspace, sessionsRoot: sessions, cachePath: cache });
    const chinese = await search.search({ query: "Electron 客户端", mode: "auto", maxResults: 5, maxReturnedTokens: 500 });
    assert.equal(chinese[0]?.scope, "memory");
    assert.match(chinese[0]?.snippet ?? "", /Electron 43/);
    assert.equal(chinese[0]?.contentSha256.length, 64);

    const exact = await search.search({ query: "durable approval", mode: "exact", maxResults: 5, maxReturnedTokens: 500 });
    assert.equal(exact[0]?.path, notes);
    assert.equal(exact[0]?.line, 3);
    assert.deepEqual(
      await search.search({ query: "durable approval", mode: "exact", glob: "*.txt", maxResults: 5, maxReturnedTokens: 500 }),
      [],
    );
    const session = await search.search({ query: "protocol cursor", scopes: ["sessions"], maxResults: 5, maxReturnedTokens: 500 });
    assert.equal(session[0]?.scope, "sessions");
    const excluded = await search.search({ query: "SEARCH_SECRET_NEVER", maxResults: 5, maxReturnedTokens: 500 });
    assert.deepEqual(excluded, []);
    assert.equal(JSON.parse(await readFile(cache, "utf8")).version, 1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(notes, "# Runtime\n\nCrash recovery uses an unknown state marker.\n", { mode: 0o600 });
    const refreshed = await search.search({ query: "unknown state marker", mode: "exact", maxResults: 5, maxReturnedTokens: 500 });
    assert.equal(refreshed[0]?.path, notes);
    const removed = await search.search({ query: "durable approval", mode: "exact", maxResults: 5, maxReturnedTokens: 500 });
    assert.deepEqual(removed, []);
  });

  test("ignores a malformed trailing JSONL record but fails closed on a malformed middle record", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-search-jsonl-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const sessions = join(root, "sessions");
    const cache = join(root, "cache", "index.json");
    await mkdir(workspace);
    await mkdir(sessions);
    await mkdir(join(root, "cache"));
    const path = join(sessions, "session.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "message", text: "valid entry" })}\n{"broken"`, { mode: 0o600 });
    const trailing = new SearchService({ workspaceRoot: workspace, sessionsRoot: sessions, cachePath: cache });
    assert.equal(
      (await trailing.search({ query: "valid entry", maxResults: 5, maxReturnedTokens: 100 }))[0]?.scope,
      "sessions",
    );

    await writeFile(path, `${JSON.stringify({ type: "message", text: "first" })}\n{broken}\n${JSON.stringify({ type: "message", text: "last" })}\n`, { mode: 0o600 });
    const middle = new SearchService({ workspaceRoot: workspace, sessionsRoot: sessions, cachePath: cache });
    await assert.rejects(middle.search({ query: "last", maxResults: 5, maxReturnedTokens: 100 }), /Malformed JSONL at line 2/);
  });
});
