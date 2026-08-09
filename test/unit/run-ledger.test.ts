import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { RunLedger } from "../../src/automation/run-ledger.js";
import type { RunTriggerSpec } from "../../src/automation/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("run ledger", () => {
  test("claims a schedule slot once and recovers a running run as unknown", async () => {
    const fixture = await makeFixture();
    const first = await fixture.ledger.claim(trigger("job:a:slot"));
    assert.equal(first.claimed, true);
    const duplicate = await fixture.ledger.claim(trigger("job:a:slot"));
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.record.id, first.record.id);
    await fixture.ledger.transition(first.record.id, { status: "running", startedAt: "2026-08-09T00:00:01.000Z" });

    const restarted = new RunLedger({
      root: fixture.runs,
      recoveryDirectory: fixture.recovery,
      clock: () => new Date("2026-08-09T00:01:00.000Z"),
      idFactory: sequence("restart"),
    });
    const recovery = await restarted.initialize();
    assert.equal(recovery.recoveredUnknown.length, 1);
    assert.equal(restarted.get(first.record.id)?.status, "unknown");
    assert.match(restarted.get(first.record.id)?.reason ?? "", /side effects/);
  });

  test("copies and truncates a malformed tail but rejects a malformed middle record", async () => {
    const fixture = await makeFixture();
    await fixture.ledger.claim(trigger("slot-tail"));
    const path = join(fixture.runs, "2026-08.jsonl");
    await appendFile(path, '{"broken"', "utf8");
    const recovered = new RunLedger({ root: fixture.runs, recoveryDirectory: fixture.recovery });
    await recovered.initialize();
    assert.doesNotMatch(await readFile(path, "utf8"), /broken/);
    assert.equal((await readdir(fixture.recovery)).length, 1);

    await appendFile(path, "{broken}\n", "utf8");
    await appendFile(path, `${JSON.stringify(trigger("after-middle"))}\n`, "utf8");
    const invalid = new RunLedger({ root: fixture.runs, recoveryDirectory: fixture.recovery });
    await assert.rejects(invalid.initialize(), /Malformed JSONL middle record/);
  });
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pspore-ledger-"));
  roots.push(root);
  const runs = join(root, "runs");
  const recovery = join(root, "recovery");
  await mkdir(runs);
  const ledger = new RunLedger({ root: runs, recoveryDirectory: recovery, idFactory: sequence("run") });
  await ledger.initialize();
  return { root, runs, recovery, ledger };
}

function trigger(slotKey: string): RunTriggerSpec {
  return {
    slotKey,
    source: "cron",
    jobId: "a",
    scheduledFor: "2026-08-09T00:00:00.000Z",
    receivedAt: "2026-08-09T00:00:00.000Z",
    objective: "test run",
    activity: { kind: "command", command: "true", cwd: "/tmp" },
    policyRef: "default",
    concurrency: "forbid",
    timeoutMs: 1_000,
    budget: { maxTurns: 1, maxToolCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxChildren: 0 },
    delivery: { kind: "none" },
  };
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
