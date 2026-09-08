import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { SessionCatalog } from "../../src/sessions/session-catalog.js";

const cleanups: string[] = [];

afterEach(async () => Promise.all(cleanups.splice(0).map(async (path) => rm(path, { recursive: true, force: true }))));

test("persists root session metadata and derives a stable title from the first prompt", async () => {
  const fixture = await catalogFixture();
  const sessionFile = join(fixture.workspaceSessions, "session-one.jsonl");
  await writeFile(sessionFile, "{}\n", { mode: 0o600 });
  const catalog = await SessionCatalog.open(fixture.options);
  const created = await catalog.add({
    id: "session-one",
    sessionFile,
    cwd: fixture.cwd,
  });
  assert.equal(created.title, "New session");
  const touched = await catalog.touch("session-one", { prompt: "调查一个很长的跨 session 历史恢复问题并给出证据" });
  assert.equal(touched?.title, "调查一个很长的跨 session 历史恢复问题并给出证据");
  const reopened = await SessionCatalog.open(fixture.options);
  assert.deepEqual(reopened.list(), catalog.list());
  assert.equal((await stat(fixture.options.path)).mode & 0o777, 0o600);
});

test("retains a safe missing Pi JSONL path so the runtime can recreate it", async () => {
  const fixture = await catalogFixture();
  const sessionFile = join(fixture.workspaceSessions, "deferred-session.jsonl");
  const catalog = await SessionCatalog.open(fixture.options);
  const created = await catalog.add({ id: "deferred", sessionFile, cwd: fixture.cwd });
  assert.equal(created.sessionFile, sessionFile);
  assert.equal((await SessionCatalog.open(fixture.options)).get("deferred")?.sessionFile, sessionFile);
  await assert.rejects(
    catalog.add({ id: "outside-missing", sessionFile: join(fixture.root, "outside-missing.jsonl"), cwd: fixture.cwd }),
    /inside the session root/,
  );
});

test("migrates only the most recent legacy JSONL as main and rejects paths outside the session root", async () => {
  const fixture = await catalogFixture();
  const older = join(fixture.workspaceSessions, "older.jsonl");
  const newer = join(fixture.workspaceSessions, "newer.jsonl");
  await writeFile(older, "{}\n", { mode: 0o600 });
  await writeFile(newer, "{}\n", { mode: 0o600 });
  await utimes(older, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
  await utimes(newer, new Date("2026-02-01T00:00:00.000Z"), new Date("2026-02-01T00:00:00.000Z"));
  const catalog = await SessionCatalog.open(fixture.options);
  assert.equal(catalog.list().length, 1);
  assert.equal(catalog.get("main")?.sessionFile, newer);

  const outside = join(fixture.root, "outside.jsonl");
  await writeFile(outside, "{}\n", { mode: 0o600 });
  await assert.rejects(
    catalog.add({ id: "outside", sessionFile: outside, cwd: fixture.cwd }),
    /inside the session root/,
  );
});

test("fails closed on unknown catalog fields", async () => {
  const fixture = await catalogFixture();
  await writeFile(fixture.options.path, '{"version":1,"sessions":[],"extra":true}\n', { mode: 0o600 });
  await assert.rejects(SessionCatalog.open(fixture.options), /unknown fields: extra/);
  assert.match(await readFile(fixture.options.path, "utf8"), /"extra"/);
});

test("removing a session drops its record and deletes only the transcript it owns", async () => {
  const fixture = await catalogFixture();
  const sessionFile = join(fixture.workspaceSessions, "doomed.jsonl");
  const survivor = join(fixture.workspaceSessions, "kept.jsonl");
  // Opened before the transcripts exist: a catalog opened over a directory of
  // loose JSONL files adopts the newest one as legacy `main`, which would add a
  // record this test never created.
  const catalog = await SessionCatalog.open(fixture.options);
  await writeFile(sessionFile, "{}\n", { mode: 0o600 });
  await writeFile(survivor, "{}\n", { mode: 0o600 });
  await catalog.add({ id: "doomed", sessionFile, cwd: fixture.cwd });
  await catalog.add({ id: "kept", sessionFile: survivor, cwd: fixture.cwd });

  const removed = await catalog.remove("doomed");
  assert.equal(removed?.record.id, "doomed");
  assert.equal(removed?.transcriptRemoved, true);
  assert.equal(catalog.get("doomed"), undefined);
  await assert.rejects(stat(sessionFile), /ENOENT/);
  assert.equal((await stat(survivor)).isFile(), true);
  // The deletion is durable, not just in memory.
  assert.deepEqual((await SessionCatalog.open(fixture.options)).list().map((record) => record.id), ["kept"]);
  assert.equal(await catalog.remove("doomed"), undefined);
});

test("removing a session whose transcript is already gone still drops the record", async () => {
  const fixture = await catalogFixture();
  const sessionFile = join(fixture.workspaceSessions, "no-transcript.jsonl");
  const catalog = await SessionCatalog.open(fixture.options);
  await catalog.add({ id: "no-transcript", sessionFile, cwd: fixture.cwd });
  const removed = await catalog.remove("no-transcript");
  assert.equal(removed?.record.id, "no-transcript");
  assert.equal(catalog.get("no-transcript"), undefined);
});

async function catalogFixture(): Promise<{
  root: string;
  cwd: string;
  workspaceSessions: string;
  options: { path: string; sessionsRoot: string; workspaceId: string; cwd: string; clock: () => Date };
}> {
  const root = await mkdtemp(join(tmpdir(), "pspore-session-catalog-"));
  cleanups.push(root);
  const cwd = join(root, "workspace");
  const sessionsRoot = join(root, "sessions");
  const workspaceSessions = join(sessionsRoot, "workspace-id");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await mkdir(workspaceSessions, { recursive: true, mode: 0o700 });
  return {
    root,
    cwd,
    workspaceSessions,
    options: {
      path: join(root, "session-catalog.json"),
      sessionsRoot,
      workspaceId: "workspace-id",
      cwd,
      clock: () => new Date("2026-08-26T00:00:00.000Z"),
    },
  };
}
