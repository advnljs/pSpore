import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SessionView } from "../../src/domain/runtime.js";
import { KernelLoop } from "../../src/kernel/loop.js";
import { reduceKernel } from "../../src/kernel/reducer.js";
import { initialKernelState, type KernelEffect } from "../../src/kernel/state.js";

const snapshot = (status: SessionView["status"]): SessionView => ({
  sessionId: "main",
  upstreamSessionId: "pi-main",
  cwd: "/workspace",
  status,
  thinking: "off",
  messages: [],
  messageCount: 0,
  messageOffset: 0,
  queue: { steering: [], followUp: [] },
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 },
});

describe("kernel reducer", () => {
  test("is deterministic and changes authoritative state only through events", () => {
    const event = { id: "e-1", ts: "2026-08-09T00:00:00.000Z", type: "session.snapshot" as const, snapshot: snapshot("idle") };
    const first = reduceKernel(initialKernelState(), event);
    const second = reduceKernel(initialKernelState(), event);
    assert.deepEqual(first, second);
    assert.equal(first.state.revision, 1);
    assert.equal(first.state.sessions["main"]?.status, "idle");
    assert.equal(first.effects[0]?.event.type, "session.snapshot");
    const closed = reduceKernel(first.state, {
      id: "e-2",
      ts: "2026-08-09T00:00:01.000Z",
      type: "session.closed",
      sessionId: "main",
    });
    assert.equal(closed.state.sessions["main"], undefined);
    assert.equal(closed.effects[0]?.event.type, "session.closed");
  });
});

describe("kernel loop", () => {
  test("serializes commits while effects may settle asynchronously", async () => {
    const seen: Array<{ effect: KernelEffect; revision: number }> = [];
    const loop = new KernelLoop(async (effect, state) => {
      await Promise.resolve();
      seen.push({ effect, revision: state.revision });
    });
    const first = loop.dispatch({
      id: "e-1",
      ts: "2026-08-09T00:00:00.000Z",
      type: "session.snapshot",
      snapshot: snapshot("idle"),
    });
    const second = loop.dispatch({
      id: "e-2",
      ts: "2026-08-09T00:00:01.000Z",
      type: "session.snapshot",
      snapshot: snapshot("running"),
    });
    assert.equal((await first).revision, 1);
    assert.equal((await second).revision, 2);
    await loop.idle();
    assert.deepEqual(
      seen.map((item) => item.revision),
      [1, 2],
    );
    assert.equal(loop.snapshot().sessions["main"]?.status, "running");
  });
});
