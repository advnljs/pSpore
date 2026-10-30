import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, screen } from "electron";
import { ArticleStore } from "../articles/store.js";
import { resolvePsporeHome } from "../config/config.js";
import { stopLegacyDaemon } from "../service/legacy-daemon.js";
import { serviceLaunchSpec } from "../service/service-launch.js";
import { SystemServiceManager } from "../service/system-service.js";
import { IndexingSettingsService } from "../settings/indexing-settings-service.js";
import { LlmSettingsService } from "../settings/llm-settings-service.js";
import { BYPASS_PERMISSION_MODE } from "../settings/llm-settings.js";
import { initializePsporeHome } from "../storage/home.js";
import { PI_VERSION, PSPORE_VERSION } from "../version.js";
import { exportArticleFile } from "./article-export.js";
import { decodeLocalPathRequest, resolveLocalPath } from "./local-path.js";
import { openLocalItem, revealLocalItem } from "./system-open.js";
import { DaemonBridge } from "./daemon-bridge.js";
import { DESKTOP_ARTICLE_EXPORT_CHANNEL, DESKTOP_OPEN_LOCAL_PATH_CHANNEL, DESKTOP_BOOTSTRAP_CHANNEL, DESKTOP_DISPATCH_CHANNEL, DESKTOP_FRAME_CHANNEL, DESKTOP_INDEXING_GET_CHANNEL, DESKTOP_ATTACH_CHANNEL, DESKTOP_INDEXING_PICK_CHANNEL, decodeAttachmentKind, DESKTOP_INDEXING_SAVE_CHANNEL, DESKTOP_SETTINGS_GET_CHANNEL, DESKTOP_SETTINGS_SAVE_CHANNEL, decodeArticleExportRequest, decodeDesktopIndexingSettingsUpdate, decodeDesktopLlmSettingsUpdate, } from "./ipc-contract.js";
import { MIN_ARTICLE_WIDTH, MIN_CONVERSATION_WIDTH } from "./renderer/article-split.js";
import { DESKTOP_CSP, desktopWindowOptions, isTrustedRendererUrl } from "./security.js";
import { createDesktopSmokeState } from "./smoke-fixture.js";
import { hardenWindow } from "./window-security.js";
import { captureRendererDiagnostics, waitFor, waitForRenderer } from "./renderer-diagnostics.js";
let arguments_;
let startup;
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
let articleRoot = "";
const smokeOpenedPaths = [];
const smokeRevealedPaths = [];
export async function startDesktop(options, startupWindow) {
    arguments_ = options;
    startup = startupWindow;
    const home = resolvePsporeHome(arguments_.home);
    const { paths } = await initializePsporeHome(home);
    articleRoot = join(paths.workspace, "articles");
    const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
    const preloadPath = join(moduleDirectory, "preload.cjs");
    const rendererPath = join(moduleDirectory, "renderer", "index.html");
    rendererUrl = pathToFileURL(rendererPath).href;
    await startup.setMessage("正在唤醒本地助手");
    if (shuttingDown)
        return;
    if (arguments_.smokeDirectory) {
        // The visual harness owns an isolated temporary daemon and must never
        // register persistent services in the developer's real user manager.
        // The production shell never loads the daemon/model SDK into its process.
        const { DaemonSupervisor } = await import("../daemon/supervisor.js");
        if (shuttingDown)
            return;
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
    if (shuttingDown)
        return;
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
    await startup.setMessage("正在整理工作空间");
    if (shuttingDown)
        return;
    window = new BrowserWindow(desktopWindowOptions(preloadPath, primaryWorkArea()));
    // Closing the main window must also close a still-visible startup window.
    window.on("closed", () => requestShutdown(0));
    captureRendererDiagnostics(window);
    hardenWindow(window, rendererUrl);
    installIpc(window, bridge, settingsService, indexingService);
    unsubscribeBridge = bridge.subscribe((frame) => sendFrame(window, frame));
    await window.loadFile(rendererPath);
    await waitForRenderer(window, "document.documentElement.dataset.ready === 'true'", 15_000);
    if (shuttingDown)
        return;
    if (arguments_.smokeDirectory) {
        window.setContentSize(1_920, 1_080);
        window.show();
        startup.close();
        await runSmoke(window, bridge, arguments_.smokeDirectory, arguments_.smokeFixture);
        await bridge.stop();
        requestShutdown(exitCode);
        return;
    }
    // The workspace is a full-height application shell, so the first launch fills
    // the display instead of leaving the desktop visible around a floating window.
    showMaximized(window);
    startup.close();
}
/** At most this many paths from one chooser, matching the composer's own ceiling. */
const MAX_ATTACHMENTS = 32;
/**
 * Where this system keeps the user's own directories. Electron resolves the XDG
 * entries, so a desktop named 桌面 is found without the renderer guessing.
 */
function desktopPlaces() {
    const place = (name) => {
        try {
            return app.getPath(name);
        }
        catch {
            return "";
        }
    };
    return { desktop: place("desktop"), home: place("home") };
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
function installIpc(target, daemonBridge, desktopSettings, indexingSettings) {
    ipcMain.removeHandler(DESKTOP_BOOTSTRAP_CHANNEL);
    ipcMain.removeHandler(DESKTOP_DISPATCH_CHANNEL);
    ipcMain.removeHandler(DESKTOP_SETTINGS_GET_CHANNEL);
    ipcMain.removeHandler(DESKTOP_SETTINGS_SAVE_CHANNEL);
    ipcMain.removeHandler(DESKTOP_INDEXING_GET_CHANNEL);
    ipcMain.removeHandler(DESKTOP_INDEXING_SAVE_CHANNEL);
    ipcMain.removeHandler(DESKTOP_INDEXING_PICK_CHANNEL);
    ipcMain.removeHandler(DESKTOP_ATTACH_CHANNEL);
    ipcMain.removeHandler(DESKTOP_ARTICLE_EXPORT_CHANNEL);
    ipcMain.removeHandler(DESKTOP_OPEN_LOCAL_PATH_CHANNEL);
    ipcMain.handle(DESKTOP_BOOTSTRAP_CHANNEL, (event) => {
        assertTrustedSender(event, target.webContents);
        return { ...daemonBridge.bootstrap(), places: desktopPlaces() };
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
    ipcMain.handle(DESKTOP_ARTICLE_EXPORT_CHANNEL, async (event, candidate) => {
        assertTrustedSender(event, target.webContents);
        const request = decodeArticleExportRequest(candidate);
        return exportArticleFile(new ArticleStore(articleRoot), request, target);
    });
    ipcMain.handle(DESKTOP_OPEN_LOCAL_PATH_CHANNEL, async (event, candidate) => {
        assertTrustedSender(event, target.webContents);
        const request = decodeLocalPathRequest(candidate);
        const path = await resolveLocalPath(request.path, request.action);
        if (arguments_.smokeFixture) {
            if (request.action === "reveal")
                smokeRevealedPaths.push(path);
            else
                smokeOpenedPaths.push(path);
            return;
        }
        if (request.action === "reveal") {
            await revealLocalItem(path);
            return;
        }
        await openLocalItem(path);
    });
    ipcMain.handle(DESKTOP_ATTACH_CHANNEL, async (event, candidate) => {
        assertTrustedSender(event, target.webContents);
        const kind = decodeAttachmentKind(candidate);
        const result = await dialog.showOpenDialog(target, {
            title: kind === "directory" ? "选择要引用的文件夹" : "选择要引用的文件",
            // One kind per call: the GTK chooser honours only one of openFile and
            // openDirectory, and answers with directories when given both.
            // Only the path is ever sent; nothing here is read or uploaded.
            properties: kind === "directory"
                ? ["openDirectory", "multiSelections"]
                : ["openFile", "multiSelections"],
        });
        if (result.canceled)
            return [];
        const attachments = [];
        for (const path of result.filePaths.slice(0, MAX_ATTACHMENTS)) {
            try {
                // The chooser is asked for one kind, but a symlink can still answer
                // with the other, so the reference says what the path actually is.
                attachments.push({ path, kind: (await stat(path)).isDirectory() ? "directory" : "file" });
            }
            catch {
                // Gone between choosing and answering; the renderer simply gets fewer.
            }
        }
        return attachments;
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
    if (BrowserWindow.getAllWindows().length !== 1 || BrowserWindow.getAllWindows()[0] !== target)
        throw new Error("Startup window survived the handoff");
    if (!isAbsolute(outputDirectory))
        throw new Error("--smoke-dir must be an absolute path");
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const linkedFile = join(outputDirectory, "example report.txt");
    const linkedDirectory = join(outputDirectory, "example-directory");
    if (fixture) {
        await writeFile(linkedFile, "A real file opened from an assistant reply.\n", { mode: 0o600 });
        await mkdir(linkedDirectory, { mode: 0o700 });
    }
    target.setContentSize(1_920, 1_080);
    target.show();
    await waitForRenderer(target, "document.documentElement.dataset.ready === 'true'", 10_000);
    await waitFor(() => daemonBridge.bootstrap().connection.phase === "connected", 8_000).catch(() => undefined);
    let reconnectVerified = false;
    let reconnectMasked = false;
    let sessionSearchProbe = { opened: false, matched: false, closed: false };
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
    const selection = {
        historyBefore: "",
        historyAfter: "",
        scrollHeldDuringSelection: false,
        streamingBefore: "",
        streamingAfter: "",
    };
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
        // leave the conversation looking dead. Waited for rather than sampled: the
        // queue control appears a render before the activity line catches up, so a
        // loaded machine reads the frame that still says "waiting".
        await waitForRenderer(target, "document.querySelector('#run-activity')?.dataset.phase === 'tool'", 5_000)
            .catch(() => undefined);
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
      thinkingVisible: Boolean(document.querySelector('.thinking-stream:not([hidden])')),
      thinkingSeparate: Boolean(document.querySelector('.thinking-stream:not([hidden])') && document.querySelector('.message.streaming > .message-body:not([hidden])')),
      thinkingHiddenAfterCompletion: false,
      truncationNoticeVisible: Boolean(document.querySelector('#transcript .message-truncated button')),
      truncationRetryOffered: false,
      legacyComposerModes: document.querySelectorAll('#composer-mode, .mode-select').length,
    // Dragging is not always possible, so a chooser has to be reachable too.
    attachButtonsOffered: [
      document.querySelector('#attach-file-button'),
      document.querySelector('#attach-directory-button'),
    ].filter(Boolean).length,
    // Hovering has to say which is which; the icons alone do not.
    attachTooltips: ['#attach-file-button', '#attach-directory-button']
      .map((id) => document.querySelector(id)?.title ?? ''),
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
      builtinTools: Array.from(document.querySelectorAll('#integration-list .tool-chips:not(.skill-chips) .tool-chip')).map((chip) => chip.textContent ?? ''),
      skills: rows.map((row) => row.textContent ?? '').filter((text) => text.startsWith('Skill ·')).map((text) => text.trim().slice(0, 40)),
      skillChips: Array.from(document.querySelectorAll('#integration-list .skill-chips .tool-chip')).map((chip) => chip.textContent ?? ''),
      unloadedSkills: rows.map((row) => row.textContent ?? '').filter((text) => text.startsWith('未加载 Skill ·')).map((text) => text.trim().slice(0, 160))
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
        // Copying out of a conversation that is still being written. Every frame
        // used to rebuild the transcript, so a selection survived for one frame at
        // most — the reader had to wait for the reply to finish before they could
        // take anything out of it.
        const streamDelta = async (seq, text) => {
            sendFrame(target, {
                version: 1,
                kind: "delta",
                streamId: "desktop-smoke",
                fromSeq: seq,
                seq,
                sessionId: "main",
                itemId: "smoke-item-1",
                channel: "text",
                text,
            });
            await settlePaint();
        };
        // A second paragraph, so the streaming body has a block that later tokens
        // do not touch. Without one there is nothing in it that could be kept.
        await streamDelta(20, "\n\n第二段：证据编号与耗时。");
        selection.historyBefore = await target.webContents.executeJavaScript(`(() => {
      const body = Array.from(document.querySelectorAll('#transcript > .message:not(.streaming) .message-body'))
        .find((node) => (node.textContent ?? '').trim().length > 24);
      if (!body) return '';
      const range = document.createRange();
      range.selectNodeContents(body);
      const active = getSelection();
      if (!active) return '';
      active.removeAllRanges();
      active.addRange(range);
      return active.toString();
    })()`);
        const scrollBeforeDelta = await target.webContents.executeJavaScript("document.querySelector('#transcript')?.scrollTop ?? -1");
        await streamDelta(21, " 历史选区期间仍在输出。");
        selection.historyAfter = await target.webContents.executeJavaScript("getSelection()?.toString() ?? ''");
        const scrollAfterDelta = await target.webContents.executeJavaScript("document.querySelector('#transcript')?.scrollTop ?? -1");
        selection.scrollHeldDuringSelection = scrollBeforeDelta >= 0 && scrollBeforeDelta === scrollAfterDelta;
        selection.streamingBefore = await target.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('.message.streaming .message-body:not([hidden]) > *');
      if (!first) return '';
      const range = document.createRange();
      range.selectNodeContents(first);
      const active = getSelection();
      if (!active) return '';
      active.removeAllRanges();
      active.addRange(range);
      return active.toString();
    })()`);
        await streamDelta(22, " 又一批 token。");
        selection.streamingAfter = await target.webContents.executeJavaScript("getSelection()?.toString() ?? ''");
        await target.webContents.executeJavaScript("getSelection()?.removeAllRanges(); true");
        await settlePaint();
        sendFrame(target, smokeEvent(23, "transcript.item.finished", {
            sessionId: "main",
            item: {
                id: "smoke-item-1", role: "assistant",
                text: `最终证据已归并。[打开文件](${pathToFileURL(linkedFile).href})，目录 ${linkedDirectory}，代码路径 \`${linkedFile}\`。`,
                status: "complete", ts: "2026-08-10T08:10:00.000Z",
            },
        }));
        await waitForRenderer(target, "!document.querySelector('.thinking-stream:not([hidden])')", 5_000);
        await settlePaint();
        await target.webContents.executeJavaScript(`(() => {
      const file = [...document.querySelectorAll('.message.assistant .md-local-link')]
        .find((node) => node.title === ${JSON.stringify(pathToFileURL(linkedFile).href)});
      const directory = [...document.querySelectorAll('.message.assistant .md-local-link')]
        .find((node) => node.title === ${JSON.stringify(linkedDirectory)});
      const code = [...document.querySelectorAll('.message.assistant .md-local-link')]
        .find((node) => node.title === ${JSON.stringify(linkedFile)});
      file?.click();
      directory?.click();
      code?.click();
    })()`);
        await waitFor(() => smokeOpenedPaths.filter((path) => path === linkedFile).length === 2
            && smokeOpenedPaths.includes(linkedDirectory), 3_000);
        await target.webContents.executeJavaScript(`(() => {
      const file = [...document.querySelectorAll('.message.assistant .md-local-link')]
        .find((node) => node.title === ${JSON.stringify(linkedFile)});
      if (!file) return;
      const rect = file.getBoundingClientRect();
      file.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 8,
        clientY: rect.bottom + 4,
      }));
    })()`);
        await waitForRenderer(target, `(() => {
        const menu = document.querySelector('.local-link-menu');
        const open = menu?.querySelector('[data-action="open"]');
        const reveal = menu?.querySelector('[data-action="reveal"]');
        return Boolean(menu && open && reveal && open.textContent?.includes('打开') && reveal.textContent?.includes('打开所在目录'));
      })()`, 2_000);
        await target.webContents.executeJavaScript(`document.querySelector('.local-link-menu [data-action="reveal"]')?.click()`);
        await waitFor(() => smokeRevealedPaths.includes(linkedFile), 3_000);
        await writeFile(join(outputDirectory, "desktop-local-links-1920x1080.png"), (await target.webContents.capturePage()).toPNG(), { mode: 0o600 });
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
        sessionSearchProbe = await target.webContents.executeJavaScript(`(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true }));
      const bar = document.querySelector('#session-search');
      const input = document.querySelector('#session-search-input');
      if (!(input instanceof HTMLInputElement) || bar?.hidden !== false) return { opened: false, matched: false, closed: false };
      input.value = 'virtual rendering fixture';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { opened: true, matched: false, closed: false };
    })()`);
        sessionSearchProbe.matched = await waitForRenderer(target, `(() => {
        const count = document.querySelector('#session-search-count')?.textContent ?? '';
        return count.includes('/') && Boolean(document.querySelector('mark.session-find-hit.current'));
      })()`, 3_000).then(() => true, () => false);
        await target.webContents.executeJavaScript(`(() => {
      document.querySelector('#session-search-close')?.click();
      const transcript = document.querySelector('#transcript');
      if (!transcript) return;
      transcript.scrollTop = transcript.scrollHeight;
      transcript.dispatchEvent(new Event('scroll'));
    })()`);
        sessionSearchProbe.closed = await waitForRenderer(target, `document.querySelector('#session-search')?.hidden === true && !document.querySelector('mark.session-find-hit')`, 2_000).then(() => true, () => false);
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
    // Checked before the provider is switched: making Base URL required is this
    // probe's doing, not something the panel was filled with.
    const form = document.querySelector('#settings-form');
    const invalidFields = Array.from(form?.elements ?? [])
      .filter((field) => field.willValidate && !field.checkValidity())
      .map((field) => field.id);
    provider.value = 'custom-openai';
    provider.dispatchEvent(new Event('change'));
    // Adding a row is the only way to see the header editor holding anything.
    document.querySelector('#settings-header-add')?.click();
    const headerRows = document.querySelectorAll('#settings-header-list .settings-header-row').length;
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
        && Number(document.querySelector('#settings-compaction-keep-recent')?.value) === settings.autoCompactionKeepRecentTokens,
      headerRowsAfterAdd: headerRows,
      headerValueInputType: document.querySelector('#settings-header-list .settings-header-value')?.type ?? '',
      formAcceptsPersistedValues: invalidFields.length === 0,
      invalidFields
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
    // Back at the baseline viewport, before the approval overlay goes up: the
    // panel needs the full width it is designed for and an unblocked page.
    const articlePanel = await exerciseArticlePanel(target);
    let approvalSize;
    if (fixture) {
        const base = daemonBridge.bootstrap();
        sendFrame(target, {
            version: 1,
            kind: "snapshot",
            snapshot: createDesktopSmokeState(base.snapshot, true),
            cursors: { ...base.cursors, "desktop-smoke": 24 },
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
        ...(fixture ? {
            localLinks: {
                fileOpened: smokeOpenedPaths.includes(linkedFile),
                directoryOpened: smokeOpenedPaths.includes(linkedDirectory),
                codePathOpened: smokeOpenedPaths.filter((path) => path === linkedFile).length === 2,
                fileRevealed: smokeRevealedPaths.includes(linkedFile),
                openedPaths: [...smokeOpenedPaths],
            },
            sessionSearch: sessionSearchProbe,
        } : {}),
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
        selection,
        indexingPanel,
        articlePanel,
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
    if (fixture && (!report.localLinks?.fileOpened || !report.localLinks.directoryOpened || !report.localLinks.codePathOpened)) {
        failures.push("assistant output did not open its linked file, directory and inline-code path");
    }
    if (fixture && !report.localLinks?.fileRevealed) {
        failures.push("the local-link menu did not reveal the file in its directory");
    }
    if (fixture && (!report.sessionSearch?.opened || !report.sessionSearch.matched || !report.sessionSearch.closed)) {
        failures.push("current-session search did not open, match, and close");
    }
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
        "exportArticle",
        "getIndexing",
        "getPathForFile",
        "getSettings",
        "openLocalPath",
        "pickAttachments",
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
    if (!report.settings.formAcceptsPersistedValues) {
        // The browser refuses to submit a form with an invalid field, so this makes
        // the save button do nothing at all.
        failures.push(`settings panel rejects its own persisted values: ${report.settings.invalidFields.join(", ")}`);
    }
    if (report.settings.headerRowsAfterAdd < 1)
        failures.push("settings panel does not offer a custom request header row");
    // A header value can be a proxy token, so it is masked like the key and cookie.
    if (report.settings.headerValueInputType !== "password")
        failures.push("custom header value is not masked");
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
        // One dialog each: the GTK chooser answers a request for both with
        // directories only, so a single button could never attach a file.
        if (report.mainVisual.attachButtonsOffered !== 2) {
            failures.push("composer does not offer separate file and folder choosers");
        }
        if (report.mainVisual.attachTooltips.some((tooltip) => tooltip.length < 4)) {
            failures.push(`an attach button has no tooltip: ${JSON.stringify(report.mainVisual.attachTooltips)}`);
        }
        // Text already on screen has to stay selectable while the reply continues.
        if (report.selection.historyBefore.length < 12)
            failures.push("smoke could not select a settled message to copy from");
        if (report.selection.historyAfter !== report.selection.historyBefore) {
            failures.push("a streaming token destroyed the selection held on an earlier message");
        }
        if (!report.selection.scrollHeldDuringSelection)
            failures.push("the transcript scrolled out from under a held selection");
        if (report.selection.streamingBefore.length < 6)
            failures.push("smoke could not select the settled part of the streaming reply");
        if (report.selection.streamingAfter !== report.selection.streamingBefore) {
            failures.push("a streaming token destroyed the selection held on the part it had already written");
        }
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
        // A skill the user put in the workspace must be visible, not only trusted installs:
        // the smoke harness seeds one loadable skill and one without an entry point.
        for (const expected of ["doc-extract", "smoke-mail"]) {
            if (!report.integrations.skillChips.includes(expected))
                failures.push(`integrations tab does not offer the ${expected} skill`);
        }
        if (report.integrations.builtinTools.includes("smoke-mail"))
            failures.push("a skill was rendered as a built-in tool");
        if (!report.integrations.unloadedSkills.some((row) => row.includes("smoke-draft") && row.includes("SKILL_DRAFT.md"))) {
            failures.push("integrations tab does not explain why the smoke-draft skill was not loaded");
        }
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
        // The document panel: chat keeps a receipt, the article is rendered here.
        const article = report.articlePanel;
        if (article.reopenLabel !== "季度复盘")
            failures.push("document panel was not offered for the session's own article");
        if (article.version !== "v2")
            failures.push(`document panel opened ${article.version || "nothing"} instead of the latest version`);
        if (article.versionChips.join(",") !== "v1,v2")
            failures.push("document panel did not list both saved versions");
        if (article.renderedBlocks < 4)
            failures.push("document panel did not render the article body");
        if (article.scrollTop !== 0)
            failures.push("document panel opened part-way down the article instead of at its title");
        if (!article.comparable)
            failures.push("document panel could not compare against the version it replaced");
        if (!article.diffSummary.includes("+3 段"))
            failures.push(`document panel summarised the change as "${article.diffSummary}"`);
        if (article.exportLabel !== "导出")
            failures.push("export formats are offered without a label saying what they are");
        // The revision view, not a one-line count of what changed.
        if (article.diffRows < 10)
            failures.push(`revision view drew ${article.diffRows} lines instead of the whole document`);
        if (article.removedRows < 1)
            failures.push("revision view did not show the line the new version dropped");
        if (article.addedRows < 2)
            failures.push("revision view did not show the lines the new version added");
        if (article.inlineMarks < 1)
            failures.push("revision view marked whole lines instead of the words that changed");
        if (article.lineViewRows !== article.diffRows)
            failures.push("line granularity changed which lines the revision shows");
        if (article.lineViewInlineMarks !== 0)
            failures.push("line granularity still marked changes inside a line");
        if (!article.reusedAcrossVersions)
            failures.push("switching versions rebuilt blocks the new version had not changed");
        if (!article.clearedOnSessionChange)
            failures.push("another session's document was left in the panel");
        if (!article.animatedOpen)
            failures.push("the document column appeared at full width instead of arriving");
        if (Math.abs(article.resizedWidth - Math.round(1_920 * 0.34)) > 24) {
            failures.push(`dragging the boundary left the document ${article.resizedWidth}px wide`);
        }
        // Arrow keys reach the same boundary, so the width is not pointer-only.
        if (article.widthAfterKeyboardStep <= article.resizedWidth) {
            failures.push("the arrow keys did not widen the document column");
        }
        for (const layout of article.split) {
            const at = `${layout.name} (${layout.viewport.width}x${layout.viewport.height})`;
            if (!layout.column)
                failures.push(`at ${at} the document floats over the conversation instead of taking a column`);
            if (layout.overlap > 0)
                failures.push(`at ${at} the document covers ${layout.overlap}px of the conversation`);
            if (layout.conversationWidth < MIN_CONVERSATION_WIDTH - 1) {
                failures.push(`at ${at} the conversation was squeezed to ${layout.conversationWidth}px`);
            }
            if (layout.articleWidth < MIN_ARTICLE_WIDTH - 1)
                failures.push(`at ${at} the document was squeezed to ${layout.articleWidth}px`);
            if (layout.conversationOverflow > 1) {
                failures.push(`at ${at} the conversation's content sticks ${layout.conversationOverflow}px out under the document`);
            }
            if (!layout.handle)
                failures.push(`at ${at} there is no boundary to drag`);
            if (layout.documentOverflow > 0)
                failures.push(`at ${at} the split pushed the workspace into a horizontal scrollbar`);
        }
        if (article.split.length < 6)
            failures.push("the split was not measured across reopen and resize");
        if (!article.reopenAnimated)
            failures.push("a reopened document appeared at full width instead of arriving");
        if (!article.splitKeptAcrossResize)
            failures.push("shrinking the window and growing it back lost the reader's split");
        if (article.compactDrag.after <= article.compactDrag.before) {
            failures.push("the boundary did not drag in the smallest window");
        }
        if (article.exportFormats.join(",") !== "txt,md,docx,pdf")
            failures.push("document panel does not offer all four exports");
        if (article.documentOverflow > 0)
            failures.push("document panel pushed the workspace into a horizontal scrollbar");
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
/**
 * Measures the open split. A long unbreakable notice is put on the status line
 * first: the session-switch notice carries a whole session id, and that one line
 * used to set the conversation's minimum width, so it stopped shrinking and was
 * clipped under the document instead.
 */
async function readArticleSplit(target, name) {
    const layout = await target.webContents.executeJavaScript(`(() => {
    const notice = document.querySelector('#notice-line');
    const previous = notice ? notice.textContent : '';
    if (notice) notice.textContent = '已切换到 session-' + 'f2fb0431d92a4424b705b55b82307dd0'.repeat(4);
    const conversation = document.querySelector('.conversation');
    const article = document.querySelector('#article-panel');
    const handle = document.querySelector('#article-resize');
    const c = conversation.getBoundingClientRect();
    const a = article.getBoundingClientRect();
    let overflow = 0;
    const parts = '.conversation-header, .conversation-header > *, .session-health > :not([hidden]), .transcript, .composer-wrap, .notice-line, .composer, .composer-toolbar, .composer-actions, #send-button';
    for (const node of conversation.querySelectorAll(parts)) {
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) overflow = Math.max(overflow, r.right - c.right);
    }
    const h = handle ? handle.getBoundingClientRect() : { width: 0 };
    const result = {
      viewport: { width: innerWidth, height: innerHeight },
      column: !article.hidden && getComputedStyle(article).position !== 'absolute',
      overlap: Math.max(0, Math.round(c.right - a.left)),
      conversationWidth: Math.round(c.width),
      articleWidth: Math.round(a.width),
      conversationOverflow: Math.max(0, Math.round(overflow)),
      handle: Boolean(handle) && h.width > 0 && getComputedStyle(handle).display !== 'none',
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
    if (notice) notice.textContent = previous;
    return result;
  })()`);
    return { name, ...layout };
}
async function exerciseArticlePanel(target) {
    const empty = {
        reopenLabel: "",
        title: "",
        version: "",
        versionChips: [],
        renderedBlocks: 0,
        scrollTop: -1,
        diffSummary: "",
        comparable: false,
        diffRows: 0,
        removedRows: 0,
        addedRows: 0,
        inlineMarks: 0,
        lineViewRows: 0,
        lineViewInlineMarks: 0,
        reusedAcrossVersions: false,
        exportLabel: "",
        clearedOnSessionChange: false,
        resizedWidth: 0,
        widthAfterKeyboardStep: 0,
        animatedOpen: false,
        exportFormats: [],
        documentOverflow: 0,
        split: [],
        reopenAnimated: false,
        splitKeptAcrossResize: false,
        compactDrag: { before: 0, after: 0 },
    };
    const offered = await waitForRenderer(target, "document.querySelector('#open-article-button')?.hidden === false", 6_000).then(() => true).catch(() => false);
    if (!offered)
        return empty;
    const reopenLabel = await target.webContents.executeJavaScript("document.querySelector('#open-article-button')?.textContent ?? ''");
    await target.webContents.executeJavaScript("document.querySelector('#open-article-button')?.click(); true");
    await waitForRenderer(target, "document.documentElement.dataset.article === 'open'", 6_000);
    // The column has to arrive, not appear: sampled immediately after the click
    // it is still narrower than it settles at.
    const openingWidth = await target.webContents.executeJavaScript("Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--article-width')) || 0");
    // The version it replaced is fetched after the first paint, so the compare
    // control only becomes usable once that lands.
    await waitForRenderer(target, "document.querySelector('#article-view-token')?.disabled === false", 6_000)
        .catch(() => undefined);
    await settlePaint();
    const opened = await target.webContents.executeJavaScript(`(() => {
    const stage = document.querySelector('#article-stage');
    return {
      title: document.querySelector('#article-title')?.textContent ?? '',
      version: document.querySelector('#article-version')?.textContent ?? '',
      versionChips: Array.from(document.querySelectorAll('.article-version')).map((node) => node.textContent ?? ''),
      renderedBlocks: document.querySelectorAll('#article-render .article-block').length,
      scrollTop: stage ? stage.scrollTop : -1,
      diffSummary: document.querySelector('#article-diff-summary')?.textContent ?? '',
      comparable: document.querySelector('#article-view-token')?.disabled === false,
      exportLabel: document.querySelector('#article-export-label')?.textContent ?? '',
      exportFormats: Array.from(document.querySelectorAll('#article-panel [data-export]')).map((node) => node.dataset.export ?? ''),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  })()`);
    // Reading the revision: the rows the diff drew, and the marks inside the line
    // that was rewritten rather than replaced.
    await target.webContents.executeJavaScript("document.querySelector('#article-view-token')?.click(); true");
    await settlePaint();
    const revision = await target.webContents.executeJavaScript(`(() => ({
    diffRows: document.querySelectorAll('#article-render .article-diff-line').length,
    removedRows: document.querySelectorAll('#article-render .article-diff-line[data-change="remove"]').length,
    addedRows: document.querySelectorAll('#article-render .article-diff-line[data-change="add"]').length,
    inlineMarks: document.querySelectorAll('#article-render .article-diff-text ins, #article-render .article-diff-text del').length
  }))()`);
    await target.webContents.executeJavaScript("document.querySelector('#article-view-line')?.click(); true");
    await settlePaint();
    const lineView = await target.webContents.executeJavaScript(`(() => ({
    lineViewRows: document.querySelectorAll('#article-render .article-diff-line').length,
    lineViewInlineMarks: document.querySelectorAll('#article-render .article-diff-text ins, #article-render .article-diff-text del').length
  }))()`);
    await target.webContents.executeJavaScript("document.querySelector('#article-view-read')?.click(); true");
    await settlePaint();
    // A version lands on top of the one already drawn: the blocks it did not
    // touch have to be the same elements, not fresh copies of the same words.
    const reusedAcrossVersions = await target.webContents.executeJavaScript(`(async () => {
    const stage = document.querySelector('#article-render');
    const first = stage?.firstElementChild;
    if (!first) return false;
    document.querySelector('.article-version[aria-pressed="false"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const back = document.querySelectorAll('.article-version');
    back[back.length - 1]?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return document.querySelector('#article-render')?.firstElementChild === first;
  })()`);
    const settledWidth = await target.webContents.executeJavaScript("Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--article-width')) || 0");
    // Dragging the boundary, and the same boundary reached from the keyboard.
    const resize = await target.webContents.executeJavaScript(`(async () => {
    const handle = document.querySelector('#article-resize');
    const read = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--article-width')) || 0;
    if (!handle) return { resizedWidth: 0, widthAfterKeyboardStep: 0 };
    const target = Math.round(innerWidth * 0.34);
    const options = { bubbles: true, pointerId: 1, button: 0, clientX: innerWidth - target, clientY: 400 };
    handle.setPointerCapture = () => undefined;
    handle.releasePointerCapture = () => undefined;
    handle.hasPointerCapture = () => false;
    handle.dispatchEvent(new PointerEvent('pointerdown', { ...options, clientX: innerWidth - read() }));
    handle.dispatchEvent(new PointerEvent('pointermove', options));
    handle.dispatchEvent(new PointerEvent('pointerup', options));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const resizedWidth = read();
    handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { resizedWidth, widthAfterKeyboardStep: read() };
  })()`);
    // The split has to survive what used to turn it into a document floating over
    // a clipped conversation: closing and reopening, and every window size the
    // shell allows. It stays a column with a boundary to drag throughout.
    const readWidth = "Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--article-width')) || 0";
    const split = [await readArticleSplit(target, "1920x1080")];
    await target.webContents.executeJavaScript("document.querySelector('#article-close')?.click(); true");
    await waitForRenderer(target, "document.documentElement.dataset.article === undefined", 4_000);
    await target.webContents.executeJavaScript("document.querySelector('#open-article-button')?.click(); true");
    const reopeningWidth = await target.webContents.executeJavaScript(readWidth);
    await settlePaint();
    const reopened = await readArticleSplit(target, "reopened");
    split.push(reopened);
    target.setContentSize(1_440, 900);
    await settlePaint();
    split.push(await readArticleSplit(target, "1440x900"));
    target.setContentSize(1_920, 1_080);
    await settlePaint();
    const restored = await readArticleSplit(target, "1920x1080 again");
    split.push(restored);
    target.setContentSize(1_180, 720);
    await settlePaint();
    split.push(await readArticleSplit(target, "1180x720"));
    const compactDrag = await target.webContents.executeJavaScript(`(async () => {
    const handle = document.querySelector('#article-resize');
    const read = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--article-width')) || 0;
    const before = read();
    if (!handle) return { before, after: before };
    const box = handle.getBoundingClientRect();
    const start = { bubbles: true, pointerId: 2, button: 0, clientX: box.left + box.width / 2, clientY: 300 };
    handle.setPointerCapture = () => undefined;
    handle.releasePointerCapture = () => undefined;
    handle.hasPointerCapture = () => false;
    handle.dispatchEvent(new PointerEvent('pointerdown', start));
    handle.dispatchEvent(new PointerEvent('pointermove', { ...start, clientX: start.clientX - 40 }));
    handle.dispatchEvent(new PointerEvent('pointerup', { ...start, clientX: start.clientX - 40 }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { before, after: read() };
  })()`);
    split.push(await readArticleSplit(target, "1180x720 dragged"));
    target.setContentSize(1_920, 1_080);
    await settlePaint();
    // Switching session has to take the document with it. The panel keeps the
    // current text to diff the next version against and a pool of rendered
    // blocks; carried across, they become the previous session's article showing
    // underneath a new one being written.
    const clearedOnSessionChange = await target.webContents.executeJavaScript(`(async () => {
    const rows = Array.from(document.querySelectorAll('#session-list button'));
    const current = document.querySelector('#session-title')?.textContent ?? '';
    const other = rows.find((row) => !(row.textContent ?? '').includes(current));
    if (!other) return false;
    other.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const cleared = document.querySelectorAll('#article-render .article-block').length === 0
      && document.documentElement.dataset.article === undefined
      && document.querySelector('#open-article-button')?.hidden === true;
    const back = rows.find((row) => (row.textContent ?? '').includes(current));
    back?.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return cleared;
  })()`);
    await target.webContents.executeJavaScript("document.querySelector('#article-close')?.click(); true");
    await waitForRenderer(target, "document.documentElement.dataset.article === undefined", 4_000).catch(() => undefined);
    await settlePaint();
    return {
        ...opened,
        ...revision,
        ...lineView,
        ...resize,
        reopenLabel,
        reusedAcrossVersions,
        clearedOnSessionChange,
        animatedOpen: openingWidth < settledWidth,
        split,
        reopenAnimated: reopeningWidth < reopened.articleWidth,
        splitKeptAcrossResize: Math.abs(restored.articleWidth - reopened.articleWidth) <= 2,
        compactDrag,
    };
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
export function requestShutdown(code) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    startup.close();
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
//# sourceMappingURL=application.js.map