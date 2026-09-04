import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { LocalGateway } from "../../src/gateway/local-gateway.js";
import { initialKernelState } from "../../src/kernel/state.js";
import { ProtocolClient } from "../../src/protocol/client.js";

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
          entries: [],
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
