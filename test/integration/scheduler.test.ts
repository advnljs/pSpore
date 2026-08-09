import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { RunLedger } from "../../src/automation/run-ledger.js";
import { Scheduler, type RunExecutor } from "../../src/automation/scheduler.js";
import type { JobDefinition, RunRecord } from "../../src/automation/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("scheduler semantics", () => {
  test("deduplicates slots and enforces forbid concurrency", async () => {
    const controlled = new ControlledExecutor();
    const scheduler = await fixture([job("forbid", "forbid")], controlled);
    const first = scheduler.triggerJob("forbid", new Date("2026-08-09T00:00:00.000Z"));
    await controlled.waitForStarts(1);
    const duplicate = scheduler.triggerJob("forbid", new Date("2026-08-09T00:00:00.000Z"));
    const second = await scheduler.triggerJob("forbid", new Date("2026-08-09T00:01:00.000Z"));
    assert.equal(second.status, "skipped");
    assert.match(second.reason ?? "", /forbid/);
    controlled.finishAll();
    assert.equal((await first).status, "succeeded");
    assert.equal((await duplicate).id, (await first).id);
    assert.equal(controlled.started.length, 1);
    await scheduler.stop();
  });

  test("replace cancels the prior run, global budget skips excess, and timeout is budget_exhausted", async () => {
    const controlled = new ControlledExecutor();
    const scheduler = await fixture([job("replace", "replace"), job("other", "allow")], controlled, 1);
    const first = scheduler.triggerJob("replace", new Date("2026-08-09T00:00:00.000Z"));
    await controlled.waitForStarts(1);
    const replacementPromise = scheduler.triggerJob("replace", new Date("2026-08-09T00:01:00.000Z"));
    await controlled.waitForStarts(2);
    assert.equal((await first).status, "cancelled");
    const excess = await scheduler.triggerJob("other", new Date("2026-08-09T00:01:00.000Z"));
    assert.equal(excess.status, "skipped");
    controlled.finishAll();
    assert.equal((await replacementPromise).status, "succeeded");
    await scheduler.stop();

    const timeoutExecutor: RunExecutor = { execute: async (_run, signal) => waitForAbort(signal) };
    const timeoutScheduler = await fixture([{ ...job("timeout", "forbid"), timeoutMs: 20 }], timeoutExecutor);
    const timedOut = await timeoutScheduler.triggerJob("timeout", new Date("2026-08-09T00:00:00.000Z"));
    assert.equal(timedOut.status, "budget_exhausted");
    assert.match(timedOut.reason ?? "", /timeout/);
    await timeoutScheduler.stop();
  });

  test("applies only the latest missed slot and obeys run_once versus skip", async () => {
    let executions = 0;
    const immediate: RunExecutor = {
      execute: async () => {
        executions += 1;
        return { status: "succeeded" };
      },
    };
    const runOnceJob = { ...job("catch-up", "forbid"), misfire: "run_once" as const };
    const scheduler = await fixture([runOnceJob], immediate);
    await scheduler.triggerJob("catch-up", new Date("2026-08-09T00:00:00.000Z"));
    await scheduler.applyMisfires(new Date("2026-08-09T00:03:30.000Z"));
    await scheduler.applyMisfires(new Date("2026-08-09T00:03:30.000Z"));
    assert.equal(executions, 2);
    assert.equal(
      scheduler.listRuns().filter((run) => run.source === "recovery").map((run) => run.scheduledFor).at(-1),
      "2026-08-09T00:03:00.000Z",
    );
    await scheduler.stop();

    const skipJob = { ...job("skip-catch-up", "forbid"), misfire: "skip" as const };
    const skipScheduler = await fixture([skipJob], immediate);
    await skipScheduler.triggerJob("skip-catch-up", new Date("2026-08-09T00:00:00.000Z"));
    await skipScheduler.applyMisfires(new Date("2026-08-09T00:03:30.000Z"));
    assert.equal(skipScheduler.listRuns().at(-1)?.status, "skipped");
    assert.match(skipScheduler.listRuns().at(-1)?.reason ?? "", /misfire policy/);
    await skipScheduler.stop();
  });
});

class ControlledExecutor implements RunExecutor {
  readonly started: RunRecord[] = [];
  readonly #pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  async execute(run: RunRecord, signal: AbortSignal) {
    this.started.push(run);
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.push({ resolve, reject });
    });
    return { status: "succeeded" as const };
  }

  finishAll(): void {
    for (const pending of this.#pending.splice(0)) pending.resolve();
  }

  async waitForStarts(count: number): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (this.started.length < count) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for executor start");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
}

async function fixture(jobs: JobDefinition[], executor: RunExecutor, maxConcurrentRuns = 4): Promise<Scheduler> {
  const root = await mkdtemp(join(tmpdir(), "pspore-scheduler-"));
  roots.push(root);
  const runs = join(root, "runs");
  await mkdir(runs);
  const ledger = new RunLedger({ root: runs, recoveryDirectory: join(root, "recovery") });
  const scheduler = new Scheduler({
    jobs: {
      loadAll: async () => jobs,
      put: async () => {
        throw new Error("put is not configured in this scheduler fixture");
      },
    },
    ledger,
    executor,
    maxConcurrentRuns,
    replaceGraceMs: 200,
    clock: () => new Date("2026-08-09T00:00:30.000Z"),
  });
  await scheduler.initialize();
  return scheduler;
}

function job(id: string, concurrency: JobDefinition["concurrency"]): JobDefinition {
  return {
    version: 1,
    id,
    enabled: true,
    schedule: { cron: "* * * * *", timezone: "UTC" },
    policyRef: "default",
    concurrency,
    misfire: "skip",
    timeoutMs: 2_000,
    budget: { maxTurns: 2, maxToolCalls: 4, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxChildren: 0 },
    delivery: { kind: "none" },
    activity: { kind: "command", command: "true", cwd: "/tmp" },
  };
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw signal.reason;
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
