import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!process.versions.electron) {
  // Electron's builtin-module loader does not support tsx's scoped imports.
  // Compile only the shared test fixture into a disposable directory.
  const ts = await import("typescript");
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "pspore-article-fixture-"));
  const fixturePath = join(fixtureDirectory, "api.mjs");
  const fixtureSource = (await readFile(new URL("../test/fixtures/article-api.ts", import.meta.url), "utf8"))
    .replaceAll("../../src/", new URL("../dist/", import.meta.url).href);
  await writeFile(fixturePath, ts.transpileModule(fixtureSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  }).outputText);
  const electron = createRequire(import.meta.url)("electron");
  const flags = process.env.PSPORE_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 2048x1200x24", electron, ...flags, fileURLToPath(import.meta.url)], {
    cwd: root, env: { ...process.env, PSPORE_ARTICLE_FIXTURE: fixturePath }, stdio: "inherit",
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
  child.once("error", (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
  child.once("exit", (code) => {
    clearTimeout(timer); process.exitCode = code ?? 1;
    void rm(fixtureDirectory, { recursive: true, force: true });
  });
} else {
  void run().catch(async (error) => {
    console.error(error);
    const { app } = await import("electron");
    app.exit(1);
  });
}

async function run() {
  const { app, BrowserWindow, ipcMain } = await import("electron");
  app.disableHardwareAcceleration();
  // Keep Electron alive until the isolated daemon, API, and bridge have closed.
  app.on("window-all-closed", () => {});
  const { articleApi, toolChunk, finishTool, finishText, textChunk, finishCompletion, waitFor } = await import(process.env.PSPORE_ARTICLE_FIXTURE);
  const { PsporeDaemon } = await import("../dist/daemon/daemon.js");
  const { DaemonBridge } = await import("../dist/desktop/daemon-bridge.js");
  const { desktopWindowOptions } = await import("../dist/desktop/security.js");
  const { ArticleStore } = await import("../dist/articles/store.js");
  const { parseArticleReceipt } = await import("../dist/articles/receipt.js");
  const home = await mkdtemp(join(tmpdir(), "pspore-article-gui-"));
  app.setPath("userData", join(home, "electron"));
  const output = join(home, "screenshots");
  await mkdir(output);
  const api = await articleApi();
  let daemon;
  let bridge;
  let target;
  let succeeded = false;
  const rendererErrors = [];
  let forwardPreviews = true;
  let failPreviewReads = 0;
  let failedPreviewReads = 0;
  let activePreviewReads = 0;
  let maxPreviewReads = 0;
  let previewReads = 0;
  const report = { viewport: { width: 1920, height: 1080 }, cpuRate: 20, previewDelayMs: 250, stages: [] };
  try {
    const paths = await api.configure(home);
    daemon = await PsporeDaemon.start({ home });
    await app.whenReady();
    bridge = new DaemonBridge({ socketPath: paths.socket, stagingRoot: join(paths.workspace, "staging"),
      versions: { pspore: "article-smoke", pi: "0.84.1", electron: process.versions.electron, node: process.versions.node } });
    const events = [];
    const skippedPreviews = new Map();
    bridge.subscribe((frame) => {
      if (frame.kind === "event") events.push(frame.event);
      // Model the gateway's transient-event shedding, including its sequence
      // bookkeeping. Dropping frames without `skipped` would freeze chat on a
      // protocol gap and make the transcript isolation assertions meaningless.
      if (!forwardPreviews && frame.kind === "event" && frame.event.type === "article.preview") {
        const { streamId, skipped = 0 } = frame.event;
        skippedPreviews.set(streamId, (skippedPreviews.get(streamId) ?? 0) + skipped + 1);
        return;
      }
      if (frame.kind === "event" || frame.kind === "delta") {
        const envelope = frame.kind === "event" ? frame.event : frame;
        const skipped = skippedPreviews.get(envelope.streamId) ?? 0;
        if (skipped) {
          skippedPreviews.delete(envelope.streamId);
          frame = frame.kind === "event"
            ? { ...frame, event: { ...frame.event, skipped: (envelope.skipped ?? 0) + skipped } }
            : { ...frame, skipped: (envelope.skipped ?? 0) + skipped };
        }
      }
      if (target && !target.isDestroyed()) target.webContents.send("pspore:desktop:frame", frame);
    });
    bridge.start();
    await waitFor(() => bridge.bootstrap().connection.phase === "connected", "bridge");
    ipcMain.handle("pspore:desktop:bootstrap", () => bridge.bootstrap());
    ipcMain.handle("pspore:desktop:dispatch", async (_event, command) => {
      if (command.action !== "article.preview") return bridge.dispatch(command);
      previewReads++;
      maxPreviewReads = Math.max(maxPreviewReads, ++activePreviewReads);
      try {
        await delay(report.previewDelayMs);
        if (failPreviewReads > 0) {
          failPreviewReads--;
          failedPreviewReads++;
          throw new Error("Transient draft read failure (fixture)");
        }
        return await bridge.dispatch(command);
      } finally {
        activePreviewReads--;
      }
    });
    target = new BrowserWindow(desktopWindowOptions(resolve(root, "dist/desktop/preload.cjs")));
    target.setContentSize(1920, 1080);
    target.webContents.on("console-message", (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
    target.webContents.on("render-process-gone", (_event, details) => rendererErrors.push(details.reason));
    await target.loadFile(resolve(root, "dist/desktop/renderer/index.html"));
    target.show();
    target.webContents.debugger.attach("1.3");
    await target.webContents.debugger.sendCommand("Emulation.setCPUThrottlingRate", { rate: report.cpuRate });
    const state = () => target.webContents.executeJavaScript(`(() => ({
      open: !document.querySelector('#article-panel').hidden,
      text: document.querySelector('#article-render').textContent,
      status: document.querySelector('#article-status').textContent,
      title: document.querySelector('#article-title').textContent,
      versions: Array.from(document.querySelectorAll('.article-version')).map(n => n.textContent),
      overflow: document.documentElement.scrollWidth > innerWidth,
      viewport: { width: innerWidth, height: innerHeight }
    }))()`);
    const capture = async (name) => {
      const current = await state();
      assert.deepEqual(current.viewport, report.viewport);
      assert.equal(current.overflow, false);
      assert.doesNotMatch(await target.webContents.executeJavaScript("document.body.textContent"), /事件流 .* 出现缺口/);
      report.stages.push({ name, ...current });
      await writeFile(join(output, `${name}.png`), (await target.webContents.capturePage()).toPNG());
    };
    await waitFor(() => target.webContents.executeJavaScript("!!window.pspore && !document.querySelector('#composer-input').disabled"), "renderer");
    const prompt = (text) => target.webContents.executeJavaScript(`window.pspore.dispatch(${JSON.stringify({ action: "prompt", sessionId: "main", text })})`);
    await prompt("写一篇接口兼容验证文稿");
    const opening = await api.next();
    toolChunk(opening, "gui-open", JSON.stringify({ action: "open", title: "接口兼容验证" }));
    finishTool(opening);
    const writing = await api.next();
    await waitFor(async () => (await state()).open && (await state()).status.includes("等待正文"), "open before any body bytes");
    assert.equal((await state()).text, "");
    assert.deepEqual((await state()).versions, []);
    await capture("01-open-before-buffered-body");
    const body = "# 接口兼容验证\n\n这里保留已有文稿。\n\n需要修改的段落。\n\n结尾保持不变。";
    toolChunk(writing, "gui-create", JSON.stringify({ action: "create", title: "接口兼容验证", content: body }));
    finishTool(writing);
    finishText(await api.next());
    await waitFor(async () => (await state()).versions.includes("v1"), "buffered create committed");
    const result = events.find((event) => event.type === "tool.completed" && event.payload.toolCallId === "gui-create").payload.result;
    const receipt = parseArticleReceipt(result.content[0].text);
    assert.ok(receipt);
    await capture("02-buffered-create");

    // Close and then reopen the existing article while the next response has
    // sent no arguments. The saved version must already be readable.
    await target.webContents.executeJavaScript("document.querySelector('#article-close').click()");
    await waitFor(async () => !(await state()).open, "closed");
    await prompt("修改其中一段");
    const reopening = await api.next();
    toolChunk(reopening, "gui-reopen", JSON.stringify({ action: "open", id: receipt.id }));
    finishTool(reopening);
    const revision = await api.next();
    await waitFor(async () => (await state()).open && (await state()).status.includes("等待修改"), "existing article opened before revision");
    assert.match((await state()).text, /这里保留已有文稿/);
    await capture("03-reopen-before-revision");

    const samples = [];
    toolChunk(revision, "gui-update", `{"action":"update","id":"${receipt.id}","edits":[{"find":"需要修改的段落。","replace":"`);
    let sending = true;
    const producer = (async () => {
      for (let index = 1; index <= 20; index++) {
        toolChunk(revision, "gui-update", `第${index}段增量文字，`, false);
        await delay(120);
      }
      sending = false;
    })();
    while (sending) {
      await delay(100);
      const current = await state();
      assert.match(current.text, /结尾保持不变/);
      assert.deepEqual(current.versions, ["v1"]);
      if (current.text.includes("第1段") && samples.at(-1) !== current.text.length) samples.push(current.text.length);
    }
    await producer;
    await waitFor(async () => (await state()).text.includes("第20段"), "latest live edit");
    assert.ok(samples.length >= 3, "repeated preview events must not starve slow draft reads");
    report.liveSamples = samples;
    await capture("04-streaming-before-tool-end");
    // Slow clients may lose transient events. After showing a few words,
    // recover both a failed read and the new body with no further notification.
    forwardPreviews = false;
    failPreviewReads = 1;
    toolChunk(revision, "gui-update", "通知丢失后仍持续刷新。", false);
    await waitFor(async () => (await state()).text.includes("通知丢失后仍持续刷新"), "recover draft without another preview event");
    assert.equal(failedPreviewReads, 1);
    assert.deepEqual((await state()).versions, ["v1"]);
    assert.equal(maxPreviewReads, 1, "recovery must share the single in-flight read");
    await target.webContents.executeJavaScript(`window.articleMutations = 0;
      window.articleObserver = new MutationObserver(() => window.articleMutations++);
      window.articleObserver.observe(document.querySelector('#article-render'), { childList: true, subtree: true, attributes: true });`);
    await delay(900);
    assert.equal(await target.webContents.executeJavaScript("window.articleMutations"), 0, "unchanged drafts must not repaint during recovery polling");
    await target.webContents.executeJavaScript("window.articleObserver.disconnect()");
    await capture("04b-recovered-without-events");
    forwardPreviews = true;
    toolChunk(revision, "gui-update", "\"}]}", false);
    finishTool(revision);
    finishText(await api.next());
    await waitFor(async () => (await state()).versions.includes("v2"), "revision committed");
    await capture("05-committed-revision");
    await waitFor(() => activePreviewReads === 0, "finish outstanding read");
    const readsAfterCommit = previewReads;
    await delay(700);
    assert.equal(previewReads, readsAfterCommit, "committed drafts must stop polling");
    report.recovery = { failedPreviewReads, maxPreviewReads, recoveredBeforeCommit: true };
    const articles = new ArticleStore(join(paths.workspace, "articles"));
    assert.equal((await articles.read({ sessionId: "main", id: receipt.id, limit: 10_000 })).versions.length, 2);

    await prompt("验证失败的修改保留已保存正文");
    const beforeFailure = await api.next();
    toolChunk(beforeFailure, "gui-open-failure", JSON.stringify({ action: "open", id: receipt.id }));
    finishTool(beforeFailure);
    const failing = await api.next();
    await waitFor(async () => (await state()).status.includes("等待修改"), "open before rejected write");
    toolChunk(failing, "gui-failed", JSON.stringify({ action: "update", id: receipt.id, edits: [{ find: "不存在的引文", replace: "无效修改" }] }));
    finishTool(failing);
    finishText(await api.next());
    await waitFor(async () => (await state()).status === "这一版没有写入", "rejected write");
    assert.deepEqual((await state()).versions, ["v1", "v2"]);
    assert.match((await state()).text, /第20段/);
    await capture("06-write-rejected");

    await prompt("再准备一篇新文稿");
    const fresh = await api.next();
    toolChunk(fresh, "gui-new", JSON.stringify({ action: "open", title: "第二篇文稿" }));
    finishTool(fresh);
    const final = await api.next();
    await waitFor(async () => (await state()).title === "第二篇文稿", "fresh document");
    assert.equal((await state()).text, "", "another document must not remain underneath the draft");
    finishText(final);
    await waitFor(async () => (await state()).status === "尚未写入新内容", "settled without a draft");
    await capture("07-open-without-write");

    await prompt("打开后中止，不保存正文");
    const beforeAbort = await api.next();
    toolChunk(beforeAbort, "gui-open-abort", JSON.stringify({ action: "open", title: "中止验证" }));
    finishTool(beforeAbort);
    await api.next();
    await waitFor(async () => (await state()).status.includes("等待正文"), "waiting before abort");
    await bridge.dispatch({ action: "abort", sessionId: "main" });
    await waitFor(async () => (await state()).status === "尚未写入新内容", "aborted before body");
    assert.deepEqual((await state()).versions, []);
    assert.equal((await articles.list("main")).length, 1);
    await capture("08-aborted-before-body");

    // Exercise a full, growing Markdown document as well as short edits.
    await prompt("持续输出长文");
    const longDraft = await api.next();
    toolChunk(longDraft, "gui-long", '{"action":"create","title":"长文持续刷新","content":"# 长文持续刷新\\n\\n开头');
    await waitFor(async () => (await state()).text.includes("开头"), "first words of long draft");
    const longSamples = [];
    let longSending = true;
    const longProducer = (async () => {
      for (let section = 1; section <= 30; section++) {
        const paragraph = `\n\n## 第${section}节\n\n${'长文中保留中文、引号"、路径 C:\\draft 和换行，持续检查正文刷新。'.repeat(12)}`;
        toolChunk(longDraft, "gui-long", JSON.stringify(paragraph).slice(1, -1), false);
        await delay(120);
      }
      longSending = false;
    })();
    while (longSending) {
      await delay(100);
      const current = await state();
      assert.deepEqual(current.versions, []);
      if (longSamples.at(-1) !== current.text.length) longSamples.push(current.text.length);
    }
    await longProducer;
    await waitFor(async () => (await state()).text.includes("第30节"), "full long draft before tool end");
    assert.ok(longSamples.length >= 3, "long content must keep painting before completion");
    report.longSamples = longSamples;
    await capture("09-long-draft-before-tool-end");
    // Aborting a live draft stops recovery reads and creates no phantom version.
    await bridge.dispatch({ action: "abort", sessionId: "main" });
    await waitFor(async () => (await state()).status === "这一版没有写入", "abort live draft");
    await waitFor(() => activePreviewReads === 0, "finish aborted read");
    const readsAfterAbort = previewReads;
    await delay(700);
    assert.equal(previewReads, readsAfterAbort, "aborted drafts must stop polling");
    assert.equal((await articles.list("main")).length, 1);

    // The target proxy streams chat text but buffers ALL tool arguments. A
    // short write call must switch to a tools-free text response for the body.
    await prompt("创建一篇通过文本流生成的长文");
    // The transcript is virtualized; scroll the new message into view before
    // asserting its DOM text, rather than depending on the previous scroll.
    await waitFor(() => target.webContents.executeJavaScript("(() => { const list = document.querySelector('#transcript'); list.scrollTop = list.scrollHeight; return list.textContent.includes('创建一篇通过文本流生成的长文'); })()"), "chat remains live during article writing");
    const writeCall = await api.next();
    toolChunk(writeCall, "gui-text-write", JSON.stringify({ action: "write", title: "普通文本流验证", instruction: "撰写一篇分为30节的文稿" }));
    finishTool(writeCall);
    const mistakenReceipt = await api.next();
    assert.equal(api.requests.at(-1).tools, undefined);
    await waitFor(async () => (await state()).open && (await state()).title === "普通文本流验证", "writer opened before text arrives");
    textChunk(mistakenReceipt, "开篇写好了，面板里可以看到全文。今天先收工，明天继续写第二章。");
    await waitFor(async () => (await state()).text.includes("开篇写好了"), "receipt is only a live draft");
    finishCompletion(mistakenReceipt);
    const bodyStream = await api.next();
    assert.equal(api.requests.at(-1).tools, undefined);
    assert.match(JSON.stringify(api.requests.at(-1).messages), /NOT saved/);
    await waitFor(async () => !(await state()).text.includes("开篇写好了"), "retry clears rejected receipt");
    assert.deepEqual((await state()).versions, []);
    textChunk(bodyStream, "# 普通文本流验证\n\n正文专用文本片段：开头。");
    await waitFor(async () => (await state()).text.includes("正文专用文本片段"), "writer first text before completion");
    const textSamples = [];
    let textSending = true;
    const textProducer = (async () => {
      for (let section = 1; section <= 30; section++) {
        textChunk(bodyStream, `\n\n## 文本第${section}节\n\n${'正文走普通文本流，工具参数已经完整返回；这里验证面板随正文持续刷新。'.repeat(12)}`);
        await delay(120);
      }
      textSending = false;
    })();
    while (textSending) {
      await delay(100);
      const current = await state();
      assert.deepEqual(current.versions, []);
      if (textSamples.at(-1) !== current.text.length) textSamples.push(current.text.length);
    }
    await textProducer;
    await waitFor(async () => (await state()).text.includes("文本第30节"), "all text visible before text response finishes");
    assert.ok(textSamples.length >= 3);
    assert.doesNotMatch(await target.webContents.executeJavaScript("document.querySelector('#transcript').textContent"), /正文专用文本片段/);
    assert.doesNotMatch(JSON.stringify(events), /正文专用文本片段/);
    assert.equal((await articles.list("main")).length, 1, "streaming text is still an unsaved draft");
    report.textStreamSamples = textSamples;
    await capture("10-text-stream-before-completion");
    finishCompletion(bodyStream);
    finishText(await api.next());
    await waitFor(async () => (await state()).versions.includes("v1"), "text writer committed once");
    const textResult = events.find((event) => event.type === "tool.completed" && event.payload.toolCallId === "gui-text-write").payload.result;
    const textReceipt = parseArticleReceipt(textResult.content[0].text);
    assert.ok(textReceipt);
    await capture("11-text-stream-committed");

    const revisedBody = "# 普通文本流验证\n\n成功修订后的正文。";
    for (const ending of ["success", "length", "receipt", "abort"]) {
      await prompt(`通过文本流修订，验证 ${ending}`);
      const revisionCall = await api.next();
      toolChunk(revisionCall, `gui-text-${ending}`, JSON.stringify({ action: "write", id: textReceipt.id, instruction: "保留标题，修订正文" }));
      finishTool(revisionCall);
      const revisionStream = await api.next();
      assert.equal(api.requests.at(-1).tools, undefined, "revision history must not trigger the proxy's tool path");
      const receiptOnly = "开篇写好了，面板里可以看到全文。今天先收工，明天继续写第二章。";
      textChunk(revisionStream, ending === "success" ? revisedBody : ending === "receipt" ? receiptOnly : "# 普通文本流验证\n\n不应保存的半篇正文。");
      await waitFor(async () => (await state()).text.includes(ending === "success" ? "成功修订" : ending === "receipt" ? "开篇写好了" : "不应保存"), `live text revision ${ending}`);
      if (ending === "receipt") {
        finishCompletion(revisionStream);
        const failedRetry = await api.next();
        assert.equal(api.requests.at(-1).tools, undefined);
        textChunk(failedRetry, receiptOnly);
        finishCompletion(failedRetry);
        finishText(await api.next());
      } else if (ending === "abort") await bridge.dispatch({ action: "abort", sessionId: "main" });
      else {
        finishCompletion(revisionStream, ending === "length" ? "length" : "stop");
        finishText(await api.next());
      }
      await waitFor(async () => ending === "success" ? (await state()).versions.includes("v2") : (await state()).status === "这一版没有写入", `text revision ${ending} ended`);
      const saved = await articles.read({ sessionId: "main", id: textReceipt.id, limit: 20_000 });
      assert.equal(saved.text, revisedBody);
      assert.equal(saved.versions.length, 2);
      assert.doesNotMatch((await state()).text, /不应保存/);
      assert.doesNotMatch((await state()).text, /开篇写好了/);
    }
    await capture("12-text-stream-failure-restores-version");
    assert.deepEqual(rendererErrors, []);
    assert.deepEqual(api.errors, []);
    assert.equal(bridge.bootstrap().connection.attempt, 0);
    await writeFile(join(home, "report.json"), JSON.stringify(report, null, 2));
    succeeded = true;
    console.log(`Article GUI passed: 1920x1080, 20x CPU slowdown, 250ms reads, ${samples.length} live edits, ${longSamples.length} long-draft updates, ${textSamples.length} plain-text stream updates, receipt retry/rejection, recovery/abort/truncation. Evidence: ${home}`);
  } catch (error) {
    console.error(error);
    console.error(`Article GUI evidence: ${home}`);
  } finally {
    target?.destroy();
    await bridge?.stop();
    await daemon?.stop();
    await api.close();
    if (succeeded && process.env.PSPORE_KEEP_SMOKE !== "1") await rm(home, { recursive: true, force: true });
    app.exit(succeeded ? 0 : 1);
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
