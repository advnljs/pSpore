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
import { articleApi, finishText, finishTool, toolChunk, waitFor } from "../fixtures/article-api.js";

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
