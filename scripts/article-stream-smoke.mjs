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
  const { articleApi, toolChunk, finishTool, finishText, waitFor } = await import(process.env.PSPORE_ARTICLE_FIXTURE);
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
  const report = { viewport: { width: 1920, height: 1080 }, cpuRate: 20, previewDelayMs: 250, stages: [] };
  try {
    const paths = await api.configure(home);
    daemon = await PsporeDaemon.start({ home });
    await app.whenReady();
    bridge = new DaemonBridge({ socketPath: paths.socket, stagingRoot: join(paths.workspace, "staging"),
      versions: { pspore: "article-smoke", pi: "0.84.1", electron: process.versions.electron, node: process.versions.node } });
    const events = [];
    bridge.subscribe((frame) => {
      if (frame.kind === "event") events.push(frame.event);
      if (target && !target.isDestroyed()) target.webContents.send("pspore:desktop:frame", frame);
    });
    bridge.start();
    await waitFor(() => bridge.bootstrap().connection.phase === "connected", "bridge");
    ipcMain.handle("pspore:desktop:bootstrap", () => bridge.bootstrap());
    ipcMain.handle("pspore:desktop:dispatch", async (_event, command) => {
      if (command.action === "article.preview") await delay(report.previewDelayMs);
      return bridge.dispatch(command);
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
    toolChunk(revision, "gui-update", "\"}]}", false);
    finishTool(revision);
    finishText(await api.next());
    await waitFor(async () => (await state()).versions.includes("v2"), "revision committed");
    await capture("05-committed-revision");
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
    assert.deepEqual(rendererErrors, []);
    assert.deepEqual(api.errors, []);
    assert.equal(bridge.bootstrap().connection.attempt, 0);
    await writeFile(join(home, "report.json"), JSON.stringify(report, null, 2));
    succeeded = true;
    console.log(`Article GUI passed: 1920x1080, buffered API, 20x CPU slowdown, 250ms draft reads, ${samples.length} live edits. Evidence: ${home}`);
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
