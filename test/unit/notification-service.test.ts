import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import type { RunRecord } from "../../src/automation/types.js";
import { NotificationService, type NotificationRecord } from "../../src/notifications/notification-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("durable notifications", () => {
  test("persists agent and run delivery, restores it, and ignores delivery=none", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-notifications-"));
    roots.push(root);
    const events = join(root, "events");
    await mkdir(events);
    const path = join(events, "notifications.jsonl");
    const published: NotificationRecord[] = [];
    const service = new NotificationService({
      path,
      recoveryDirectory: join(root, "recovery"),
      idFactory: sequence("notification"),
      clock: () => new Date("2026-08-10T00:00:00.000Z"),
      onNotification: (record) => {
        published.push(record);
      },
    });
    await service.initialize();
    const agent = await service.notify({
      level: "info",
      title: "Review ready",
      body: "The local change is ready for review.",
      source: { kind: "agent", sessionId: "main" },
    });
    assert.equal(agent.target.kind, "local-notification");
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    await service.deliverRun(run("local-notification"));
    await service.deliverRun(run("none"));
    assert.equal(service.list().length, 2);
    assert.equal(published.length, 2);
    assert.match(await readFile(path, "utf8"), /Review ready/);

    const restored: NotificationRecord[] = [];
    const restarted = new NotificationService({
      path,
      recoveryDirectory: join(root, "recovery"),
      onNotification: (record) => {
        restored.push(record);
      },
    });
    await restarted.initialize();
    assert.equal(restarted.list().length, 2);
    assert.deepEqual(restored.map((record) => record.title), ["Review ready", "Job daily: succeeded"]);
  });
});

function run(delivery: "local-notification" | "none"): RunRecord {
  return {
    version: 1,
    revision: 3,
    id: `run-${delivery}`,
    slotKey: `slot-${delivery}`,
    source: "cron",
    jobId: "daily",
    scheduledFor: "2026-08-10T00:00:00.000Z",
    receivedAt: "2026-08-10T00:00:00.000Z",
    objective: "daily check",
    activity: { kind: "command", command: "true", cwd: "/tmp" },
    policyRef: "default",
    concurrency: "forbid",
    timeoutMs: 1_000,
    budget: { maxTurns: 1, maxToolCalls: 1, maxInputTokens: 10, maxOutputTokens: 10, maxChildren: 0 },
    delivery: { kind: delivery },
    status: "succeeded",
    startedAt: "2026-08-10T00:00:00.000Z",
    finishedAt: "2026-08-10T00:00:01.000Z",
  };
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
