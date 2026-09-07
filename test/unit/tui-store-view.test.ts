import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

import type { SessionView } from "../../src/domain/runtime.js";
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
    const kernelBeforeDelta = store.snapshot().kernel;
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "e-1",
      streamId: "kernel",
      seq: 1,
      ts: "2026-08-09T00:00:01.000Z",
      durable: false,
      type: "transcript.delta",
      payload: { sessionId: "main", itemId: "item-1", kind: "thinking", delta: "reasoning" },
    });
    assert.equal(store.snapshot().streamingThinking["main"], "reasoning");
    assert.equal(store.snapshot().kernel, kernelBeforeDelta, "streaming must not clone the complete TUI history");
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "e-2",
      streamId: "kernel",
      seq: 2,
      ts: "2026-08-09T00:00:02.000Z",
      durable: false,
      type: "transcript.delta",
      payload: { sessionId: "main", itemId: "item-1", kind: "text", delta: "stream" },
    });
    assert.equal(store.snapshot().streamingText["main"], "stream");
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "e-3",
      streamId: "kernel",
      seq: 3,
      ts: "2026-08-09T00:00:03.000Z",
      durable: true,
      type: "session.closed",
      payload: { sessionId: "main", revision: 5 },
    });
    assert.equal(store.snapshot().kernel.sessions["main"], undefined);
    assert.equal(store.snapshot().streamingText["main"], undefined);
    assert.equal(store.snapshot().streamingThinking["main"], undefined);
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "e-5",
      streamId: "kernel",
      seq: 5,
      ts: "2026-08-09T00:00:05.000Z",
      durable: true,
      type: "run.settled",
      payload: {},
    });
    assert.deepEqual(store.snapshot().gap, { streamId: "kernel", expected: 4, received: 5 });
  });

  test("prepends a fetched history page and refuses one that would leave a hole", () => {
    const store = new TuiStore();
    const initial = hello();
    const main = initial.snapshot.sessions["main"];
    assert.ok(main);
    // A long session arrives as its newest messages plus where they sit.
    store.applyHello({
      ...initial,
      snapshot: {
        ...initial.snapshot,
        sessions: {
          ...initial.snapshot.sessions,
          main: { ...main, messages: [{ role: "user", text: "recent" }], messageOffset: 40, messageCount: 41 },
        },
      },
    });

    const older = [{ role: "assistant", text: "older 38" }, { role: "user", text: "older 39" }];
    assert.equal(store.applyTranscriptPage({ sessionId: "main", from: 38, count: 41, messages: older }), true);
    const merged = store.snapshot().kernel.sessions["main"];
    assert.equal(merged?.messageOffset, 38);
    assert.deepEqual(merged?.messages.map((message) => message.text), ["older 38", "older 39", "recent"]);

    // A page that stops short of what is already loaded would reorder history.
    assert.equal(
      store.applyTranscriptPage({ sessionId: "main", from: 0, count: 41, messages: [{ role: "user", text: "ancient" }] }),
      false,
    );
    // A page already covered changes nothing.
    assert.equal(store.applyTranscriptPage({ sessionId: "main", from: 38, count: 41, messages: older }), false);
  });

  test("keeps paged-back history when the daemon re-establishes its bounded tail", () => {
    const store = new TuiStore();
    const initial = hello();
    const main = initial.snapshot.sessions["main"];
    assert.ok(main);
    store.applyHello({
      ...initial,
      snapshot: {
        ...initial.snapshot,
        sessions: {
          ...initial.snapshot.sessions,
          main: { ...main, messages: [{ role: "user", text: "recent" }], messageOffset: 40, messageCount: 41 },
        },
      },
    });
    assert.equal(
      store.applyTranscriptPage({
        sessionId: "main",
        from: 38,
        count: 41,
        messages: [{ role: "assistant", text: "older 38" }, { role: "user", text: "older 39" }],
      }),
      true,
    );

    // A settled run ships the newest tail. Replacing outright would throw away
    // the scrollback the reader just asked for.
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "settled-1",
      streamId: "kernel",
      seq: 1,
      ts: "2026-08-09T00:00:06.000Z",
      durable: true,
      type: "run.settled",
      payload: {
        sessionId: "main",
        upstreamSessionId: "pi-main",
        revision: 6,
        session: {
          ...main,
          messages: [{ role: "user", text: "recent" }, { role: "assistant", text: "answer" }],
          messageOffset: 40,
          messageCount: 42,
        },
      },
    });
    const merged = store.snapshot().kernel.sessions["main"];
    assert.equal(merged?.messageOffset, 38);
    assert.deepEqual(merged?.messages.map((message) => message.text), ["older 38", "older 39", "recent", "answer"]);

    // A replaced upstream session renumbers the transcript, so its old prefix
    // can no longer be joined onto the new tail.
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "replaced-1",
      streamId: "kernel",
      seq: 2,
      ts: "2026-08-09T00:00:07.000Z",
      durable: true,
      type: "session.replaced",
      payload: {
        sessionId: "main",
        upstreamSessionId: "pi-main-2",
        revision: 7,
        session: {
          ...main,
          upstreamSessionId: "pi-main-2",
          messages: [{ role: "user", text: "fresh" }],
          messageOffset: 3,
          messageCount: 4,
        },
      },
    });
    const replaced = store.snapshot().kernel.sessions["main"];
    assert.equal(replaced?.messageOffset, 3);
    assert.deepEqual(replaced?.messages.map((message) => message.text), ["fresh"]);
  });

  test("appends a finished item instead of waiting for the transcript to be re-sent", () => {
    const store = new TuiStore();
    store.applyHello(hello());
    const before = store.snapshot().kernel.sessions["main"];
    assert.ok(before);
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "finished-1",
      streamId: "kernel",
      seq: 1,
      ts: "2026-08-09T00:00:04.000Z",
      durable: true,
      type: "transcript.item.finished",
      payload: {
        sessionId: "main",
        upstreamSessionId: "pi-main",
        item: { id: "item-9", role: "assistant", text: "appended answer", status: "complete", ts: "2026-08-09T00:00:04.000Z" },
      },
    });
    const after = store.snapshot().kernel.sessions["main"];
    assert.equal(after?.messages.length, before.messages.length + 1);
    assert.equal(after?.messages.at(-1)?.text, "appended answer");
    assert.equal(after?.messageCount, before.messageCount + 1);
  });

  test("keeps a delta from a superseded item out of the message on screen", () => {
    const store = new TuiStore();
    store.applyHello(hello());
    const delta = (seq: number, itemId: string, text: string) => store.applyEvent({
      v: 1,
      kind: "event",
      id: `d-${seq}`,
      streamId: "kernel",
      seq,
      ts: "2026-08-09T00:00:01.000Z",
      durable: false,
      type: "transcript.delta",
      payload: { sessionId: "main", itemId, kind: "text", delta: text },
    });
    delta(1, "item-1", "first ");
    delta(2, "item-1", "answer");
    assert.equal(store.snapshot().streamingText["main"], "first answer");
    // Without item identity a retried or replaced message appended to whatever
    // was already on screen, which is how streams used to run together.
    delta(3, "item-2", "second answer");
    assert.equal(store.snapshot().streamingText["main"], "second answer");
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
    assert.equal(createHash("sha256").update(screen).digest("hex"), "7c4bc9506252d79a0f42c37751291df9185b2d5a1afb7b605576b67458bdd1a5");
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

  test("renders thinking separately while streaming and hides it when the response completes", () => {
    const store = new TuiStore();
    store.applyHello(hello());
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "thinking-1",
      streamId: "kernel",
      seq: 1,
      ts: "2026-08-09T00:00:01.000Z",
      durable: false,
      type: "transcript.delta",
      payload: { sessionId: "main", itemId: "item-1", kind: "thinking", delta: "inspect private evidence" },
    });
    store.applyEvent({
      v: 1,
      kind: "event",
      id: "text-2",
      streamId: "kernel",
      seq: 2,
      ts: "2026-08-09T00:00:02.000Z",
      durable: false,
      type: "transcript.delta",
      payload: { sessionId: "main", itemId: "item-1", kind: "text", delta: "public answer" },
    });
    const streaming = stripTerminalSequences(renderTuiSnapshot(store.snapshot(), 96, 30, "", { color: false }).join("\n"));
    assert.match(streaming, /thought\s+inspect private evidence/);
    assert.match(streaming, /auto-hidden when the response completes/);
    assert.match(streaming, /pSpore\s+public answer/);

    store.applyEvent({
      v: 1,
      kind: "event",
      id: "completed-3",
      streamId: "kernel",
      seq: 3,
      ts: "2026-08-09T00:00:03.000Z",
      durable: true,
      type: "transcript.item.finished",
      payload: {
        sessionId: "main",
        item: { id: "item-1", role: "assistant", text: "public answer", status: "complete", ts: "2026-08-09T00:00:03.000Z" },
      },
    });
    const completed = stripTerminalSequences(renderTuiSnapshot(store.snapshot(), 96, 30, "", { color: false }).join("\n"));
    assert.doesNotMatch(completed, /inspect private evidence/);
    assert.equal(store.snapshot().streamingThinking["main"], undefined);
  });

  test("formats only the visible tail of a long restored history", () => {
    const store = new TuiStore();
    store.applyHello(hello());
    const base = store.snapshot();
    const main = base.kernel.sessions["main"];
    assert.ok(main);
    let textReads = 0;
    const messages = Array.from({ length: 10_000 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      get text() {
        textReads += 1;
        return `history message ${index}`;
      },
    }));
    const state = {
      ...base,
      selectedSessionId: "main",
      kernel: {
        ...base.kernel,
        agents: {},
        sessions: {
          main: {
            ...main,
            rootSession: {
              title: "Long history",
              createdAt: "2026-08-09T00:00:00.000Z",
              updatedAt: "2026-08-09T00:00:00.000Z",
            },
            messages,
          },
        },
      },
    };
    const plain = stripTerminalSequences(renderTuiSnapshot(state, 96, 30, "", { color: false }).join("\n"));
    assert.match(plain, /history message 9999/);
    assert.doesNotMatch(plain, /history message 0(?:\D|$)/);
    assert.ok(textReads < 100, `expected a virtual tail, read ${textReads} message bodies`);
  });

  test("asks for older history only once the window reaches past what is loaded", () => {
    const store = new TuiStore();
    store.applyHello(hello());
    const base = store.snapshot();
    const main = base.kernel.sessions["main"];
    assert.ok(main);
    const state = {
      ...base,
      selectedSessionId: "main",
      kernel: {
        ...base.kernel,
        agents: {},
        sessions: {
          main: {
            ...main,
            messages: Array.from({ length: 60 }, (_, index) => ({
              role: index % 2 === 0 ? "user" : "assistant",
              text: `loaded message ${index}`,
            })),
            messageOffset: 200,
            messageCount: 260,
          },
        },
      },
    };

    let requests = 0;
    const onHistoryExhausted = () => {
      requests += 1;
    };
    // Sitting at the tail, and one page up, both stay inside what is loaded.
    renderTuiSnapshot(state, 96, 30, "", { color: false, onHistoryExhausted });
    renderTuiSnapshot(state, 96, 30, "", { color: false, scrollOffset: 16, onHistoryExhausted });
    assert.equal(requests, 0, "history was fetched before the reader ran out of it");

    // Scrolling past every loaded message is the moment older history is worth
    // asking for; a broadcast carries only the newest of a 260-message session.
    renderTuiSnapshot(state, 96, 30, "", { color: false, scrollOffset: 400, onHistoryExhausted });
    assert.equal(requests, 1);
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
  const session: SessionView = {
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
    firstUserText: "hello",
    messageCount: 2,
    messageOffset: 0,
    queue: { steering: [], followUp: [] },
    usage: { input: 12, output: 4, cacheRead: 6, cacheWrite: 2, total: 24, costUsd: 0 },
  };
  const child: SessionView = {
    ...session,
    sessionId: "agent:child-1",
    upstreamSessionId: "pi-child-1",
    status: "running",
    messages: [
      { role: "user", text: "inspect the public API" },
      { role: "assistant", text: "child result in progress" },
    ],
    firstUserText: "inspect the public API",
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
