import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "dist", "cli", "main.js");
const desktop = join(root, "dist", "desktop", "main.js");
const require = createRequire(import.meta.url);
const electron = require("electron");
if (typeof electron !== "string") throw new Error("Could not resolve the local Electron executable");
const electronFlags = process.env["PSPORE_ELECTRON_NO_SANDBOX"] === "1"
  ? ["--no-sandbox", "--disable-dev-shm-usage"]
  : [];
const electronTimeoutMs = parseSmokeTimeout(process.env["PSPORE_ELECTRON_SMOKE_TIMEOUT_MS"]);

const temporaryHome = await mkdtemp(join(tmpdir(), "pspore-electron-smoke-"));
const outputDirectory = join(temporaryHome, "smoke");
const ownedHome = await mkdtemp(join(tmpdir(), "pspore-electron-owned-smoke-"));
const ownedOutputDirectory = join(ownedHome, "smoke");
let daemon;
let daemonExit;
let succeeded = false;

try {
  await seedWorkspaceSkills(temporaryHome);
  await seedWorkspaceSkills(ownedHome);
  await seedArticle(temporaryHome);
  await seedArticle(ownedHome);
  await run(process.execPath, [cli, "--home", temporaryHome, "init"]);
  daemon = spawn(process.execPath, [cli, "--home", temporaryHome, "daemon"], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemonExit = collectExit(daemon);
  await waitForDaemon(temporaryHome, daemonExit);
  await run(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 2048x1200x24",
      electron,
      ...electronFlags,
      desktop,
      "--home",
      temporaryHome,
      "--smoke-dir",
      outputDirectory,
      "--smoke-fixture",
    ],
    electronTimeoutMs,
  );
  const report = JSON.parse(await readFile(join(outputDirectory, "desktop-security.json"), "utf8"));
  if (report?.probe?.viewport?.width !== 1_920 || report?.probe?.viewport?.height !== 1_080) {
    throw new Error("Electron smoke report did not contain the 1920x1080 viewport");
  }
  if (report?.daemonOwnership !== "external") {
    throw new Error("Electron did not reuse the externally started daemon");
  }
  await run(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 2048x1200x24",
      electron,
      ...electronFlags,
      desktop,
      "--home",
      ownedHome,
      "--smoke-dir",
      ownedOutputDirectory,
      "--smoke-fixture",
    ],
    electronTimeoutMs,
  );
  const ownedReport = JSON.parse(await readFile(join(ownedOutputDirectory, "desktop-security.json"), "utf8"));
  if (ownedReport?.daemonOwnership !== "owned" || ownedReport?.connection?.phase !== "connected") {
    throw new Error("Electron did not initialize and own its desktop daemon");
  }
  if (await exists(join(ownedHome, "run", "daemon.sock")) || await exists(join(ownedHome, "run", "endpoint.json"))) {
    throw new Error("Electron-owned daemon did not clean up its runtime files on exit");
  }
  process.stdout.write(
    `Electron 43 smoke passed: 1920x1080, 1440x900 and 1180x720 desktop layouts, path-only file/directory drop references, dark/light themes, settings, typography, the document panel with its version diff and four exports, owned/external daemon, reconnect and IPC allowlist verified.\n`,
  );
  succeeded = true;
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGTERM");
    if (daemonExit) await Promise.race([daemonExit.promise, delay(5_000)]);
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
  }
  if (succeeded && process.env["PSPORE_KEEP_SMOKE"] !== "1") {
    await rm(temporaryHome, { recursive: true });
    await rm(ownedHome, { recursive: true });
  }
  else if (!succeeded || process.env["PSPORE_KEEP_SMOKE"] === "1") {
    const externalFiles = await listEntries(outputDirectory);
    const ownedFiles = await listEntries(ownedOutputDirectory);
    process.stderr.write(
      `Electron smoke artifacts retained at ${temporaryHome} and ${ownedHome}; external output: ${externalFiles}; owned output: ${ownedFiles}\n`,
    );
  }
}

/**
 * Skills a user would drop into the workspace by hand: one loadable (its
 * description is not valid YAML, as hand-written Chinese frontmatter often is)
 * and one with sub-documents but no SKILL.md, which must be explained.
 */
async function seedWorkspaceSkills(home) {
  const skills = join(home, "workspace", "skills");
  await mkdir(join(skills, "smoke-mail"), { recursive: true, mode: 0o700 });
  await writeFile(join(skills, "smoke-mail", "SKILL.md"), "---\nname: smoke-mail\ndescription: 邮件: 发送与读取\n---\n\n# smoke-mail\n");
  await mkdir(join(skills, "smoke-draft"), { recursive: true, mode: 0o700 });
  await writeFile(join(skills, "smoke-draft", "SKILL_DRAFT.md"), "# draft\n");
}

/**
 * A two-version article owned by the fixture session, so the document panel has
 * something real to render: the store is on disk and the panel reads it through
 * the daemon, which no synthetic renderer state can stand in for.
 */
async function seedArticle(home) {
  const id = "art_5c0de0000001";
  const directory = join(home, "workspace", "articles", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const first = [
    "# 季度复盘",
    "",
    "## 一、结论",
    "",
    "营收同比增长 **23.4%**。",
    "",
    "- 华东区拉动",
    "  - 新增两个服务点",
    "- SaaS 订阅续约",
    "",
    "这一段在下一版会被删掉。",
    "",
  ].join("\n");
  const second = [
    "# 季度复盘",
    "",
    "## 一、结论",
    "",
    "营收同比增长 **23.4%**。",
    "",
    "- 华东区拉动",
    "  - 新增两个服务点",
    "- SaaS 订阅续约",
    "",
    "## 二、下季度动作",
    "",
    "1. 控制获客成本",
    "2. 提升续费率",
    "",
  ].join("\n");
  const now = "2026-09-22T02:00:00.000Z";
  const version = (number, content) => ({
    version: number,
    createdAt: now,
    chars: content.length,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  });
  await writeFile(join(directory, "v0001.md"), first, { mode: 0o600 });
  await writeFile(join(directory, "v0002.md"), second, { mode: 0o600 });
  await writeFile(join(directory, "current.md"), second, { mode: 0o600 });
  await writeFile(
    join(directory, "meta.json"),
    JSON.stringify({
      id,
      title: "季度复盘",
      sessionId: "main",
      createdAt: now,
      updatedAt: now,
      versions: [version(1, first), version(2, second)],
    }),
    { mode: 0o600 },
  );
}

async function waitForDaemon(home, daemonExit) {
  const endpoint = join(home, "run", "endpoint.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await exists(endpoint)) {
      try {
        const value = JSON.parse(await readFile(endpoint, "utf8"));
        if (value?.version === 1 && (value?.state === "ready" || value?.state === "degraded")) return;
      } catch {
        // Atomic endpoint publication can be retried until the complete JSON is visible.
      }
    }
    if (daemonExit.settled) throw new Error(`Daemon exited before Electron smoke startup: ${daemonExit.output()}`);
    await delay(50);
  }
  throw new Error("Timed out waiting for the pSpore daemon");
}

function collectExit(child) {
  let stdout = "";
  let stderr = "";
  let settled = false;
  child.stdout?.on("data", (chunk) => {
    stdout = boundedAppend(stdout, chunk.toString());
  });
  child.stderr?.on("data", (chunk) => {
    stderr = boundedAppend(stderr, chunk.toString());
  });
  const promise = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      settled = true;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      settled = true;
      resolve({ code, signal, stdout, stderr });
    });
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    output: () => `${stdout}${stderr}`.trim(),
  };
}

async function run(command, args, timeoutMs = 15_000) {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const exit = collectExit(child);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      const output = exit.output();
      reject(new Error(`${command} timed out after ${timeoutMs}ms${output ? `: ${output}` : ""}`));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([exit.promise, timeout]);
    if (result.code !== 0) {
      throw new Error(`${command} exited ${result.code ?? result.signal}: ${(result.stderr || result.stdout).trim()}`);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listEntries(path) {
  try {
    const entries = (await readdir(path)).sort();
    return entries.length > 0 ? entries.join(", ") : "(empty)";
  } catch (error) {
    return `(unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }
}

function boundedAppend(previous, next) {
  const combined = previous + next;
  return combined.length > 32_000 ? combined.slice(-32_000) : combined;
}

function parseSmokeTimeout(value) {
  if (value === undefined) return 60_000;
  if (!/^\d+$/.test(value)) throw new Error("PSPORE_ELECTRON_SMOKE_TIMEOUT_MS must be an integer");
  const milliseconds = Number(value);
  if (milliseconds < 60_000 || milliseconds > 300_000) {
    throw new Error("PSPORE_ELECTRON_SMOKE_TIMEOUT_MS must be between 60000 and 300000");
  }
  return milliseconds;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
