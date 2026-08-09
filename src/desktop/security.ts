import type { BrowserWindowConstructorOptions } from "electron";

export const DESKTOP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

export function desktopWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1_920,
    height: 1_080,
    minWidth: 1_180,
    minHeight: 720,
    useContentSize: true,
    show: false,
    backgroundColor: "#0b0d0c",
    title: "pSpore",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  };
}

export function isTrustedRendererUrl(candidate: string, rendererUrl: string): boolean {
  try {
    const actual = new URL(candidate);
    const expected = new URL(rendererUrl);
    return actual.protocol === "file:" && actual.href === expected.href;
  } catch {
    return false;
  }
}
