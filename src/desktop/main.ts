import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent, type WebContents } from "electron";

import { resolvePsporeHome } from "../config/config.js";
import { initializePsporeHome } from "../storage/home.js";
import { PI_VERSION, PSPORE_VERSION } from "../version.js";
import { DaemonBridge } from "./daemon-bridge.js";
import { DesktopDaemonSupervisor, type DesktopDaemonOwnership } from "./daemon-supervisor.js";
import {
  DESKTOP_BOOTSTRAP_CHANNEL,
  DESKTOP_DISPATCH_CHANNEL,
  DESKTOP_FRAME_CHANNEL,
  type DesktopFrame,
} from "./ipc-contract.js";
import { DESKTOP_CSP, desktopWindowOptions, isTrustedRendererUrl } from "./security.js";
import { createDesktopSmokeState } from "./smoke-fixture.js";

interface DesktopArguments {
  home?: string;
  smokeDirectory?: string;
  smokeFixture: boolean;
}

interface SmokeReport {
  connection: { phase: string };
  daemonOwnership: DesktopDaemonOwnership;
  reconnectVerified: boolean;
  images: {
    main: { width: number; height: number };
    light: { width: number; height: number };
    approval?: { width: number; height: number };
  };
  themes: {
    dark: { colorScheme: string; backgroundColor: string; surfaceColor: string };
    light: { colorScheme: string; backgroundColor: string; surfaceColor: string };
  };
  typography: Record<string, number>;
  mainVisual: {
    transcriptScrollable: boolean;
    codeContained: boolean;
    composerVisible: boolean;
    streamingVisible: boolean;
  };
  probe: {
    viewport: { width: number; height: number; devicePixelRatio: number };
    globals: Record<string, string>;
    apiKeys: string[];
    document: {
      scrollWidth: number;
      scrollHeight: number;
      bodyOverflow: string;
      csp: string | null;
      approval: string | null;
      transcriptScrollable: boolean;
      codeContained: boolean;
      composerVisible: boolean;
      modalContained: boolean;
      backgroundInert: boolean;
      focusLabel: string | null;
    };
  };
  ipcProbe: { jobsArray: boolean; rejected: boolean; rejectionMessage: string };
}

const arguments_ = parseArguments(process.argv.slice(1));
if (arguments_.smokeDirectory) app.disableHardwareAcceleration();

let window: BrowserWindow | undefined;
let bridge: DaemonBridge | undefined;
let daemonSupervisor: DesktopDaemonSupervisor | undefined;
let unsubscribeBridge: (() => void) | undefined;
let rendererUrl = "";
let exitCode = 0;
let shuttingDown = false;

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

async function startDesktop(): Promise<void> {
  const home = resolvePsporeHome(arguments_.home);
  const { paths } = await initializePsporeHome(home);
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  const preloadPath = join(moduleDirectory, "preload.cjs");
  const rendererPath = join(moduleDirectory, "renderer", "index.html");
  rendererUrl = pathToFileURL(rendererPath).href;

  installSessionSecurity();
  daemonSupervisor = new DesktopDaemonSupervisor({ home });
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

  window = new BrowserWindow(desktopWindowOptions(preloadPath));
  hardenWindow(window, rendererUrl);
  installIpc(window, bridge);
  unsubscribeBridge = bridge.subscribe((frame) => sendFrame(window, frame));
  await window.loadFile(rendererPath);

  if (arguments_.smokeDirectory) {
    await runSmoke(window, bridge, arguments_.smokeDirectory, arguments_.smokeFixture);
    await bridge.stop();
    requestShutdown(exitCode);
    return;
  }
  window.once("ready-to-show", () => window?.show());
  if (!window.isVisible()) window.show();
}

function installSessionSecurity(): void {
  const desktopSession = session.defaultSession;
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  desktopSession.on("will-download", (event) => event.preventDefault());
  desktopSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (_details, callback) => callback({ cancel: true }),
  );
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

function hardenWindow(target: BrowserWindow, expectedUrl: string): void {
  const contents = target.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, expectedUrl)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isTrustedRendererUrl(url, expectedUrl)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

function installIpc(target: BrowserWindow, daemonBridge: DaemonBridge): void {
  ipcMain.removeHandler(DESKTOP_BOOTSTRAP_CHANNEL);
  ipcMain.removeHandler(DESKTOP_DISPATCH_CHANNEL);
  ipcMain.handle(DESKTOP_BOOTSTRAP_CHANNEL, (event) => {
    assertTrustedSender(event, target.webContents);
    return daemonBridge.bootstrap();
  });
  ipcMain.handle(DESKTOP_DISPATCH_CHANNEL, async (event, command: unknown) => {
    assertTrustedSender(event, target.webContents);
    return daemonBridge.dispatch(command);
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent, expected: WebContents): void {
  if (event.sender !== expected || !isTrustedRendererUrl(event.senderFrame?.url ?? "", rendererUrl)) {
    throw new Error("Rejected IPC from an untrusted renderer");
  }
}

function sendFrame(target: BrowserWindow | undefined, frame: DesktopFrame): void {
  if (!target || target.isDestroyed() || target.webContents.isDestroyed() || target.webContents.isLoadingMainFrame()) return;
  target.webContents.send(DESKTOP_FRAME_CHANNEL, frame);
}

async function runSmoke(
  target: BrowserWindow,
  daemonBridge: DaemonBridge,
  outputDirectory: string,
  fixture: boolean,
): Promise<void> {
  if (!isAbsolute(outputDirectory)) throw new Error("--smoke-dir must be an absolute path");
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
  if (fixture) await waitForRenderer(target, "Boolean(document.querySelector('.message.streaming'))", 5_000);
  await setRendererTheme(target, "dark");
  await settlePaint();
  const mainVisual: SmokeReport["mainVisual"] = await target.webContents.executeJavaScript(`(() => {
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
  const typography: Record<string, number> = await target.webContents.executeJavaScript(`(() => {
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

  let approvalSize: { width: number; height: number } | undefined;
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

  const probe: SmokeReport["probe"] = await target.webContents.executeJavaScript(`(() => {
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
  const ipcProbe: SmokeReport["ipcProbe"] = await target.webContents.executeJavaScript(`(async () => {
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
  const report: SmokeReport & { version: 1; capturedAt: string } = {
    version: 1,
    capturedAt: new Date().toISOString(),
    connection: daemonBridge.bootstrap().connection,
    daemonOwnership: daemonSupervisor?.ownership ?? "external",
    reconnectVerified,
    images: {
      main: mainImage.getSize(),
      light: lightImage.getSize(),
      ...(approvalSize ? { approval: approvalSize } : {}),
    },
    themes: { dark: darkTheme, light: lightTheme },
    typography,
    mainVisual,
    probe,
    ipcProbe,
  };
  await writeFile(join(outputDirectory, "desktop-security.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  assertSmokeReport(report, fixture);
}

function assertSmokeReport(report: SmokeReport, fixture: boolean): void {
  const failures: string[] = [];
  if (report.connection.phase !== "connected") failures.push("desktop did not connect to the real daemon");
  if (fixture && !report.reconnectVerified) failures.push("desktop reconnect path was not verified");
  if (report.images.main.width !== 1_920 || report.images.main.height !== 1_080) failures.push("main capture is not 1920x1080");
  if (report.images.light.width !== 1_920 || report.images.light.height !== 1_080) failures.push("light capture is not 1920x1080");
  if (report.themes.dark.colorScheme !== "dark" || report.themes.light.colorScheme !== "light") failures.push("theme color-scheme did not switch");
  if (report.themes.dark.backgroundColor === report.themes.light.backgroundColor) failures.push("theme canvas colors did not switch");
  if (report.themes.dark.surfaceColor === report.themes.light.surfaceColor) failures.push("theme surface colors did not switch");
  const minimumFontSizes: Record<string, number> = {
    body: 14,
    conversationTitle: 20,
    messageBody: 15,
    composerInput: 14,
    sectionHeading: 15,
    sessionPrimary: 13,
    sessionSecondary: 11.5,
    denseTitle: 12.5,
    auxiliary: 10.5,
  };
  for (const [name, minimum] of Object.entries(minimumFontSizes)) {
    const actual = report.typography[name];
    if (actual === undefined || !Number.isFinite(actual) || actual < minimum) failures.push(`${name} font size is below ${minimum}px`);
  }
  if (report.probe.viewport.width !== 1_920 || report.probe.viewport.height !== 1_080) failures.push("renderer viewport is not 1920x1080");
  if (report.probe.document.scrollWidth !== 1_920 || report.probe.document.scrollHeight !== 1_080) failures.push("document overflows the viewport");
  if (report.probe.document.bodyOverflow !== "hidden") failures.push("body overflow is not contained");
  if (report.probe.document.csp !== DESKTOP_CSP) failures.push("renderer CSP does not match the strict policy");
  for (const global of ["process", "require", "Buffer", "electron"]) {
    if (report.probe.globals[global] !== "undefined") failures.push(`renderer exposes ${global}`);
  }
  if (report.probe.apiKeys.join(",") !== "bootstrap,dispatch,subscribe") failures.push("preload API surface changed");
  if (!report.ipcProbe.jobsArray) failures.push("allowlisted IPC round trip failed");
  if (!report.ipcProbe.rejected || !report.ipcProbe.rejectionMessage.includes("not allowlisted")) failures.push("non-allowlisted IPC was not rejected");
  if (fixture) {
    if (report.images.approval?.width !== 1_920 || report.images.approval.height !== 1_080) failures.push("approval capture is not 1920x1080");
    if (!report.mainVisual.transcriptScrollable || !report.probe.document.transcriptScrollable) failures.push("transcript fixture did not exercise vertical scrolling");
    if (!report.mainVisual.codeContained || !report.probe.document.codeContained) failures.push("long code did not exercise contained horizontal scrolling");
    if (!report.mainVisual.composerVisible || !report.probe.document.composerVisible) failures.push("composer is not fully visible");
    if (!report.mainVisual.streamingVisible) failures.push("streaming delta is not visible in the main capture");
    if (!report.probe.document.modalContained) failures.push("approval modal escapes the viewport");
    if (!report.probe.document.backgroundInert) failures.push("approval modal did not make the background inert");
    if (report.probe.document.focusLabel !== "拒绝") failures.push("approval modal did not receive deterministic focus");
  }
  if (failures.length > 0) throw new Error(`Electron smoke validation failed: ${failures.join("; ")}`);
}

function smokeEvent(seq: number, type: string, payload: Record<string, unknown>): DesktopFrame {
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

async function waitForRenderer(target: BrowserWindow, expression: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => Boolean(await target.webContents.executeJavaScript(expression)), timeoutMs);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function settlePaint(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 320));
}

async function setRendererTheme(target: BrowserWindow, theme: "dark" | "light"): Promise<void> {
  await target.webContents.executeJavaScript(`(() => {
    if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) {
      document.querySelector('#theme-toggle')?.click();
    }
  })()`);
  await waitForRenderer(target, `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, 2_000);
}

async function readThemeSnapshot(
  target: BrowserWindow,
): Promise<{ colorScheme: string; backgroundColor: string; surfaceColor: string }> {
  return target.webContents.executeJavaScript(`(() => ({
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    surfaceColor: getComputedStyle(document.querySelector('.panel')).backgroundColor
  }))()`);
}

function parseArguments(argv: readonly string[]): DesktopArguments {
  let home: string | undefined;
  let smokeDirectory: string | undefined;
  let smokeFixture = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--home") {
      const value = argv[++index];
      if (!value) throw new Error("--home requires a path");
      home = value;
    } else if (argument?.startsWith("--home=")) {
      home = argument.slice("--home=".length);
    } else if (argument === "--smoke-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--smoke-dir requires a path");
      smokeDirectory = value;
    } else if (argument?.startsWith("--smoke-dir=")) {
      smokeDirectory = argument.slice("--smoke-dir=".length);
    } else if (argument === "--smoke-fixture") {
      smokeFixture = true;
    }
  }
  return {
    ...(home ? { home } : {}),
    ...(smokeDirectory ? { smokeDirectory } : {}),
    smokeFixture,
  };
}

function failStartup(error: unknown): void {
  exitCode = 1;
  process.stderr.write(`pSpore desktop: ${toError(error).message}\n`);
  requestShutdown(exitCode);
}

function requestShutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  unsubscribeBridge?.();
  unsubscribeBridge = undefined;
  void (async () => {
    await bridge?.stop();
    await daemonSupervisor?.stop();
  })()
    .catch((error: unknown) => {
      process.stderr.write(`pSpore desktop shutdown: ${toError(error).message}\n`);
      exitCode = 1;
    })
    .finally(() => app.exit(exitCode));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
