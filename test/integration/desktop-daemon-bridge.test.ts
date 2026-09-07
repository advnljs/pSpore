import assert from "node:assert/strict";
import test from "node:test";

import { DaemonBridge } from "../../src/desktop/daemon-bridge.js";
import { initialKernelState } from "../../src/kernel/state.js";
import type { EventEnvelope, ServerHelloFrame } from "../../src/protocol/schema.js";

test("desktop daemon bridge validates commands and coalesces text and thinking independently", async () => {
  const client = new FakeProtocolClient();
  const bridge = new DaemonBridge({
    socketPath: "/unused/daemon.sock",
    stagingRoot: "/private/workspace/staging",
    versions: { pspore: "0.1.0", pi: "0.84.1", electron: "43.3.0", node: "24.19.0" },
    reconnectDelay: () => 1,
    clientFactory: () => client,
  });
  const frames: unknown[] = [];
  bridge.subscribe((frame) => frames.push(frame));
  bridge.start();
  await waitFor(() => bridge.bootstrap().connection.phase === "connected");

  client.emit(event(1, "transcript.delta", { sessionId: "main", itemId: "item-1", kind: "thinking", delta: "check " }));
  client.emit(event(2, "transcript.delta", { sessionId: "main", itemId: "item-1", kind: "thinking", delta: "facts" }));
  client.emit(event(3, "transcript.delta", { sessionId: "main", itemId: "item-1", kind: "text", delta: "hel" }));
  client.emit(event(4, "transcript.delta", { sessionId: "main", itemId: "item-1", kind: "text", delta: "lo" }));
  await new Promise((resolve) => setTimeout(resolve, 45));
  const deltas = frames.filter((frame) => isRecord(frame) && frame["kind"] === "delta");
  assert.deepEqual(deltas, [
    {
      version: 1,
      kind: "delta",
      streamId: "stream-1",
      fromSeq: 1,
      seq: 2,
      sessionId: "main",
      itemId: "item-1",
      channel: "thinking",
      text: "check facts",
    },
    {
      version: 1,
      kind: "delta",
      streamId: "stream-1",
      fromSeq: 3,
      seq: 4,
      sessionId: "main",
      itemId: "item-1",
      channel: "text",
      text: "hello",
    },
  ]);

  await bridge.dispatch({ action: "resources.inspect", stagingName: "safe-skill" });
  assert.deepEqual(client.commands.at(-1), {
    type: "resources.inspect",
    payload: { stagingPath: "/private/workspace/staging/safe-skill" },
    options: {},
  });
  await assert.rejects(() => bridge.dispatch({ action: "protocol.raw", payload: {} }), /not allowlisted/);
  await bridge.stop();
});

test("reports why a rejected daemon frame closed the connection", async () => {
  const client = new FakeProtocolClient();
  const bridge = new DaemonBridge({
    socketPath: "/unused/daemon.sock",
    stagingRoot: "/private/workspace/staging",
    versions: { pspore: "0.1.0", pi: "0.84.1", electron: "43.3.0", node: "24.19.0" },
    reconnectDelay: () => 5_000,
    clientFactory: () => client,
  });
  bridge.start();
  await waitFor(() => bridge.bootstrap().connection.phase === "connected");

  // Silently reconnecting forever is what made this failure impossible to
  // diagnose from the client: the banner has to name the rejected frame.
  client.emit(event(1, "transcript.delta", { sessionId: "main", itemId: "item-1", kind: "text", delta: 42 as unknown as string }));
  await waitFor(() => bridge.bootstrap().connection.phase === "disconnected");
  const connection = bridge.bootstrap().connection;
  assert.equal(connection.phase, "disconnected");
  assert.match(connection.message ?? "", /Rejected a transcript\.delta event from the daemon/);
  await bridge.stop();
});

test("reports an unexplained sequence jump instead of closing silently", async () => {
  const client = new FakeProtocolClient();
  const bridge = new DaemonBridge({
    socketPath: "/unused/daemon.sock",
    stagingRoot: "/private/workspace/staging",
    versions: { pspore: "0.1.0", pi: "0.84.1", electron: "43.3.0", node: "24.19.0" },
    reconnectDelay: () => 5_000,
    clientFactory: () => client,
  });
  bridge.start();
  await waitFor(() => bridge.bootstrap().connection.phase === "connected");

  client.emit(event(7, "transcript.delta", { sessionId: "main", itemId: "item-1", kind: "text", delta: "late" }));
  await waitFor(() => bridge.bootstrap().connection.phase === "disconnected");
  assert.match(bridge.bootstrap().connection.message ?? "", /Event gap on stream-1: expected 1, received 7/);
  await bridge.stop();
});

class FakeProtocolClient {
  readonly commands: Array<{ type: string; payload: unknown; options: Record<string, unknown> }> = [];
  readonly #events = new Set<(event: EventEnvelope) => void>();
  readonly #connections = new Set<(connected: boolean, error?: Error) => void>();
  #connected = false;

  async connect(): Promise<ServerHelloFrame> {
    this.#connected = true;
    for (const listener of this.#connections) listener(true);
    return {
      v: 1,
      kind: "hello_ack",
      id: "hello-1",
      protocolVersion: 1,
      instanceId: "daemon-1",
      streamId: "stream-1",
      latestSeq: 0,
      replayFromSeq: 1,
      snapshot: initialKernelState(),
    };
  }

  async close(): Promise<void> {
    if (!this.#connected) return;
    this.#connected = false;
    for (const listener of this.#connections) listener(false, new Error("closed"));
  }

  async command<T = unknown>(type: string, payload: unknown, options: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ type, payload, options });
    return { ok: true } as T;
  }

  subscribe(listener: (event: EventEnvelope) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  subscribeConnection(listener: (connected: boolean, error?: Error) => void): () => void {
    this.#connections.add(listener);
    return () => this.#connections.delete(listener);
  }

  emit(value: EventEnvelope): void {
    for (const listener of this.#events) listener(value);
  }
}

function event(seq: number, type: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    v: 1,
    kind: "event",
    id: `event-${seq}`,
    streamId: "stream-1",
    seq,
    ts: "2026-08-10T00:00:00.000Z",
    durable: false,
    type,
    payload: { ...payload, upstreamSessionId: "upstream-main" },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for desktop bridge");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
