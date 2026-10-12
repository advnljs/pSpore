// Keep this entry free of business/daemon imports: ESM evaluates every static
// dependency before running even the first line that can create the splash.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, dialog } from "electron";

import { captureRendererDiagnostics, waitFor, waitForRenderer } from "./renderer-diagnostics.js";
import { DESKTOP_ICON } from "./security.js";
import { hardenWindow, installSessionSecurity } from "./window-security.js";

export interface DesktopArguments {
  home?: string;
  smokeDirectory?: string;
  smokeFixture: boolean;
}

/** The loaded application takes over teardown while the entry owns the splash. */
export interface DesktopStartup {
  setMessage(message: string): Promise<void>;
  close(): void;
}

const arguments_ = parseArguments(process.argv.slice(1));
if (arguments_.smokeDirectory) app.disableHardwareAcceleration();
app.setName("pSpore");
if (process.platform === "linux") {
  // Keep the existing identity: pinned launchers survive overlay upgrades.
  app.setDesktopName("pSpore.desktop");
  app.commandLine.appendSwitch("class", "pSpore");
}

let splash: BrowserWindow | undefined;
let shuttingDown = false;
let stopApplication: ((code: number) => void) | undefined;

app.on("window-all-closed", () => shutdown(0));
app.on("before-quit", (event) => {
  event.preventDefault();
  shutdown(0);
});
process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

if (arguments_.smokeDirectory || app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    // PDF export also creates a hidden BrowserWindow; only restore the workspace.
    const target = splash ?? BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL() === new URL("./renderer/index.html", import.meta.url).href);
    if (!target || target.isDestroyed()) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  });
  app.whenReady().then(async () => {
    installSessionSecurity();
    await showStartupWindow();
    if (shuttingDown) return;
    // No workspace IO, settings, service management or model SDK may run until
    // the startup card has painted and its native window is actually visible.
    const application = await import("./application.js");
    if (shuttingDown) return;
    stopApplication = application.requestShutdown;
    await application.startDesktop(arguments_, {
      setMessage: setStartupMessage,
      close: closeStartupWindow,
    });
  }).catch(failStartup);
} else {
  app.exit(0);
}

async function showStartupWindow(): Promise<void> {
  const startupPath = fileURLToPath(new URL("./splash/index.html", import.meta.url));
  const target = new BrowserWindow({
    width: 512, height: 332, useContentSize: true, center: true,
    show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, maximizable: false, minimizable: false,
    // Electron 43's skipTaskbar is only implemented on macOS/Windows. Linux
    // window managers use the native splash type to omit this transient window.
    ...(process.platform === "linux" ? { type: "splash" } : {}),
    skipTaskbar: true, autoHideMenuBar: true, title: "pSpore · 正在启动", icon: DESKTOP_ICON,
    webPreferences: {
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false, spellcheck: false,
    },
  });
  splash = target;
  captureRendererDiagnostics(target);
  hardenWindow(target, pathToFileURL(startupPath).href);
  target.on("closed", () => {
    if (splash !== target) return;
    splash = undefined;
    shutdown(0);
  });
  target.once("ready-to-show", () => {
    if (!shuttingDown && !target.isDestroyed()) target.show();
  });
  await target.loadFile(startupPath);
  await waitFor(() => shuttingDown || target.isVisible(), 10_000);
  if (shuttingDown) return;
  await waitForRenderer(target, "document.documentElement.dataset.ready === 'true'", 10_000);
  if (shuttingDown) return;
  if (arguments_.smokeDirectory) {
    await mkdir(arguments_.smokeDirectory, { recursive: true, mode: 0o700 });
    const probe: unknown = await target.webContents.executeJavaScript(`({
      width: innerWidth, height: innerHeight,
      node: typeof process, preload: typeof window.pspore,
      iconLoaded: document.querySelector('img').complete && document.querySelector('img').naturalWidth > 0,
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      status: document.getElementById('status').textContent
    })`);
    await writeFile(join(arguments_.smokeDirectory, "desktop-startup.json"), JSON.stringify({
      visible: target.isVisible(), mainCreated: BrowserWindow.getAllWindows().some((candidate) => candidate !== target),
      probe,
    }, null, 2));
    await writeFile(join(arguments_.smokeDirectory, "desktop-startup.png"), (await target.webContents.capturePage()).toPNG());
  }
}

async function setStartupMessage(message: string): Promise<void> {
  if (!splash || splash.isDestroyed() || shuttingDown) return;
  await splash.webContents.executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(message)}`);
}

function closeStartupWindow(): void {
  const target = splash;
  splash = undefined;
  if (target && !target.isDestroyed()) target.destroy();
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
  if (shuttingDown) return;
  process.stderr.write(`pSpore desktop: ${toError(error).message}\n`);
  if (!arguments_.smokeDirectory && app.isReady()) {
    // A service/configuration failure must not leave an endless loading card.
    dialog.showErrorBox("pSpore 启动失败", `无法打开工作空间。\n\n${toError(error).message}\n\n可从应用快捷方式菜单打开启动日志。`);
  }
  shutdown(1);
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (stopApplication) stopApplication(code);
  else {
    closeStartupWindow();
    app.exit(code);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
