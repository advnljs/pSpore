import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, unlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { atomicWriteFile } from "../storage/atomic.js";
const execFileAsync = promisify(execFile);
/**
 * Installs and controls the per-user systemd service used by production clients.
 * GUI/TUI callers never own the daemon process; their only lifecycle action is
 * asking systemd to keep the authoritative service enabled and running.
 */
export class SystemServiceManager {
    #home;
    #runner;
    #username;
    #beforeStart;
    unitName;
    unitPath;
    constructor(options) {
        this.#home = resolve(options.home);
        this.#runner = options.runner ?? runSystemCommand;
        this.#username = options.username ?? userInfo().username;
        this.#beforeStart = options.beforeStart;
        this.unitName = serviceUnitName(this.#home);
        const configDirectory = options.userConfigDirectory
            ?? resolve(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"));
        this.unitPath = join(configDirectory, "systemd", "user", this.unitName);
    }
    async ensureRunning(spec) {
        const unitChanged = await this.install(spec);
        if (unitChanged)
            await this.#systemctl("daemon-reload");
        const wasActive = await this.#isSystemctlState("is-active");
        const recoveredFromFailure = wasActive ? false : await this.#resetFailedUnit();
        if (!wasActive)
            await this.#beforeStart?.();
        if (unitChanged && wasActive) {
            await this.#systemctl("restart", this.unitName);
        }
        else {
            await this.#systemctl("enable", "--now", this.unitName);
        }
        let lingerWarning;
        let linger = await this.#lingerEnabled();
        if (linger === false) {
            const result = await this.#runner("loginctl", ["--no-ask-password", "enable-linger", this.#username]);
            if (result.code === 0)
                linger = await this.#lingerEnabled();
            else
                lingerWarning = commandFailure("Could not enable boot-time user lingering", result);
        }
        const status = await this.status();
        if (!status.active) {
            throw new Error(status.detail ?? `System service ${this.unitName} did not become active`);
        }
        return {
            ...status,
            unitChanged,
            ...(recoveredFromFailure ? { recoveredFromFailure } : {}),
            ...(lingerWarning === undefined ? {} : { lingerWarning }),
        };
    }
    async install(spec) {
        const content = renderSystemdUserUnit(this.#home, spec);
        let current;
        try {
            current = await readFile(this.unitPath, "utf8");
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT")
                throw error;
        }
        if (current === content)
            return false;
        await mkdir(dirname(this.unitPath), { recursive: true, mode: 0o700 });
        await atomicWriteFile(this.unitPath, content, 0o644);
        return true;
    }
    async restart() {
        await this.#resetFailedUnit();
        await this.#systemctl("restart", this.unitName);
    }
    async start() {
        await this.#resetFailedUnit();
        await this.#systemctl("enable", "--now", this.unitName);
    }
    async stop() {
        await this.#systemctl("stop", this.unitName);
    }
    async uninstall() {
        await this.#runner("systemctl", ["--user", "disable", "--now", this.unitName]);
        await unlink(this.unitPath).catch((error) => {
            if (!isNodeError(error) || error.code !== "ENOENT")
                throw error;
        });
        await this.#systemctl("daemon-reload");
    }
    async status() {
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
    async logs(lines = 100) {
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
        if (result.code !== 0)
            throw new Error(commandFailure("Could not read service logs", result));
        return result.stdout;
    }
    async #systemctl(...args) {
        const result = await this.#runner("systemctl", ["--user", ...args]);
        if (result.code !== 0)
            throw new Error(commandFailure(`systemctl --user ${args.join(" ")} failed`, result));
    }
    /**
     * A daemon that crashes repeatedly trips `StartLimitBurst`, and systemd then
     * refuses every further start with "start request repeated too quickly". The
     * unit stays failed across client restarts, so clients report a permanently
     * lost connection until the failure is cleared. Clearing it is safe: it only
     * resets systemd's bookkeeping, never a running service.
     */
    async #resetFailedUnit() {
        const result = await this.#runner("systemctl", ["--user", "is-failed", this.unitName]);
        if (result.stdout.trim() !== "failed")
            return false;
        await this.#runner("systemctl", ["--user", "reset-failed", this.unitName]);
        return true;
    }
    async #isSystemctlState(command) {
        const result = await this.#runner("systemctl", ["--user", command, this.unitName]);
        return result.code === 0 && result.stdout.trim() === (command === "is-active" ? "active" : "enabled");
    }
    async #lingerEnabled() {
        const result = await this.#runner("loginctl", ["show-user", this.#username, "--property", "Linger", "--value"]);
        if (result.code !== 0)
            return undefined;
        const value = result.stdout.trim().toLowerCase();
        return value === "yes" ? true : value === "no" ? false : undefined;
    }
}
export function renderSystemdUserUnit(home, spec) {
    const executable = resolveExecutable(spec.executable);
    const workingDirectory = resolve(spec.workingDirectory);
    const command = [executable, ...spec.args].map(systemdQuote).join(" ");
    const environment = Object.entries(spec.environment ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error(`Invalid service environment name: ${key}`);
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
export function serviceUnitName(home, defaultHome = join(homedir(), ".pspore")) {
    const normalizedHome = normalize(resolve(home));
    if (normalizedHome === normalize(resolve(defaultHome)))
        return "pspore.service";
    const suffix = createHash("sha256").update(normalizedHome).digest("hex").slice(0, 12);
    return `pspore-${suffix}.service`;
}
export function systemdQuote(value) {
    if (/[\r\n\u0000]/u.test(value))
        throw new Error("System service arguments cannot contain newlines or NUL");
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
function systemdPath(value) {
    if (/\s$/u.test(value))
        throw new Error("System service paths cannot end with whitespace");
    if (/[\r\n\u0000]/u.test(value))
        throw new Error("System service paths cannot contain newlines or NUL");
    if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        throw new Error("System service paths cannot contain control characters");
    }
    return value.replaceAll("%", "%%");
}
async function runSystemCommand(executable, args) {
    try {
        const result = await execFileAsync(executable, [...args], {
            encoding: "utf8",
            timeout: 20_000,
            maxBuffer: 1_048_576,
        });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
    }
    catch (error) {
        const candidate = error;
        return {
            code: typeof candidate.code === "number" ? candidate.code : 1,
            stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
            stderr: typeof candidate.stderr === "string" ? candidate.stderr : candidate.message,
        };
    }
}
function resolveExecutable(value) {
    if (!value.trim())
        throw new Error("System service executable is required");
    return value.includes("/") ? resolve(value) : value;
}
function commandFailure(prefix, result) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    return `${prefix}: ${detail}`;
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=system-service.js.map