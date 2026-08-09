import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { defaultConfig } from "../../src/config/config.js";
import { PsporeDaemon } from "../../src/daemon/daemon.js";
import type {
  Accepted,
  AgentHandle,
  AgentRuntimePort,
  AgentSessionSpec,
  AgentSnapshot,
  ResumeSessionSpec,
  RuntimeEvent,
} from "../../src/domain/runtime.js";
import { ProtocolClient } from "../../src/protocol/client.js";
import { atomicWriteJson } from "../../src/storage/atomic.js";
import { initializePsporeHome } from "../../src/storage/home.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup())));

describe("daemon vertical slice", () => {
  test("becomes ready before a session, serves a prompt over UDS, and shuts down cleanly", async () => {
    const home = await mkdtemp(join(tmpdir(), "pspore-daemon-"));
    await initializePsporeHome(home);
    const config = defaultConfig(home);
    config.model = { provider: "fake", model: "fake", thinking: "off" };
    await atomicWriteJson(join(home, "config.json"), config);
    const runtime = new FakeRuntime();
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => runtime,
      idFactory: sequence("daemon"),
    });
    const client = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "test-tui", idFactory: sequence("client") });
    cleanups.push(async () => {
      await client.close();
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    });

    const hello = await client.connect();
    assert.equal(hello.snapshot.daemon.phase, "ready");
    assert.equal(Object.keys(hello.snapshot.sessions).length, 0);
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));
    const accepted = await client.command<Accepted>("session.prompt", { text: "hello", mode: "prompt" }, {
      id: "prompt-once",
      sessionId: "main",
    });
    assert.equal(accepted.accepted, true);
    const duplicate = await client.command<Accepted>("session.prompt", { text: "hello", mode: "prompt" }, {
      id: "prompt-once",
      sessionId: "main",
    });
    assert.deepEqual(duplicate, accepted);
    assert.equal(runtime.promptCalls, 1);
    await waitFor(() => events.includes("run.settled"));
    const status = await client.command<{ sessions: Record<string, AgentSnapshot> }>("status.get", {});
    assert.equal(status.sessions["main"]?.messages.at(-1)?.text, "fake reply");

    await client.close();
    await daemon.stop();
    assert.equal(daemon.kernel.snapshot().daemon.phase, "stopped");
    await assert.rejects(access(daemon.paths.socket));
    await assert.rejects(access(daemon.paths.endpoint));
    await assert.rejects(access(daemon.paths.lock));
    assert.match(await readFile(join(home, "config.json"), "utf8"), /"fake"/);
  });
});

class FakeRuntime implements AgentRuntimePort {
  promptCalls = 0;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  #snapshot: AgentSnapshot | undefined;

  async create(spec: AgentSessionSpec): Promise<AgentHandle> {
    this.#snapshot = baseSnapshot(spec);
    return { sessionId: spec.sessionId, upstreamSessionId: `fake-${spec.sessionId}` };
  }

  async resume(spec: ResumeSessionSpec): Promise<AgentHandle> {
    return this.create(spec);
  }

  async prompt(sessionId: string, input: string): Promise<Accepted> {
    this.promptCalls += 1;
    const current = this.required();
    this.#snapshot = { ...current, status: "running", messages: [...current.messages, { role: "user", text: input }] };
    this.#emit(sessionId, "run.started", true);
    setImmediate(() => {
      const running = this.required();
      this.#snapshot = {
        ...running,
        status: "idle",
        messages: [...running.messages, { role: "assistant", text: "fake reply" }],
      };
      this.#emit(sessionId, "message.completed", false);
      this.#emit(sessionId, "run.settled", false);
    });
    return { accepted: true, commandId: "fake-command", acceptedAt: new Date(0).toISOString() };
  }

  async steer(sessionId: string, input: string): Promise<Accepted> {
    return this.prompt(sessionId, input);
  }

  async followUp(sessionId: string, input: string): Promise<Accepted> {
    return this.prompt(sessionId, input);
  }

  async abort(): Promise<void> {}
  async compact(): Promise<void> {}
  snapshot(): AgentSnapshot {
    return structuredClone(this.required());
  }
  subscribe(_sessionId: string, sink: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(sink);
    return () => this.#listeners.delete(sink);
  }
  async waitForIdle(): Promise<void> {}
  async dispose(): Promise<void> {}

  #emit(sessionId: string, type: RuntimeEvent["type"], transient: boolean): void {
    const event: RuntimeEvent = {
      id: `runtime-${type}-${Math.random()}`,
      sessionId,
      upstreamSessionId: `fake-${sessionId}`,
      type,
      ts: new Date().toISOString(),
      transient,
      payload: {},
    };
    for (const listener of this.#listeners) listener(event);
  }

  required(): AgentSnapshot {
    if (!this.#snapshot) throw new Error("Fake session was not created");
    return this.#snapshot;
  }
}

function baseSnapshot(spec: AgentSessionSpec): AgentSnapshot {
  return {
    sessionId: spec.sessionId,
    upstreamSessionId: `fake-${spec.sessionId}`,
    cwd: spec.cwd,
    status: "idle",
    thinking: "off",
    messages: [],
    entries: [],
    queue: { steering: [], followUp: [] },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 },
  };
}

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
