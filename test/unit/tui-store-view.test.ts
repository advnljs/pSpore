import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import type { AgentSnapshot } from "../../src/domain/runtime.js";
import { initialKernelState } from "../../src/kernel/state.js";
import type { ServerHelloFrame } from "../../src/protocol/schema.js";
import { conversationIntent } from "../../src/ui/shared/presentation.js";
import { TUI_HELP_LINES } from "../../src/ui/tui/commands.js";
import { TuiStore } from "../../src/ui/tui/store.js";
import {
  acceptsModelSetupOffer,
  MODEL_SETUP_OFFER_LINES,
  MODEL_SETUP_OFFER_PROMPT,
} from "../../src/ui/tui/tui-app.js";
import { maskSecretInput, renderTuiSnapshot } from "../../src/ui/tui/view.js";

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

  test("routes selected child input to agent.send semantics instead of main", () => {
    const kernel = hello().snapshot;
    assert.deepEqual(conversationIntent(kernel, "agent:child-1", "continue", "prompt"), {
      target: "agent",
      agentId: "child-1",
      sessionId: "agent:child-1",
      text: "continue",
      mode: "next",
    });
    assert.deepEqual(conversationIntent(kernel, "main", "redirect", "steer"), {
      target: "main",
      sessionId: "main",
      text: "redirect",
      mode: "steer",
    });
  });
});

describe("TUI 160x45 snapshot", () => {
  test("keeps all critical controls reachable at the baseline terminal size", () => {
    const store = new TuiStore();
    store.applyHello(hello());
    store.setNotice("Ready for verification");
    assert.equal(store.selectSession("child-1"), "agent:child-1");
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "tool-start",
      streamId: "kernel",
      seq: 1,
      ts: "2026-08-09T00:00:03.000Z",
      durable: false,
      type: "tool.started",
      payload: {
        sessionId: "agent:child-1",
        toolCallId: "tool-search-1",
        toolName: "search",
        input: { query: "public API", path: "/workspace" },
      },
    });
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "tool-end",
      streamId: "kernel",
      seq: 2,
      ts: "2026-08-09T00:00:03.125Z",
      durable: true,
      type: "tool.completed",
      payload: {
        sessionId: "agent:child-1",
        toolCallId: "tool-search-1",
        toolName: "search",
        isError: false,
        result: { content: [{ type: "text", text: "2 matches" }], details: { hits: [{}, {}] } },
      },
    });
    const lines = renderTuiSnapshot(store.snapshot(), 160, 45, "inspect workspace", { animationFrame: 0 });
    assert.equal(lines.length, 45);
    assert.ok(lines.every((line) => visibleWidth(line) === 160));
    const screen = lines.join("\n");
    const plain = stripTerminalSequences(screen);
    if (process.env["PSPORE_PRINT_TUI_SNAPSHOT"] === "1") process.stderr.write(`\n${screen}\n`);
    assert.match(screen, /\u001b\[38;5;109m/);
    assert.match(screen, /\u001b\[38;5;151m/);
    assert.match(plain, /pSpore  LOCAL COWORK AGENT/);
    assert.match(plain, /deepseek\/deepseek-v4-flash/);
    assert.match(plain, /CONVERSATION  agent:child-1/);
    assert.match(plain, /pSpore  child result in progress/);
    assert.match(plain, /WORK STEPS/);
    assert.match(plain, /✓ Searched workspace · “public API” in \/workspace · 2 matches/);
    assert.match(plain, /└─● child-1  running/);
    // The conversation grows upward from the prompt and the workspace summary stays pinned below the session list.
    const rowOf = (needle: string) => lines.findIndex((line) => stripTerminalSequences(line).includes(needle));
    assert.ok(rowOf("you     inspect the public API") > 30, "conversation is not anchored to the prompt");
    assert.ok(rowOf("WORKSPACE") > rowOf("SESSIONS"), "workspace summary is not pinned below the session list");
    assert.match(plain, /mcp\s+1\/1/);
    assert.match(plain, /resources\s+1\/1/);
    assert.match(plain, /! APPROVAL approval-1/);
    assert.match(plain, /\/help commands/);
    assert.match(plain, /\/config setup/);
    assert.match(plain, /to child-1 › inspect workspace/);
    assert.equal(createHash("sha256").update(screen).digest("hex"), "c120e22fb2d245aea779bb3c9ac956728af45bf46cf8578e9006c3ba26ecdf50");
  });

  test("labels every follow-up with the requested queue and direct-send wording", () => {
    const initial = hello();
    const main = initial.snapshot.sessions["main"];
    assert.ok(main);
    const store = new TuiStore();
    store.applyHello({
      ...initial,
      snapshot: {
        ...initial.snapshot,
        sessions: {
          ...initial.snapshot.sessions,
          main: { ...main, status: "running", queue: { steering: [], followUp: ["first queued", "second queued"] } },
        },
      },
    });
    const plain = stripTerminalSequences(renderTuiSnapshot(store.snapshot(), 160, 45, "", { color: false }).join("\n"));
    assert.match(plain, /1\. 继续排队 · first queued · \/send-now 1 直接发送消息/);
    assert.match(plain, /2\. 继续排队 · second queued · \/send-now 2 直接发送消息/);
  });

  test("opens the complete command palette and adapts to a compact terminal", () => {
    const store = new TuiStore();
    store.applyHello(hello());
    store.setPanel("Command palette", TUI_HELP_LINES);
    const help = renderTuiSnapshot(store.snapshot(), 160, 45).join("\n");
    assert.match(help, /\/config set custom-openai/);
    assert.match(help, /\/mcp-tools/);
    assert.match(help, /\/resource-install/);
    assert.match(help, /\/approve/);

    store.clearPanel();
    const compact = renderTuiSnapshot(store.snapshot(), 96, 30);
    if (process.env["PSPORE_PRINT_TUI_SNAPSHOT"] === "1") process.stderr.write(`\n${compact.join("\n")}\n`);
    assert.equal(compact.length, 30);
    assert.ok(compact.every((line) => visibleWidth(line) === 96));
    assert.ok(compact.every((line) => !line.includes("┬")));
    assert.match(compact.join("\n"), /CONVERSATION/);
  });

  test("never renders a secret value in clear text", () => {
    const secret = "secret-that-must-not-render";
    const masked = maskSecretInput(secret, 12);
    assert.doesNotMatch(masked, /secret/);
    assert.equal(visibleWidth(masked), 12);
  });

  test("shows the saved model before a conversation session exists", () => {
    const store = new TuiStore();
    store.setConfiguredModel({ provider: "deepseek", model: "deepseek-v4-flash" });
    const screen = renderTuiSnapshot(store.snapshot(), 96, 30, "", { color: false }).join("\n");
    assert.match(screen, /deepseek\/deepseek-v4-flash/);
    assert.doesNotMatch(screen, /model not configured/);
  });
});

describe("first-run model setup offer", () => {
  test("recommends the wizard by default but honours an explicit decline", () => {
    // Enter alone accepts, because the offer is phrased [Y/n].
    assert.equal(acceptsModelSetupOffer(""), true);
    assert.equal(acceptsModelSetupOffer("  "), true);
    assert.equal(acceptsModelSetupOffer("y"), true);
    assert.equal(acceptsModelSetupOffer("Yes"), true);

    assert.equal(acceptsModelSetupOffer("n"), false);
    assert.equal(acceptsModelSetupOffer("no"), false);
    // Esc resolves to undefined and must never start the wizard.
    assert.equal(acceptsModelSetupOffer(undefined), false);
  });

  test("explains why setup is offered without promising the key is displayed", () => {
    const text = MODEL_SETUP_OFFER_LINES.join("\n");
    assert.match(text, /model_not_configured/);
    assert.match(text, /\/config wizard/);
    assert.match(MODEL_SETUP_OFFER_PROMPT, /\[Y\/n\]/);
  });
});

function hello(): ServerHelloFrame {
  const session: AgentSnapshot = {
    sessionId: "main",
    upstreamSessionId: "pi-main",
    cwd: "/workspace",
    status: "idle",
    model: { provider: "deepseek", model: "deepseek-v4-flash" },
    thinking: "off",
    messages: [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hello from fake" },
    ],
    entries: [],
    queue: { steering: [], followUp: [] },
    usage: { input: 12, output: 4, cacheRead: 6, cacheWrite: 2, total: 24, costUsd: 0 },
  };
  const child: AgentSnapshot = {
    ...session,
    sessionId: "agent:child-1",
    upstreamSessionId: "pi-child-1",
    status: "running",
    messages: [
      { role: "user", text: "inspect the public API" },
      { role: "assistant", text: "child result in progress" },
    ],
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10, costUsd: 0 },
  };
  const kernel = {
    ...initialKernelState(),
    revision: 4,
    daemon: { phase: "ready" as const, instanceId: "daemon-test" },
    sessions: { main: session, [child.sessionId]: child },
    agents: {
      "child-1": {
        version: 1 as const,
        id: "child-1",
        sessionId: child.sessionId,
        parentId: "main",
        rootId: "main",
        objective: "inspect the public API",
        cwd: "/workspace",
        depth: 1,
        workspaceMode: "shared-read" as const,
        budget: {
          maxTurns: 2,
          maxToolCalls: 4,
          maxInputTokens: 1_000,
          maxOutputTokens: 500,
          maxChildren: 0,
        },
        status: "running" as const,
        createdAt: "2026-08-09T00:00:00.000Z",
        startedAt: "2026-08-09T00:00:01.000Z",
      },
    },
    mcpServers: {
      fixture: {
        version: 1 as const,
        serverId: "fixture",
        status: "ready" as const,
        transport: "stdio" as const,
        toolCount: 3,
        failureCount: 0,
        updatedAt: "2026-08-09T00:00:02.000Z",
        connectedAt: "2026-08-09T00:00:02.000Z",
      },
    },
    resources: {
      "skill:review-skill": {
        version: 1 as const,
        key: "skill:review-skill",
        kind: "skill" as const,
        name: "review-skill",
        resourceVersion: "unversioned",
        digest: "a".repeat(64),
        status: "active" as const,
        updatedAt: "2026-08-09T00:00:02.000Z",
        restartRequired: false,
      },
    },
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
