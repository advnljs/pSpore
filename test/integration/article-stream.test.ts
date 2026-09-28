import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArticleStore } from "../../src/articles/store.js";
import { parseArticleOpenReceipt, parseArticleReceipt } from "../../src/articles/receipt.js";
import { PsporeDaemon } from "../../src/daemon/daemon.js";
import { DaemonBridge } from "../../src/desktop/daemon-bridge.js";
import type { EventEnvelope } from "../../src/protocol/schema.js";
import { articleApi, finishCompletion, finishText, finishTool, textChunk, toolChunk, waitFor } from "../fixtures/article-api.js";

test("article retries a receipt-only response, streams real prose and preserves saved versions if retry also fails", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-article-receipt-"));
  const api = await articleApi();
  let daemon: PsporeDaemon | undefined;
  let bridge: DaemonBridge | undefined;
  const notice = "开篇写好了，面板里可以看到全文。今天先收工，明天继续写第二章。";
  try {
    const paths = await api.configure(home);
    daemon = await PsporeDaemon.start({ home });
    bridge = new DaemonBridge({ socketPath: paths.socket, stagingRoot: join(paths.workspace, "staging"),
      versions: { pspore: "test", pi: "0.84.1", electron: "test", node: process.versions.node } });
    const events: EventEnvelope[] = [];
    bridge.subscribe((frame) => { if (frame.kind === "event") events.push(frame.event); });
    bridge.start();
    await waitFor(() => bridge?.bootstrap().connection.phase === "connected", "receipt writer bridge");
    const articles = new ArticleStore(join(paths.workspace, "articles"));
    await bridge.dispatch({ action: "prompt", sessionId: "main", text: "写一个以义体与记忆为主题的赛博朋克小说开篇。" });
    const calling = await api.next();
    toolChunk(calling, "receipt-create", JSON.stringify({ action: "write", title: "灰域接线员", instruction: "按用户要求写开篇" }));
    finishTool(calling);
    const firstAttempt = await api.next();
    textChunk(firstAttempt, notice);
    finishCompletion(firstAttempt);
    const retry = await api.next();
    assert.equal(api.requests.at(-1)?.["tools"], undefined);
    assert.match(JSON.stringify(api.requests.at(-1)?.["messages"]), /NOT saved/);
    assert.match(JSON.stringify(api.requests.at(-1)?.["messages"]), /义体与记忆/);
    assert.deepEqual(await articles.list("main"), []);
    await waitFor(async () => JSON.stringify(await bridge!.dispatch({ action: "article.preview", sessionId: "main", toolCallId: "receipt-create" })).includes('"text":""'), "rejected preview cleared");
    textChunk(retry, "# 灰域接线员\n\n雨落在他的义体上，");
    await waitFor(async () => JSON.stringify(await bridge!.dispatch({ action: "article.preview", sessionId: "main", toolCallId: "receipt-create" })).includes("雨落在"), "retry still streams before completion");
    textChunk(retry, "一段陌生的记忆醒了过来。");
    finishCompletion(retry);
    finishText(await api.next());
    await waitFor(() => events.some((event) => event.type === "run.settled"), "retry settled");
    const receipt = parseArticleReceipt(resultText(events, "receipt-create"));
    assert.ok(receipt);
    const saved = await articles.read({ sessionId: "main", id: receipt.id, limit: 1000 });
    assert.equal(saved?.text, "# 灰域接线员\n\n雨落在他的义体上，一段陌生的记忆醒了过来。");
    assert.equal(saved.versions.length, 1);
    assert.deepEqual(daemon.kernel.snapshot().sessions["main"]?.usage,
      { input: 36, output: 102, cacheRead: 0, cacheWrite: 0, total: 138, costUsd: 0 });
    assert.doesNotMatch(JSON.stringify(events), /雨落在他的义体/);

    // A second receipt is an error, never an endless retry or a new version.
    events.length = 0;
    await bridge.dispatch({ action: "prompt", sessionId: "main", text: "修订这篇开篇" });
    const revise = await api.next();
    toolChunk(revise, "receipt-revise", JSON.stringify({ action: "write", id: receipt.id, instruction: "改写第一段" }));
    finishTool(revise);
    for (let attempt = 0; attempt < 2; attempt++) {
      const writing = await api.next();
      assert.equal(api.requests.at(-1)?.["tools"], undefined);
      textChunk(writing, notice);
      finishCompletion(writing);
    }
    const parent = await api.next();
    assert.ok(Array.isArray(api.requests.at(-1)?.["tools"]), "writer retries at most once");
    finishText(parent);
    await waitFor(() => events.some((event) => event.type === "run.settled"), "rejected revision settled");
    assert.equal(payload(events.find((event) => event.type === "tool.completed" && payload(event)["toolCallId"] === "receipt-revise")!)["isError"], true);
    assert.deepEqual(await articles.read({ sessionId: "main", id: receipt.id, limit: 1000 }), saved);
    assert.equal(bridge.bootstrap().connection.attempt, 0);
    assert.deepEqual(api.errors, []);
  } finally {
    await bridge?.stop();
    await daemon?.stop();
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("article write streams ordinary text when tool arguments are buffered, and never commits failed drafts", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-article-text-"));
  const api = await articleApi();
  let daemon: PsporeDaemon | undefined;
  let bridge: DaemonBridge | undefined;
  try {
    const paths = await api.configure(home);
    daemon = await PsporeDaemon.start({ home });
    bridge = new DaemonBridge({ socketPath: paths.socket, stagingRoot: join(paths.workspace, "staging"),
      versions: { pspore: "test", pi: "0.84.1", electron: "test", node: process.versions.node } });
    const events: EventEnvelope[] = [];
    bridge.subscribe((frame) => { if (frame.kind === "event") events.push(frame.event); });
    bridge.start();
    await waitFor(() => bridge?.bootstrap().connection.phase === "connected", "text writer bridge");
    const articles = new ArticleStore(join(paths.workspace, "articles"));
    await bridge.dispatch({ action: "prompt", sessionId: "main", text: "使用提供的资料生成一篇报告，保留事实来源。" });
    const calling = await api.next();
    // No tool argument deltas: this gateway delivers the short instruction in one piece.
    toolChunk(calling, "text-create", JSON.stringify({ action: "write", title: "文本流报告", instruction: "按要求写报告" }));
    finishTool(calling);
    const writing = await api.next();
    const request = api.requests.at(-1);
    assert.equal(request?.["stream"], true);
    assert.equal(request?.["tools"], undefined, "the body must use ordinary text, not tool arguments");
    assert.match(JSON.stringify(request?.["messages"]), /保留事实来源/);
    assert.doesNotMatch(JSON.stringify(request?.["messages"]), /text-create/, "unfinished tool calls cannot enter the writer context");
    const getDraft = () => bridge!.dispatch({ action: "article.preview", sessionId: "main", toolCallId: "text-create" });
    textChunk(writing, "# 文本流报告\n\n正文正在");
    await waitFor(async () => JSON.stringify(await getDraft()).includes("正文正在"), "first body text before response completion");
    textChunk(writing, "持续增长，文本流独有标记。");
    await waitFor(async () => JSON.stringify(await getDraft()).includes("文本流独有标记"), "later body text before response completion");
    assert.deepEqual(await articles.list("main"), []);
    assert.equal(events.some((event) => event.type === "tool.completed" && payload(event)["toolCallId"] === "text-create"), false);
    assert.doesNotMatch(JSON.stringify(events), /文本流独有标记/, "draft body must not enter transcript or activity broadcasts");
    finishCompletion(writing);
    finishText(await api.next());
    await waitFor(() => events.some((event) => event.type === "run.settled"), "text writer settled");
    const receipt = parseArticleReceipt(resultText(events, "text-create"));
    assert.ok(receipt);
    const first = await articles.read({ sessionId: "main", id: receipt.id, limit: 10_000 });
    assert.equal(first?.text, "# 文本流报告\n\n正文正在持续增长，文本流独有标记。");
    assert.equal(first.versions.length, 1);
    assert.doesNotMatch(JSON.stringify(events), /文本流独有标记/);
    // The parent receipt and the document text request each report 46 tokens.
    assert.deepEqual(daemon.kernel.snapshot().sessions["main"]?.usage,
      { input: 24, output: 68, cacheRead: 0, cacheWrite: 0, total: 92, costUsd: 0 });

    for (const ending of ["success", "truncated", "failed", "aborted"] as const) {
      events.length = 0;
      await bridge.dispatch({ action: "prompt", sessionId: "main", text: `修订报告 ${ending}` });
      const start = await api.next();
      const callId = `text-${ending}`;
      toolChunk(start, callId, JSON.stringify({ action: "write", id: receipt.id, instruction: "保留标题并修改正文" }));
      finishTool(start);
      const revision = await api.next();
      assert.equal(api.requests.at(-1)?.["tools"], undefined);
      assert.match(JSON.stringify(api.requests.at(-1)?.["messages"]), /文本流独有标记|已成功修订/);
      textChunk(revision, "# 文本流报告\n\n已成功修订");
      await waitFor(async () => JSON.stringify(await bridge!.dispatch({ action: "article.preview", sessionId: "main", toolCallId: callId })).includes("已成功修订"), "revision draft");
      if (ending === "aborted") await bridge.dispatch({ action: "abort", sessionId: "main" });
      else {
        if (ending === "failed") revision.destroy();
        else finishCompletion(revision, ending === "truncated" ? "length" : "stop");
        finishText(await api.next());
      }
      await waitFor(() => events.some((event) => event.type === "run.settled"), `revision ${ending} settled`);
      const saved = await articles.read({ sessionId: "main", id: receipt.id, limit: 10_000 });
      assert.equal(saved?.text, "# 文本流报告\n\n已成功修订");
      assert.equal(saved.versions.length, 2, "failure, truncation and abort must not create versions");
    }
    assert.equal(bridge.bootstrap().connection.attempt, 0);
    assert.deepEqual(api.errors, []);
  } finally {
    await bridge?.stop();
    await daemon?.stop();
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenAI SSE opens before buffered arguments and still previews real argument deltas", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pspore-article-api-"));
  const api = await articleApi();
  let daemon: PsporeDaemon | undefined;
  let bridge: DaemonBridge | undefined;
  try {
    const paths = await api.configure(home);
    daemon = await PsporeDaemon.start({ home });
    bridge = new DaemonBridge({ socketPath: paths.socket, stagingRoot: join(paths.workspace, "staging"),
      versions: { pspore: "test", pi: "0.84.1", electron: "test", node: process.versions.node } });
    const events: EventEnvelope[] = [];
    bridge.subscribe((frame) => { if (frame.kind === "event") events.push(frame.event); });
    bridge.start();
    await waitFor(() => bridge?.bootstrap().connection.phase === "connected", "desktop bridge");
    await bridge.dispatch({ action: "prompt", sessionId: "main", text: "写一篇文稿" });

    // The gateway buffers a whole call. A short preparation call must finish
    // before it even starts the next response carrying the large document.
    const opening = await api.next();
    toolChunk(opening, "open-1", JSON.stringify({ action: "open", title: "接口兼容验证" }));
    finishTool(opening);
    const writing = await api.next();
    await waitFor(() => events.some((event) => event.type === "tool.completed" && payload(event)["toolCallId"] === "open-1"), "open receipt");
    assert.equal(parseArticleOpenReceipt(resultText(events, "open-1"))?.title, "接口兼容验证");
    const articles = new ArticleStore(join(paths.workspace, "articles"));
    assert.deepEqual(await articles.list("main"), [], "opening must not create an empty saved version");
    assert.equal(events.some((event) => event.type === "article.preview"), false, "no arguments received, no invented preview");
    assert.equal(api.requests[0]?.["stream"], true);

    toolChunk(writing, "create-1", JSON.stringify({ action: "create", title: "接口兼容验证", content: "# 接口兼容验证\n\n原文。" }));
    finishTool(writing);
    finishText(await api.next());
    await waitFor(() => events.some((event) => event.type === "run.settled"), "create settled");
    const receipt = parseArticleReceipt(resultText(events, "create-1"));
    assert.ok(receipt);
    events.length = 0;
    await bridge.dispatch({ action: "prompt", sessionId: "main", text: "修改这篇文稿" });
    const reopening = await api.next();
    toolChunk(reopening, "open-2", JSON.stringify({ action: "open", id: receipt.id }));
    finishTool(reopening);
    const revision = await api.next();
    await waitFor(() => events.some((event) => event.type === "tool.completed" && payload(event)["toolCallId"] === "open-2"), "reopen receipt");
    assert.equal(parseArticleOpenReceipt(resultText(events, "open-2"))?.version, 1);
    assert.equal((await articles.read({ sessionId: "main", id: receipt.id, limit: 10_000 }))?.versions.length, 1);

    // The other gateway sends genuine tool argument deltas. Assert a draft is
    // available before the JSON string, tool call, or assistant response ends.
    toolChunk(revision, "update-1", `{"action":"update","id":"${receipt.id}","edits":[{"find":"原文。","replace":"新`);
    await waitFor(() => events.some((event) => event.type === "article.preview" && payload(event)["toolCallId"] === "update-1"), "partial edit preview");
    const preview = await bridge.dispatch({ action: "article.preview", sessionId: "main", toolCallId: "update-1" });
    assert.ok(typeof preview === "object" && preview !== null && "text" in preview);
    assert.match(String(preview.text), /新/);
    assert.equal(events.some((event) => event.type === "tool.started" && payload(event)["toolCallId"] === "update-1"), false);
    assert.equal((await articles.read({ sessionId: "main", id: receipt.id, limit: 10_000 }))?.version, 1);
    toolChunk(revision, "update-1", "正文。\"}]}", false);
    finishTool(revision);
    finishText(await api.next());
    await waitFor(() => events.some((event) => event.type === "run.settled"), "update settled");
    assert.equal((await articles.read({ sessionId: "main", id: receipt.id, limit: 10_000 }))?.text, "# 接口兼容验证\n\n新正文。");
    assert.equal(bridge.bootstrap().connection.attempt, 0, "all events survive the actual desktop validator");
    assert.deepEqual(api.errors, []);
  } finally {
    await bridge?.stop();
    await daemon?.stop();
    await api.close();
    await rm(home, { recursive: true, force: true });
  }
});

function resultText(events: readonly EventEnvelope[], callId: string): string {
  const event = events.find((event) => event.type === "tool.completed" && payload(event)["toolCallId"] === callId);
  const result = event ? payload(event)["result"] : undefined;
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.map((block: unknown) => block && typeof block === "object" && "text" in block ? String(block.text) : "").join("\n");
}

function payload(event: EventEnvelope): Record<string, unknown> {
  assert.ok(event.payload && typeof event.payload === "object" && !Array.isArray(event.payload));
  return event.payload as Record<string, unknown>;
}
