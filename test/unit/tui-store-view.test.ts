import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentSnapshot } from "../../src/domain/runtime.js";
import { initialKernelState } from "../../src/kernel/state.js";
import type { ServerHelloFrame } from "../../src/protocol/schema.js";
import { TuiStore } from "../../src/ui/tui/store.js";
import { renderTuiSnapshot } from "../../src/ui/tui/view.js";

describe("TUI protocol store", () => {
  test("uses snapshot authority, applies ordered events, and detects gaps", () => {
    const store = new TuiStore();
    store.applyHello(hello());
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "e-1",
      streamId: "kernel",
      seq: 1,
      ts: "2026-08-09T00:00:01.000Z",
      durable: false,
      type: "message.delta",
      payload: { sessionId: "main", delta: "stream" },
    });
    assert.equal(store.snapshot().streamingText["main"], "stream");
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "e-2",
      streamId: "kernel",
      seq: 2,
      ts: "2026-08-09T00:00:02.000Z",
      durable: true,
      type: "session.closed",
      payload: { sessionId: "main", revision: 5 },
    });
    assert.equal(store.snapshot().kernel.sessions["main"], undefined);
    assert.equal(store.snapshot().streamingText["main"], undefined);
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "e-4",
      streamId: "kernel",
      seq: 4,
      ts: "2026-08-09T00:00:03.000Z",
      durable: true,
      type: "run.settled",
      payload: {},
    });
    assert.deepEqual(store.snapshot().gap, { streamId: "kernel", expected: 3, received: 4 });
  });
});

describe("TUI 160x45 snapshot", () => {
  test("keeps all critical controls reachable at the baseline terminal size", () => {
    const store = new TuiStore();
    store.applyHello(hello());
    store.setNotice("Ready for verification");
    const lines = renderTuiSnapshot(store.snapshot(), 160, 45, "inspect workspace");
    assert.equal(lines.length, 45);
    assert.ok(lines.every((line) => visibleWidth(line) === 160));
    const screen = lines.join("\n");
    assert.match(screen, /pSpore v1 core/);
    assert.match(screen, /TRANSCRIPT  main/);
    assert.match(screen, /assistant> hello from fake/);
    assert.match(screen, /APPROVAL approval-1/);
    assert.match(screen, /\/steer/);
    assert.match(screen, /\/notifications/);
    assert.match(screen, /\/quit/);
    assert.match(screen, /prompt> inspect workspace/);
    assert.equal(createHash("sha256").update(screen).digest("hex"), "4bf0e9ffc5dd5055235b92ab7f4343335dc16d44d469a301f46eb7a9fdc6cf99");
  });
});

function hello(): ServerHelloFrame {
  const session: AgentSnapshot = {
    sessionId: "main",
    upstreamSessionId: "pi-main",
    cwd: "/workspace",
    status: "idle",
    thinking: "off",
    messages: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hello from fake" },
    ],
    entries: [],
    queue: { steering: [], followUp: [] },
    usage: { input: 12, output: 4, cacheRead: 6, cacheWrite: 2, total: 24, costUsd: 0 },
  };
  const kernel = {
    ...initialKernelState(),
    revision: 4,
    daemon: { phase: "ready" as const, instanceId: "daemon-test" },
    sessions: { main: session },
    approvals: {
      "approval-1": {
        id: "approval-1",
        sessionId: "main",
        agentPath: ["main"],
        toolCallId: "tool-1",
        capability: "process.exec" as const,
        display: { summary: "shell in /workspace" },
        riskReasons: [],
        requestedAt: "2026-08-09T00:00:00.000Z",
        expiresAt: "2026-08-09T00:05:00.000Z",
        allowedScopes: ["once" as const, "session" as const],
      },
    },
  };
  return {
    v: 1,
    kind: "hello_ack",
    id: "hello",
    protocolVersion: 1,
    instanceId: "daemon-test",
    streamId: "kernel",
    latestSeq: 0,
    replayFromSeq: 1,
    snapshot: kernel,
  };
}
