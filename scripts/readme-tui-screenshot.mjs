#!/usr/bin/env node
/**
 * Regenerates docs/images/tui.png: the real terminal client in a 160×45 xterm,
 * connected to an isolated daemon and the same scripted demonstration model
 * as the desktop pictures (readme-demo.mjs). Nothing is installed as a
 * service and no credentials or personal files are involved.
 *
 * Linux only. Needs a current build (`npm run build`) plus xvfb-run, xterm,
 * xdotool and ImageMagick's `import`.
 *
 *   node scripts/readme-tui-screenshot.mjs [output.png]   # default: docs/images/tui.png
 *
 * The script runs in three roles: this outer launcher starts a virtual display,
 * `--session` drives xterm inside it, and `--client` is what xterm runs.
 */
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const self = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const [role, argument] = process.argv.slice(2);

if (role === "--client") await client(argument);
else if (role === "--session") await session(argument);
else await launcher(resolve(role ?? join(root, "docs/images/tui.png")));

async function launcher(output) {
  await mkdir(dirname(output), { recursive: true });
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 2200x1300x24", process.execPath, self, "--session", output], {
    cwd: root, stdio: "inherit",
  });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
}

/** Inside the virtual display: one xterm, one typed request, one capture. */
async function session(output) {
  const { initializePsporeHome } = await import("../dist/storage/home.js");
  const { LlmSettingsService } = await import("../dist/settings/llm-settings-service.js");
  const { DEMOS, configureDemoHome, demoModel, sleep } = await import("./readme-demo.mjs");
  const demo = DEMOS.en;
  const home = await mkdtemp(join(tmpdir(), "pspore-readme-tui-"));
  const model = await demoModel(demo.turns);
  let terminal;
  try {
    const paths = await configureDemoHome(home, demo, model.port, { initializePsporeHome, LlmSettingsService });
    terminal = spawn("xterm", [
      "-u8", "-geometry", "160x45", "-fa", "DejaVu Sans Mono", "-fs", "12", "-T", "pspore-tui",
      "-bg", "#0f141c", "-fg", "#d8dee9", "-b", "14", "+sb", "-xrm", "XTerm*cursorBlink: false",
      "-e", process.execPath, self, "--client", home,
    ], { cwd: home, env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: "ignore" });
    const window = (await run("xdotool", ["search", "--sync", "--name", "^pspore-tui$"], { timeout: 20_000 })).stdout.trim().split("\n")[0];
    await waitFor(() => access(paths.socket).then(() => true, () => false), 30_000, "daemon socket");
    await sleep(3_000);
    // No window manager runs here, so input focus is set directly.
    await run("xdotool", ["windowfocus", "--sync", window]);
    await sleep(500);
    await run("xdotool", ["type", "--delay", "12", demo.prompt]);
    await run("xdotool", ["key", "Return"]);
    await Promise.race([model.finished, sleep(60_000).then(() => { throw new Error("The demo answer did not finish"); })]);
    await sleep(2_500);
    await run("import", ["-window", window, output]);
    if (model.errors.length) throw model.errors[0];
    process.stdout.write(`Screenshot written to ${output}\n`);
    await run("xdotool", ["type", "/quit"]);
    await run("xdotool", ["key", "Return"]);
    await Promise.race([once(terminal, "exit"), sleep(10_000)]);
  } finally {
    if (terminal && terminal.exitCode === null) terminal.kill("SIGTERM");
    await model.close();
    await rm(home, { recursive: true, force: true });
  }
}

/** What xterm runs: an isolated foreground daemon and the TUI connected to it. */
async function client(home) {
  const { initializePsporeHome } = await import("../dist/storage/home.js");
  const { LlmSettingsService } = await import("../dist/settings/llm-settings-service.js");
  const { PsporeDaemon } = await import("../dist/daemon/daemon.js");
  const { PsporeTuiApp } = await import("../dist/ui/tui/tui-app.js");
  const { paths } = await initializePsporeHome(home);
  const daemon = await PsporeDaemon.start({ home });
  try {
    await new PsporeTuiApp({ socketPath: paths.socket, settings: new LlmSettingsService(home, paths) }).run();
  } finally {
    await daemon.stop();
  }
  process.exit(0);
}

async function waitFor(check, timeout, label) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}
