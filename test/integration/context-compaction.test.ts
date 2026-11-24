import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PsporeDaemon } from "../../src/daemon/daemon.js";
import { DaemonBridge } from "../../src/desktop/daemon-bridge.js";
import { DesktopStore } from "../../src/desktop/renderer/store.js";
import type { EventEnvelope } from "../../src/protocol/schema.js";
import { atomicWriteJson } from "../../src/storage/atomic.js";
import { loadConfig } from "../../src/storage/home.js";
import { articleApi, waitFor } from "../fixtures/article-api.js";

test("real daemon/UDS bounds tool results, compacts and drains queues, restores history, and aborts a later compaction", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-context-wire-"));
  const api = await articleApi();
  let daemon: PsporeDaemon | undefined;
  let bridge: DaemonBridge | undefined;
  let store = new DesktopStore();
  const events: EventEnvelope[] = [];
  try {
    const paths = await api.configure(home);
    const config = await loadConfig(home);
    config.context.autoCompaction = { enabled: true, triggerTokens: 6_000, reserveTokens: 1_024, keepRecentTokens: 100 };
    await atomicWriteJson(paths.config, config);
    const path = join(paths.workspace, "large-evidence.txt");
    const original = "BEGIN-RAW-EVIDENCE\n" + "evidence ".repeat(8_000) + "\nEND-RAW-EVIDENCE";
    await writeFile(path, original);
    const connect = async (): Promise<void> => {
      store = new DesktopStore();
      daemon = await PsporeDaemon.start({ home });
      bridge = new DaemonBridge({ socketPath: paths.socket, stagingRoot: join(paths.workspace, "staging"),
        versions: { pspore: "test", pi: "0.84.1", electron: "test", node: process.versions.node } });
      bridge.subscribe((frame) => {
        store.applyFrame(frame);
        if (frame.kind === "event") events.push(frame.event);
      });
      bridge.start();
      await waitFor(() => bridge?.bootstrap().connection.phase === "connected", "context bridge");
    };
    await connect();
    await bridge!.dispatch({ action: "prompt", sessionId: "main", text: "Read the evidence once and report its beginning and end." });
    tool(await api.next(), path, "read-first");
    const summary = await api.next();
    assert.match(JSON.stringify(api.requests.at(-1)), /summar/i);
    assert.match(JSON.stringify(api.requests.at(-1)), /Full output:/);
    assert.match(JSON.stringify(api.requests.at(-1)), /END-RAW-EVIDENCE/);
    assert.ok(JSON.stringify(api.requests.at(-1)).length < 50_000, "summarization sees only the bounded tool excerpt");
    await waitFor(() => events.some((event) => event.type === "compaction.started"), "compaction before continuation");
    assert.equal(daemon!.kernel.snapshot().sessions["main"]?.status, "running");
    const compaction = store.snapshot().kernel.sessions["main"]?.compaction;
    assert.equal(compaction?.status, "running");
    assert.equal(bridge!.bootstrap().snapshot?.sessions["main"]?.compaction?.id, compaction?.id, "renderer reload uses current progress");
    // A new client receives the active progress through hello, without replay.
    const observer = new DaemonBridge({ socketPath: paths.socket, stagingRoot: join(paths.workspace, "staging"),
      versions: { pspore: "test", pi: "0.84.1", electron: "test", node: process.versions.node } });
    try {
      observer.start();
      await waitFor(() => observer.bootstrap().connection.phase === "connected", "compaction observer");
      const observerStore = new DesktopStore();
      observerStore.applyBootstrap(observer.bootstrap());
      assert.equal(observerStore.snapshot().kernel.sessions["main"]?.compaction?.id, compaction?.id);
    } finally { await observer.stop(); }
    await bridge!.dispatch({ action: "prompt", sessionId: "main", text: "queued follow-up" });
    await bridge!.dispatch({ action: "prompt", sessionId: "main", text: "prioritize this steering message" });
    await bridge!.dispatch({ action: "queue.send-now", sessionId: "main", index: 1 });
    await bridge!.dispatch({ action: "prompt", sessionId: "main", text: "CANCELLED-FOLLOW-UP" });
    await bridge!.dispatch({ action: "prompt", sessionId: "main", text: "CANCELLED-DIRECT" });
    await bridge!.dispatch({ action: "queue.send-now", sessionId: "main", index: 2 });
    await bridge!.dispatch({ action: "queue.cancel", sessionId: "main", mode: "followUp", index: 1,
      revision: daemon!.kernel.snapshot().sessions["main"]!.queueRevision! });
    await bridge!.dispatch({ action: "queue.cancel", sessionId: "main", mode: "steering", index: 1,
      revision: daemon!.kernel.snapshot().sessions["main"]!.queueRevision! });
    await waitFor(() => bridge!.bootstrap().snapshot?.sessions["main"]?.queue.followUp.length === 1, "bootstrap catches queue cancellation");
    assert.deepEqual(bridge!.bootstrap().snapshot?.sessions["main"]?.queue, { steering: ["prioritize this steering message"], followUp: ["queued follow-up"] });
    reply(summary, "Summary: original request remains. Read completed once; BEGIN-RAW-EVIDENCE and END-RAW-EVIDENCE confirmed. Do not repeat it.");
    const continuation = await api.next();
    assert.match(JSON.stringify(api.requests.at(-1)), /prioritize this steering message/);
    assert.ok(JSON.stringify(api.requests.at(-1)).length < 50_000);
    reply(continuation, "Original task and steering complete.");
    const followUp = await api.next();
    assert.match(JSON.stringify(api.requests.at(-1)), /queued follow-up/);
    reply(followUp, "Follow-up complete.");
    await waitFor(() => events.some((event) => event.type === "run.settled"), "logical task settled");
    assert.equal(events.filter((event) => event.type === "run.started").length, 1);
    assert.equal(events.filter((event) => event.type === "run.settled").length, 1);
    assert.equal(events.filter((event) => event.type === "tool.started").length, 1);
    assert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
    const session = store.snapshot().kernel.sessions["main"];
    assert.ok(session);
    assert.equal(session.compaction?.status, "succeeded");
    assert.ok(session.compaction.tokensAfter !== undefined);
    assert.ok(api.requests.every((request) => !JSON.stringify(request).includes("CANCELLED-")), "cancelled input never reaches a model request");
    assert.deepEqual(session.queue, { steering: [], followUp: [] });
    assert.equal(session.status, "idle");
    assert.ok(session.context && session.context.tokens < session.usage.total);
    const result = session.messages.find((message) => message.toolCallId === "read-first");
    assert.ok(result && result.text.length <= 24_000);
    const artifact = /Full output: (.+?)\. Read selected lines/.exec(result.text)?.[1];
    assert.ok(artifact);
    const full = await readFile(artifact, "utf8");
    assert.ok(full.includes("2: " + "evidence ".repeat(8_000)));
    assert.equal((await stat(artifact)).mode & 0o777, 0o600);
    assert.equal(bridge!.bootstrap().connection.attempt, 0);

    await bridge!.stop();
    await daemon!.stop();
    await connect();
    const restored = store.snapshot().kernel.sessions["main"];
    assert.ok(restored);
    assert.deepEqual(restored.messages, session.messages, "compaction must not remove the visible persisted transcript");
    assert.equal(restored.messages.at(-1)?.text, "Follow-up complete.");
    assert.ok(restored.messages.every((message) => message.role !== "custom"));
    const call = restored.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.id === "read-first");
    assert.equal(call?.name, "read");
    assert.equal(JSON.parse(call!.input).path, path);

    events.length = 0;
    await bridge!.dispatch({ action: "prompt", sessionId: "main", text: "Read again, then wait for cancellation." });
    tool(await api.next(), path, "read-second");
    await api.next();
    await waitFor(() => events.some((event) => event.type === "compaction.started"), "second summary");
    const requestsBeforeAbort = api.requests.length;
    await bridge!.dispatch({ action: "abort", sessionId: "main" });
    await waitFor(() => events.some((event) => event.type === "run.settled"), "aborted compaction settled");
    assert.equal(daemon!.kernel.snapshot().sessions["main"]?.status, "idle");
    assert.equal(daemon!.kernel.snapshot().sessions["main"]?.compaction?.status, "aborted");
    assert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
    assert.equal(api.requests.length, requestsBeforeAbort, "abort must not start a continuation request");
    assert.equal(bridge!.bootstrap().connection.phase, "connected");
    assert.equal(bridge!.bootstrap().connection.attempt, 0);
    assert.deepEqual(api.errors, []);
  } finally {
    await bridge?.stop();
    await daemon?.stop();
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a manual compaction does not hold back the desktop connection, and Stop ends it while it summarizes", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-manual-compact-"));
  const api = await articleApi();
  let daemon: PsporeDaemon | undefined;
  let bridge: DaemonBridge | undefined;
  const store = new DesktopStore();
  const prompt = async (): Promise<void> => {
    await bridge!.dispatch({ action: "prompt", sessionId: "main", text: "Summarize the demo project status in two sentences." });
    reply(await api.next(), "The demo project is on track. Next step: confirm owners and dates.");
    await waitFor(() => daemon!.kernel.snapshot().sessions["main"]?.status === "idle", "reply settled");
  };
  const within = async <T>(promise: Promise<T>, label: string, ms = 3_000): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} waited behind the compaction`)), ms); })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const paths = await api.configure(home);
    const config = await loadConfig(home);
    config.context.autoCompaction = { enabled: true, triggerTokens: 100_000, reserveTokens: 1_024, keepRecentTokens: 10 };
    await atomicWriteJson(paths.config, config);
    daemon = await PsporeDaemon.start({ home });
    bridge = new DaemonBridge({ socketPath: paths.socket, stagingRoot: join(paths.workspace, "staging"),
      versions: { pspore: "test", pi: "0.84.1", electron: "test", node: process.versions.node } });
    bridge.subscribe((frame) => store.applyFrame(frame));
    bridge.start();
    await waitFor(() => bridge?.bootstrap().connection.phase === "connected", "manual compact bridge");
    await prompt();
    await prompt();

    const compact = bridge.dispatch({ action: "compact", sessionId: "main" });
    const settled = compact.then(() => "resolved", (error: unknown) => (error instanceof Error ? error.message : String(error)));
    const summary = await api.next();
    assert.match(JSON.stringify(api.requests.at(-1)), /summar/i);
    await waitFor(() => store.snapshot().kernel.sessions["main"]?.compaction?.status === "running", "manual summary running");
    // The same connection keeps answering while the model is still summarizing.
    await within(bridge.dispatch({ action: "jobs.list" }), "jobs.list");
    const requestsBeforeAbort = api.requests.length;
    await within(bridge.dispatch({ action: "abort", sessionId: "main" }), "Stop");
    await waitFor(() => daemon!.kernel.snapshot().sessions["main"]?.compaction?.status === "aborted", "manual compaction aborted");
    assert.equal(daemon!.kernel.snapshot().sessions["main"]?.compaction?.error, undefined, "a user Stop is not reported as a failure");
    assert.notEqual(await within(settled, "compact response"), "resolved", "an aborted compaction is not reported as done");
    summary.destroy();
    await waitFor(() => daemon!.kernel.snapshot().sessions["main"]?.status === "idle", "idle after Stop");
    assert.equal(api.requests.length, requestsBeforeAbort, "Stop must not start another model request");
    assert.equal(bridge.bootstrap().connection.attempt, 0);
    assert.deepEqual(api.errors, []);
  } finally {
    await bridge?.stop();
    await daemon?.stop();
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});

function chunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: "context-test", object: "chat.completion.chunk", created: 0, model: "article-fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function finish(response: ServerResponse, reason: string): void {
  chunk(response, {}, reason);
  response.write(`data: ${JSON.stringify({ id: "context-test", object: "chat.completion.chunk", created: 0, model: "article-fixture",
    choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function tool(response: ServerResponse, path: string, id: string): void {
  chunk(response, { tool_calls: [{ index: 0, id, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } }] });
  finish(response, "tool_calls");
}

function reply(response: ServerResponse, text: string): void {
  chunk(response, { content: text });
  finish(response, "stop");
}
