import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { DESKTOP_CSP, desktopWindowOptions, isTrustedRendererUrl } from "../../src/desktop/security.js";

test("Electron window security baseline is fail-closed", () => {
  const options = desktopWindowOptions("/trusted/preload.cjs");
  assert.equal(options.width, 1_920);
  assert.equal(options.height, 1_080);
  assert.equal(options.useContentSize, true);
  assert.equal(options.webPreferences?.preload, "/trusted/preload.cjs");
  assert.equal(options.webPreferences?.contextIsolation, true);
  assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(options.webPreferences?.nodeIntegration, false);
  assert.equal(options.webPreferences?.nodeIntegrationInWorker, false);
  assert.equal(options.webPreferences?.nodeIntegrationInSubFrames, false);
  assert.equal(options.webPreferences?.webSecurity, true);
  assert.equal(options.webPreferences?.allowRunningInsecureContent, false);
  assert.equal(options.webPreferences?.webviewTag, false);
});

test("renderer navigation is restricted to the exact local document", () => {
  const renderer = "file:///opt/pspore/renderer/index.html";
  assert.equal(isTrustedRendererUrl(renderer, renderer), true);
  assert.equal(isTrustedRendererUrl("file:///opt/pspore/renderer/other.html", renderer), false);
  assert.equal(isTrustedRendererUrl("https://example.com/", renderer), false);
  assert.equal(isTrustedRendererUrl("not a url", renderer), false);
});

test("preload and renderer assets contain fixed IPC and strict CSP only", async () => {
  const preload = await readFile(resolve("src/desktop/preload.cjs"), "utf8");
  const html = await readFile(resolve("src/desktop/renderer/index.html"), "utf8");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("pspore", api\)/);
  assert.match(preload, /pspore:desktop:bootstrap/);
  assert.match(preload, /pspore:desktop:dispatch/);
  assert.match(preload, /pspore:desktop:frame/);
  assert.doesNotMatch(preload, /ipcRenderer\.send\s*\(/);
  assert.doesNotMatch(preload, /shell\.|remote\.|webFrame/);
  assert.match(html, new RegExp(escapeRegExp(DESKTOP_CSP)));
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script(?![^>]*type="module"[^>]*src="\.\/renderer\.js")/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
