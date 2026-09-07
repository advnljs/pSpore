import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { DaemonBridge } from "../../src/desktop/daemon-bridge.js";
import { ProtocolClient } from "../../src/protocol/client.js";
import type { EventEnvelope } from "../../src/protocol/schema.js";
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
      "mcp_discover",
      "mcp_call",
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

  test("creates persistent root sessions and restores their full history after daemon restart", async () => {
    const home = await configuredHome();
    const first = await PsporeDaemon.start({
      home,
      runtimeFactory: async (context) => new FakeRuntime(true, context.paths.sessions),
      idFactory: sequence("session-first"),
    });
    const firstClient = new ProtocolClient({ socketPath: first.paths.socket, clientId: "session-first-client" });
    await firstClient.connect();
    const created = await firstClient.command<AgentSnapshot>("session.create", { title: "Persistent research" });
    await firstClient.command("session.prompt", { text: "remember this history", mode: "auto" }, { sessionId: created.sessionId });
    await waitFor(() => first.kernel.snapshot().sessions[created.sessionId]?.messages.at(-1)?.text === "fake reply");
    await firstClient.close();
    await first.stop();

    const second = await PsporeDaemon.start({
      home,
      runtimeFactory: async (context) => new FakeRuntime(true, context.paths.sessions),
      idFactory: sequence("session-second"),
    });
    const secondClient = new ProtocolClient({ socketPath: second.paths.socket, clientId: "session-second-client" });
    cleanups.push(async () => {
      await secondClient.close();
      await second.stop();
      await rm(home, { recursive: true, force: true });
    });
    const hello = await secondClient.connect();
    const restored = hello.snapshot.sessions[created.sessionId];
    assert.equal(restored?.rootSession?.title, "Persistent research");
    assert.deepEqual(restored?.messages.map((message) => message.text), ["remember this history", "fake reply"]);
    assert.equal(restored?.status, "idle");
    assert.match(await readFile(second.paths.sessionCatalog, "utf8"), new RegExp(created.sessionId));
  });

  test("automatically queues a normal send while running and can promote it for direct delivery", async () => {
    const home = await configuredHome();
    const runtime = new FakeRuntime(false);
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => runtime,
      idFactory: sequence("queue-daemon"),
    });
    const client = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "queue-client" });
    cleanups.push(async () => {
      runtime.finishAll();
      await client.close();
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    });
    await client.connect();
    await client.command("session.prompt", { text: "start", mode: "auto" }, { sessionId: "main" });
    await client.command("session.prompt", { text: "queued next", mode: "auto" }, { sessionId: "main" });
    await waitFor(() => daemon.kernel.snapshot().sessions["main"]?.queue.followUp[0] === "queued next");
    await client.command("session.queue.send-now", { index: 0 }, { sessionId: "main" });
    await waitFor(() => daemon.kernel.snapshot().sessions["main"]?.queue.steering[0] === "queued next");
    assert.deepEqual(daemon.kernel.snapshot().sessions["main"]?.queue.followUp, []);
  });

  test("lazily discovers configured MCP schemas through UDS and publishes health", async () => {
    const home = await configuredHome();
    const config = defaultConfig(home);
    config.model = { provider: "fake", model: "fake", thinking: "off" };
    const fixture = fileURLToPath(new URL("../fixtures/fake-mcp-server.ts", import.meta.url));
    config.mcpServers = [{
      id: "fixture",
      enabled: true,
      trust: "trusted-local",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["--import", "tsx", fixture],
        cwd: process.cwd(),
        envRefs: {},
      },
      allowedTools: ["echo"],
      deniedTools: ["mutate"],
      idleTimeoutMs: 60_000,
      requestTimeoutMs: 2_000,
    }];
    await atomicWriteJson(join(home, "config.json"), config);
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => new FakeRuntime(),
      idFactory: sequence("mcp-daemon"),
    });
    const client = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "mcp-client" });
    cleanups.push(async () => {
      await client.close();
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    });
    await client.connect();

    const before = await client.command<Array<{ serverId: string; status: string }>>("mcp.servers", {});
    assert.deepEqual(before.map((server) => [server.serverId, server.status]), [["fixture", "idle"]]);
    const tools = await client.command<Array<{ name: string; normalizedName: string }>>("mcp.discover", {
      serverId: "fixture",
    });
    assert.deepEqual(tools.map((tool) => [tool.name, tool.normalizedName]), [["echo", "mcp__fixture__echo"]]);
    const activated = await client.command<Array<{ normalizedName: string }>>("mcp.tools", {});
    assert.deepEqual(activated.map((tool) => tool.normalizedName), ["mcp__fixture__echo"]);
    await waitFor(() => daemon.kernel.snapshot().mcpServers["fixture"]?.status === "ready");
    assert.equal(daemon.kernel.snapshot().mcpServers["fixture"]?.toolCount, 1);
    assert.equal(daemon.kernel.snapshot().daemon.phase, "ready");
  });

  test("inspects and installs a staged skill through UDS without trusting staged content implicitly", async () => {
    const home = await configuredHome();
    const staged = join(home, "workspace", "staging", "daemon-skill");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "SKILL.md"), [
      "---",
      "name: daemon-skill",
      "description: Exercises explicit resource installation over the local protocol.",
      "---",
      "",
      "# Daemon skill",
      "",
    ].join("\n"));
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => new FakeRuntime(),
      idFactory: sequence("resource-daemon"),
    });
    const client = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "resource-client" });
    cleanups.push(async () => {
      await client.close();
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    });
    const hello = await client.connect();
    assert.deepEqual(hello.snapshot.resources, {});
    assert.deepEqual(await client.command("skills.list", {}), []);

    const inspected = await client.command<{ digest: string; installable: boolean }>("resources.inspect", {
      stagingPath: "daemon-skill",
    });
    assert.equal(inspected.installable, true);
    const installed = await client.command<{ record: { digest: string }; health: { status: string } }>("resources.install", {
      stagingPath: "daemon-skill",
      expectedDigest: inspected.digest,
    });
    assert.equal(installed.record.digest, inspected.digest);
    assert.equal(installed.health.status, "active");
    await waitFor(() => daemon.kernel.snapshot().resources["skill:daemon-skill"]?.status === "active");
    const listed = await client.command<Array<{ record: { name: string } }>>("skills.list", {});
    assert.deepEqual(listed.map((entry) => entry.record.name), ["daemon-skill"]);

    await client.command("resources.disable", {
      kind: "skill",
      name: "daemon-skill",
      expectedDigest: inspected.digest,
    });
    await waitFor(() => daemon.kernel.snapshot().resources["skill:daemon-skill"]?.status === "disabled");
  });

  test("activates an exact trusted host plugin only after config grant and daemon restart", async () => {
    const home = await configuredHome();
    const marker = join(home, "plugin-lifecycle.log");
    const staged = join(home, "workspace", "staging", "daemon-plugin");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "pspore.plugin.json"), `${JSON.stringify({
      apiVersion: 1,
      name: "daemon-plugin",
      version: "1.0.0",
      entry: "index.mjs",
      capabilities: ["diagnostic.write"],
      contributes: [],
    }, null, 2)}\n`);
    await writeFile(join(staged, "index.mjs"), [
      'import { appendFile } from "node:fs/promises";',
      `const marker = ${JSON.stringify(marker)};`,
      "export default {",
      "  async start(context) { await appendFile(marker, `start:${context.digest}\\n`); },",
      "  health() { return { status: 'ready' }; },",
      "  async stop(reason) { await appendFile(marker, `stop:${reason}\\n`); },",
      "};",
      "",
    ].join("\n"));

    const first = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => new FakeRuntime(),
      idFactory: sequence("plugin-install-daemon"),
    });
    const firstClient = new ProtocolClient({ socketPath: first.paths.socket, clientId: "plugin-install-client" });
    let second: PsporeDaemon | undefined;
    let secondClient: ProtocolClient | undefined;
    cleanups.push(async () => {
      await firstClient.close();
      await first.stop();
      await secondClient?.close();
      await second?.stop();
      await rm(home, { recursive: true, force: true });
    });
    await firstClient.connect();
    const inspection = await firstClient.command<{ digest: string }>("resources.inspect", { stagingPath: "daemon-plugin" });
    await firstClient.command("resources.install", {
      stagingPath: "daemon-plugin",
      expectedDigest: inspection.digest,
    });
    await assert.rejects(access(marker));
    await firstClient.close();
    await first.stop();

    const config = defaultConfig(home);
    config.model = { provider: "fake", model: "fake", thinking: "off" };
    config.plugins = [{
      name: "daemon-plugin",
      enabled: true,
      digest: inspection.digest,
      grantedCapabilities: ["diagnostic.write"],
    }];
    await atomicWriteJson(join(home, "config.json"), config);
    second = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => new FakeRuntime(),
      idFactory: sequence("plugin-active-daemon"),
    });
    secondClient = new ProtocolClient({ socketPath: second.paths.socket, clientId: "plugin-active-client" });
    const hello = await secondClient.connect();
    assert.equal(hello.snapshot.daemon.phase, "ready");
    assert.equal(hello.snapshot.resources["host-plugin:daemon-plugin"]?.status, "ready");
    const plugins = await secondClient.command<Array<{ health: { status: string } }>>("plugins.list", {});
    assert.deepEqual(plugins.map((entry) => entry.health.status), ["ready"]);
    assert.match(await readFile(marker, "utf8"), new RegExp(`start:${inspection.digest}`));
    await secondClient.close();
    await second.stop();
    assert.match(await readFile(marker, "utf8"), /stop:daemon shutdown/);
  });

  test("stays reachable for the desktop client when a session holds an oversized message", async () => {
    const home = await configuredHome();
    const runtime = new FakeRuntime();
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => runtime,
      idFactory: sequence("oversized-daemon"),
    });
    const seed = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "oversized-seed" });
    await seed.connect();
    await seed.command<Accepted>("session.prompt", { text: "read the log", mode: "prompt" }, { sessionId: "main" });
    await seed.close();
    // A long tool result or a big model answer used to travel verbatim into the
    // authoritative snapshot. The desktop client rejected the frame, and since
    // the snapshot arrives on every reconnect, restarting never recovered it.
    runtime.seedMessage("main", "assistant", "x".repeat(300_000));

    const bridge = new DaemonBridge({
      socketPath: daemon.paths.socket,
      stagingRoot: join(home, "workspace", "staging"),
      versions: { pspore: "0.1.17", pi: "0.84.1", electron: "43.3.0", node: process.versions.node },
      reconnectDelay: () => 20,
    });
    cleanups.push(async () => {
      await bridge.stop();
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    });
    bridge.start();
    await waitFor(() => bridge.bootstrap().connection.phase === "connected", 5_000);

    const client = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "oversized-client" });
    cleanups.push(async () => client.close());
    const events: EventEnvelope[] = [];
    client.subscribe((event) => events.push(event));
    await client.connect();
    runtime.emit("main", "message.completed", false, { role: "assistant", text: "done" });
    await waitFor(() => events.some((event) => event.type === "message.completed"), 5_000);
    await waitFor(() => bridge.bootstrap().connection.phase === "connected", 5_000);
    assert.equal(bridge.bootstrap().connection.phase, "connected");
    assert.equal(bridge.bootstrap().connection.attempt, 0);
  });

  test("keeps streaming cheap by attaching the session only where clients need it", async () => {
    const home = await configuredHome();
    const runtime = new FakeRuntime();
    const daemon = await PsporeDaemon.start({
      home,
      runtimeFactory: async () => runtime,
      idFactory: sequence("stream-daemon"),
    });
    const client = new ProtocolClient({ socketPath: daemon.paths.socket, clientId: "stream-client" });
    cleanups.push(async () => {
      await client.close();
      await daemon.stop();
      await rm(home, { recursive: true, force: true });
    });
    await client.connect();
    const events: EventEnvelope[] = [];
    client.subscribe((event) => events.push(event));

    await client.command<Accepted>("session.prompt", { text: "hello", mode: "prompt" }, { sessionId: "main" });
    await waitFor(() => events.some((event) => event.type === "run.settled"));

    // A transcript rebuilt and shipped for every streamed token is what made a
    // long run stall the daemon and drop its clients.
    runtime.emit("main", "message.delta", true, { delta: "chunk" });
    runtime.emit("main", "tool.started", false, { toolName: "shell" });
    runtime.emit("main", "tool.completed", false, { toolName: "shell" });
    await waitFor(() => events.filter((event) => event.type === "tool.completed").length === 1);
    // Once the window has passed, the next tool event refreshes clients again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    runtime.emit("main", "tool.started", false, { toolName: "shell" });
    await waitFor(() => events.filter((event) => event.type === "tool.started").length === 2);

    const payload = (type: string): Record<string, unknown> =>
      events.find((event) => event.type === type)?.payload as Record<string, unknown>;
    assert.equal(payload("message.delta")["session"], undefined);
    assert.equal(payload("message.delta")["revision"], undefined);
    assert.ok(payload("message.completed")["session"], "a settled message must carry the authoritative session");
    assert.ok(payload("run.settled")["session"], "a settled run must carry the authoritative session");
    // The settled run published the transcript microseconds earlier, so the
    // tool events that follow it add nothing a client needs a full copy for.
    assert.equal(payload("tool.started")["session"], undefined, "the coalescing window suppresses a redundant copy");
    assert.equal(payload("tool.completed")["session"], undefined, "the coalescing window suppresses a redundant copy");
    const refreshed = events.filter((event) => event.type === "tool.started").at(-1)?.payload as Record<string, unknown>;
    assert.ok(refreshed["session"], "a tool event past the window carries the session again");
    // State stays authoritative even where the broadcast omits the snapshot.
    assert.equal(daemon.kernel.snapshot().sessions["main"]?.messages.at(-1)?.text, "fake reply");
  });
});

class FakeRuntime implements AgentRuntimePort {
  promptCalls = 0;
  readonly #listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  readonly #snapshots = new Map<string, AgentSnapshot>();
  readonly #autoSettle: boolean;
  readonly #persistenceRoot: string | undefined;
  readonly #files = new Map<string, string>();
  readonly #settlers: Array<{ sessionId: string; settle: () => void }> = [];
  readonly #idle = new Map<string, Promise<void>>();
  readonly #resolveIdle = new Map<string, () => void>();

  constructor(autoSettle = true, persistenceRoot?: string) {
    this.#autoSettle = autoSettle;
    this.#persistenceRoot = persistenceRoot;
  }

  async create(spec: AgentSessionSpec): Promise<AgentHandle> {
    let snapshot = baseSnapshot(spec);
    let sessionFile: string | undefined;
    if (this.#persistenceRoot) {
      const directory = join(this.#persistenceRoot, spec.workspaceId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      sessionFile = join(directory, `${spec.sessionId.replace(/[^A-Za-z0-9._-]/g, "-")}.jsonl`);
      snapshot = { ...snapshot, sessionFile };
      this.#files.set(spec.sessionId, sessionFile);
      await writeFile(sessionFile, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    }
    this.#snapshots.set(spec.sessionId, snapshot);
    return {
      sessionId: spec.sessionId,
      upstreamSessionId: `fake-${spec.sessionId}`,
      ...(sessionFile === undefined ? {} : { sessionFile }),
    };
  }

  async resume(spec: ResumeSessionSpec): Promise<AgentHandle> {
    const stored = JSON.parse((await readFile(spec.sessionFile, "utf8")).trim()) as AgentSnapshot;
    const snapshot = {
      ...stored,
      sessionId: spec.sessionId,
      upstreamSessionId: `fake-${spec.sessionId}`,
      cwd: spec.cwd,
      status: "idle" as const,
      sessionFile: spec.sessionFile,
    };
    this.#snapshots.set(spec.sessionId, snapshot);
    this.#files.set(spec.sessionId, spec.sessionFile);
    return { sessionId: spec.sessionId, upstreamSessionId: snapshot.upstreamSessionId, sessionFile: spec.sessionFile };
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
    this.#snapshots.set(sessionId, {
      ...current,
      queue: { ...current.queue, followUp: [...current.queue.followUp, input] },
    });
    this.#emit(sessionId, "queue.updated", false);
    return { accepted: true, commandId: "fake-follow", acceptedAt: new Date(0).toISOString() };
  }

  async promoteFollowUp(sessionId: string, index: number): Promise<Accepted> {
    const current = this.required(sessionId);
    const message = current.queue.followUp[index];
    if (message === undefined) throw new Error(`Follow-up queue index is out of range: ${index}`);
    this.#snapshots.set(sessionId, {
      ...current,
      queue: {
        steering: [...current.queue.steering, message],
        followUp: current.queue.followUp.filter((_value, queuedIndex) => queuedIndex !== index),
      },
    });
    this.#emit(sessionId, "queue.updated", false);
    return { accepted: true, commandId: "fake-promote", acceptedAt: new Date(0).toISOString() };
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
    const snapshot = this.#snapshots.get(sessionId);
    const file = this.#files.get(sessionId);
    if (snapshot && file) await writeFile(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    this.#snapshots.delete(sessionId);
    this.#listeners.delete(sessionId);
    this.#idle.delete(sessionId);
    this.#resolveIdle.delete(sessionId);
    this.#files.delete(sessionId);
  }

  finishAll(): void {
    for (const pending of this.#settlers.splice(0)) pending.settle();
  }

  seedMessage(sessionId: string, role: string, text: string): void {
    const current = this.required(sessionId);
    this.#snapshots.set(sessionId, { ...current, messages: [...current.messages, { role, text }] });
  }

  emit(sessionId: string, type: RuntimeEvent["type"], transient: boolean, payload: Record<string, unknown> = {}): void {
    const event: RuntimeEvent = {
      id: `runtime-${type}-${Math.random()}`,
      sessionId,
      upstreamSessionId: `fake-${sessionId}`,
      type,
      ts: new Date().toISOString(),
      transient,
      payload,
    };
    for (const listener of this.#listeners.get(sessionId) ?? []) listener(event);
  }

  #emit(sessionId: string, type: RuntimeEvent["type"], transient: boolean): void {
    this.emit(sessionId, type, transient);
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
