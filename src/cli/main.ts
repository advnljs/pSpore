#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { PsporeDaemon } from "../daemon/daemon.js";
import type { AgentSnapshot } from "../domain/runtime.js";
import type { KernelState } from "../kernel/state.js";
import { ProtocolClient } from "../protocol/client.js";
import { resolvePsporeHome } from "../config/config.js";
import { ShellService } from "../shell/shell-service.js";
import { initializePsporeHome, loadConfig, psporePaths } from "../storage/home.js";
import { PsporeTuiApp } from "../ui/tui/tui-app.js";
import { PI_VERSION, PSPORE_VERSION } from "../version.js";

const execFileAsync = promisify(execFile);

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseGlobalOptions(argv);
  const home = resolvePsporeHome(parsed.home);
  const command = parsed.args[0] ?? "help";
  const args = parsed.args.slice(1);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(helpText());
      return 0;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`pSpore ${PSPORE_VERSION} (Pi ${PI_VERSION}, Node ${process.versions.node})\n`);
      return 0;
    case "init": {
      requireNoArgs(args, "init");
      const result = await initializePsporeHome(home);
      process.stdout.write(
        result.created.length > 0
          ? `Initialized pSpore home at ${home}\nCreated ${result.created.length} files.\n`
          : `pSpore home is already initialized at ${home}; no files overwritten.\n`,
      );
      return 0;
    }
    case "daemon":
      requireNoArgs(args, "daemon");
      return runDaemon(home);
    case "status":
      requireNoArgs(args, "status");
      return printStatus(home);
    case "doctor":
      requireNoArgs(args, "doctor");
      return doctor(home);
    case "tui":
      requireNoArgs(args, "tui");
      return runTui(home);
    case "jobs":
      requireNoArgs(args, "jobs");
      return printProtocolList(home, "jobs.list");
    case "runs":
      requireNoArgs(args, "runs");
      return printProtocolList(home, "runs.list");
    case "notifications":
      requireNoArgs(args, "notifications");
      return printProtocolList(home, "notifications.list");
    case "schedule":
      if (args.length !== 2 || args[0] !== "put") throw new CliError("schedule usage: schedule put JOB.json");
      return putJobFile(home, args[1] as string);
    case "run":
      if (args.length !== 1) throw new CliError("run requires exactly one job ID");
      return runJob(home, args[0] as string);
    case "cancel":
      if (args.length !== 1) throw new CliError("cancel requires exactly one run ID");
      return cancelRun(home, args[0] as string);
    case "prompt":
      if (args.length === 0 || !args.join(" ").trim()) throw new CliError("prompt requires text");
      return runPrompt(home, args.join(" "));
    default:
      throw new CliError(`Unknown command: ${command}\n\n${helpText()}`);
  }
}

async function runDaemon(home: string): Promise<number> {
  const daemon = await PsporeDaemon.start({ home });
  process.stdout.write(`pSpore daemon ready (PID ${process.pid})\nSocket: ${daemon.paths.socket}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void daemon.stop().catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await daemon.whenStopped();
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function printStatus(home: string): Promise<number> {
  const client = await connectFromEndpoint(home, "status");
  try {
    const status = await client.command<KernelState>("status.get", {});
    const sessionCount = Object.keys(status.sessions).length;
    const active = Object.values(status.sessions).filter((session) => session.status === "running").length;
    process.stdout.write(
      [
        `Daemon: ${status.daemon.phase}`,
        `Instance: ${status.daemon.instanceId ?? "unknown"}`,
        `Revision: ${status.revision}`,
        `Sessions: ${sessionCount} (${active} running)`,
        `Pending approvals: ${Object.keys(status.approvals).length}`,
        `Runs: ${Object.keys(status.runs).length} (${Object.values(status.runs).filter((run) => run.status === "running").length} running)`,
      ].join("\n") + "\n",
    );
    return 0;
  } finally {
    await client.close();
  }
}

async function doctor(home: string): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "Node", ok: nodeMajor === 24, detail: process.versions.node });
  try {
    const config = await loadConfig(home);
    checks.push({ name: "Config", ok: true, detail: `${home}/config.json` });
    checks.push({
      name: "Model",
      ok: config.model !== null,
      detail: config.model ? `${config.model.provider}/${config.model.model}` : "not configured",
    });
    const shell = new ShellService({
      artifactRoot: psporePaths(home, config.runtime.workspace).artifacts,
      ...(config.shell.executable === undefined ? {} : { configuredShell: config.shell.executable }),
    });
    const resolved = await shell.initialize();
    checks.push({ name: "Shell", ok: true, detail: `${resolved.path} (${resolved.source})` });
  } catch (error) {
    checks.push({ name: "Config", ok: false, detail: toError(error).message });
  }
  try {
    const result = await execFileAsync("rg", ["--version"], { encoding: "utf8" });
    checks.push({ name: "ripgrep", ok: true, detail: result.stdout.split("\n")[0] ?? "available" });
  } catch (error) {
    checks.push({ name: "ripgrep", ok: false, detail: toError(error).message });
  }
  try {
    const endpoint = await endpointFor(home);
    const client = new ProtocolClient({ socketPath: endpoint.socket, clientId: "doctor" });
    await client.connect();
    await client.close();
    checks.push({ name: "Daemon", ok: true, detail: `${endpoint.state} at ${endpoint.socket}` });
  } catch (error) {
    checks.push({ name: "Daemon", ok: false, detail: toError(error).message });
  }
  for (const check of checks) process.stdout.write(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  return checks.every((check) => check.ok || check.name === "Model" || check.name === "Daemon") ? 0 : 1;
}

async function runTui(home: string): Promise<number> {
  const paths = psporePaths(home);
  const endpoint = await endpointFor(home).catch(() => ({ socket: paths.socket, state: "unknown" }));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("tui requires an interactive TTY; use `pspore status` for a non-interactive check");
  }
  await new PsporeTuiApp({ socketPath: endpoint.socket }).run();
  return 0;
}

async function runPrompt(home: string, text: string): Promise<number> {
  const client = await connectFromEndpoint(home, "prompt");
  let resolveSettled!: () => void;
  let printedDelta = false;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const unsubscribe = client.subscribe((event) => {
    if (event.type === "message.delta" && typeof (event.payload as Record<string, unknown>)["delta"] === "string") {
      printedDelta = true;
      process.stdout.write((event.payload as Record<string, unknown>)["delta"] as string);
    }
    if (event.type === "run.settled") resolveSettled();
  });
  const abort = () => void client.command("session.abort", { reason: "CLI interrupted" }, { sessionId: "main" }).catch(() => undefined);
  process.once("SIGINT", abort);
  try {
    await client.command("session.prompt", { text, mode: "prompt" }, { sessionId: "main" });
    await settled;
    const snapshot = await client.command<AgentSnapshot | null>("session.snapshot", {}, { sessionId: "main" });
    if (!snapshot) throw new CliError("Session disappeared before completion");
    const finalText = snapshot.messages.at(-1)?.text;
    if (printedDelta) process.stdout.write("\n");
    else process.stdout.write(`${finalText ?? ""}\n`);
    return 0;
  } finally {
    process.off("SIGINT", abort);
    unsubscribe();
    await client.close();
  }
}

async function printProtocolList(
  home: string,
  command: "jobs.list" | "runs.list" | "notifications.list",
): Promise<number> {
  const client = await connectFromEndpoint(home, command.split(".")[0] ?? "list");
  try {
    const values = await client.command<unknown[]>(command, {});
    process.stdout.write(`${JSON.stringify(values, null, 2)}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

async function runJob(home: string, jobId: string): Promise<number> {
  const client = await connectFromEndpoint(home, "run");
  try {
    const run = await client.command<{ id: string; status: string; reason?: string; error?: string }>("job.run", { jobId });
    process.stdout.write(`${run.id} ${run.status}${run.reason ? `: ${run.reason}` : run.error ? `: ${run.error}` : ""}\n`);
    return run.status === "succeeded" ? 0 : 1;
  } finally {
    await client.close();
  }
}

async function putJobFile(home: string, path: string): Promise<number> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CliError(`Cannot read job JSON ${path}: ${toError(error).message}`);
  }
  if (!isRecord(value) || typeof value["id"] !== "string" || !value["id"].trim()) {
    throw new CliError("Job JSON must contain a non-empty id");
  }
  const client = await connectFromEndpoint(home, "schedule");
  try {
    const jobs = await client.command<Array<{ id: string; sourceSha256?: string }>>("jobs.list", {});
    const current = jobs.find((job) => job.id === value["id"]);
    const updated = await client.command<{ id: string; sourceSha256?: string }>("job.put", {
      job: value,
      expectedSha256: current?.sourceSha256 ?? null,
    });
    process.stdout.write(`${updated.id} ${current ? "updated" : "created"} ${updated.sourceSha256 ?? ""}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

async function cancelRun(home: string, runId: string): Promise<number> {
  const client = await connectFromEndpoint(home, "cancel");
  try {
    const run = await client.command<{ id: string; status: string }>("run.cancel", { runId });
    process.stdout.write(`${run.id} ${run.status}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

async function connectFromEndpoint(home: string, purpose: string): Promise<ProtocolClient> {
  const endpoint = await endpointFor(home);
  const client = new ProtocolClient({ socketPath: endpoint.socket, clientId: `${purpose}-${process.pid}` });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new CliError(`Cannot connect to pSpore daemon at ${endpoint.socket}: ${toError(error).message}`);
  }
}

async function endpointFor(home: string): Promise<{ socket: string; state: string }> {
  const path = psporePaths(home).endpoint;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CliError(`No daemon endpoint at ${path}; start it with \`pspore daemon\``);
  }
  if (!isRecord(value) || value["version"] !== 1 || typeof value["socket"] !== "string" || typeof value["state"] !== "string") {
    throw new CliError(`Invalid daemon endpoint file: ${path}`);
  }
  return { socket: value["socket"], state: value["state"] };
}

function parseGlobalOptions(argv: readonly string[]): { home?: string; args: string[] } {
  const args: string[] = [];
  let home: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--home") {
      const value = argv[++index];
      if (!value) throw new CliError("--home requires a path");
      home = value;
    } else if (argument?.startsWith("--home=")) {
      home = argument.slice("--home=".length);
      if (!home) throw new CliError("--home requires a path");
    } else if (argument !== undefined) {
      args.push(argument);
    }
  }
  return { ...(home === undefined ? {} : { home }), args };
}

function requireNoArgs(args: readonly string[], command: string): void {
  if (args.length > 0) throw new CliError(`${command} does not accept positional arguments`);
}

function helpText(): string {
  return `pSpore ${PSPORE_VERSION} — Linux local agent core\n\nUsage: pspore [--home PATH] <command>\n\nCommands:\n  init             Initialize private config/workspace/state directories\n  daemon           Run the foreground daemon\n  tui              Open the reconnecting terminal client\n  prompt TEXT      Send one prompt and wait for completion\n  jobs             List loaded cron jobs\n  runs             List durable automation runs\n  notifications    List durable local notifications\n  schedule put FILE\n                   Atomically create/update a cron job from JSON\n  run JOB_ID       Trigger one job now and wait for completion\n  cancel RUN_ID    Cancel a queued or active run\n  status           Show daemon and session status\n  doctor           Check Node, config, model, shell, ripgrep, and daemon\n  version          Print pinned runtime versions\n  help             Show this help\n`;
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`pSpore: ${toError(error).message}\n`);
      process.exitCode = 1;
    },
  );
}
