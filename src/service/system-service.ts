import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, unlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";

import { atomicWriteFile } from "../storage/atomic.js";

const execFileAsync = promisify(execFile);

export interface SystemServiceLaunchSpec {
  executable: string;
  args: readonly string[];
  workingDirectory: string;
  environment?: Readonly<Record<string, string>>;
}

export interface SystemServiceCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SystemServiceCommandRunner = (
  executable: string,
  args: readonly string[],
) => Promise<SystemServiceCommandResult>;

export interface SystemServiceStatus {
  unitName: string;
  unitPath: string;
  installed: boolean;
  enabled: boolean;
  active: boolean;
  linger: boolean | undefined;
  detail?: string;
}

export interface SystemServiceEnsureResult extends SystemServiceStatus {
  unitChanged: boolean;
  lingerWarning?: string;
}

export interface SystemServiceManagerOptions {
  home: string;
  userConfigDirectory?: string;
  username?: string;
  runner?: SystemServiceCommandRunner;
  beforeStart?: () => Promise<void>;
}

/**
 * Installs and controls the per-user systemd service used by production clients.
 * GUI/TUI callers never own the daemon process; their only lifecycle action is
 * asking systemd to keep the authoritative service enabled and running.
 */
export class SystemServiceManager {
  readonly #home: string;
  readonly #runner: SystemServiceCommandRunner;
  readonly #username: string;
  readonly #beforeStart: (() => Promise<void>) | undefined;
  readonly unitName: string;
  readonly unitPath: string;

  constructor(options: SystemServiceManagerOptions) {
    this.#home = resolve(options.home);
    this.#runner = options.runner ?? runSystemCommand;
    this.#username = options.username ?? userInfo().username;
    this.#beforeStart = options.beforeStart;
    this.unitName = serviceUnitName(this.#home);
    const configDirectory = options.userConfigDirectory
      ?? resolve(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"));
    this.unitPath = join(configDirectory, "systemd", "user", this.unitName);
  }

  async ensureRunning(spec: SystemServiceLaunchSpec): Promise<SystemServiceEnsureResult> {
    const unitChanged = await this.install(spec);
    if (unitChanged) await this.#systemctl("daemon-reload");

    const wasActive = await this.#isSystemctlState("is-active");
    if (!wasActive) await this.#beforeStart?.();
    if (unitChanged && wasActive) {
      await this.#systemctl("restart", this.unitName);
    } else {
      await this.#systemctl("enable", "--now", this.unitName);
    }

    let lingerWarning: string | undefined;
    let linger = await this.#lingerEnabled();
    if (linger === false) {
      const result = await this.#runner("loginctl", ["--no-ask-password", "enable-linger", this.#username]);
      if (result.code === 0) linger = await this.#lingerEnabled();
      else lingerWarning = commandFailure("Could not enable boot-time user lingering", result);
    }

    const status = await this.status();
    if (!status.active) {
      throw new Error(status.detail ?? `System service ${this.unitName} did not become active`);
    }
    return {
      ...status,
      unitChanged,
      ...(lingerWarning === undefined ? {} : { lingerWarning }),
    };
  }

  async install(spec: SystemServiceLaunchSpec): Promise<boolean> {
    const content = renderSystemdUserUnit(this.#home, spec);
    let current: string | undefined;
    try {
      current = await readFile(this.unitPath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    if (current === content) return false;
    await mkdir(dirname(this.unitPath), { recursive: true, mode: 0o700 });
    await atomicWriteFile(this.unitPath, content, 0o644);
    return true;
  }

  async restart(): Promise<void> {
    await this.#systemctl("restart", this.unitName);
  }

  async start(): Promise<void> {
    await this.#systemctl("enable", "--now", this.unitName);
  }

  async stop(): Promise<void> {
    await this.#systemctl("stop", this.unitName);
  }

  async uninstall(): Promise<void> {
    await this.#runner("systemctl", ["--user", "disable", "--now", this.unitName]);
    await unlink(this.unitPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
    await this.#systemctl("daemon-reload");
  }

  async status(): Promise<SystemServiceStatus> {
    const installed = await access(this.unitPath).then(() => true, () => false);
    const enabledResult = await this.#runner("systemctl", ["--user", "is-enabled", this.unitName]);
    const activeResult = await this.#runner("systemctl", ["--user", "is-active", this.unitName]);
    const enabled = enabledResult.code === 0 && enabledResult.stdout.trim() === "enabled";
    const active = activeResult.code === 0 && activeResult.stdout.trim() === "active";
    const detail = active
      ? undefined
      : [activeResult.stderr.trim(), activeResult.stdout.trim()].filter(Boolean).join(": ") || undefined;
    return {
      unitName: this.unitName,
      unitPath: this.unitPath,
      installed,
      enabled,
      active,
      linger: await this.#lingerEnabled(),
      ...(detail === undefined ? {} : { detail }),
    };
  }

  async logs(lines = 100): Promise<string> {
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 2_000) {
      throw new Error("Service log line count must be between 1 and 2000");
    }
    const result = await this.#runner("journalctl", [
      "--user-unit",
      this.unitName,
      "--lines",
      String(lines),
      "--no-pager",
      "--output",
      "short-iso",
    ]);
    if (result.code !== 0) throw new Error(commandFailure("Could not read service logs", result));
    return result.stdout;
  }

  async #systemctl(...args: string[]): Promise<void> {
    const result = await this.#runner("systemctl", ["--user", ...args]);
    if (result.code !== 0) throw new Error(commandFailure(`systemctl --user ${args.join(" ")} failed`, result));
  }

  async #isSystemctlState(command: "is-active" | "is-enabled"): Promise<boolean> {
    const result = await this.#runner("systemctl", ["--user", command, this.unitName]);
    return result.code === 0 && result.stdout.trim() === (command === "is-active" ? "active" : "enabled");
  }

  async #lingerEnabled(): Promise<boolean | undefined> {
    const result = await this.#runner("loginctl", ["show-user", this.#username, "--property", "Linger", "--value"]);
    if (result.code !== 0) return undefined;
    const value = result.stdout.trim().toLowerCase();
    return value === "yes" ? true : value === "no" ? false : undefined;
  }
}

export function renderSystemdUserUnit(home: string, spec: SystemServiceLaunchSpec): string {
  const executable = resolveExecutable(spec.executable);
  const workingDirectory = resolve(spec.workingDirectory);
  const command = [executable, ...spec.args].map(systemdQuote).join(" ");
  const environment = Object.entries(spec.environment ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid service environment name: ${key}`);
      return `Environment=${systemdQuote(`${key}=${value}`)}`;
    });
  return [
    "[Unit]",
    "Description=pSpore local agent service",
    "Documentation=https://github.com/advnljs/pSpore",
    "StartLimitIntervalSec=30",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${command}`,
    `WorkingDirectory=${systemdPath(workingDirectory)}`,
    `Environment=${systemdQuote(`PSPORE_HOME=${resolve(home)}`)}`,
    ...environment,
    "UMask=0077",
    "Restart=always",
    "RestartSec=2",
    "TimeoutStopSec=20",
    "KillMode=mixed",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function serviceUnitName(home: string, defaultHome = join(homedir(), ".pspore")): string {
  const normalizedHome = normalize(resolve(home));
  if (normalizedHome === normalize(resolve(defaultHome))) return "pspore.service";
  const suffix = createHash("sha256").update(normalizedHome).digest("hex").slice(0, 12);
  return `pspore-${suffix}.service`;
}

export function systemdQuote(value: string): string {
  if (/[\r\n\u0000]/u.test(value)) throw new Error("System service arguments cannot contain newlines or NUL");
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error("System service arguments cannot contain control characters");
  }
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Path-valued directives do not use ExecStart's command-line quoting rules.
 * In particular, systemd 245 treats surrounding quotes as literal path bytes,
 * so an otherwise absolute WorkingDirectory becomes invalid. Spaces are valid
 * unquoted in this directive; percent signs still need escaping as specifiers.
 */
function systemdPath(value: string): string {
  if (/\s$/u.test(value)) throw new Error("System service paths cannot end with whitespace");
  if (/[\r\n\u0000]/u.test(value)) throw new Error("System service paths cannot contain newlines or NUL");
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error("System service paths cannot contain control characters");
  }
  return value.replaceAll("%", "%%");
}

async function runSystemCommand(executable: string, args: readonly string[]): Promise<SystemServiceCommandResult> {
  try {
    const result = await execFileAsync(executable, [...args], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 1_048_576,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
    return {
      code: typeof candidate.code === "number" ? candidate.code : 1,
      stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
      stderr: typeof candidate.stderr === "string" ? candidate.stderr : candidate.message,
    };
  }
}

function resolveExecutable(value: string): string {
  if (!value.trim()) throw new Error("System service executable is required");
  return value.includes("/") ? resolve(value) : value;
}

function commandFailure(prefix: string, result: SystemServiceCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
  return `${prefix}: ${detail}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
