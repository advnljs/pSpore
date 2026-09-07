import assert from "node:assert/strict";
import test from "node:test";

import { initialKernelState } from "../../src/kernel/state.js";
import { CONNECTION_SETTLE_MS, DesktopStore } from "../../src/desktop/renderer/store.js";
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
  const kernelBeforeDelta = store.snapshot().kernel;
  store.applyFrame({
    version: 1,
    kind: "delta",
    streamId: "stream",
    fromSeq: 5,
    seq: 6,
    sessionId: "main",
    channel: "thinking",
    text: "private reasoning",
  });
  store.applyFrame({
    version: 1,
    kind: "delta",
    streamId: "stream",
    fromSeq: 7,
    seq: 7,
    sessionId: "main",
    channel: "text",
    text: "hello",
  });
  assert.equal(store.snapshot().streamingText["main"], "hello");
  assert.equal(store.snapshot().streamingThinking["main"], "private reasoning");
  assert.equal(store.snapshot().cursors["stream"], 7);
  assert.equal(store.snapshot().kernel, kernelBeforeDelta, "streaming deltas must not clone the full history");

  store.applyFrame(eventFrame(8, "tool.started", {
    sessionId: "main",
    toolCallId: "tool-shell",
    toolName: "shell",
    input: { command: "node --version 2>/dev/null" },
  }));
  assert.equal(store.snapshot().activities.length, 1);
  assert.equal(store.snapshot().activities[0]?.label, "Running command");
  assert.equal(store.snapshot().activities[0]?.summary, "node --version 2>/dev/null");
  assert.equal(store.snapshot().activities[0]?.status, "running");
  assert.equal(store.snapshot().cursors["stream"], 8);

  store.applyFrame(eventFrame(9, "tool.completed", {
    sessionId: "main",
    toolCallId: "tool-shell",
    toolName: "shell",
    isError: false,
    result: { details: { capturedBytes: 12 } },
  }));
  assert.equal(store.snapshot().activities.length, 1);
  assert.equal(store.snapshot().activities[0]?.status, "succeeded");
  assert.equal(store.snapshot().activities[0]?.label, "Ran command");
  assert.equal(store.snapshot().activities[0]?.resultSummary, "12 B output captured");
  assert.equal(store.snapshot().cursors["stream"], 9);

  store.applyFrame(eventFrame(10, "tool.started", {
    sessionId: "main",
    toolCallId: "tool-mcp",
    toolName: "mcp_call",
    input: { serverId: "calendar", toolName: "list", arguments: { apiKey: "ds-sensitive-value-123456" } },
  }));
  const detail = store.snapshot().activities.at(-1)?.detail ?? "";
  assert.doesNotMatch(detail, /sensitive-value/);
  assert.match(detail, /\[redacted\]/);

  store.applyFrame(eventFrame(11, "runtime.error", {
    sessionId: "main",
    message: "model request failed",
  }));
  assert.equal(store.snapshot().activities.at(-1)?.label, "Cowork task failed");
  assert.equal(store.snapshot().activities.at(-1)?.status, "failed");
  assert.equal(store.snapshot().streamingText["main"], undefined);
  assert.equal(store.snapshot().streamingThinking["main"], undefined);
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

test("a short reconnect stays presented as connected, a real outage does not", () => {
  let now = 1_000;
  const store = new DesktopStore(() => now);
  store.applyBootstrap({
    version: 1,
    connection: { phase: "connected", attempt: 0, instanceId: "daemon-1" },
    snapshot: initialKernelState(),
    cursors: {},
    versions: { pspore: "0.1.0", pi: "0.84.1", electron: "43.3.0", node: "24.19.0" },
  });
  assert.equal(store.snapshot().stableConnection.phase, "connected");

  // A long run drops and re-establishes the socket within the settle window:
  // the presented state must not flap, only `connection` records the truth.
  store.applyFrame({ version: 1, kind: "connection", connection: { phase: "disconnected", attempt: 1, message: "closed" } });
  assert.equal(store.snapshot().connection.phase, "disconnected");
  assert.equal(store.snapshot().stableConnection.phase, "connected");
  assert.equal(store.snapshot().reconnecting, true);
  assert.equal(store.snapshot().notice, "已连接本地守护进程");

  now += 400;
  store.applyFrame({ version: 1, kind: "connection", connection: { phase: "connecting", attempt: 2, message: "Reconnect attempt 2" } });
  assert.equal(store.snapshot().stableConnection.phase, "connected");

  now += 400;
  store.applyFrame({ version: 1, kind: "connection", connection: { phase: "connected", attempt: 0, instanceId: "daemon-1" } });
  assert.equal(store.snapshot().reconnecting, false);
  assert.equal(store.snapshot().stableConnection.phase, "connected");

  // An outage that outlives the window has to surface, even with no new frames.
  store.applyFrame({ version: 1, kind: "connection", connection: { phase: "disconnected", attempt: 1, message: "daemon stopped" } });
  assert.equal(store.snapshot().stableConnection.phase, "connected");
  now += CONNECTION_SETTLE_MS + 1;
  assert.equal(store.settleConnection(), true);
  assert.equal(store.snapshot().stableConnection.phase, "disconnected");
  assert.equal(store.snapshot().reconnecting, false);
  assert.equal(store.snapshot().notice, "daemon stopped");
});

test("streaming survives transient events the daemon shed under backpressure", () => {
  const store = new DesktopStore();
  store.applyBootstrap({
    version: 1,
    connection: { phase: "connected", attempt: 0, instanceId: "daemon-1" },
    snapshot: initialKernelState(),
    cursors: { stream: 10 },
    versions: { pspore: "0.1.0", pi: "0.84.1", electron: "43.3.0", node: "24.19.0" },
  });
  // seq 11..13 were shed; the next delivered delta starts at 14 and says so.
  store.applyFrame({
    version: 1,
    kind: "delta",
    streamId: "stream",
    fromSeq: 14,
    seq: 15,
    skipped: 3,
    sessionId: "main",
    channel: "text",
    text: "resumed",
  });
  assert.equal(store.snapshot().streamingText["main"], "resumed");
  assert.equal(store.snapshot().cursors["stream"], 15);
  assert.equal(store.snapshot().gap, undefined);

  // A jump the daemon did not account for is still a real gap.
  store.applyFrame({
    version: 1,
    kind: "delta",
    streamId: "stream",
    fromSeq: 30,
    seq: 30,
    sessionId: "main",
    channel: "text",
    text: "lost",
  });
  assert.equal(store.snapshot().gap?.expected, 16);
});
