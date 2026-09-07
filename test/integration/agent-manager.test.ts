import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { AgentManager, type AgentSessionHost } from "../../src/agents/agent-manager.js";
import type { AgentMessageMode } from "../../src/agents/types.js";
import type { AgentSessionSpec, AgentSnapshot, RuntimeEvent } from "../../src/domain/runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe("subagent tree and duplex mailbox", () => {
  test("runs two children concurrently, steers one, and returns bounded structured results", async () => {
    const root = await workspace();
    const host = new FakeHost();
    host.addRoot("main");
    const agents = await AgentManager.create({
      workspaceRoot: root,
      host,
      maxConcurrentAgents: 2,
      idFactory: sequence("agent"),
      clock: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const first = await agents.spawn(task("main", root, "inspect alpha"));
    const second = await agents.spawn(task("main", root, "inspect beta"));
    await host.waitForStarts(2);
    assert.deepEqual(new Set(host.started), new Set([first.sessionId, second.sessionId]));
    assert.ok(host.authorizations.get(first.sessionId)?.deniedCapabilities?.includes("fs.write"));
    assert.deepEqual(host.authorizations.get(first.sessionId)?.agentPath, ["main", first.id]);

    const message = await agents.send({
      senderId: "user",
      recipientId: first.id,
      text: "focus on the public API",
      mode: "steer",
      priority: "high",
    });
    assert.equal(message.sequence, 1);
    assert.deepEqual(host.sent.at(-1), {
      sessionId: first.sessionId,
      text: "focus on the public API",
      mode: "steer",
    });

    host.finish(first.sessionId, "alpha result");
    host.finish(second.sessionId, "beta result");
    const joined = await agents.join([first.id, second.id], 1_000);
    assert.deepEqual(joined.map((agent) => agent.status), ["succeeded", "succeeded"]);
    assert.deepEqual(joined.map((agent) => agent.result?.summary), ["alpha result", "beta result"]);
    await waitFor(() => host.sent.filter((entry) => entry.sessionId === "main").length >= 2);
    assert.equal(host.sent.filter((entry) => entry.sessionId === "main").length, 2);
    assert.equal(agents.listMessages().filter((entry) => entry.recipientId === "main").length, 2);
    await agents.stop();
  });

  test("rejects budget/depth escalation and cascades parent cancellation", async () => {
    const root = await workspace();
    const host = new FakeHost();
    host.addRoot("main");
    const agents = await AgentManager.create({
      workspaceRoot: root,
      host,
      maxConcurrentAgents: 3,
      maxDepth: 2,
      idFactory: sequence("tree"),
    });
    const parent = await agents.spawn({
      ...task("main", root, "parent"),
      workspaceMode: "shared-write",
      budget: { maxTurns: 4, maxToolCalls: 8, maxInputTokens: 2_000, maxOutputTokens: 1_000, maxChildren: 1 },
    });
    await host.waitForStarts(1);
    await assert.rejects(
      agents.spawn({
        ...task(parent.id, root, "too large"),
        budget: { maxTurns: 5, maxToolCalls: 4, maxInputTokens: 1_000, maxOutputTokens: 500, maxChildren: 0 },
      }),
      /exceeds parent/,
    );
    const child = await agents.spawn({
      ...task(parent.id, root, "nested"),
      budget: { maxTurns: 2, maxToolCalls: 4, maxInputTokens: 1_000, maxOutputTokens: 500, maxChildren: 0 },
    });
    await host.waitForStarts(2);
    await assert.rejects(agents.spawn(task(child.id, root, "too deep")), /depth 3 exceeds/);
    const cancelled = await agents.cancel(parent.id, "stop the tree");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(agents.list().find((agent) => agent.id === child.id)?.status, "cancelled");
    await agents.stop();
  });
});

class FakeHost implements AgentSessionHost {
  readonly started: string[] = [];
  readonly sent: Array<{ sessionId: string; text: string; mode: AgentMessageMode }> = [];
  readonly authorizations = new Map<string, NonNullable<AgentSessionSpec["authorization"]>>();
  readonly #snapshots = new Map<string, AgentSnapshot>();
  readonly #listeners = new Map<string, Set<(event: RuntimeEvent) => void>>();
  readonly #idle = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  addRoot(sessionId: string): void {
    this.#snapshots.set(sessionId, snapshot(sessionId, "/workspace"));
  }

  async createAgentSession(
    sessionId: string,
    cwd: string,
    authorization: NonNullable<AgentSessionSpec["authorization"]>,
  ): Promise<void> {
    this.#snapshots.set(sessionId, snapshot(sessionId, cwd));
    this.authorizations.set(sessionId, structuredClone(authorization));
  }

  hasAgentSession(sessionId: string): boolean {
    return this.#snapshots.has(sessionId);
  }

  async startAgentPrompt(sessionId: string, text: string): Promise<void> {
    const current = this.required(sessionId);
    const idle = deferredVoid();
    this.#idle.set(sessionId, idle);
    this.#snapshots.set(sessionId, {
      ...current,
      status: "running",
      messages: [...current.messages, { role: "user", text }],
    });
    this.started.push(sessionId);
    this.emit(sessionId, "run.started");
  }

  async sendAgentMessage(sessionId: string, text: string, mode: AgentMessageMode): Promise<void> {
    this.sent.push({ sessionId, text, mode });
  }

  async waitForAgentIdle(sessionId: string): Promise<void> {
    await this.#idle.get(sessionId)?.promise;
  }

  async abortAgentSession(sessionId: string): Promise<void> {
    const current = this.#snapshots.get(sessionId);
    if (current) this.#snapshots.set(sessionId, { ...current, status: "idle" });
    this.#idle.get(sessionId)?.resolve();
  }

  snapshotAgentSession(sessionId: string): AgentSnapshot {
    return structuredClone(this.required(sessionId));
  }

  subscribeAgentSession(sessionId: string, sink: (event: RuntimeEvent) => void): () => void {
    const listeners = this.#listeners.get(sessionId) ?? new Set();
    listeners.add(sink);
    this.#listeners.set(sessionId, listeners);
    return () => listeners.delete(sink);
  }

  async closeAgentSession(sessionId: string): Promise<void> {
    this.#snapshots.delete(sessionId);
    this.#listeners.delete(sessionId);
    this.#idle.delete(sessionId);
  }

  finish(sessionId: string, summary: string): void {
    const current = this.required(sessionId);
    this.#snapshots.set(sessionId, {
      ...current,
      status: "idle",
      messages: [...current.messages, { role: "assistant", text: summary }],
    });
    this.emit(sessionId, "run.settled");
    this.#idle.get(sessionId)?.resolve();
  }

  async waitForStarts(count: number): Promise<void> {
    await waitFor(() => this.started.length >= count);
  }

  private emit(sessionId: string, type: RuntimeEvent["type"]): void {
    const event: RuntimeEvent = {
      id: `${sessionId}-${type}`,
      sessionId,
      upstreamSessionId: `fake-${sessionId}`,
      type,
      ts: "2026-08-10T00:00:00.000Z",
      transient: false,
      payload: {},
    };
    for (const listener of this.#listeners.get(sessionId) ?? []) listener(event);
  }

  private required(sessionId: string): AgentSnapshot {
    const value = this.#snapshots.get(sessionId);
    if (!value) throw new Error(`Missing fake session: ${sessionId}`);
    return value;
  }
}

function task(parentId: string, cwd: string, objective: string) {
  return {
    parentId,
    cwd,
    objective,
    workspaceMode: "shared-read" as const,
    budget: { maxTurns: 2, maxToolCalls: 4, maxInputTokens: 1_000, maxOutputTokens: 500, maxChildren: 0 },
  };
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pspore-agent-manager-"));
  roots.push(root);
  return root;
}

function snapshot(sessionId: string, cwd: string): AgentSnapshot {
  return {
    sessionId,
    upstreamSessionId: `fake-${sessionId}`,
    cwd,
    status: "idle",
    thinking: "off",
    messages: [],
    messageCount: 0,
    queue: { steering: [], followUp: [] },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 },
  };
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
