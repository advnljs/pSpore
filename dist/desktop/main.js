import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, screen, session } from "electron";
import { resolvePsporeHome } from "../config/config.js";
import { DaemonSupervisor } from "../daemon/supervisor.js";
import { stopLegacyDaemon } from "../service/legacy-daemon.js";
import { serviceLaunchSpec } from "../service/service-launch.js";
import { SystemServiceManager } from "../service/system-service.js";
import { IndexingSettingsService } from "../settings/indexing-settings-service.js";
import { LlmSettingsService } from "../settings/llm-settings-service.js";
import { BYPASS_PERMISSION_MODE } from "../settings/llm-settings.js";
import { initializePsporeHome } from "../storage/home.js";
import { PI_VERSION, PSPORE_VERSION } from "../version.js";
import { DaemonBridge } from "./daemon-bridge.js";
import { DESKTOP_BOOTSTRAP_CHANNEL, DESKTOP_DISPATCH_CHANNEL, DESKTOP_FRAME_CHANNEL, DESKTOP_INDEXING_GET_CHANNEL, DESKTOP_INDEXING_PICK_CHANNEL, DESKTOP_INDEXING_SAVE_CHANNEL, DESKTOP_SETTINGS_GET_CHANNEL, DESKTOP_SETTINGS_SAVE_CHANNEL, decodeDesktopIndexingSettingsUpdate, decodeDesktopLlmSettingsUpdate, } from "./ipc-contract.js";
import { DESKTOP_CSP, desktopWindowOptions, isTrustedRendererUrl } from "./security.js";
import { createDesktopSmokeState } from "./smoke-fixture.js";
const arguments_ = parseArguments(process.argv.slice(1));
if (arguments_.smokeDirectory)
    app.disableHardwareAcceleration();
let window;
let bridge;
let daemonSupervisor;
let systemService;
let settingsService;
let unsubscribeBridge;
let rendererUrl = "";
let exitCode = 0;
let shuttingDown = false;
let savingSettings = false;
app.on("window-all-closed", () => requestShutdown(0));
app.on("before-quit", (event) => {
    if (!shuttingDown) {
        event.preventDefault();
        requestShutdown(0);
    }
});
process.once("SIGINT", () => requestShutdown(0));
process.once("SIGTERM", () => requestShutdown(0));
app.whenReady().then(startDesktop).catch(failStartup);
async function startDesktop() {
    const home = resolvePsporeHome(arguments_.home);
    const { paths } = await initializePsporeHome(home);
    const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
    const preloadPath = join(moduleDirectory, "preload.cjs");
    const rendererPath = join(moduleDirectory, "renderer", "index.html");
    rendererUrl = pathToFileURL(rendererPath).href;
    installSessionSecurity();
    if (arguments_.smokeDirectory) {
        // The visual harness owns an isolated temporary daemon and must never
        // register persistent services in the developer's real user manager.
        daemonSupervisor = new DaemonSupervisor({ home });
        await daemonSupervisor.start();
    }
    else {
        systemService = new SystemServiceManager({ home, beforeStart: async () => stopLegacyDaemon(home) });
        const launch = await serviceLaunchSpec(home, paths.workspace, {
            execPath: process.execPath,
            moduleUrl: import.meta.url,
            electron: true,
        });
        const ensured = await systemService.ensureRunning(launch);
        if (ensured.lingerWarning)
            process.stderr.write(`pSpore service warning: ${ensured.lingerWarning}\n`);
        if (ensured.recoveredFromFailure) {
            process.stderr.write("pSpore service: cleared a failed unit state before starting the daemon\n");
        }
    }
    bridge = new DaemonBridge({
        socketPath: paths.socket,
        stagingRoot: join(paths.workspace, "staging"),
        versions: {
            pspore: PSPORE_VERSION,
            pi: PI_VERSION,
            electron: process.versions.electron,
            node: process.versions.node,
        },
    });
    bridge.start();
    settingsService = new LlmSettingsService(home, paths);
    const indexingService = new IndexingSettingsService(home, paths);
    window = new BrowserWindow(desktopWindowOptions(preloadPath, primaryWorkArea()));
    captureRendererDiagnostics(window);
    hardenWindow(window, rendererUrl);
    installIpc(window, bridge, settingsService, indexingService);
    unsubscribeBridge = bridge.subscribe((frame) => sendFrame(window, frame));
    await window.loadFile(rendererPath);
    if (arguments_.smokeDirectory) {
        await runSmoke(window, bridge, arguments_.smokeDirectory, arguments_.smokeFixture);
        await bridge.stop();
        requestShutdown(exitCode);
        return;
    }
    // The workspace is a full-height application shell, so the first launch fills
    // the display instead of leaving the desktop visible around a floating window.
    window.once("ready-to-show", () => showMaximized(window));
    if (!window.isVisible())
        showMaximized(window);
}
function primaryWorkArea() {
    try {
        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
        return { width, height };
    }
    catch {
        // Headless or display-less startup: fall back to the design baseline size.
        return undefined;
    }
}
function showMaximized(target) {
    if (!target || target.isDestroyed())
        return;
    if (!target.isMaximized())
        target.maximize();
    if (!target.isVisible())
        target.show();
}
function installSessionSecurity() {
    const desktopSession = session.defaultSession;
    desktopSession.setPermissionCheckHandler(() => false);
    desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    desktopSession.on("will-download", (event) => event.preventDefault());
    desktopSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
    app.on("web-contents-created", (_event, contents) => {
        contents.on("will-attach-webview", (event) => event.preventDefault());
    });
}
function hardenWindow(target, expectedUrl) {
    const contents = target.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
        if (!isTrustedRendererUrl(url, expectedUrl))
            event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
        if (!isTrustedRendererUrl(url, expectedUrl))
            event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
}
function installIpc(target, daemonBridge, desktopSettings, indexingSettings) {
    ipcMain.removeHandler(DESKTOP_BOOTSTRAP_CHANNEL);
    ipcMain.removeHandler(DESKTOP_DISPATCH_CHANNEL);
    ipcMain.removeHandler(DESKTOP_SETTINGS_GET_CHANNEL);
    ipcMain.removeHandler(DESKTOP_SETTINGS_SAVE_CHANNEL);
    ipcMain.removeHandler(DESKTOP_INDEXING_GET_CHANNEL);
    ipcMain.removeHandler(DESKTOP_INDEXING_SAVE_CHANNEL);
    ipcMain.removeHandler(DESKTOP_INDEXING_PICK_CHANNEL);
    ipcMain.handle(DESKTOP_BOOTSTRAP_CHANNEL, (event) => {
        assertTrustedSender(event, target.webContents);
        return daemonBridge.bootstrap();
    });
    ipcMain.handle(DESKTOP_DISPATCH_CHANNEL, async (event, command) => {
        assertTrustedSender(event, target.webContents);
        return daemonBridge.dispatch(command);
    });
    ipcMain.handle(DESKTOP_SETTINGS_GET_CHANNEL, async (event) => {
        assertTrustedSender(event, target.webContents);
        return desktopSettings.get();
    });
    ipcMain.handle(DESKTOP_INDEXING_GET_CHANNEL, async (event) => {
        assertTrustedSender(event, target.webContents);
        return indexingSettings.get();
    });
    ipcMain.handle(DESKTOP_INDEXING_SAVE_CHANNEL, async (event, candidate) => {
        assertTrustedSender(event, target.webContents);
        const update = decodeDesktopIndexingSettingsUpdate(candidate);
        const settings = await indexingSettings.save(update);
        // "Saved" is not "indexing": a switched-on indexer with no directory, or one
        // whose release shipped no binary, does nothing. Saying so here keeps this
        // message from contradicting the status panel.
        const caveat = !settings.enabled
            ? ""
            : settings.directories.length === 0
                ? " 尚未选择索引目录，索引不会运行。"
                : settings.indexerAvailable
                    ? ""
                    : " 本次发行版未包含索引程序，索引不会运行。";
        // The daemon reads config.indexing once at startup, so a saved change only
        // takes effect after it restarts; the client is told which happened.
        if (systemService) {
            await daemonBridge.stop();
            await systemService.restart();
            daemonBridge.start();
            await waitFor(() => daemonBridge.bootstrap().connection.phase === "connected", 10_000);
            return { settings, applied: true, message: `索引设置已保存并应用，后台服务已重启。${caveat}` };
        }
        return { settings, applied: false, message: `索引设置已保存；重启服务后生效。${caveat}` };
    });
    ipcMain.handle(DESKTOP_INDEXING_PICK_CHANNEL, async (event) => {
        assertTrustedSender(event, target.webContents);
        // A native chooser is the only way the renderer learns an absolute path: it
        // has no filesystem access of its own.
        const result = await dialog.showOpenDialog(target, {
            title: "选择要索引的目录",
            properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? undefined : result.filePaths[0];
    });
    ipcMain.handle(DESKTOP_SETTINGS_SAVE_CHANNEL, async (event, candidate) => {
        assertTrustedSender(event, target.webContents);
        if (savingSettings)
            throw new Error("Desktop settings are already being saved");
        const update = decodeDesktopLlmSettingsUpdate(candidate);
        savingSettings = true;
        try {
            const settings = await desktopSettings.save(update);
            if (systemService) {
                await daemonBridge.stop();
                await systemService.restart();
                daemonBridge.start();
                await waitFor(() => daemonBridge.bootstrap().connection.phase === "connected", 10_000);
                return {
                    settings,
                    applied: true,
                    restartRequired: false,
                    message: `设置已保存并应用，后台系统服务已安全重启。${bypassNotice(settings)}`,
                };
            }
            const ownership = daemonSupervisor?.ownership;
            if (ownership !== "owned") {
                return {
                    settings,
                    applied: false,
                    restartRequired: true,
                    message: `设置已安全保存；当前测试使用外部 Daemon，重启后生效。${bypassNotice(settings)}`,
                };
            }
            await daemonBridge.stop();
            await daemonSupervisor?.stop();
            await daemonSupervisor?.start();
            daemonBridge.start();
            await waitFor(() => daemonBridge.bootstrap().connection.phase === "connected", 10_000);
            return {
                settings,
                applied: true,
                restartRequired: false,
                message: `设置已保存并应用，测试 Daemon 已安全重启。${bypassNotice(settings)}`,
            };
        }
        finally {
            savingSettings = false;
        }
    });
}
/** Bypassing approvals is a standing risk, so every save restates it. */
function bypassNotice(settings) {
    return settings.permissionMode === BYPASS_PERMISSION_MODE
        ? " 授权确认已绕过：工具会以当前用户权限直接执行。"
        : "";
}
function assertTrustedSender(event, expected) {
    if (event.sender !== expected || !isTrustedRendererUrl(event.senderFrame?.url ?? "", rendererUrl)) {
        throw new Error("Rejected IPC from an untrusted renderer");
    }
}
function sendFrame(target, frame) {
    if (!target || target.isDestroyed() || target.webContents.isDestroyed() || target.webContents.isLoadingMainFrame())
        return;
    target.webContents.send(DESKTOP_FRAME_CHANNEL, frame);
}
async function runSmoke(target, daemonBridge, outputDirectory, fixture) {
    if (!isAbsolute(outputDirectory))
        throw new Error("--smoke-dir must be an absolute path");
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    target.setContentSize(1_920, 1_080);
    target.show();
    await waitForRenderer(target, "document.documentElement.dataset.ready === 'true'", 10_000);
    await waitFor(() => daemonBridge.bootstrap().connection.phase === "connected", 8_000).catch(() => undefined);
    let reconnectVerified = false;
    let reconnectMasked = false;
    if (fixture && daemonBridge.bootstrap().connection.phase === "connected") {
        await daemonBridge.stop();
        // A long run drops and re-establishes the socket constantly; the shell must
        // keep presenting the last good state until the settle window expires,
        // instead of strobing the badge, banner and every connection-gated control.
        await waitForRenderer(target, "document.documentElement.dataset.reconnecting === 'true'", 3_000);
        reconnectMasked = await target.webContents.executeJavaScript("document.documentElement.dataset.connection === 'connected'");
        // A genuine outage still has to surface once the window elapses.
        await waitForRenderer(target, "document.documentElement.dataset.connection === 'disconnected'", 8_000);
        daemonBridge.start();
        await waitFor(() => daemonBridge.bootstrap().connection.phase === "connected", 8_000);
        await waitForRenderer(target, "document.documentElement.dataset.connection === 'connected'", 5_000);
        reconnectVerified = true;
    }
    const runActivity = {
        toolPhase: "unmeasured",
        toolLabel: "",
        streamingPhase: "unmeasured",
        hiddenWhenIdle: false,
    };
    let fixtureState;
    let directQueueVisibleBeforeToolCompletion = false;
    // Nothing is running yet, so the activity line must be absent. Checked here
    // rather than by faking a settle later: the real daemon's session is idle.
    runActivity.hiddenWhenIdle = await target.webContents.executeJavaScript("document.querySelector('#run-activity')?.hidden === true");
    if (fixture) {
        const base = daemonBridge.bootstrap();
        const cursors = { ...base.cursors, "desktop-smoke": 10 };
        fixtureState = createDesktopSmokeState(base.snapshot, false);
        sendFrame(target, { version: 1, kind: "snapshot", snapshot: fixtureState, cursors });
        sendFrame(target, smokeEvent(11, "tool.started", { sessionId: "main", toolCallId: "smoke-tool-1", toolName: "shell", command: "npm run check" }));
        await waitForRenderer(target, "Boolean(document.querySelector('#message-queue [data-queue-mode=direct]'))", 5_000);
        directQueueVisibleBeforeToolCompletion = true;
        // A tool is running and nothing is streaming yet: the state that used to
        // leave the conversation looking dead.
        runActivity.toolPhase = await target.webContents.executeJavaScript("document.querySelector('#run-activity')?.dataset.phase ?? 'hidden'");
        runActivity.toolLabel = await target.webContents.executeJavaScript("document.querySelector('#run-activity-label')?.textContent ?? ''");
        sendFrame(target, smokeEvent(12, "tool.completed", {
            sessionId: "main",
            toolCallId: "smoke-tool-1",
            toolName: "shell",
            status: "succeeded",
            output: Array.from({ length: 80 }, (_, index) => `verification line ${index + 1}: pass`).join("\n"),
        }));
        sendFrame(target, {
            version: 1,
            kind: "delta",
            streamId: "desktop-smoke",
            fromSeq: 13,
            seq: 14,
            sessionId: "main",
            itemId: "smoke-item-1",
            channel: "thinking",
            text: "正在核对测试结果、运行时版本与升级边界。",
        });
        sendFrame(target, {
            version: 1,
            kind: "delta",
            streamId: "desktop-smoke",
            fromSeq: 15,
            seq: 17,
            sessionId: "main",
            itemId: "smoke-item-1",
            channel: "text",
            text: "正在归并最终证据；这段文字来自连续 streaming delta。",
        });
    }
    await waitForRenderer(target, "Number(document.documentElement.dataset.renderSequence || '0') > 0", 5_000);
    if (fixture) {
        await waitForRenderer(target, "Boolean(document.querySelector('.message.streaming'))", 5_000);
        runActivity.streamingPhase = await target.webContents.executeJavaScript("document.querySelector('#run-activity')?.dataset.phase ?? 'hidden'");
    }
    await setRendererTheme(target, "dark");
    let fileDrop;
    let fileDropSize;
    if (fixture) {
        const result = await exerciseComposerFileDrop(target, outputDirectory);
        fileDrop = result.probe;
        fileDropSize = result.imageSize;
    }
    await settlePaint();
    const mainVisual = await target.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector('#transcript');
    const code = document.querySelector('.message.assistant pre');
    const composerRect = document.querySelector('.composer')?.getBoundingClientRect();
    return {
      transcriptScrollable: Boolean(transcript && transcript.scrollHeight > transcript.clientHeight),
      codeContained: Boolean(code && code.scrollWidth > code.clientWidth && getComputedStyle(code).overflowX !== 'visible'),
      composerVisible: Boolean(composerRect && composerRect.top >= 0 && composerRect.bottom <= innerHeight),
      streamingVisible: Boolean(document.querySelector('.message.streaming')),
      streamingActive: transcript?.getAttribute('aria-busy') === 'true',
      thinkingVisible: Boolean(document.querySelector('.thinking-stream')),
      thinkingSeparate: Boolean(document.querySelector('.thinking-stream') && document.querySelector('.message.streaming > .message-body')),
      thinkingHiddenAfterCompletion: false,
      truncationNoticeVisible: Boolean(document.querySelector('#transcript .message-truncated button')),
      truncationRetryOffered: false,
      legacyComposerModes: document.querySelectorAll('#composer-mode, .mode-select').length,
      virtualIndices: Array.from(document.querySelectorAll('#transcript > .message')).map((node) => Number(node.dataset.virtualIndex)),
      scrollDistance: transcript ? transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight : -1,
      renderedMessages: document.querySelectorAll('#transcript > .message').length,
      authoritativeMessages: 1008,
      historyBrowseRequestedTop: -1,
      historyBrowseAfterIdleTop: -1,
      historyBrowseAfterDeltaTop: -1,
      tailDistanceAfterReturn: -1,
      directQueueVisibleBeforeToolCompletion: ${directQueueVisibleBeforeToolCompletion},
      followUpQueueVisible: Boolean(document.querySelector('#message-queue [data-queue-mode="follow-up"]'))
    };
  })()`);
    const sessionRail = await target.webContents.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('#session-list .session-row'));
    const rootRows = rows.filter((row) => Number(row.querySelector('.session-item')?.dataset.depth ?? '0') === 0);
    const agentRows = rows.filter((row) => Number(row.querySelector('.session-item')?.dataset.depth ?? '0') > 0);
    const first = rootRows[0]?.querySelector('.session-delete');
    const hiddenUntilHover = Boolean(first) && Number(getComputedStyle(first).opacity) === 0;
    const probe = {
      rootOrder: rootRows.map((row) => row.querySelector('.session-item strong')?.firstChild?.textContent?.trim() ?? ''),
      times: rootRows.map((row) => row.querySelector('.session-time')?.textContent ?? ''),
      totalRows: rows.length,
      rootRows: rootRows.length,
      deleteControls: rootRows.filter((row) => row.querySelector('.session-delete')).length,
      agentDeleteControls: agentRows.filter((row) => row.querySelector('.session-delete')).length,
      hiddenUntilHover
    };
    // Deleting a session destroys its transcript, so one click may only arm the
    // control: the row it belongs to has to survive it.
    first?.click();
    return {
      ...probe,
      armedLabel: document.querySelector('#session-list .session-delete.armed')?.textContent ?? '',
      armedAfterFirstClick: Boolean(document.querySelector('#session-list .session-row.arming')),
      rowsAfterFirstClick: document.querySelectorAll('#session-list .session-row').length,
      armedAtCapture: false
    };
  })()`);
    // Read the panel without activating its tab: clicking one moves focus, and the
    // approval modal's focus is asserted later from wherever it was left.
    const integrations = await target.webContents.executeJavaScript(`(() => {
    const rows = Array.from(document.querySelectorAll('#integration-list > *'));
    return {
      builtinTools: Array.from(document.querySelectorAll('#integration-list .tool-chip')).map((chip) => chip.textContent ?? ''),
      skills: rows.map((row) => row.textContent ?? '').filter((text) => text.includes('Skill ·')).map((text) => text.trim().slice(0, 40))
    };
  })()`);
    const indexingPanel = await target.webContents.executeJavaScript(`(() => ({
    phase: document.querySelector('#indexing-panel')?.dataset.phase ?? '',
    phaseLabel: document.querySelector('#indexing-phase')?.textContent ?? '',
    counts: document.querySelector('#indexing-counts')?.textContent ?? '',
    note: document.querySelector('#indexing-note')?.textContent ?? ''
  }))()`);
    // Evidence for the one destructive control in the rail: the armed state is
    // captured on its own, because the main capture is taken after it reverts.
    const railRect = await target.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('#session-list')?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(Math.min(rect.height, 220)) } : { x: 0, y: 0, width: 320, height: 220 };
  })()`);
    const armedRailImage = await target.webContents.capturePage(railRect);
    await writeFile(join(outputDirectory, "desktop-session-delete-armed.png"), armedRailImage.toPNG(), { mode: 0o600 });
    sessionRail.armedAtCapture = await target.webContents.executeJavaScript("Boolean(document.querySelector('#session-list .session-row.arming'))");
    // Narrow the window without crossing a breakpoint. Nothing used to re-render
    // here, so the transcript kept the heights it measured at the old width.
    const beforeResize = await target.webContents.executeJavaScript(`(() => ({
    width: document.querySelector('#transcript')?.clientWidth ?? 0,
    scrollHeight: document.querySelector('#transcript')?.scrollHeight ?? 0,
    panels: \`\${document.documentElement.dataset.navigation}/\${document.documentElement.dataset.inspector}\`
  }))()`);
    target.setContentSize(1_700, 1_080);
    await settlePaint();
    await waitForRenderer(target, `(document.querySelector('#transcript')?.scrollHeight ?? 0) !== ${beforeResize.scrollHeight}`, 5_000)
        .catch(() => undefined);
    const afterResize = await target.webContents.executeJavaScript(`(() => ({
    width: document.querySelector('#transcript')?.clientWidth ?? 0,
    scrollHeight: document.querySelector('#transcript')?.scrollHeight ?? 0,
    panels: \`\${document.documentElement.dataset.navigation}/\${document.documentElement.dataset.inspector}\`
  }))()`);
    const inBandResize = {
        beforeWidth: beforeResize.width,
        afterWidth: afterResize.width,
        beforeScrollHeight: beforeResize.scrollHeight,
        afterScrollHeight: afterResize.scrollHeight,
        panelsUnchanged: beforeResize.panels === afterResize.panels,
    };
    target.setContentSize(1_920, 1_080);
    // The reflow is debounced, so it must be allowed to land before anything else
    // touches the transcript; otherwise it resets the scroll mid-assertion.
    await waitForRenderer(target, `(document.querySelector('#transcript')?.scrollHeight ?? 0) === ${beforeResize.scrollHeight}`, 5_000).catch(() => undefined);
    await settlePaint();
    const mainImage = await target.webContents.capturePage();
    await writeFile(join(outputDirectory, "desktop-main-dark-1920x1080.png"), mainImage.toPNG(), { mode: 0o600 });
    if (fixture) {
        mainVisual.historyBrowseRequestedTop = await target.webContents.executeJavaScript(`(() => {
      const transcript = document.querySelector('#transcript');
      if (!transcript) return -1;
      transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight - Math.max(600, transcript.clientHeight));
      transcript.dispatchEvent(new Event('scroll'));
      return transcript.scrollTop;
    })()`);
        await settlePaint();
        mainVisual.historyBrowseAfterIdleTop = await target.webContents.executeJavaScript("document.querySelector('#transcript')?.scrollTop ?? -1");
        sendFrame(target, {
            version: 1,
            kind: "delta",
            streamId: "desktop-smoke",
            fromSeq: 18,
            seq: 19,
            sessionId: "main",
            itemId: "smoke-item-1",
            channel: "text",
            text: " 浏览历史期间的新输出不应抢走滚动位置。",
        });
        await settlePaint();
        mainVisual.historyBrowseAfterDeltaTop = await target.webContents.executeJavaScript("document.querySelector('#transcript')?.scrollTop ?? -1");
        await target.webContents.executeJavaScript(`(() => {
      const transcript = document.querySelector('#transcript');
      if (!transcript) return;
      transcript.scrollTop = transcript.scrollHeight;
      transcript.dispatchEvent(new Event('scroll'));
    })()`);
        await settlePaint();
        sendFrame(target, smokeEvent(20, "transcript.item.finished", {
            sessionId: "main",
            item: { id: "smoke-item-1", role: "assistant", text: "最终证据已归并。", status: "complete", ts: "2026-08-10T08:10:00.000Z" },
        }));
        await waitForRenderer(target, "!document.querySelector('.thinking-stream')", 5_000);
        await settlePaint();
        mainVisual.tailDistanceAfterReturn = await target.webContents.executeJavaScript(`(() => {
      const transcript = document.querySelector('#transcript');
      return transcript ? transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight : -1;
    })()`);
        mainVisual.thinkingHiddenAfterCompletion = true;
        // Clicking "载入全文" reaches the daemon through the allowlisted command.
        // The smoke fixture's transcript is not the daemon's, so the request is
        // refused — which is exactly the path that has to leave the button usable.
        await target.webContents.executeJavaScript("document.querySelector('#transcript .message-truncated button')?.click()");
        mainVisual.truncationRetryOffered = await waitForRenderer(target, "(() => { const b = document.querySelector('#transcript .message-truncated button'); return Boolean(b && !b.disabled && b.textContent === '重试载入全文'); })()", 5_000).then(() => true, () => false);
    }
    const darkTheme = await readThemeSnapshot(target);
    const typography = await target.webContents.executeJavaScript(`(() => {
    const size = (selector) => Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
    return {
      body: Number.parseFloat(getComputedStyle(document.body).fontSize),
      conversationTitle: size('.conversation-header h2'),
      messageBody: size('.message-body'),
      composerInput: size('#composer-input'),
      sectionHeading: size('.section-heading h2'),
      sessionPrimary: size('.session-item strong'),
      sessionSecondary: size('.session-item small'),
      denseTitle: size('.dense-item b'),
      auxiliary: size('.eyebrow')
    };
  })()`);
    await setRendererTheme(target, "light");
    await settlePaint();
    const lightTheme = await readThemeSnapshot(target);
    const lightImage = await target.webContents.capturePage();
    await writeFile(join(outputDirectory, "desktop-main-light-1920x1080.png"), lightImage.toPNG(), { mode: 0o600 });
    await setRendererTheme(target, "dark");
    await target.webContents.executeJavaScript("document.querySelector('#settings-button')?.click()");
    await waitForRenderer(target, "document.querySelector('#settings-overlay')?.hidden === false", 5_000);
    await waitForRenderer(target, "document.querySelector('#settings-save')?.disabled === false", 5_000);
    await settlePaint();
    const settingsImage = await target.webContents.capturePage();
    await writeFile(join(outputDirectory, "desktop-settings-1920x1080.png"), settingsImage.toPNG(), { mode: 0o600 });
    const settingsProbe = await target.webContents.executeJavaScript(`(async () => {
    const dialog = document.querySelector('.settings-dialog');
    const dialogRect = dialog?.getBoundingClientRect();
    const settings = await window.pspore.getSettings();
    const provider = document.querySelector('#settings-provider');
    provider.value = 'custom-openai';
    provider.dispatchEvent(new Event('change'));
    return {
      dialogContained: Boolean(dialogRect && dialogRect.left >= 0 && dialogRect.top >= 0 && dialogRect.right <= innerWidth && dialogRect.bottom <= innerHeight),
      backgroundInert: Boolean(document.querySelector('#app-shell')?.inert),
      apiKeyInputType: document.querySelector('#settings-api-key')?.type || '',
      cookieInputType: document.querySelector('#settings-cookie')?.type || '',
      returnedSecret: Object.prototype.hasOwnProperty.call(settings, 'apiKey') || Object.prototype.hasOwnProperty.call(settings, 'cookie'),
      fieldFontSize: Number.parseFloat(getComputedStyle(provider).fontSize),
      providerOptions: Array.from(provider.options).map((option) => option.value),
      permissionModes: Array.from(document.querySelector('#settings-permission-mode')?.options || []).map((option) => option.value),
      permissionWarningHidden: document.querySelector('#settings-permission-warning')?.hidden !== false,
      bypassWarningShown: (() => {
        const mode = document.querySelector('#settings-permission-mode');
        mode.value = 'allow_all';
        mode.dispatchEvent(new Event('change'));
        const shown = document.querySelector('#settings-permission-warning')?.hidden === false;
        mode.value = 'ask_risky';
        mode.dispatchEvent(new Event('change'));
        return shown && document.querySelector('#settings-permission-warning')?.hidden === true;
      })(),
      customBaseUrlEnabled: !document.querySelector('#settings-base-url')?.disabled && Boolean(document.querySelector('#settings-base-url')?.required),
      customApiEnabled: !document.querySelector('#settings-api')?.disabled && document.querySelector('#settings-api')?.value === 'openai-completions',
      autoCompactionControls: document.querySelector('#settings-auto-compaction')?.checked === settings.autoCompactionEnabled
        && Number(document.querySelector('#settings-compaction-trigger')?.value) === settings.autoCompactionTriggerTokens
        && Number(document.querySelector('#settings-compaction-reserve')?.value) === settings.autoCompactionReserveTokens
        && Number(document.querySelector('#settings-compaction-keep-recent')?.value) === settings.autoCompactionKeepRecentTokens
    };
  })()`);
    await target.webContents.executeJavaScript("document.querySelector('#settings-close')?.click()");
    await waitForRenderer(target, "document.querySelector('#settings-overlay')?.hidden === true", 2_000);
    await target.webContents.executeJavaScript("document.activeElement?.blur()");
    target.setContentSize(1_440, 900);
    await settlePaint();
    const mediumLayout = await readResponsiveLayout(target);
    const mediumImage = await target.webContents.capturePage();
    await writeFile(join(outputDirectory, "desktop-responsive-1440x900.png"), mediumImage.toPNG(), { mode: 0o600 });
    target.setContentSize(1_180, 720);
    await settlePaint();
    const compactLayout = await readResponsiveLayout(target);
    const compactImage = await target.webContents.capturePage();
    await writeFile(join(outputDirectory, "desktop-responsive-1180x720.png"), compactImage.toPNG(), { mode: 0o600 });
    await target.webContents.executeJavaScript("document.querySelector('#inspector-toggle')?.click()");
    await settlePaint();
    const compactInspectorLayout = await readResponsiveLayout(target);
    await target.webContents.executeJavaScript("document.querySelector('#inspector-close')?.click()");
    target.setContentSize(1_920, 1_080);
    await settlePaint();
    let approvalSize;
    if (fixture) {
        const base = daemonBridge.bootstrap();
        sendFrame(target, {
            version: 1,
            kind: "snapshot",
            snapshot: createDesktopSmokeState(base.snapshot, true),
            cursors: { ...base.cursors, "desktop-smoke": 20 },
        });
        await waitForRenderer(target, "document.documentElement.dataset.approval === 'visible'", 5_000);
        // The overlay is marked visible a frame before focus moves into it, so
        // waiting on visibility alone races the assertion below on a loaded machine.
        // Wait for the thing actually being checked instead.
        await waitForRenderer(target, "document.activeElement?.textContent?.trim() === '拒绝'", 5_000);
        await settlePaint();
        const approvalImage = await target.webContents.capturePage();
        await writeFile(join(outputDirectory, "desktop-approval-1920x1080.png"), approvalImage.toPNG(), { mode: 0o600 });
        approvalSize = approvalImage.getSize();
    }
    const probe = await target.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector('#transcript');
    const code = document.querySelector('.message.assistant pre');
    const composer = document.querySelector('.composer');
    const modal = document.querySelector('.approval-dialog');
    const composerRect = composer?.getBoundingClientRect();
    const modalRect = modal?.getBoundingClientRect();
    return {
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    globals: {
      process: typeof process,
      require: typeof require,
      Buffer: typeof Buffer,
      electron: typeof electron
    },
    apiKeys: Object.keys(window.pspore || {}).sort(),
    document: {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      shellHeight: document.querySelector('#app-shell')?.getBoundingClientRect().height || 0,
      workspaceBottom: document.querySelector('#main-workspace')?.getBoundingClientRect().bottom || 0,
      bodyOverflow: getComputedStyle(document.body).overflow,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null,
      approval: document.documentElement.dataset.approval || null,
      transcriptScrollable: Boolean(transcript && transcript.scrollHeight > transcript.clientHeight),
      codeContained: Boolean(code && code.scrollWidth > code.clientWidth && getComputedStyle(code).overflowX !== 'visible'),
      composerVisible: Boolean(composerRect && composerRect.top >= 0 && composerRect.bottom <= innerHeight),
      modalContained: Boolean(modalRect && modalRect.left >= 0 && modalRect.top >= 0 && modalRect.right <= innerWidth && modalRect.bottom <= innerHeight),
      backgroundInert: Boolean(document.querySelector('#app-shell')?.inert),
      focusLabel: document.activeElement?.textContent?.trim() || null
    }
  }})()`);
    const ipcProbe = await target.webContents.executeJavaScript(`(async () => {
    const jobs = await window.pspore.dispatch({ action: 'jobs.list' });
    let rejected = false;
    let rejectionMessage = '';
    try {
      await window.pspore.dispatch({ action: 'shell.exec', command: 'id' });
    } catch (error) {
      rejected = true;
      rejectionMessage = String(error?.message || error);
    }
    return { jobsArray: Array.isArray(jobs), rejected, rejectionMessage };
  })()`);
    const report = {
        version: 1,
        capturedAt: new Date().toISOString(),
        connection: daemonBridge.bootstrap().connection,
        daemonOwnership: daemonSupervisor?.ownership ?? "external",
        reconnectVerified,
        reconnectMasked,
        images: {
            main: mainImage.getSize(),
            light: lightImage.getSize(),
            settings: settingsImage.getSize(),
            medium: mediumImage.getSize(),
            compact: compactImage.getSize(),
            ...(fileDropSize ? { fileDrop: fileDropSize } : {}),
            ...(approvalSize ? { approval: approvalSize } : {}),
        },
        themes: { dark: darkTheme, light: lightTheme },
        typography,
        mainVisual,
        inBandResize,
        integrations,
        runActivity,
        sessionRail,
        indexingPanel,
        responsive: { medium: mediumLayout, compact: compactLayout, compactInspector: compactInspectorLayout },
        settings: settingsProbe,
        ...(fileDrop ? { fileDrop } : {}),
        probe,
        ipcProbe,
    };
    await writeFile(join(outputDirectory, "desktop-security.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    assertSmokeReport(report, fixture);
}
/** The shell keeps a 10px gutter below the workspace; anything more is dead space. */
const SHELL_PADDING_TOLERANCE = 12;
function assertSmokeReport(report, fixture) {
    const failures = [];
    if (report.connection.phase !== "connected")
        failures.push("desktop did not connect to the real daemon");
    if (fixture && !report.reconnectVerified)
        failures.push("desktop reconnect path was not verified");
    if (fixture && !report.reconnectMasked)
        failures.push("a brief outage was surfaced instead of being settled");
    if (report.images.main.width !== 1_920 || report.images.main.height !== 1_080)
        failures.push("main capture is not 1920x1080");
    if (report.images.light.width !== 1_920 || report.images.light.height !== 1_080)
        failures.push("light capture is not 1920x1080");
    if (report.images.settings.width !== 1_920 || report.images.settings.height !== 1_080)
        failures.push("settings capture is not 1920x1080");
    if (report.images.medium.width !== 1_440 || report.images.medium.height !== 900)
        failures.push("medium capture is not 1440x900");
    if (report.images.compact.width !== 1_180 || report.images.compact.height !== 720)
        failures.push("compact capture is not 1180x720");
    if (report.themes.dark.colorScheme !== "dark" || report.themes.light.colorScheme !== "light")
        failures.push("theme color-scheme did not switch");
    if (report.themes.dark.backgroundColor === report.themes.light.backgroundColor)
        failures.push("theme canvas colors did not switch");
    if (report.themes.dark.surfaceColor === report.themes.light.surfaceColor)
        failures.push("theme surface colors did not switch");
    const minimumFontSizes = {
        body: 14,
        conversationTitle: 20,
        messageBody: 15,
        composerInput: 14,
        sectionHeading: 15,
        sessionPrimary: 13,
        sessionSecondary: 11.5,
        denseTitle: 12.5,
        auxiliary: 11.5,
    };
    for (const [name, minimum] of Object.entries(minimumFontSizes)) {
        const actual = report.typography[name];
        if (actual === undefined || !Number.isFinite(actual) || actual < minimum)
            failures.push(`${name} font size is below ${minimum}px`);
    }
    if (report.probe.viewport.width !== 1_920 || report.probe.viewport.height !== 1_080)
        failures.push("renderer viewport is not 1920x1080");
    if (report.probe.document.scrollWidth !== 1_920 || report.probe.document.scrollHeight !== 1_080)
        failures.push("document overflows the viewport");
    if (report.probe.document.bodyOverflow !== "hidden")
        failures.push("body overflow is not contained");
    if (Math.abs(report.probe.document.shellHeight - 1_080) > 1)
        failures.push("app shell does not fill the viewport height");
    if (1_080 - report.probe.document.workspaceBottom > SHELL_PADDING_TOLERANCE)
        failures.push("main workspace leaves vertical dead space");
    if (report.probe.document.csp !== DESKTOP_CSP)
        failures.push("renderer CSP does not match the strict policy");
    for (const global of ["process", "require", "Buffer", "electron"]) {
        if (report.probe.globals[global] !== "undefined")
            failures.push(`renderer exposes ${global}`);
    }
    // Pinned deliberately: the preload is the renderer's only capability surface,
    // so a new method must be a conscious change rather than an accident.
    const expectedApi = [
        "bootstrap",
        "dispatch",
        "getIndexing",
        "getPathForFile",
        "getSettings",
        "pickIndexDirectory",
        "saveIndexing",
        "saveSettings",
        "subscribe",
    ].join(",");
    if (report.probe.apiKeys.join(",") !== expectedApi) {
        failures.push(`preload API surface changed: ${report.probe.apiKeys.join(",")} (expected ${expectedApi})`);
    }
    if (!report.ipcProbe.jobsArray)
        failures.push("allowlisted IPC round trip failed");
    if (!report.ipcProbe.rejected || !report.ipcProbe.rejectionMessage.includes("not allowlisted"))
        failures.push("non-allowlisted IPC was not rejected");
    if (!report.settings.dialogContained || !report.settings.backgroundInert)
        failures.push("settings dialog is not contained and modal");
    if (report.settings.apiKeyInputType !== "password" || report.settings.cookieInputType !== "password" || report.settings.returnedSecret)
        failures.push("settings API exposed an API key or cookie");
    if (report.settings.fieldFontSize < 14)
        failures.push("settings field font size is below 14px");
    if (report.settings.providerOptions.join(",") !== "deepseek,openai,custom-openai")
        failures.push("settings provider choices changed");
    if (report.settings.permissionModes.join(",") !== "ask_risky,ask_all,allow_all,deny")
        failures.push("settings permission modes changed");
    if (!report.settings.permissionWarningHidden)
        failures.push("bypass warning is shown while approvals are still enforced");
    if (!report.settings.bypassWarningShown)
        failures.push("selecting the bypass mode did not surface its risk warning");
    if (!report.settings.customBaseUrlEnabled || !report.settings.customApiEnabled)
        failures.push("custom OpenAI controls are not enabled correctly");
    if (!report.settings.autoCompactionControls)
        failures.push("auto-compaction controls do not reflect persisted settings");
    const expectedResponsive = [
        ["medium", report.responsive.medium, 1_440, 900],
        ["compact", report.responsive.compact, 1_180, 720],
        ["compact inspector", report.responsive.compactInspector, 1_180, 720],
    ];
    for (const [name, layout, width, height] of expectedResponsive) {
        if (layout.viewport.width !== width || layout.viewport.height !== height)
            failures.push(`${name} viewport changed unexpectedly`);
        if (layout.scrollWidth !== width || layout.scrollHeight !== height)
            failures.push(`${name} document overflows the viewport`);
        if (Math.abs(layout.shellHeight - height) > 1)
            failures.push(`${name} app shell does not fill the viewport height`);
        if (height - layout.workspaceBottom > SHELL_PADDING_TOLERANCE)
            failures.push(`${name} main workspace leaves vertical dead space`);
        if (!layout.composerVisible || layout.conversationWidth < 520)
            failures.push(`${name} conversation does not use the available space`);
        if (!layout.inspectorContained)
            failures.push(`${name} inspector escapes the viewport`);
    }
    if (!report.responsive.medium.navigationVisible || report.responsive.medium.inspectorVisible)
        failures.push("medium layout did not maximize the conversation canvas by default");
    if (!report.responsive.compact.navigationVisible || report.responsive.compact.inspectorVisible)
        failures.push("compact layout did not collapse the inspector");
    if (!report.responsive.compactInspector.inspectorVisible)
        failures.push("compact inspector drawer did not open");
    if (fixture) {
        if (report.images.fileDrop?.width !== 1_920 || report.images.fileDrop.height !== 1_080)
            failures.push("file-drop capture is not 1920x1080");
        if (!report.fileDrop?.activeIndicatorVisible)
            failures.push("file-drop target did not show its active state");
        if (!report.fileDrop?.inputPreserved || !report.fileDrop.notSubmitted || !report.fileDrop.overlayHiddenAfterDrop)
            failures.push("file drop submitted or replaced the composer draft");
        if (report.fileDrop?.referenceCount !== 2 || report.fileDrop.referencedPaths.length !== 2)
            failures.push("file and directory paths were not added as two references");
        if (report.fileDrop?.referencedKinds.slice().sort().join(",") !== "directory,file")
            failures.push("file drop did not preserve file/directory reference kinds");
        if (report.images.approval?.width !== 1_920 || report.images.approval.height !== 1_080)
            failures.push("approval capture is not 1920x1080");
        if (!report.mainVisual.transcriptScrollable || !report.probe.document.transcriptScrollable)
            failures.push("transcript fixture did not exercise vertical scrolling");
        // A windowed transcript does not promise that the long-code fixture and
        // the streaming tail coexist in one DOM window. The approval capture
        // scroll state independently exercises the code overflow contract.
        if (!report.probe.document.codeContained)
            failures.push("long code did not exercise contained horizontal scrolling");
        if (!report.mainVisual.composerVisible || !report.probe.document.composerVisible)
            failures.push("composer is not fully visible");
        if (!report.mainVisual.streamingVisible)
            failures.push("streaming delta is not visible in the main capture");
        if (!report.mainVisual.thinkingVisible || !report.mainVisual.thinkingSeparate)
            failures.push("thinking was not rendered separately from response text");
        if (!report.mainVisual.thinkingHiddenAfterCompletion)
            failures.push("thinking did not hide after message completion");
        if (!report.mainVisual.truncationNoticeVisible)
            failures.push("a message cut by the publishing ceiling offered no way to load it in full");
        if (!report.mainVisual.truncationRetryOffered)
            failures.push("a refused full-text load left its button stuck");
        if (report.mainVisual.legacyComposerModes !== 0)
            failures.push("legacy composer mode controls are still visible");
        if (report.mainVisual.authoritativeMessages < 1_000 || report.mainVisual.renderedMessages >= 40)
            failures.push("long history was not virtualized");
        if (report.mainVisual.historyBrowseRequestedTop <= 0)
            failures.push("history scroll fixture did not move above the transcript tail");
        if (Math.abs(report.mainVisual.historyBrowseAfterIdleTop - report.mainVisual.historyBrowseRequestedTop) > 64) {
            failures.push("transcript snapped to the tail without a new message");
        }
        if (Math.abs(report.mainVisual.historyBrowseAfterDeltaTop - report.mainVisual.historyBrowseAfterIdleTop) > 64) {
            failures.push("streaming output stole the history browsing position");
        }
        if (report.mainVisual.tailDistanceAfterReturn < 0 || report.mainVisual.tailDistanceAfterReturn > 32) {
            failures.push("transcript did not resume tail following after returning to the bottom");
        }
        if (!report.mainVisual.directQueueVisibleBeforeToolCompletion)
            failures.push("direct-send queue was hidden until tool completion");
        if (!report.mainVisual.followUpQueueVisible)
            failures.push("follow-up queue is not visible alongside direct-send messages");
        // A run that produces no text still has to look alive, and the tool phase has
        // to be distinguishable from the streaming one.
        if (report.runActivity.toolPhase !== "tool") {
            failures.push(`run activity did not show the tool phase: ${report.runActivity.toolPhase}`);
        }
        if (!report.runActivity.toolLabel.includes("shell")) {
            failures.push(`run activity did not name the running tool: ${report.runActivity.toolLabel}`);
        }
        if (report.runActivity.streamingPhase === report.runActivity.toolPhase) {
            failures.push("run activity does not distinguish streaming from a running tool");
        }
        if (!report.runActivity.hiddenWhenIdle)
            failures.push("run activity was visible while nothing was running");
        // The panel has to answer "what can this agent do", not only "what was added".
        for (const expected of ["read", "document", "edit", "search", "shell"]) {
            if (!report.integrations.builtinTools.includes(expected)) {
                failures.push(`integrations tab is missing the ${expected} tool`);
            }
        }
        if (report.integrations.skills.length === 0)
            failures.push("integrations tab lists no installed skill");
        // Panels stay put inside a band; the transcript still has to re-lay out.
        if (!report.inBandResize.panelsUnchanged)
            failures.push("in-band resize crossed a breakpoint, so it tests nothing");
        if (report.inBandResize.afterWidth >= report.inBandResize.beforeWidth) {
            failures.push(`in-band resize did not narrow the conversation: ${report.inBandResize.beforeWidth} -> ${report.inBandResize.afterWidth}`);
        }
        if (report.inBandResize.afterScrollHeight === report.inBandResize.beforeScrollHeight) {
            failures.push("transcript kept its old measurements after the window was resized");
        }
        if (report.sessionRail.rootRows < 1)
            failures.push("session rail rendered no root session row");
        // Newest first: the fixture's later session was created after main, so it
        // leads even though main is inserted first and used to be pinned there.
        if (report.sessionRail.rootOrder.join(",") !== "session-later,main") {
            failures.push(`session rail is not newest-first: ${report.sessionRail.rootOrder.join(", ")}`);
        }
        if (report.sessionRail.times.some((time) => time === "")) {
            failures.push("a root session row rendered without its time");
        }
        if (report.sessionRail.deleteControls !== report.sessionRail.rootRows) {
            failures.push("not every root session row offers a delete control");
        }
        // Child agents are cancelled through their own controls; deleting one would
        // orphan the transcript its root session still owns.
        if (report.sessionRail.agentDeleteControls !== 0)
            failures.push("a child agent row offered a session delete control");
        if (!report.sessionRail.hiddenUntilHover)
            failures.push("session delete control is visible before the row is hovered");
        if (!report.sessionRail.armedAfterFirstClick)
            failures.push("session delete control did not arm on its first click");
        if (!report.sessionRail.armedLabel.includes("确认"))
            failures.push("armed session delete control does not ask for confirmation");
        if (!report.sessionRail.armedAtCapture)
            failures.push("armed session delete control reverted before it could be captured");
        if (report.sessionRail.rowsAfterFirstClick !== report.sessionRail.totalRows) {
            failures.push("a single click on the delete control changed the session rail");
        }
        // The status panel must agree with the settings panel that switched it on.
        if (report.indexingPanel.phase !== "unconfigured")
            failures.push("indexing panel did not render the unconfigured phase");
        if (report.indexingPanel.phaseLabel.includes("未启用"))
            failures.push("indexing panel reported an enabled indexer as switched off");
        if (!report.indexingPanel.note.includes("已启用"))
            failures.push("indexing panel did not report the configured enable state");
        if (!report.probe.document.modalContained)
            failures.push("approval modal escapes the viewport");
        if (!report.probe.document.backgroundInert)
            failures.push("approval modal did not make the background inert");
        if (report.probe.document.focusLabel !== "拒绝")
            failures.push("approval modal did not receive deterministic focus");
    }
    if (failures.length > 0)
        throw new Error(`Electron smoke validation failed: ${failures.join("; ")}`);
}
async function exerciseComposerFileDrop(target, outputDirectory) {
    const fixtureRoot = join(outputDirectory, "file-drop-fixture");
    const filePath = join(fixtureRoot, "dragged file.txt");
    const directoryPath = join(fixtureRoot, "dragged folder");
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    await writeFile(filePath, "The renderer must not read this file during drop.\n", { encoding: "utf8", mode: 0o600 });
    await target.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#composer-input');
    const form = document.querySelector('#composer-form');
    if (input) input.value = '请检查拖入的上下文';
    if (form) {
      form.dataset.smokeSubmitCount = '0';
      form.addEventListener('submit', () => {
        form.dataset.smokeSubmitCount = String(Number(form.dataset.smokeSubmitCount || '0') + 1);
      });
    }
  })()`);
    const point = await target.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('#composer-form')?.getBoundingClientRect();
    if (!rect) throw new Error('Missing composer drop target');
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 56) };
  })()`);
    const dragData = {
        items: [{
                mimeType: "text/uri-list",
                data: `${pathToFileURL(filePath).href}\r\n${pathToFileURL(directoryPath).href}`,
            }],
        files: [filePath, directoryPath],
        dragOperationsMask: 1,
    };
    const debugging = target.webContents.debugger;
    const attachedHere = !debugging.isAttached();
    let dropped = false;
    try {
        if (attachedHere)
            debugging.attach("1.3");
        await debugging.sendCommand("Input.dispatchDragEvent", { type: "dragEnter", ...point, data: dragData });
        await debugging.sendCommand("Input.dispatchDragEvent", { type: "dragOver", ...point, data: dragData });
        await waitForRenderer(target, "document.querySelector('#composer-form')?.dataset.dropActive === 'true'", 2_000);
        await settlePaint();
        const activeIndicatorVisible = await target.webContents.executeJavaScript("document.querySelector('#composer-drop-overlay')?.hidden === false");
        const image = await target.webContents.capturePage();
        await writeFile(join(outputDirectory, "desktop-file-drop-1920x1080.png"), image.toPNG(), { mode: 0o600 });
        await debugging.sendCommand("Input.dispatchDragEvent", { type: "drop", ...point, data: dragData });
        dropped = true;
        await waitForRenderer(target, "document.querySelectorAll('#composer-references .composer-reference').length === 2", 2_000);
        await settlePaint();
        const probe = await target.webContents.executeJavaScript(`(() => ({
      activeIndicatorVisible: ${Boolean(activeIndicatorVisible)},
      inputPreserved: document.querySelector('#composer-input')?.value === '请检查拖入的上下文',
      notSubmitted: document.querySelector('#composer-form')?.dataset.smokeSubmitCount === '0',
      overlayHiddenAfterDrop: document.querySelector('#composer-drop-overlay')?.hidden === true,
      referenceCount: document.querySelectorAll('#composer-references .composer-reference').length,
      referencedPaths: Array.from(document.querySelectorAll('#composer-references .composer-reference-path')).map((node) => node.title),
      referencedKinds: Array.from(document.querySelectorAll('#composer-references .composer-reference')).map((node) => node.dataset.kind || '')
    }))()`);
        return { probe, imageSize: image.getSize() };
    }
    finally {
        if (!dropped && debugging.isAttached()) {
            await debugging.sendCommand("Input.dispatchDragEvent", { type: "dragCancel", ...point, data: dragData }).catch(() => undefined);
        }
        if (attachedHere && debugging.isAttached())
            debugging.detach();
    }
}
function smokeEvent(seq, type, payload) {
    return {
        version: 1,
        kind: "event",
        event: {
            v: 1,
            kind: "event",
            id: `desktop-smoke-${seq}`,
            streamId: "desktop-smoke",
            seq,
            ts: new Date(Date.parse("2026-08-10T08:30:00.000Z") + seq).toISOString(),
            durable: false,
            type,
            payload,
        },
    };
}
/**
 * Renderer-side failures otherwise surface only as a bare wait timeout, which
 * says nothing about the cause. Buffering console output and load failures lets
 * a timeout report what the renderer actually did.
 */
const rendererDiagnostics = [];
function captureRendererDiagnostics(target) {
    const record = (line) => {
        rendererDiagnostics.push(line);
        // Keep the buffer bounded; the earliest lines explain a failed startup.
        if (rendererDiagnostics.length > 200)
            rendererDiagnostics.shift();
    };
    target.webContents.on("console-message", (_event, level, message, line, source) => {
        record(`console[${level}] ${message} (${source}:${line})`);
    });
    target.webContents.on("did-fail-load", (_event, code, description) => {
        record(`did-fail-load ${code} ${description}`);
    });
    target.webContents.on("preload-error", (_event, preload, error) => {
        record(`preload-error ${preload}: ${error.message}`);
    });
    target.webContents.on("render-process-gone", (_event, details) => {
        record(`render-process-gone ${details.reason} exit=${String(details.exitCode)}`);
    });
}
async function waitForRenderer(target, expression, timeoutMs) {
    try {
        await waitFor(async () => Boolean(await target.webContents.executeJavaScript(expression)), timeoutMs);
    }
    catch (error) {
        const detail = rendererDiagnostics.length > 0
            ? `\nRenderer diagnostics:\n  ${rendererDiagnostics.join("\n  ")}`
            : "\nRenderer diagnostics: none captured";
        throw new Error(`${toError(error).message} while waiting for: ${expression}${detail}`);
    }
}
async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate())
            return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out after ${timeoutMs}ms`);
}
async function settlePaint() {
    await new Promise((resolve) => setTimeout(resolve, 320));
}
async function setRendererTheme(target, theme) {
    await target.webContents.executeJavaScript(`(() => {
    if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) {
      document.querySelector('#theme-toggle')?.click();
    }
  })()`);
    await waitForRenderer(target, `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, 2_000);
}
async function readThemeSnapshot(target) {
    return target.webContents.executeJavaScript(`(() => ({
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    surfaceColor: getComputedStyle(document.querySelector('.panel')).backgroundColor
  }))()`);
}
async function readResponsiveLayout(target) {
    return target.webContents.executeJavaScript(`(() => {
    const visible = (selector) => {
      const node = document.querySelector(selector);
      return Boolean(node && getComputedStyle(node).display !== 'none');
    };
    const composerRect = document.querySelector('.composer')?.getBoundingClientRect();
    const conversationRect = document.querySelector('.conversation')?.getBoundingClientRect();
    const inspectorRect = document.querySelector('#inspector-panel')?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      shellHeight: document.querySelector('#app-shell')?.getBoundingClientRect().height || 0,
      workspaceBottom: document.querySelector('#main-workspace')?.getBoundingClientRect().bottom || 0,
      navigationVisible: visible('#navigation-panel'),
      inspectorVisible: visible('#inspector-panel'),
      inspectorContained: !visible('#inspector-panel') || Boolean(inspectorRect && inspectorRect.left >= 0 && inspectorRect.top >= 0 && inspectorRect.right <= innerWidth && inspectorRect.bottom <= innerHeight),
      conversationWidth: conversationRect?.width || 0,
      composerVisible: Boolean(composerRect && composerRect.top >= 0 && composerRect.bottom <= innerHeight)
    };
  })()`);
}
function parseArguments(argv) {
    let home;
    let smokeDirectory;
    let smokeFixture = false;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "--home") {
            const value = argv[++index];
            if (!value)
                throw new Error("--home requires a path");
            home = value;
        }
        else if (argument?.startsWith("--home=")) {
            home = argument.slice("--home=".length);
        }
        else if (argument === "--smoke-dir") {
            const value = argv[++index];
            if (!value)
                throw new Error("--smoke-dir requires a path");
            smokeDirectory = value;
        }
        else if (argument?.startsWith("--smoke-dir=")) {
            smokeDirectory = argument.slice("--smoke-dir=".length);
        }
        else if (argument === "--smoke-fixture") {
            smokeFixture = true;
        }
    }
    return {
        ...(home ? { home } : {}),
        ...(smokeDirectory ? { smokeDirectory } : {}),
        smokeFixture,
    };
}
function failStartup(error) {
    exitCode = 1;
    process.stderr.write(`pSpore desktop: ${toError(error).message}\n`);
    requestShutdown(exitCode);
}
function requestShutdown(code) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    exitCode = code;
    unsubscribeBridge?.();
    unsubscribeBridge = undefined;
    void (async () => {
        await bridge?.stop();
        // Production GUI is only a shell. The system service intentionally keeps
        // sessions, automation, and integrations alive after every window closes.
        await daemonSupervisor?.stop();
    })()
        .catch((error) => {
        process.stderr.write(`pSpore desktop shutdown: ${toError(error).message}\n`);
        exitCode = 1;
    })
        .finally(() => app.exit(exitCode));
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=main.js.map