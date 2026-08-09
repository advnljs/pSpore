import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { CronSchedule, validateFiveFieldCron } from "../../src/automation/cron-adapter.js";
import { JobStore, parseJob } from "../../src/automation/job-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("cron adapter", () => {
  test("accepts only standard five-field cron and valid IANA timezone", () => {
    assert.doesNotThrow(() => validateFiveFieldCron("*/5 * * * MON-FRI", "Asia/Shanghai"));
    assert.throws(() => validateFiveFieldCron("0 */5 * * * *", "UTC"), /exactly 5 fields/);
    assert.throws(() => validateFiveFieldCron("0 0 L * *", "UTC"), /non-standard/);
    assert.throws(() => validateFiveFieldCron("0 0 * * *", "Mars/Olympus"), /Invalid IANA/);
  });

  test("pins Croner timezone/DST behavior to UTC instants", () => {
    const spring = new CronSchedule("30 2 * * *", "America/New_York");
    assert.deepEqual(
      spring.nextMany(3, new Date("2026-03-07T00:00:00.000Z")).map((date) => date.toISOString()),
      ["2026-03-07T07:30:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"],
    );
    spring.stop();
    const fall = new CronSchedule("30 1 * * *", "America/New_York");
    assert.deepEqual(
      fall.nextMany(3, new Date("2026-10-31T00:00:00.000Z")).map((date) => date.toISOString()),
      ["2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"],
    );
    fall.stop();
  });
});

describe("job schema", () => {
  test("strictly parses a command job and canonicalizes cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-job-"));
    roots.push(root);
    const job = await parseJob(definition(), "daily", root);
    assert.equal(job.activity.kind, "command");
    assert.equal(job.activity.cwd, root);
    await assert.rejects(parseJob({ ...definition(), typo: true }, "daily", root), /unknown keys/);
    await assert.rejects(parseJob({ ...definition(), id: "other" }, "daily", root), /must match filename/);
    await writeFile(join(root, "not-a-directory"), "data");
    await assert.rejects(
      parseJob({ ...definition(), cwd: "not-a-directory" }, "daily", root),
      /must resolve to a directory/,
    );
  });

  test("atomically creates and updates a job only against the expected source hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-job-store-"));
    roots.push(root);
    const jobsDirectory = join(root, "jobs");
    await mkdir(jobsDirectory);
    const store = new JobStore({ jobsDirectory, workspaceRoot: root });
    const created = await store.put(definition(), null);
    assert.match(created.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal((await stat(join(jobsDirectory, "daily.json"))).mode & 0o777, 0o600);
    await assert.rejects(store.put(definition(), null), /update conflict/);

    const updatedSource = {
      ...definition(),
      payload: { command: "printf updated" },
    };
    const updated = await store.put(updatedSource, created.sourceSha256 ?? "missing");
    assert.notEqual(updated.sourceSha256, created.sourceSha256);
    assert.match(await readFile(join(jobsDirectory, "daily.json"), "utf8"), /printf updated/);
    assert.equal((await store.loadAll())[0]?.sourceSha256, updated.sourceSha256);
    await assert.rejects(store.put(definition(), created.sourceSha256 ?? "missing"), /update conflict/);
  });
});

function definition(): Record<string, unknown> {
  return {
    version: 1,
    id: "daily",
    enabled: true,
    schedule: { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    cwd: ".",
    policyRef: "default",
    concurrency: "forbid",
    misfire: "skip",
    timeoutMs: 60_000,
    budget: {
      maxTurns: 4,
      maxToolCalls: 10,
      maxInputTokens: 10_000,
      maxOutputTokens: 2_000,
      maxChildren: 0,
    },
    delivery: { kind: "none" },
    kind: "command",
    payload: { command: "printf ok" },
  };
}
