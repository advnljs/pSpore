import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  validateEventEnvelope,
  validateProtocolResult,
  validateServerHello,
} from "../../src/desktop/validation.js";
import { LocalGateway } from "../../src/gateway/local-gateway.js";
import { initialKernelState } from "../../src/kernel/state.js";
import { ProtocolClient } from "../../src/protocol/client.js";
import { MAX_PROTOCOL_STRING_CHARS, MAX_PUBLISHED_STRING_CHARS } from "../../src/protocol/limits.js";
import type { EventEnvelope } from "../../src/protocol/schema.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup())));

describe("local UDS gateway", () => {
  test("handshakes, broadcasts, rejects stale revisions, and deduplicates commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-gateway-"));
    const socketPath = join(root, "daemon.sock");
    let calls = 0;
    const state = { ...initialKernelState(), revision: 7, daemon: { phase: "ready" as const } };
    const gateway = new LocalGateway({
      socketPath,
      instanceId: "daemon-test",
      snapshot: () => state,
      handleCommand: async (command) => {
        calls += 1;
        return { echoed: command.payload };
      },
      idFactory: sequence("server"),
    });
    await gateway.start();
    const client = new ProtocolClient({ socketPath, clientId: "tui-test", idFactory: sequence("client") });
    cleanups.push(async () => {
      await client.close();
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    });

    const hello = await client.connect();
    assert.equal(hello.instanceId, "daemon-test");
    assert.equal(hello.snapshot.revision, 7);

    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));
    gateway.publish({ id: "event-1", ts: "2026-08-09T00:00:00.000Z", durable: true, type: "daemon.state", payload: {} });
    await waitFor(() => events.length === 1);
    assert.deepEqual(events, ["daemon.state"]);

    const first = await client.command<{ echoed: unknown }>("status.get", {}, { id: "same", expectedRevision: 7 });
    const duplicate = await client.command<{ echoed: unknown }>("status.get", {}, { id: "same", expectedRevision: 7 });
    assert.deepEqual(first, duplicate);
    assert.equal(calls, 1);

    await assert.rejects(
      client.command("status.get", {}, { expectedRevision: 6 }),
      (error: unknown) => error instanceof Error && Reflect.get(error, "code") === "revision_conflict",
    );
    assert.equal(calls, 1);
  });

  test("sheds transient events under backpressure without opening a sequence gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-gateway-backpressure-"));
    const socketPath = join(root, "daemon.sock");
    const state = { ...initialKernelState(), revision: 1, daemon: { phase: "ready" as const } };
    const gateway = new LocalGateway({
      socketPath,
      instanceId: "daemon-backpressure",
      snapshot: () => state,
      handleCommand: async () => ({}),
      idFactory: sequence("server-backpressure"),
    });
    await gateway.start();
    const client = new ProtocolClient({
      socketPath,
      clientId: "slow-client",
      idFactory: sequence("client-backpressure"),
    });
    cleanups.push(async () => {
      await client.close();
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    });

    await client.connect();
    const received: Array<{ seq: number; skipped: number | undefined }> = [];
    client.subscribe((event) => received.push({ seq: event.seq, skipped: event.skipped }));

    // A long run streams far more transient deltas than a paused reader drains,
    // so the daemon must shed them and say how many, instead of silently
    // renumbering the stream and forcing the client to reconnect.
    const chunk = "x".repeat(64_000);
    for (let index = 0; index < 40; index += 1) {
      gateway.publish({
        id: `delta-${index}`,
        ts: "2026-09-07T00:00:00.000Z",
        durable: false,
        type: "message.delta",
        payload: { sessionId: "main", delta: chunk },
      });
    }
    gateway.publish({
      id: "settled",
      ts: "2026-09-07T00:00:01.000Z",
      durable: true,
      type: "run.settled",
      payload: { sessionId: "main" },
    });
    await waitFor(() => received.some((event) => event.seq === 41), 5_000);

    let cursor = 0;
    for (const event of received) {
      assert.equal(event.seq, cursor + 1 + (event.skipped ?? 0), "every delivered event must reconcile against the cursor");
      cursor = event.seq;
    }
    assert.equal(cursor, 41, "the durable tail event is always delivered");
    assert.ok(
      received.some((event) => (event.skipped ?? 0) > 0),
      "the fixture must actually exercise shedding, not just a fast reader",
    );
  });

  test("a command response does not swallow the pending skip count", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-gateway-skip-response-"));
    const socketPath = join(root, "daemon.sock");
    const state = { ...initialKernelState(), revision: 1, daemon: { phase: "ready" as const } };
    const gateway = new LocalGateway({
      socketPath,
      instanceId: "daemon-skip-response",
      snapshot: () => state,
      handleCommand: async () => ({ ok: true }),
      idFactory: sequence("server-skip-response"),
    });
    await gateway.start();
    const client = new ProtocolClient({
      socketPath,
      clientId: "skip-response-client",
      idFactory: sequence("client-skip-response"),
    });
    cleanups.push(async () => {
      await client.close();
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    });

    await client.connect();
    const received: Array<{ seq: number; skipped: number | undefined }> = [];
    client.subscribe((event) => received.push({ seq: event.seq, skipped: event.skipped }));

    const chunk = "y".repeat(64_000);
    for (let index = 0; index < 40; index += 1) {
      gateway.publish({
        id: `delta-${index}`,
        ts: "2026-09-07T00:00:00.000Z",
        durable: false,
        type: "message.delta",
        payload: { sessionId: "main", delta: chunk },
      });
    }
    // A response written between the shed deltas and the next event must not
    // clear the pending count, or the client would see an unexplained jump.
    await client.command("status.get", {});
    gateway.publish({
      id: "settled",
      ts: "2026-09-07T00:00:01.000Z",
      durable: true,
      type: "run.settled",
      payload: { sessionId: "main" },
    });
    await waitFor(() => received.some((event) => event.seq === 41), 5_000);

    let cursor = 0;
    for (const event of received) {
      assert.equal(event.seq, cursor + 1 + (event.skipped ?? 0), "the skip count must survive an interleaved response");
      cursor = event.seq;
    }
    assert.equal(cursor, 41);
    assert.ok(received.some((event) => (event.skipped ?? 0) > 0));
  });

  test("negotiates bounded chunks for snapshots and events larger than one frame", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-gateway-large-"));
    const socketPath = join(root, "daemon.sock");
    const text = randomBytes(12_000).toString("base64");
    const state = {
      ...initialKernelState(),
      revision: 8,
      daemon: { phase: "ready" as const },
      sessions: {
        main: {
          sessionId: "main",
          upstreamSessionId: "upstream-main",
          cwd: root,
          status: "idle" as const,
          thinking: "off" as const,
          messages: [{ role: "assistant", text }],
          queue: { steering: [], followUp: [] },
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, costUsd: 0 },
        },
      },
    };
    const gateway = new LocalGateway({
      socketPath,
      instanceId: "daemon-large",
      snapshot: () => state,
      handleCommand: async () => ({}),
      maxFrameBytes: 1_024,
      maxServerMessageBytes: 64_000,
      idFactory: sequence("server-large"),
    });
    await gateway.start();
    const client = new ProtocolClient({
      socketPath,
      clientId: "large-client",
      maxFrameBytes: 1_024,
      maxServerMessageBytes: 64_000,
      idFactory: sequence("client-large"),
    });
    cleanups.push(async () => {
      await client.close();
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    });

    const hello = await client.connect();
    assert.equal(hello.snapshot.sessions["main"]?.messages[0]?.text, text);
    const received = new Promise<string>((resolve) => {
      client.subscribe((event) => {
        if (event.type === "large.event") resolve(String((event.payload as Record<string, unknown>)["text"]));
      });
    });
    gateway.publish({
      id: "large-event",
      ts: "2026-09-04T00:00:00.000Z",
      durable: true,
      type: "large.event",
      payload: { text },
    });
    assert.equal(await received, text);
  });

  test("bounds oversized snapshots and payloads so a client never has to reject a frame", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-gateway-bounded-"));
    const socketPath = join(root, "daemon.sock");
    // A single huge tool result or pasted message used to travel verbatim. The
    // desktop client rejects such a frame, and because the snapshot carries it
    // on every reconnect, that rejection locked the client out permanently.
    const huge = "x".repeat(MAX_PROTOCOL_STRING_CHARS + 4_096);
    const state = {
      ...initialKernelState(),
      revision: 3,
      daemon: { phase: "ready" as const },
      sessions: {
        main: {
          sessionId: "main",
          upstreamSessionId: "upstream-main",
          cwd: root,
          status: "idle" as const,
          thinking: "off" as const,
          messages: [{ role: "user", text: huge }],
          queue: { steering: [], followUp: [] },
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, costUsd: 0 },
        },
      },
    };
    const gateway = new LocalGateway({
      socketPath,
      instanceId: "daemon-bounded",
      snapshot: () => state,
      handleCommand: async () => ({ result: huge }),
      idFactory: sequence("server-bounded"),
    });
    await gateway.start();
    const client = new ProtocolClient({ socketPath, clientId: "bounded-client", idFactory: sequence("client-bounded") });
    cleanups.push(async () => {
      await client.close();
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    });

    const hello = validateServerHello(await client.connect());
    assert.equal(hello.snapshot.sessions["main"]?.messages[0]?.text.length, MAX_PUBLISHED_STRING_CHARS);

    const events: EventEnvelope[] = [];
    client.subscribe((event) => events.push(event));
    gateway.publish({
      id: "tool-completed",
      ts: "2026-09-07T00:00:00.000Z",
      durable: true,
      type: "tool.completed",
      payload: { sessionId: "main", upstreamSessionId: "upstream-main", toolName: "shell", result: huge },
    });
    await waitFor(() => events.length === 1);
    const validated = validateEventEnvelope(events[0]);
    assert.equal((validated.payload as { result: string }).result.length, MAX_PUBLISHED_STRING_CHARS);

    const response = await client.command<{ result: string }>("status.get", {});
    assert.equal(validateProtocolResult(response).result.length, MAX_PUBLISHED_STRING_CHARS);
  });

  test("caps the retained replay window by size and still recovers a lagging client", async () => {
    const root = await mkdtemp(join(tmpdir(), "pspore-gateway-replay-"));
    const socketPath = join(root, "daemon.sock");
    const state = { ...initialKernelState(), revision: 1, daemon: { phase: "ready" as const } };
    const gateway = new LocalGateway({
      socketPath,
      instanceId: "daemon-replay",
      snapshot: () => state,
      handleCommand: async () => ({}),
      maxReplayBytes: 40_000,
      idFactory: sequence("server-replay"),
    });
    await gateway.start();
    cleanups.push(async () => {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    });

    // Durable events carry session snapshots; counting only events let the
    // window retain hundreds of megabytes of transcripts during a long run.
    for (let index = 0; index < 20; index += 1) {
      gateway.publish({
        id: `snapshot-${index}`,
        ts: "2026-09-07T00:00:00.000Z",
        durable: true,
        type: "session.snapshot",
        payload: { sessionId: "main", text: "z".repeat(10_000) },
      });
    }

    const client = new ProtocolClient({
      socketPath,
      clientId: "lagging-client",
      cursors: { kernel: 1 },
      idFactory: sequence("client-replay"),
    });
    cleanups.push(async () => client.close());
    const replayed: number[] = [];
    client.subscribe((event) => replayed.push(event.seq));
    const hello = await client.connect();

    // The window no longer reaches this client's cursor, so the handshake
    // snapshot is what brings it back rather than an unbounded replay buffer.
    assert.ok(hello.replayFromSeq > 1, "the oldest retained event moved past the lagging cursor");
    assert.equal(hello.latestSeq, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(replayed, []);
  });
});

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
