#!/usr/bin/env node
/**
 * Regenerates the README screenshots in docs/images/ from the real desktop app.
 *
 * A scripted, local OpenAI-compatible "model" answers one demonstration request,
 * so the pictures show a genuine run — isolated daemon, real tools, real
 * renderer — with no credentials, no network and nobody's own files involved.
 *
 * Linux only. Needs a current build (`npm run build`), the Electron dev
 * dependency and `xvfb-run`. Set PSPORE_ELECTRON_NO_SANDBOX=1 where Chromium's
 * sandbox is unavailable (containers, root).
 *
 *   node scripts/readme-screenshots.mjs [--lang en|zh-CN] [output-directory]
 *
 * English (the default) writes desktop-*.png for README.md; zh-CN writes
 * desktop-*.zh-CN.png for README.zh-CN.md. Output defaults to docs/images.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const languageIndex = args.indexOf("--lang");
const language = languageIndex >= 0 ? args.splice(languageIndex, 2)[1] : "en";
if (language !== "en" && language !== "zh-CN") throw new Error("--lang must be en or zh-CN");
const output = resolve(args[0] ?? join(root, "docs/images"));
/** English pictures keep the plain names the default (English) README uses. */
const imageName = (name) => language === "en" ? `${name}.png` : `${name}.${language}.png`;
const viewport = { width: 1920, height: 1080 };
const debugPort = Number(process.env.PSPORE_SCREENSHOT_CDP_PORT ?? 9337);

const { initializePsporeHome } = await import("../dist/storage/home.js");
const { LlmSettingsService } = await import("../dist/settings/llm-settings-service.js");
const { DEMOS, configureDemoHome, deferred, demoModel, sleep } = await import("./readme-demo.mjs");

const { prompt: PROMPT, turns: TURNS, streamingText } = DEMOS[language];

const home = await mkdtemp(join(tmpdir(), "pspore-readme-"));
let app;
let model;
let devtools;
try {
  await mkdir(output, { recursive: true });
  const releaseAnswer = deferred();
  model = await demoModel(TURNS, releaseAnswer.promise);
  await configureDemoHome(home, DEMOS[language], model.port, { initializePsporeHome, LlmSettingsService });

  app = launchDesktop(home);
  devtools = await connectRenderer(debugPort, app);
  const page = devtools;
  // The isolated harness first runs its own window checks, resizing the window
  // as it goes; its report file marks the end of them.
  await waitForFile(join(home, "smoke", "desktop-security.json"), 180_000);
  await page.waitFor("document.documentElement.dataset.ready === 'true' && document.documentElement.dataset.connection === 'connected'", 30_000);
  await page.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`(() => {
    document.querySelector('#session-search-close')?.click();
    document.querySelector('#article-close')?.click();
    document.activeElement?.blur();
  })()`);

  // Dark: the run is still streaming, with the inspector's live activity open.
  await setInspector(page, true);
  await setTheme(page, "dark");
  await page.evaluate(`(() => {
    const input = document.querySelector('#composer-input');
    input.value = ${JSON.stringify(PROMPT)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer-form').requestSubmit();
  })()`);
  await page.waitFor(`document.querySelector('#transcript')?.textContent.includes(${JSON.stringify(streamingText)})`, 60_000);
  await page.waitFor("document.querySelectorAll('.process-body .tool-call').length === 2", 10_000);
  await settle(page);
  // Following the stream leaves the group's own heading half under the header.
  await page.evaluate("document.querySelector('.process-message').scrollIntoView({ block: 'start' })");
  await settle(page);
  await capture(page, imageName("desktop-dark"));

  // Light: the finished answer, with its steps folded into one line.
  releaseAnswer.resolve();
  await page.waitFor("document.querySelector('#session-status')?.textContent.trim() === 'IDLE' && document.querySelector('.process-details')?.open === false", 60_000);
  await setInspector(page, false);
  await setTheme(page, "light");
  await page.evaluate("document.querySelector('#transcript').scrollTop = 0");
  await settle(page);
  await capture(page, imageName("desktop-light"));

  // Process: the folded steps reopened, with the shell call's input and output.
  await page.evaluate("document.querySelector('.process-summary').click()");
  await page.waitFor("document.querySelectorAll('.process-body .tool-call').length === 2", 10_000);
  // The group can re-render just after opening; click until the card stays open.
  await page.waitFor(`(() => {
    const details = document.querySelectorAll('.process-body .tool-call details')[1];
    if (!details.open) details.querySelector('summary').click();
    return details.open && document.querySelectorAll('.tool-call details[open]').length === 1;
  })()`, 10_000);
  await page.evaluate("document.querySelector('#transcript').scrollTop = 0");
  await settle(page);
  await capture(page, imageName("desktop-process"));
  if (model.errors.length) throw model.errors[0];
  process.stdout.write(`Screenshots written to ${output}\n`);
} finally {
  // Closing the window shuts the app and its isolated daemon down cleanly.
  await devtools?.evaluate("window.close()").catch(() => undefined);
  devtools?.close();
  if (app && app.exitCode === null) {
    await Promise.race([once(app, "exit"), sleep(15_000)]);
    if (app.exitCode === null) app.kill("SIGTERM");
  }
  await model?.close();
  await rm(home, { recursive: true, force: true });
}

async function waitForFile(path, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    if (app.exitCode !== null) throw new Error(`Desktop exited early with code ${app.exitCode}`);
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${path}`);
      await sleep(250);
    }
  }
}

function launchDesktop(pspHome) {
  const electron = createRequire(import.meta.url)("electron");
  const flags = process.env.PSPORE_ELECTRON_NO_SANDBOX === "1" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];
  const child = spawn("xvfb-run", [
    "-a", "-s", "-screen 0 2048x1200x24", electron, ...flags, `--lang=${language === "en" ? "en-US" : "zh-CN"}`,
    `--remote-debugging-port=${debugPort}`,
    join(root, "dist/desktop/main.js"), "--home", pspHome, "--smoke-dir", join(pspHome, "smoke"),
  ], {
    cwd: root,
    env: { ...process.env, PSPORE_SMOKE_KEEP_OPEN: "1", LANG: language === "en" ? "en_US.UTF-8" : "zh_CN.UTF-8" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("error", (error) => process.stderr.write(`${error.message}\n`));
  return child;
}

/** Minimal Chrome DevTools Protocol client for the one renderer page. */
async function connectRenderer(port, child) {
  const deadline = Date.now() + 90_000;
  let target;
  while (!target) {
    if (child.exitCode !== null) throw new Error(`Desktop exited early with code ${child.exitCode}`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets.find((entry) => entry.type === "page" && entry.url.endsWith("/renderer/index.html"));
    } catch {
      // Not listening yet.
    }
    if (!target) {
      if (Date.now() > deadline) throw new Error("Desktop renderer did not appear");
      await sleep(250);
    }
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = message.id === undefined ? undefined : pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`Renderer error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  };
  const waitFor = async (expression, timeout = 10_000) => {
    const end = Date.now() + timeout;
    while (!(await evaluate(`Boolean(${expression})`))) {
      if (Date.now() > end) throw new Error(`Timed out waiting for: ${expression}`);
      await sleep(100);
    }
  };
  return { send, evaluate, waitFor, close: () => socket.close() };
}

async function setInspector(page, open) {
  if (await page.evaluate("document.querySelector('#inspector-toggle').getAttribute('aria-expanded') === 'true'") !== open) {
    await page.evaluate("document.querySelector('#inspector-toggle').click()");
  }
  await page.waitFor(`document.querySelector('#inspector-toggle').getAttribute('aria-expanded') === ${JSON.stringify(String(open))}`);
}

async function setTheme(page, theme) {
  if (await page.evaluate("document.documentElement.dataset.theme") !== theme) {
    await page.evaluate("document.querySelector('#theme-toggle').click()");
  }
  await page.waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`);
}

/** Lets entrance animations, fonts and the virtual list measurements finish. */
async function settle(page) {
  await page.evaluate("document.fonts.ready.then(() => true)");
  await sleep(1_200);
}

async function capture(page, name) {
  const overflow = await page.evaluate("document.documentElement.scrollWidth > innerWidth");
  if (overflow) throw new Error(`Horizontal overflow before ${name}`);
  if (language === "en") {
    // Every label, hidden dialogs included, must be English; only the switch
    // back to Chinese is written in Chinese on purpose.
    const leftover = await page.evaluate(`(() => {
      const han = /[\\u4e00-\\u9fff]/;
      const toggle = document.querySelector('#language-toggle');
      const found = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!toggle?.contains(node) && han.test(node.nodeValue)) found.add(node.nodeValue.trim());
      }
      for (const element of document.querySelectorAll('[title], [aria-label], [placeholder]')) {
        if (element === toggle) continue;
        for (const name of ['title', 'aria-label', 'placeholder']) {
          const value = element.getAttribute(name);
          if (value && han.test(value)) found.add(name + ': ' + value);
        }
      }
      return [...found];
    })()`);
    if (leftover.length) throw new Error(`Chinese left in the English interface before ${name}: ${leftover.join(" | ")}`);
  }
  const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(join(output, name), Buffer.from(data, "base64"));
  process.stdout.write(`captured ${name}\n`);
}
