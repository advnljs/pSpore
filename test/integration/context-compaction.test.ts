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
    await bridge!.dispatch({ action: "prompt", sessionId: "main", text: "queued follow-up" });
    await bridge!.dispatch({ action: "prompt", sessionId: "main", text: "prioritize this steering message" });
    await bridge!.dispatch({ action: "queue.send-now", sessionId: "main", index: 1 });
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
