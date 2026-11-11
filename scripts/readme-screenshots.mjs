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
 *   node scripts/readme-screenshots.mjs [output-directory]   # default: docs/images
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "docs/images"));
const viewport = { width: 1920, height: 1080 };
const debugPort = Number(process.env.PSPORE_SCREENSHOT_CDP_PORT ?? 9337);

const { initializePsporeHome } = await import("../dist/storage/home.js");
const { LlmSettingsService } = await import("../dist/settings/llm-settings-service.js");

const PROMPT = "请阅读 notes 里本周的工作记录，整理下周的重点任务和行动计划。";

const NOTES = {
  "本周工作记录.md": [
    "# 本周工作记录",
    "",
    "- [x] 完成新版方案初稿",
    "- [x] 召开两次需求评审会",
    "- [ ] 汇总用户反馈，完成方案评审",
    "- [ ] 整理会议纪要与项目资料",
    "- [ ] 编写周报并确认下周计划",
    "",
  ].join("\n"),
  "会议纪要-周二.md": "# 需求评审（周二）\n\n- 反馈集中在导入流程\n- 下周一前给出修改方案\n",
  "会议纪要-周四.md": "# 需求评审（周四）\n\n- 确认交付节奏\n- 资料统一归档到共享目录\n",
};

/** The demonstration model's three turns, chosen by how many assistant replies it has already given. */
const TURNS = [
  {
    reasoning: "先读本周的工作记录，弄清楚哪些事项还没有完成。",
    tool: { name: "read", arguments: { path: "notes/本周工作记录.md" } },
  },
  {
    reasoning: "记录里提到两次评审会，再确认会议纪要是否都已经整理出来。",
    tool: { name: "shell", arguments: { command: "wc -l notes/*.md" } },
  },
  {
    reasoning: "三项未完成的任务里，方案评审依赖反馈汇总，应该排在最前面。",
    text: [
      "## 下周行动计划\n\n",
      "本周记录里还有 **3 项**未完成事项。建议先完成方案评审，再推进资料归档。\n\n",
      "| 优先级 | 任务 | 时间安排 |\n| --- | --- | --- |\n",
      "| 高 | 汇总用户反馈并完成方案评审 | 周一至周二 |\n",
      "| 中 | 整理两次评审的会议纪要与项目资料 | 周三 |\n",
      "| 中 | 编写周报并确认下周计划 | 周五 |\n\n",
      "### 建议的下一步\n\n",
      "- [ ] 核对每项任务的负责人和交付时间\n",
      "- [ ] 把方案评审拆成可执行的步骤\n",
      "- [ ] 设置每周五自动汇总进度的定时任务\n\n",
      "需要的话，我可以继续帮你起草周报。",
    ],
    // The dark screenshot is taken while this answer is still streaming.
    pauseAfter: 5,
  },
];

const home = await mkdtemp(join(tmpdir(), "pspore-readme-"));
let app;
let model;
let devtools;
try {
  await mkdir(output, { recursive: true });
  const releaseAnswer = deferred();
  model = await demoModel(releaseAnswer.promise);
  const { paths } = await initializePsporeHome(home);
  await new LlmSettingsService(home, paths).save({
    provider: "custom-openai", model: "demo", customModel: true, api: "openai-completions",
    baseUrl: `http://127.0.0.1:${model.port}/v1`, thinking: "off", permissionMode: "ask_risky",
    apiKey: "local-demo-placeholder", clearApiKey: false, clearCookie: false,
  });
  await mkdir(join(paths.workspace, "notes"), { recursive: true });
  for (const [name, text] of Object.entries(NOTES)) await writeFile(join(paths.workspace, "notes", name), text);

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
  await page.waitFor("document.querySelector('#transcript')?.textContent.includes('整理两次评审')", 60_000);
  await page.waitFor("document.querySelectorAll('.process-body .tool-call').length === 2", 10_000);
  await settle(page);
  // Following the stream leaves the group's own heading half under the header.
  await page.evaluate("document.querySelector('.process-message').scrollIntoView({ block: 'start' })");
  await settle(page);
  await capture(page, "desktop-dark.png");

  // Light: the finished answer, with its steps folded into one line.
  releaseAnswer.resolve();
  await page.waitFor("document.querySelector('#session-status')?.textContent.trim() === 'IDLE' && document.querySelector('.process-details')?.open === false", 60_000);
  await setInspector(page, false);
  await setTheme(page, "light");
  await page.evaluate("document.querySelector('#transcript').scrollTop = 0");
  await settle(page);
  await capture(page, "desktop-light.png");

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
  await capture(page, "desktop-process.png");
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
    "-a", "-s", "-screen 0 2048x1200x24", electron, ...flags, `--remote-debugging-port=${debugPort}`,
    join(root, "dist/desktop/main.js"), "--home", pspHome, "--smoke-dir", join(pspHome, "smoke"),
  ], { cwd: root, env: { ...process.env, PSPORE_SMOKE_KEEP_OPEN: "1", LANG: "zh_CN.UTF-8" }, stdio: ["ignore", "inherit", "inherit"] });
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
  const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(join(output, name), Buffer.from(data, "base64"));
  process.stdout.write(`captured ${name}\n`);
}

/** OpenAI-compatible streaming endpoint that plays TURNS in order. */
async function demoModel(answerGate) {
  const errors = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const messages = JSON.parse(body).messages ?? [];
      const turn = TURNS[Math.min(messages.filter((message) => message.role === "assistant").length, TURNS.length - 1)];
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      for (const piece of chunked(turn.reasoning, 6)) {
        send(response, { reasoning_content: piece });
        await sleep(40);
      }
      if (turn.tool) {
        send(response, { tool_calls: [{ index: 0, id: `call-${turn.tool.name}`, type: "function",
          function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments) } }] });
        finish(response, "tool_calls");
        return;
      }
      for (const [index, piece] of turn.text.entries()) {
        if (index === turn.pauseAfter) await answerGate;
        send(response, { content: piece });
        await sleep(60);
      }
      finish(response, "stop");
    })().catch((error) => {
      errors.push(error);
      response.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    errors,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

function send(response, delta, finishReason = null) {
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-demo", object: "chat.completion.chunk", created: 0, model: "demo",
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function finish(response, reason) {
  send(response, {}, reason);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-demo", object: "chat.completion.chunk", created: 0, model: "demo",
    choices: [], usage: { prompt_tokens: 3_180, completion_tokens: 420, total_tokens: 3_600 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function chunked(text, size) {
  const characters = [...text];
  return Array.from({ length: Math.ceil(characters.length / size) }, (_, index) => characters.slice(index * size, (index + 1) * size).join(""));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
