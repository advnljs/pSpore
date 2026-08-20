import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { resolvePsporeHome } from "../config/config.js";
import { DaemonSupervisor } from "../daemon/supervisor.js";
import { LlmSettingsService } from "../settings/llm-settings-service.js";
import { initializePsporeHome } from "../storage/home.js";
import { PI_VERSION, PSPORE_VERSION } from "../version.js";
import { DaemonBridge } from "./daemon-bridge.js";
import { DESKTOP_BOOTSTRAP_CHANNEL, DESKTOP_DISPATCH_CHANNEL, DESKTOP_FRAME_CHANNEL, DESKTOP_SETTINGS_GET_CHANNEL, DESKTOP_SETTINGS_SAVE_CHANNEL, decodeDesktopLlmSettingsUpdate, } from "./ipc-contract.js";
import { DESKTOP_CSP, desktopWindowOptions, isTrustedRendererUrl } from "./security.js";
import { createDesktopSmokeState } from "./smoke-fixture.js";
const arguments_ = parseArguments(process.argv.slice(1));
if (arguments_.smokeDirectory)
    app.disableHardwareAcceleration();
let window;
let bridge;
let daemonSupervisor;
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
    daemonSupervisor = new DaemonSupervisor({ home });
    await daemonSupervisor.start();
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
    window = new BrowserWindow(desktopWindowOptions(preloadPath));
    hardenWindow(window, rendererUrl);
    installIpc(window, bridge, settingsService);
    unsubscribeBridge = bridge.subscribe((frame) => sendFrame(window, frame));
    await window.loadFile(rendererPath);
    if (arguments_.smokeDirectory) {
        await runSmoke(window, bridge, arguments_.smokeDirectory, arguments_.smokeFixture);
        await bridge.stop();
        requestShutdown(exitCode);
        return;
    }
    window.once("ready-to-show", () => window?.show());
    if (!window.isVisible())
        window.show();
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
function installIpc(target, daemonBridge, desktopSettings) {
    ipcMain.removeHandler(DESKTOP_BOOTSTRAP_CHANNEL);
    ipcMain.removeHandler(DESKTOP_DISPATCH_CHANNEL);
    ipcMain.removeHandler(DESKTOP_SETTINGS_GET_CHANNEL);
    ipcMain.removeHandler(DESKTOP_SETTINGS_SAVE_CHANNEL);
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
    ipcMain.handle(DESKTOP_SETTINGS_SAVE_CHANNEL, async (event, candidate) => {
        assertTrustedSender(event, target.webContents);
        if (savingSettings)
            throw new Error("Desktop settings are already being saved");
        const update = decodeDesktopLlmSettingsUpdate(candidate);
        savingSettings = true;
        try {
            const settings = await desktopSettings.save(update);
            const ownership = daemonSupervisor?.ownership;
            if (ownership !== "owned") {
                return {
                    settings,
                    applied: false,
                    restartRequired: true,
                    message: "设置已安全保存；当前由外部 Daemon 提供服务，重启该 Daemon 后生效。",
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
                message: "设置已保存并应用，本地 Daemon 已安全重启。",
            };
        }
        finally {
            savingSettings = false;
        }
    });
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
    if (fixture && daemonBridge.bootstrap().connection.phase === "connected") {
        await daemonBridge.stop();
        await waitForRenderer(target, "document.documentElement.dataset.connection === 'disconnected'", 5_000);
        daemonBridge.start();
        await waitFor(() => daemonBridge.bootstrap().connection.phase === "connected", 8_000);
        await waitForRenderer(target, "document.documentElement.dataset.connection === 'connected'", 5_000);
        reconnectVerified = true;
    }
    if (fixture) {
        const base = daemonBridge.bootstrap();
        const cursors = { ...base.cursors, "desktop-smoke": 10 };
        sendFrame(target, { version: 1, kind: "snapshot", snapshot: createDesktopSmokeState(base.snapshot, false), cursors });
        sendFrame(target, smokeEvent(11, "tool.started", { sessionId: "main", toolName: "shell", command: "npm run check" }));
        sendFrame(target, smokeEvent(12, "tool.completed", {
            sessionId: "main",
            toolName: "shell",
            status: "succeeded",
            output: Array.from({ length: 80 }, (_, index) => `verification line ${index + 1}: pass`).join("\n"),
        }));
        sendFrame(target, {
            version: 1,
            kind: "delta",
            streamId: "desktop-smoke",
            fromSeq: 13,
            seq: 15,
            sessionId: "main",
            text: "正在归并最终证据；这段文字来自连续 streaming delta。",
        });
    }
    await waitForRenderer(target, "Number(document.documentElement.dataset.renderSequence || '0') > 0", 5_000);
    if (fixture)
        await waitForRenderer(target, "Boolean(document.querySelector('.message.streaming'))", 5_000);
    await setRendererTheme(target, "dark");
    await settlePaint();
    const mainVisual = await target.webContents.executeJavaScript(`(() => {
    const transcript = document.querySelector('#transcript');
    const code = document.querySelector('.message.assistant pre');
    const composerRect = document.querySelector('.composer')?.getBoundingClientRect();
    return {
      transcriptScrollable: Boolean(transcript && transcript.scrollHeight > transcript.clientHeight),
      codeContained: Boolean(code && code.scrollWidth > code.clientWidth && getComputedStyle(code).overflowX !== 'visible'),
      composerVisible: Boolean(composerRect && composerRect.top >= 0 && composerRect.bottom <= innerHeight),
      streamingVisible: Boolean(document.querySelector('.message.streaming'))
    };
  })()`);
    const mainImage = await target.webContents.capturePage();
    await writeFile(join(outputDirectory, "desktop-main-dark-1920x1080.png"), mainImage.toPNG(), { mode: 0o600 });
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
      customBaseUrlEnabled: !document.querySelector('#settings-base-url')?.disabled && Boolean(document.querySelector('#settings-base-url')?.required),
      customApiEnabled: !document.querySelector('#settings-api')?.disabled && document.querySelector('#settings-api')?.value === 'openai-completions'
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
            cursors: { ...base.cursors, "desktop-smoke": 15 },
        });
        await waitForRenderer(target, "document.documentElement.dataset.approval === 'visible'", 5_000);
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
        images: {
            main: mainImage.getSize(),
            light: lightImage.getSize(),
            settings: settingsImage.getSize(),
            medium: mediumImage.getSize(),
            compact: compactImage.getSize(),
            ...(approvalSize ? { approval: approvalSize } : {}),
        },
        themes: { dark: darkTheme, light: lightTheme },
        typography,
        mainVisual,
        responsive: { medium: mediumLayout, compact: compactLayout, compactInspector: compactInspectorLayout },
        settings: settingsProbe,
        probe,
        ipcProbe,
    };
    await writeFile(join(outputDirectory, "desktop-security.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    assertSmokeReport(report, fixture);
}
function assertSmokeReport(report, fixture) {
    const failures = [];
    if (report.connection.phase !== "connected")
        failures.push("desktop did not connect to the real daemon");
    if (fixture && !report.reconnectVerified)
        failures.push("desktop reconnect path was not verified");
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
    if (report.probe.document.csp !== DESKTOP_CSP)
        failures.push("renderer CSP does not match the strict policy");
    for (const global of ["process", "require", "Buffer", "electron"]) {
        if (report.probe.globals[global] !== "undefined")
            failures.push(`renderer exposes ${global}`);
    }
    if (report.probe.apiKeys.join(",") !== "bootstrap,dispatch,getSettings,saveSettings,subscribe")
        failures.push("preload API surface changed");
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
    if (!report.settings.customBaseUrlEnabled || !report.settings.customApiEnabled)
        failures.push("custom OpenAI controls are not enabled correctly");
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
        if (report.images.approval?.width !== 1_920 || report.images.approval.height !== 1_080)
            failures.push("approval capture is not 1920x1080");
        if (!report.mainVisual.transcriptScrollable || !report.probe.document.transcriptScrollable)
            failures.push("transcript fixture did not exercise vertical scrolling");
        if (!report.mainVisual.codeContained || !report.probe.document.codeContained)
            failures.push("long code did not exercise contained horizontal scrolling");
        if (!report.mainVisual.composerVisible || !report.probe.document.composerVisible)
            failures.push("composer is not fully visible");
        if (!report.mainVisual.streamingVisible)
            failures.push("streaming delta is not visible in the main capture");
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
async function waitForRenderer(target, expression, timeoutMs) {
    await waitFor(async () => Boolean(await target.webContents.executeJavaScript(expression)), timeoutMs);
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