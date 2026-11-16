import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!process.versions.electron) {
  const ts = await import("typescript");
  const temporary = await mkdtemp(join(tmpdir(), "pspore-context-fixture-"));
  const fixture = join(temporary, "api.mjs");
  const source = (await readFile(new URL("../test/fixtures/article-api.ts", import.meta.url), "utf8"))
    .replaceAll("../../src/", new URL("../dist/", import.meta.url).href);
  await writeFile(fixture, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  }).outputText);
  const flags = ["--lang=zh-CN", ...(process.env.PSPORE_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [])];
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 2048x1200x24", createRequire(import.meta.url)("electron"), ...flags, fileURLToPath(import.meta.url)], {
    cwd: root, env: { ...process.env, PSPORE_CONTEXT_FIXTURE: fixture }, stdio: "inherit",
  });
  const timer = process.env.PSPORE_SMOKE_KEEP_OPEN === "1" ? undefined : setTimeout(() => child.kill("SIGTERM"), 180_000);
  child.once("error", (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
  child.once("exit", (code) => {
    clearTimeout(timer); process.exitCode = code ?? 1;
    void rm(temporary, { recursive: true, force: true });
  });
} else {
  void run().catch(async (error) => {
    console.error(error);
    (await import("electron")).app.exit(1);
  });
}

async function run() {
  const { app, BrowserWindow, ipcMain } = await import("electron");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const { articleApi, waitFor } = await import(process.env.PSPORE_CONTEXT_FIXTURE);
  const { PsporeDaemon } = await import("../dist/daemon/daemon.js");
  const { DaemonBridge } = await import("../dist/desktop/daemon-bridge.js");
  const { desktopWindowOptions } = await import("../dist/desktop/security.js");
  const { loadConfig } = await import("../dist/storage/home.js");
  const { atomicWriteJson } = await import("../dist/storage/atomic.js");
  const home = await mkdtemp(join(tmpdir(), "pspore-context-gui-"));
  const output = process.env.PSPORE_CONTEXT_OUTPUT ?? join(home, "screenshots");
  await mkdir(output, { recursive: true });
  app.setPath("userData", join(home, "electron"));
  const api = await articleApi();
  let daemon, bridge, target;
  const errors = [];
  const report = { viewport: { width: 1920, height: 1080 }, home, stages: [] };
  try {
    const paths = await api.configure(home);
    const config = await loadConfig(home);
    config.context.autoCompaction = { enabled: true, triggerTokens: 6_000, reserveTokens: 1_024, keepRecentTokens: 100 };
    await atomicWriteJson(paths.config, config);
    const evidence = join(paths.workspace, "demo-evidence.txt");
    await writeFile(evidence, "Demo project evidence. ".repeat(4_000));
    daemon = await PsporeDaemon.start({ home });
    await app.whenReady();
    bridge = new DaemonBridge({ socketPath: paths.socket, stagingRoot: join(paths.workspace, "staging"),
      versions: { pspore: "context-smoke", pi: "0.84.1", electron: process.versions.electron, node: process.versions.node } });
    bridge.subscribe((frame) => {
      if (target && !target.isDestroyed()) target.webContents.send("pspore:desktop:frame", frame);
    });
    bridge.start();
    await waitFor(() => bridge.bootstrap().connection.phase === "connected", "bridge");
    ipcMain.handle("pspore:desktop:bootstrap", () => bridge.bootstrap());
    ipcMain.handle("pspore:desktop:dispatch", (_event, command) => bridge.dispatch(command));
    target = new BrowserWindow(desktopWindowOptions(resolve(root, "dist/desktop/preload.cjs")));
    target.setContentSize(1920, 1080);
    target.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
    await target.loadFile(resolve(root, "dist/desktop/renderer/index.html"));
    target.show();
    target.focus();
    target.webContents.focus();
    target.webContents.debugger.attach("1.3");
    const evaluate = (code) => target.webContents.executeJavaScript(code);
    const ready = () => waitFor(() => evaluate("document.documentElement.dataset.ready === 'true' && !document.querySelector('#composer-input').disabled"), "renderer");
    const click = async (selector) => {
      const point = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n || n.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(selector)}); n.scrollIntoView({block:'nearest'}); const r = n.getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)}; })()`);
      target.webContents.sendInputEvent({ type: "mouseMove", ...point });
      target.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      target.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await delay(70);
    };
    const send = async (text) => {
      await click("#composer-input");
      await target.webContents.debugger.sendCommand("Input.insertText", { text });
      assert.equal(await evaluate("document.querySelector('#composer-input').value"), text, "real keyboard input reaches composer");
      await click("#send-button");
      await waitFor(() => evaluate("document.querySelector('#composer-input').value === ''"), "composer sent");
    };
    const nextResponse = async () => {
      let timer;
      try { return await Promise.race([api.next(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Model request timeout")), 15_000); })]); }
      finally { clearTimeout(timer); }
    };
    const queue = () => daemon.kernel.snapshot().sessions.main?.queue;
    const waitQueue = (followUp, steering) => waitFor(() => queue()?.followUp.length === followUp && queue()?.steering.length === steering, "queue length");
    const capture = async (name) => {
      await delay(400);
      const state = await evaluate(`(() => {
        const root = document.querySelector('#compaction-panel');
        const bar = root.querySelector('[role=progressbar]');
        const controls = [...document.querySelectorAll('#compaction-panel, #message-queue button, #composer-form')].filter(n => n.getBoundingClientRect().height > 0);
        return {viewport:{width:innerWidth,height:innerHeight}, theme:document.documentElement.dataset.theme, language:document.documentElement.lang,
          overflow:document.documentElement.scrollWidth > innerWidth, visible: !root.hidden, status:root.dataset.status,
          progress:bar.getAttribute('aria-valuenow'), title:root.querySelector('.compaction-title').textContent,
          detail:root.querySelector('.compaction-detail').textContent, elapsed:root.querySelector('.compaction-elapsed').textContent,
          controlsVisible:controls.every(n => {const r=n.getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth;})}; })()`);
      assert.deepEqual(state.viewport, report.viewport);
      assert.equal(state.overflow, false);
      assert.equal(state.controlsVisible, true);
      report.stages.push({ name, ...state });
      console.log(`Captured ${name}`);
      await writeFile(join(output, `${name}.png`), (await target.webContents.capturePage()).toPNG());
      return state;
    };
    await ready();
    await delay(800);
    await capture("00-ready");
    await send("请核对演示材料，整理项目进展与下一步。保留关键事实。");
    const first = await nextResponse();
    // Cancel ordinary SDK-backed queues while a model request is in flight.
    await send("CANCELLED-FOLLOWUP");
    await send("请保留这条消息：补充下一步计划。");
    await send("CANCELLED-DIRECT");
    await waitQueue(3, 0);
    await click('.queue-message:nth-child(3) .queue-actions button:first-child');
    await waitQueue(2, 1);
    await capture("01-queued-messages");
    await click('.queue-message[data-queue-mode="direct"] .queue-cancel');
    await waitQueue(2, 0);
    await click('.queue-message[data-queue-mode="follow-up"] .queue-cancel');
    await waitQueue(1, 0);
    // The actual read tool trips auto-compaction at its completed batch.
    chunk(first, { tool_calls: [{ index: 0, id: "read-evidence", type: "function", function: { name: "read", arguments: JSON.stringify({ path: evidence }) } }] });
    finish(first, "tool_calls");
    const summary = await nextResponse();
    await waitFor(() => evaluate("!document.querySelector('#compaction-panel').hidden && document.querySelector('#compaction-panel').dataset.status === 'running'"), "compaction visible");
    assert.equal(await evaluate("document.querySelector('#compact-button').disabled"), true);
    const id = daemon.kernel.snapshot().sessions.main.compaction.id;
    await send("CANCELLED-HELD-FOLLOWUP");
    await send("CANCELLED-HELD-DIRECT");
    await waitQueue(3, 0);
    await click('.queue-message:nth-child(3) .queue-actions button:first-child');
    await waitQueue(2, 1);
    let view = await capture("02-compacting-light");
    assert.equal(view.progress, null, "no made-up percentage during summarization");
    const beforeMotion = await evaluate("getComputedStyle(document.querySelector('.compaction-fill')).transform");
    await delay(250);
    assert.notEqual(await evaluate("getComputedStyle(document.querySelector('.compaction-fill')).transform"), beforeMotion);
    await click("#theme-toggle");
    await capture("03-compacting-dark");
    await click("#language-toggle");
    await ready();
    await waitFor(() => evaluate("document.documentElement.lang === 'en'"), "English reload");
    view = await capture("04-reconnected-english");
    assert.equal(view.visible, true);
    assert.equal(view.title, "Compacting context");
    assert.equal(daemon.kernel.snapshot().sessions.main.compaction.id, id);
    await target.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.compaction-fill')).animationName"), "none");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.compaction-sheet')).animationName"), "none");
    await capture("05-reduced-motion");
    await target.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    await click('.queue-message[data-queue-mode="direct"] .queue-cancel');
    await waitQueue(2, 0);
    await click('.queue-message:nth-child(2) .queue-cancel');
    await waitQueue(1, 0);
    reply(summary, "Summary: evidence read once. Keep the original task and the queued plan request. All demo evidence is consistent.");
    reply(await nextResponse(), "## 项目进展\n\n演示材料核对完成，关键事实已保留。\n\n下一步：整理计划并确认责任人。");
    reply(await nextResponse(), "已补充下一步计划。完整记录可以继续查看。");
    await waitFor(() => daemon.kernel.snapshot().sessions.main.status === "idle", "run settled");
    await waitFor(() => evaluate("document.querySelector('#compaction-panel').dataset.status === 'succeeded'"), "completed progress");
    view = await capture("06-completed");
    assert.equal(view.progress, "100");
    assert.ok(api.requests.every((request) => !JSON.stringify(request).includes("CANCELLED-")), "cancelled messages never reach the model");
    await waitQueue(0, 0);
    // Manual compaction uses the same real lifecycle and must show errors too.
    await click("#compact-button");
    const manual = await nextResponse();
    await waitFor(() => daemon.kernel.snapshot().sessions.main.compaction.reason === "manual" && daemon.kernel.snapshot().sessions.main.compaction.status === "running", "manual summary");
    await capture("07-manual-compaction");
    reply(manual, "Summary: the original task and queued plan request are complete. No pending work.");
    await waitFor(() => daemon.kernel.snapshot().sessions.main.compaction.status === "succeeded", "manual completed");
    await click("#compact-button");
    await waitFor(() => evaluate("document.querySelector('#compaction-panel').dataset.status === 'failed'"), "already compacted failure");
    view = await capture("08-error-state");
    assert.notEqual(view.progress, "100");
    await click(".compaction-dismiss");
    assert.equal(await evaluate("document.querySelector('#compaction-panel').hidden"), true);
    await send("Read the demo evidence again, then wait.");
    const secondRead = await nextResponse();
    chunk(secondRead, { tool_calls: [{ index: 0, id: "read-again", type: "function", function: { name: "read", arguments: JSON.stringify({ path: evidence }) } }] });
    finish(secondRead, "tool_calls");
    await nextResponse();
    await waitFor(() => evaluate("document.querySelector('#compaction-panel').dataset.status === 'running'"), "second automatic compaction");
    await click("#abort-button");
    await waitFor(() => evaluate("document.querySelector('#compaction-panel').dataset.status === 'aborted'"), "aborted compaction");
    view = await capture("09-aborted");
    assert.equal(view.title, "Compaction stopped");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.compaction-fill')).animationName"), "none");
    assert.deepEqual(api.errors, []);
    assert.deepEqual(errors, []);
    report.cancelledAbsentFromRequests = true;
    report.rendererErrors = errors;
    await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Context/queue GUI passed: real clicks, queued and held cancellation, auto/manual progress, reload, two languages/themes, reduced motion and errors. Artifacts: ${output}`);
    if (process.env.PSPORE_SMOKE_KEEP_OPEN === "1") {
      console.log(`Preview remains open with isolated home ${home}`);
      await new Promise((resolve) => target.once("closed", resolve));
    }
  } finally {
    if (target && !target.isDestroyed()) target.destroy();
    await bridge?.stop();
    await daemon?.stop();
    await api.close();
    console.log(`GUI artifacts retained: ${output}`);
  }
  app.quit();
}

function chunk(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: "context-gui", object: "chat.completion.chunk", created: 0, model: "article-fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}
function finish(response, reason = "stop") {
  chunk(response, {}, reason);
  response.write(`data: ${JSON.stringify({ id: "context-gui", object: "chat.completion.chunk", created: 0, model: "article-fixture", choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}
function reply(response, text) { chunk(response, { content: text }); finish(response); }
