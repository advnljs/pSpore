import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const until = Date.now() + 15_000;
  while (!await check()) { if (Date.now() > until) throw new Error(`Timed out: ${label}`); await delay(50); }
}

if (!process.versions.electron) {
  const flags = ["--lang=zh-CN", ...(process.env.PSPORE_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [])];
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 2048x1200x24", createRequire(import.meta.url)("electron"), ...flags, fileURLToPath(import.meta.url)], { cwd: root, env: process.env, stdio: "inherit" });
  const timer = process.env.PSPORE_SMOKE_KEEP_OPEN === "1" ? undefined : setTimeout(() => child.kill("SIGTERM"), 150_000);
  child.once("error", (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
  child.once("exit", (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  void run().catch(async (error) => { console.error(error); (await import("electron")).app.exit(1); });
}

async function run() {
  const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = await import("electron");
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const { PsporeDaemon } = await import("../dist/daemon/daemon.js");
  const { NotificationService } = await import("../dist/notifications/notification-service.js");
  const { DaemonBridge } = await import("../dist/desktop/daemon-bridge.js");
  const { DesktopNotifications, openNotificationTarget } = await import("../dist/desktop/desktop-notifications.js");
  const { desktopWindowOptions } = await import("../dist/desktop/security.js");
  const { installSessionSecurity, hardenWindow } = await import("../dist/desktop/window-security.js");
  const { setInterfaceLocale } = await import("../dist/desktop/main-i18n.js");
  const { initializePsporeHome } = await import("../dist/storage/home.js");
  const { LlmSettingsService } = await import("../dist/settings/llm-settings-service.js");
  const home = await mkdtemp(join(tmpdir(), "pspore-notification-gui-"));
  const output = process.env.PSPORE_NOTIFICATION_OUTPUT ?? join(home, "screenshots");
  await mkdir(output, { recursive: true });
  app.setPath("userData", join(home, "electron"));
  const report = { viewport: { width: 1920, height: 1080 }, home, checks: [], captures: [] };
  let daemon, bridge, controller, target, service;
  const errors = [];
  let retained = false;
  try {
    const { paths } = await initializePsporeHome(home);
    await new LlmSettingsService(home, paths).save({ provider: "custom-openai", model: "notification-demo", customModel: true,
      api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", thinking: "off", permissionMode: "ask_risky",
      apiKey: "local-test-placeholder", clearApiKey: false, clearCookie: false });
    daemon = await PsporeDaemon.start({ home });
    service = new NotificationService({ path: join(daemon.paths.events, "notification-smoke.jsonl"), recoveryDirectory: join(daemon.paths.artifacts, "recovery"),
      onNotification: async (notification) => { await daemon.kernel.dispatch({ id: randomUUID(), ts: new Date().toISOString(), type: "notification.created", notification }); } });
    await service.initialize();
    const notify = (title, extra = {}) => service.notify({ title, body: "周报已整理完成。关键进展与下一步行动已保存，点击即可继续这段对话。", level: "success", source: { kind: "agent", sessionId: "main" }, ...extra });
    await notify("Historical notification");
    await app.whenReady();
    installSessionSecurity();
    setInterfaceLocale("zh-CN");
    bridge = new DaemonBridge({ socketPath: daemon.paths.socket, stagingRoot: join(home, "workspace/staging"),
      versions: { pspore: "notification-smoke", pi: "0.84.1", electron: process.versions.electron, node: process.versions.node } });
    bridge.start();
    await waitFor(() => bridge.bootstrap().connection.phase === "connected", "bridge");
    const destination = await bridge.dispatch({ action: "session.create", title: "项目周报 · 下一步行动" });
    const other = await bridge.dispatch({ action: "session.create", title: "另一个会话" });
    ipcMain.handle("pspore:desktop:bootstrap", () => bridge.bootstrap());
    ipcMain.handle("pspore:desktop:dispatch", (_event, command) => bridge.dispatch(command));
    target = new BrowserWindow(desktopWindowOptions(join(root, "dist/desktop/preload.cjs")));
    target.setContentSize(1920, 1080);
    target.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
    const rendererUrl = new URL("../dist/desktop/renderer/index.html", import.meta.url);
    hardenWindow(target, rendererUrl.href);
    controller = new DesktopNotifications({ target, bootstrap: () => bridge.bootstrap(),
      open: (sessionId) => openNotificationTarget(target, () => bridge.bootstrap(), sessionId), quit: () => app.quit() });
    target.on("close", (event) => controller.hideOnClose(event));
    bridge.subscribe((frame) => { target.webContents.send("pspore:desktop:frame", frame); controller.receive(frame); });
    await target.loadFile(fileURLToPath(rendererUrl));
    target.show(); target.focus();
    const evaluate = (code) => target.webContents.executeJavaScript(code);
    await waitFor(() => evaluate("document.documentElement.dataset.ready === 'true'"), "workspace ready");
    assert.deepEqual(await evaluate("({width:innerWidth,height:innerHeight})"), report.viewport);
    const popup = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("/notification/index.html"));
    const visible = () => Boolean(popup()?.isVisible());
    const popupReady = async (title) => {
      await waitFor(() => visible() && popup().webContents.executeJavaScript(`document.querySelector('#title').textContent === ${JSON.stringify(title)}`), `notification ${title}`);
    };
    const check = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };
    const capture = async (name) => {
      await delay(400);
      const view = popup();
      const probe = await view.webContents.executeJavaScript(`({theme:document.documentElement.dataset.theme, locale:document.documentElement.lang,
        node:typeof process, workspaceApi:typeof window.pspore, api:Object.keys(window.psporeNotification).sort(),
        overflow:document.documentElement.scrollWidth>innerWidth || document.documentElement.scrollHeight>innerHeight,
        title:document.querySelector('#title').textContent, button:document.querySelector('#open').textContent,
        controls:[...document.querySelectorAll('button')].every(n=>{const r=n.getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})})`);
      assert.equal(probe.overflow, false); assert.equal(probe.controls, true);
      assert.equal(probe.node, "undefined"); assert.equal(probe.workspaceApi, "undefined");
      assert.deepEqual(probe.api, ["act", "current", "subscribe"]);
      report.captures.push({ name, bounds: view.getBounds(), ...probe });
      await writeFile(join(output, `${name}.png`), (await view.webContents.capturePage()).toPNG());
    };
    const click = async (win, selector) => {
      const point = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
      win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await delay(100);
    };
    assert.equal(visible(), false); check("initial history is silent");
    await waitFor(() => target.isFocused(), "main focused");
    await notify("Already reading"); await delay(250);
    assert.equal(visible(), false); check("focused workspace suppresses popup");
    const otherApp = new BrowserWindow({ width: 320, height: 240, title: "Demo application",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await otherApp.loadURL("data:text/html,<title>Demo application</title><p>Working in another application</p>");
    otherApp.show(); otherApp.focus();
    await waitFor(() => !target.isFocused() && otherApp.isFocused(), "other application focused");
    await notify("Working in another application");
    await popupReady("Working in another application");
    assert.equal(target.isVisible(), true); assert.equal(otherApp.isFocused(), true);
    check("visible but unfocused workspace notifies without stealing focus");
    controller.dismiss(); otherApp.destroy(); target.focus();
    await waitFor(() => target.isFocused(), "workspace focused again");
    target.close();
    assert.equal(target.isDestroyed(), false); assert.equal(target.isVisible(), false);
    check("close keeps background notification receiver alive");
    await notify("你的项目周报已准备好", { source: { kind: "agent", sessionId: destination.sessionId } });
    await popupReady("你的项目周报已准备好");
    assert.equal(popup().isFocused(), false); assert.equal(target.isVisible(), false);
    const area = screen.getDisplayMatching(target.getBounds()).workArea;
    const bounds = popup().getBounds();
    assert.equal(bounds.x + bounds.width, area.x + area.width - 16);
    assert.equal(bounds.y + bounds.height, area.y + area.height - 16);
    await capture("01-notification-light");
    const screens = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: screen.getPrimaryDisplay().size });
    await writeFile(join(output, "02-desktop-bottom-right.png"), screens[0].thumbnail.toPNG());
    check("bottom-right position and inactive presentation");
    await click(popup(), "#open");
    await waitFor(() => target.isVisible() && evaluate("document.querySelector('#session-title').textContent.includes('项目周报')"), "destination session");
    assert.equal(visible(), false); check("mouse click restores correct session");
    // A command originating from the workspace cannot use the popup-only channel.
    const handler = ipcMain._invokeHandlers.get("pspore:notification:action");
    await assert.rejects(() => handler({ sender: target.webContents, senderFrame: target.webContents.mainFrame }, "open", "id"), /untrusted/);
    check("popup IPC rejects workspace sender");
    target.hide();
    const first = await notify("Earlier update");
    await popupReady("Earlier update");
    const id = popup().id;
    await notify("Another update");
    await notify("最新进展：三项任务已完成", { source: { kind: "agent", sessionId: destination.sessionId } });
    await popupReady("最新进展：三项任务已完成");
    assert.equal(popup().id, id);
    assert.equal(await popup().webContents.executeJavaScript("document.querySelector('#count').textContent"), "3 条新通知");
    await popup().webContents.executeJavaScript(`window.psporeNotification.act('open', ${JSON.stringify(first.id)})`);
    assert.equal(target.isVisible(), false); check("burst coalesces and stale button cannot navigate");
    await capture("03-latest-with-count");
    // Real pointer hover suspends auto-dismiss, including after the original deadline.
    popup().webContents.sendInputEvent({ type: "mouseMove", x: 120, y: 130 });
    await delay(12_500);
    assert.equal(visible(), true); check("hover pauses expiration");
    popup().webContents.sendInputEvent({ type: "mouseLeave", x: -1, y: -1 });
    await popup().webContents.executeJavaScript("document.activeElement?.blur()");
    await waitFor(() => !visible(), "auto-dismiss after pointer leaves"); check("auto-dismiss resumes");
    await evaluate("localStorage.setItem('pspore.desktop.theme','dark')");
    setInterfaceLocale("en"); controller.updateLocale();
    await notify("Your workspace needs attention", { level: "warning", body: "A scheduled task is waiting for your review. Open the conversation to pick up where you left off.", source: { kind: "agent", sessionId: destination.sessionId } });
    await popupReady("Your workspace needs attention");
    await capture("04-notification-dark-english");
    assert.equal(report.captures.at(-1).theme, "dark");
    assert.match(report.captures.at(-1).button, /Open session/);
    popup().webContents.debugger.attach("1.3");
    await popup().webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.equal(await popup().webContents.executeJavaScript("getComputedStyle(document.querySelector('.card')).animationName"), "none");
    check("theme, locale and reduced motion");
    await click(popup(), "#dismiss"); assert.equal(visible(), false);
    await bridge.stop();
    await notify("Arrived while disconnected", { source: { kind: "agent", sessionId: destination.sessionId } });
    bridge.start();
    await popupReady("Arrived while disconnected");
    await click(popup(), "#dismiss");
    await bridge.stop(); bridge.start();
    await waitFor(() => bridge.bootstrap().connection.phase === "connected", "reconnected");
    await delay(300); assert.equal(visible(), false); check("reconnect recovers only unseen notifications");
    await notify("<img src=x onerror=alert(1)>", { body: "长消息安全预览".repeat(400), source: { kind: "agent", sessionId: other.sessionId } });
    await popupReady("<img src=x onerror=alert(1)>");
    assert.equal(await popup().webContents.executeJavaScript("document.querySelector('#title img') === null"), true);
    await capture("05-long-text-safe");
    await bridge.dispatch({ action: "session.delete", sessionId: other.sessionId });
    await click(popup(), "#open");
    await waitFor(() => evaluate("document.documentElement.dataset.inspector === 'open' && !document.querySelector('#panel-activity').hidden"), "deleted-session fallback");
    check("deleted session opens notification history and text stays inert");
    target.minimize(); await waitFor(() => target.isMinimized(), "minimized");
    await notify("Minimized workspace", { source: { kind: "agent", sessionId: destination.sessionId } });
    await popupReady("Minimized workspace");
    await click(popup(), "#open");
    await waitFor(() => !target.isMinimized() && target.isVisible(), "restored");
    check("minimized workspace restores");
    assert.deepEqual(errors, []);
    await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(`Notification smoke passed: ${output}`);
    if (process.env.PSPORE_SMOKE_KEEP_OPEN === "1") {
      retained = true;
      setInterfaceLocale("zh-CN");
      await evaluate("localStorage.setItem('pspore.desktop.theme','light')");
      target.hide();
      await notify("你的项目周报已准备好", { source: { kind: "agent", sessionId: destination.sessionId } });
      await popupReady("你的项目周报已准备好");
      await popup().webContents.executeJavaScript("window.psporeNotification.current().then(c=>window.psporeNotification.act('pause',c.id))");
      return;
    }
  } finally {
    if (!retained) { controller?.dispose(); await bridge?.stop(); await daemon?.stop(); }
  }
  app.exit(0);
}
