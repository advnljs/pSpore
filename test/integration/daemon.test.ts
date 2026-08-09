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
      "agent_spawn",
      "agent_send",
      "agent_join",
      "agent_cancel",
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

  test("routes two concurrent child agents and user steering through UDS", async () => {
    const home = await configuredHome();
    const runtime = new FakeRuntime(false);
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => runtime,
      idFactory: sequence("agent-daemon"),
    });
    const client = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "agent-client" });
    cleanups.push(async () => {
      runtime.finishAll();
      await client.close();
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    });
    await client.connect();

    await client.command("session.prompt", { text: "coordinate children", mode: "prompt" }, { sessionId: "main" });
    runtime.finishAll();
    await waitFor(() => runtime.required("main").status === "idle");

    const budget = {
      maxTurns: 2,
      maxToolCalls: 4,
      maxInputTokens: 1_000,
      maxOutputTokens: 500,
      maxChildren: 0,
    };
    const first = await client.command<{ id: string; sessionId: string }>("agent.spawn", {
      parentId: "main",
      objective: "inspect alpha",
      cwd: daemon.paths.workspace,
      workspaceMode: "shared-read",
      budget,
    });
    const second = await client.command<{ id: string; sessionId: string }>("agent.spawn", {
      parentId: "main",
      objective: "inspect beta",
      cwd: daemon.paths.workspace,
      workspaceMode: "shared-read",
      budget,
    });
    await waitFor(() => [first.id, second.id].every((id) => daemon.kernel.snapshot().agents[id]?.status === "running"));

    await client.command("agent.send", {
      agentId: first.id,
      message: "focus on the public API",
      mode: "steer",
    });
    assert.match(runtime.required(first.sessionId).messages.at(-1)?.text ?? "", /steer:focus on the public API/);

    runtime.finishAll();
    const joined = await client.command<Array<{ id: string; status: string; result?: { summary: string } }>>("agent.join", {
      agentIds: [first.id, second.id],
      timeoutMs: 1_000,
    });
    assert.deepEqual(joined.map((agent) => agent.status), ["succeeded", "succeeded"]);
    assert.ok(joined.every((agent) => agent.result?.summary === "fake reply"));
    await waitFor(() => daemon.kernel.snapshot().agentMessages.filter((message) => message.recipientId === "main").length === 2);
    await waitFor(() => runtime.required("main").messages.some((message) => message.text.includes('"status":"succeeded"')));
    runtime.finishAll();
    await waitFor(() => [first.sessionId, second.sessionId].every((id) => daemon.kernel.snapshot().sessions[id] === undefined));
  });
});

class FakeRuntime implements AgentRuntimePort {
  promptCalls = 0;
  readonly #listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  readonly #snapshots = new Map<string, AgentSnapshot>();
  readonly #autoSettle: boolean;
  readonly #settlers: Array<{ sessionId: string; settle: () => void }> = [];
  readonly #idle = new Map<string, Promise<void>>();
  readonly #resolveIdle = new Map<string, () => void>();

  constructor(autoSettle = true) {
    this.#autoSettle = autoSettle;
  }

  async create(spec: AgentSessionSpec): Promise<AgentHandle> {
    this.#snapshots.set(spec.sessionId, baseSnapshot(spec));
    return { sessionId: spec.sessionId, upstreamSessionId: `fake-${spec.sessionId}` };
  }

  async resume(spec: ResumeSessionSpec): Promise<AgentHandle> {
    return this.create(spec);
  }

  async prompt(sessionId: string, input: string): Promise<Accepted> {
    this.promptCalls += 1;
    const current = this.required(sessionId);
    this.#idle.set(sessionId, new Promise<void>((resolve) => {
      this.#resolveIdle.set(sessionId, resolve);
    }));
    this.#snapshots.set(sessionId, { ...current, status: "running", messages: [...current.messages, { role: "user", text: input }] });
    this.#emit(sessionId, "run.started", true);
    const settle = () => {
      const running = this.required(sessionId);
      this.#snapshots.set(sessionId, {
        ...running,
        status: "idle",
        messages: [...running.messages, { role: "assistant", text: "fake reply" }],
      });
      this.#emit(sessionId, "message.completed", false);
      this.#emit(sessionId, "run.settled", false);
      this.#resolveIdle.get(sessionId)?.();
      this.#resolveIdle.delete(sessionId);
    };
    if (this.#autoSettle) setImmediate(settle);
    else this.#settlers.push({ sessionId, settle });
    return { accepted: true, commandId: "fake-command", acceptedAt: new Date(0).toISOString() };
  }

  async steer(sessionId: string, input: string): Promise<Accepted> {
    const current = this.required(sessionId);
    this.#snapshots.set(sessionId, { ...current, messages: [...current.messages, { role: "user", text: `steer:${input}` }] });
    return { accepted: true, commandId: "fake-steer", acceptedAt: new Date(0).toISOString() };
  }

  async followUp(sessionId: string, input: string): Promise<Accepted> {
    const current = this.required(sessionId);
    this.#snapshots.set(sessionId, { ...current, messages: [...current.messages, { role: "user", text: `follow:${input}` }] });
    return { accepted: true, commandId: "fake-follow", acceptedAt: new Date(0).toISOString() };
  }

  async abort(sessionId: string): Promise<void> {
    const current = this.#snapshots.get(sessionId);
    if (current) this.#snapshots.set(sessionId, { ...current, status: "idle" });
    this.#resolveIdle.get(sessionId)?.();
    this.#resolveIdle.delete(sessionId);
  }
  async compact(): Promise<void> {}
  snapshot(sessionId: string): AgentSnapshot {
    return structuredClone(this.required(sessionId));
  }
  subscribe(sessionId: string, sink: (event: RuntimeEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(sink);
    this.#listeners.set(sessionId, listeners);
    return () => listeners.delete(sink);
  }
  async waitForIdle(sessionId: string): Promise<void> {
    await this.#idle.get(sessionId);
  }
  async dispose(sessionId: string): Promise<void> {
    this.#snapshots.delete(sessionId);
    this.#listeners.delete(sessionId);
    this.#idle.delete(sessionId);
    this.#resolveIdle.delete(sessionId);
  }

  finishAll(): void {
    for (const pending of this.#settlers.splice(0)) pending.settle();
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
    for (const listener of this.#listeners.get(sessionId) ?? []) listener(event);
  }

  required(sessionId: string): AgentSnapshot {
    const snapshot = this.#snapshots.get(sessionId);
    if (!snapshot) throw new Error(`Fake session was not created: ${sessionId}`);
    return snapshot;
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
