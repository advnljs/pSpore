import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  DESKTOP_CSP,
  DESKTOP_MINIMUM_SIZE,
  desktopInitialSize,
  desktopWindowOptions,
  isTrustedRendererUrl,
} from "../../src/desktop/security.js";

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
  assert.equal(options.webPreferences?.navigateOnDragDrop, false);
});

test("the initial window never asks for more content space than the desktop offers", () => {
  assert.deepEqual(desktopInitialSize(), { width: 1_920, height: 1_080 });
  assert.deepEqual(desktopInitialSize({ width: 2_560, height: 1_440 }), { width: 1_920, height: 1_080 });
  // A 1080p desktop with a panel: asking for 1080 content pushed the window off screen.
  assert.deepEqual(desktopInitialSize({ width: 1_920, height: 1_053 }), { width: 1_920, height: 1_053 });
  assert.deepEqual(desktopInitialSize({ width: 1_366, height: 740 }), { width: 1_366, height: 740 });
  assert.deepEqual(desktopInitialSize({ width: 900, height: 600 }), { ...DESKTOP_MINIMUM_SIZE });
  assert.deepEqual(desktopInitialSize({ width: 0, height: 0 }), { width: 1_920, height: 1_080 });
  const options = desktopWindowOptions("/trusted/preload.cjs", { width: 1_600, height: 900 });
  assert.equal(options.width, 1_600);
  assert.equal(options.height, 900);
  assert.equal(options.minWidth, DESKTOP_MINIMUM_SIZE.width);
  assert.equal(options.minHeight, DESKTOP_MINIMUM_SIZE.height);
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
  assert.match(preload, /pspore:desktop:settings:get/);
  assert.match(preload, /pspore:desktop:settings:save/);
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.doesNotMatch(preload, /ipcRenderer\.send\s*\(/);
  assert.doesNotMatch(preload, /shell\.|remote\.|webFrame/);
  assert.match(html, new RegExp(escapeRegExp(DESKTOP_CSP)));
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /id="composer-mode"|>Steer<|>Follow-up</);
  assert.match(html, /id="new-session-button"/);
  assert.match(html, /id="message-queue"/);
  assert.match(html, /id="composer-drop-overlay"/);
  assert.match(html, /id="composer-references"/);
  assert.match(html, /仅记录文件或目录路径，不读取、不上传内容/);
  assert.match(html, /继续排队/);
  assert.match(html, /id="settings-auto-compaction"/);
  assert.match(html, /id="settings-compaction-trigger"/);
  assert.match(html, /id="settings-compaction-reserve"/);
  assert.match(html, /id="settings-compaction-keep-recent"/);
  // Only the exact local module entry plus the vendored GSAP build may load;
  // anything else (inline or another src) stays forbidden.
  assert.doesNotMatch(html, /<script(?![^>]*src="\.\/(vendor\/gsap\.min\.js|renderer\.js)")/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
