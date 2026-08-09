import assert from "node:assert/strict";
import test from "node:test";

import { initialKernelState } from "../../src/kernel/state.js";
import { DesktopStore } from "../../src/desktop/renderer/store.js";
import type { DesktopBootstrap, DesktopFrame } from "../../src/desktop/ipc-contract.js";

test("desktop store applies authoritative snapshot and coalesced deltas in sequence", () => {
  const store = new DesktopStore();
  const bootstrap: DesktopBootstrap = {
    version: 1,
    connection: { phase: "connected", attempt: 0, instanceId: "daemon-1" },
    snapshot: initialKernelState(),
    cursors: { stream: 4 },
    versions: { pspore: "0.1.0", pi: "0.84.1", electron: "43.3.0", node: "24.19.0" },
  };
  store.applyBootstrap(bootstrap);
  store.applyFrame({ version: 1, kind: "delta", streamId: "stream", fromSeq: 5, seq: 7, sessionId: "main", text: "hello" });
  assert.equal(store.snapshot().streamingText["main"], "hello");
  assert.equal(store.snapshot().cursors["stream"], 7);

  store.applyFrame(eventFrame(8, "tool.started", { sessionId: "main", toolName: "shell" }));
  assert.equal(store.snapshot().activities.length, 1);
  assert.equal(store.snapshot().activities[0]?.summary, "tool.started: shell");
  assert.equal(store.snapshot().cursors["stream"], 8);
});

test("desktop store detects IPC ordering gaps and replaces stale state with a snapshot", () => {
  const store = new DesktopStore();
  store.applyBootstrap({
    version: 1,
    connection: { phase: "connected", attempt: 0 },
    snapshot: initialKernelState(),
    cursors: { stream: 1 },
    versions: { pspore: "0.1.0", pi: "0.84.1", electron: "43.3.0", node: "24.19.0" },
  });
  store.applyFrame(eventFrame(3, "runtime.error", { sessionId: "main", error: "gap" }));
  assert.deepEqual(store.snapshot().gap, { streamId: "stream", expected: 2, received: 3 });

  const replacement = { ...initialKernelState(), revision: 9 };
  store.applyFrame({ version: 1, kind: "snapshot", snapshot: replacement, cursors: { stream: 20 } });
  assert.equal(store.snapshot().kernel.revision, 9);
  assert.equal(store.snapshot().gap, undefined);
  assert.equal(store.snapshot().cursors["stream"], 20);
});

function eventFrame(seq: number, type: string, payload: Record<string, unknown>): DesktopFrame {
  return {
    version: 1,
    kind: "event",
    event: {
      v: 1,
      kind: "event",
      id: `event-${seq}`,
      streamId: "stream",
      seq,
      ts: "2026-08-10T00:00:00.000Z",
      durable: false,
      type,
      payload,
    },
  };
}
