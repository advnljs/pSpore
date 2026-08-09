import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { acquireDaemonLock } from "../../src/storage/daemon-lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("daemon lock", () => {
  test("uses PID plus process start identity and releases only its own lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-lock-"));
    roots.push(root);
    const path = join(root, "daemon.lock");
    const lock = await acquireDaemonLock(path);
    const record = JSON.parse(await readFile(path, "utf8")) as { instanceId: string };
    assert.equal(record.instanceId, lock.instanceId);
    await assert.rejects(acquireDaemonLock(path), /already running/);
    await lock.release();
    await assert.rejects(readFile(path), /ENOENT/);
  });

  test("recovers a stale or malformed lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-stale-lock-"));
    roots.push(root);
    const path = join(root, "daemon.lock");
    await writeFile(path, "not-json", { mode: 0o600 });
    const lock = await acquireDaemonLock(path);
    assert.ok(lock.instanceId);
    await lock.release();
  });
});
