import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import type { JobDefinition, RunRecord } from "../../src/automation/types.js";
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
    let toolNames: string[] = [];
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async (context) => {
        toolNames = context.tools.map((tool) => tool.name);
        return runtime;
      },
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
    assert.deepEqual(toolNames, [
      "read",
      "edit",
      "search",
      "shell",
      "memory_append",
      "memory_curate",
      "notify",
      "schedule",
    ]);
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

  test("runs a persisted command job through UDS and exposes its durable run state", async () => {
    const home = await configuredHome();
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => new FakeRuntime(),
      idFactory: sequence("job-daemon"),
    });
    const client = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "job-client" });
    cleanups.push(async () => {
      await client.close();
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    });
    await client.connect();
    const created = await client.command<JobDefinition>("job.put", {
      job: jobFile("command-job"),
      expectedSha256: null,
    });
    assert.match(created.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
    await assert.rejects(
      client.command("job.put", { job: jobFile("command-job"), expectedSha256: null }),
      /update conflict/,
    );
    const jobs = await client.command<JobDefinition[]>("jobs.list", {});
    assert.deepEqual(jobs.map((job) => job.id), ["command-job"]);
    const run = await client.command<RunRecord>("job.run", { jobId: "command-job" });
    assert.equal(run.status, "succeeded");
    const runs = await client.command<RunRecord[]>("runs.list", {});
    assert.equal(runs.at(-1)?.id, run.id);
    assert.equal(daemon.kernel.snapshot().runs[run.id]?.status, "succeeded");
    const artifactDirectories = (await readdir(daemon.paths.artifacts, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && entry.name !== "recovery",
    );
    assert.equal(artifactDirectories.length, 1);
    assert.match(
      await readFile(join(daemon.paths.artifacts, artifactDirectories[0]?.name ?? "missing", "output.log"), "utf8"),
      /scheduled-ok/,
    );
  });

  test("publishes ready before a BOOT agent run settles", async () => {
    const home = await configuredHome();
    const config = defaultConfig(home);
    config.model = { provider: "fake", model: "fake", thinking: "off" };
    config.boot.enabled = true;
    await atomicWriteJson(join(home, "config.json"), config);
    await writeFile(join(home, "workspace", "BOOT.md"), "# Startup\n\nCheck the local workspace once.\n", { mode: 0o600 });
    const runtime = new FakeRuntime(false);
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => runtime,
      idFactory: sequence("boot-daemon"),
    });
    const client = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "boot-client" });
    cleanups.push(async () => {
      runtime.finishAll();
      await client.close();
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    });
    const hello = await client.connect();
    assert.equal(hello.snapshot.daemon.phase, "ready");
    await waitFor(() => Object.values(daemon.kernel.snapshot().runs).some((run) => run.source === "boot" && run.status === "running"));
    assert.equal(daemon.kernel.snapshot().daemon.phase, "ready");
    runtime.finishAll();
    await waitFor(() => Object.values(daemon.kernel.snapshot().runs).some((run) => run.source === "boot" && run.status === "succeeded"));
    assert.equal(Object.keys(daemon.kernel.snapshot().sessions).some((sessionId) => sessionId.startsWith("run:")), false);
    await waitFor(() => daemon.kernel.snapshot().notifications.length > 0);
    assert.match(daemon.kernel.snapshot().notifications.at(-1)?.title ?? "", /Run boot: succeeded/);
  });
});

class FakeRuntime implements AgentRuntimePort {
  promptCalls = 0;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  #snapshot: AgentSnapshot | undefined;
  readonly #autoSettle: boolean;
  readonly #settlers: Array<() => void> = [];
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle: (() => void) | undefined;

  constructor(autoSettle = true) {
    this.#autoSettle = autoSettle;
  }

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
    this.#idle = new Promise<void>((resolve) => {
      this.#resolveIdle = resolve;
    });
    this.#snapshot = { ...current, status: "running", messages: [...current.messages, { role: "user", text: input }] };
    this.#emit(sessionId, "run.started", true);
    const settle = () => {
      const running = this.required();
      this.#snapshot = {
        ...running,
        status: "idle",
        messages: [...running.messages, { role: "assistant", text: "fake reply" }],
      };
      this.#emit(sessionId, "message.completed", false);
      this.#emit(sessionId, "run.settled", false);
      this.#resolveIdle?.();
      this.#resolveIdle = undefined;
    };
    if (this.#autoSettle) setImmediate(settle);
    else this.#settlers.push(settle);
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
  async waitForIdle(): Promise<void> {
    await this.#idle;
  }
  async dispose(): Promise<void> {}

  finishAll(): void {
    for (const settle of this.#settlers.splice(0)) settle();
  }

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

async function configuredHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pspore-daemon-automation-"));
  await initializePsporeHome(home);
  const config = defaultConfig(home);
  config.model = { provider: "fake", model: "fake", thinking: "off" };
  await atomicWriteJson(join(home, "config.json"), config);
  return home;
}

function jobFile(id: string): Record<string, unknown> {
  return {
    version: 1,
    id,
    enabled: true,
    schedule: { cron: "0 0 1 1 *", timezone: "UTC" },
    cwd: ".",
    policyRef: "default",
    concurrency: "forbid",
    misfire: "skip",
    timeoutMs: 2_000,
    budget: {
      maxTurns: 1,
      maxToolCalls: 1,
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxChildren: 0,
    },
    delivery: { kind: "none" },
    kind: "command",
    payload: { command: "printf scheduled-ok" },
  };
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
