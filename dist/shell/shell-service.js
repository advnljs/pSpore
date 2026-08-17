var _a;
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
const PTY_BRIDGE_SOURCE = String.raw `
const { spawn } = require("node:child_process");
const shell = process.env.PSPORE_PTY_SHELL;
const command = process.env.PSPORE_PTY_COMMAND;
const cwd = process.env.PSPORE_PTY_CWD;
if (!shell || command === undefined || !cwd) process.exit(126);
const child = spawn(shell, ["-l", "-c", command], { cwd, env: process.env, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    try { child.kill(signal); } catch {}
  });
}
child.once("error", () => process.exit(126));
child.once("exit", (code) => process.exit(code === null ? 1 : code));
`;
export class ShellService {
    #artifactRoot;
    #baseEnv;
    #configuredShell;
    #passwdPath;
    #configuredScriptPath;
    #clock;
    #idFactory;
    #summaryBytesPerStream;
    #resolvedShell;
    #resolvedScriptPath;
    constructor(options) {
        this.#artifactRoot = options.artifactRoot;
        this.#baseEnv = { ...(options.env ?? process.env) };
        this.#configuredShell = options.configuredShell;
        this.#passwdPath = options.passwdPath ?? "/etc/passwd";
        this.#configuredScriptPath = options.scriptPath;
        this.#clock = options.clock ?? (() => new Date());
        this.#idFactory = options.idFactory ?? randomUUID;
        this.#summaryBytesPerStream = options.summaryBytesPerStream ?? 8 * 1024;
    }
    async initialize() {
        await mkdir(this.#artifactRoot, { recursive: true, mode: 0o700 });
        await chmod(this.#artifactRoot, 0o700);
        this.#resolvedShell = await resolveUserShell({
            ...(this.#configuredShell ? { configuredShell: this.#configuredShell } : {}),
            env: this.#baseEnv,
            passwdPath: this.#passwdPath,
        });
        return this.#resolvedShell;
    }
    async doctor() {
        const shell = await this.#shell();
        const scriptPath = await this.#scriptPath(false);
        return {
            shell,
            pipe: true,
            pty: scriptPath ? { available: true, scriptPath } : { available: false },
        };
    }
    async run(request, onChunk) {
        return (await this.start(request, onChunk)).completion;
    }
    async start(request, onChunk) {
        validateRequest(request);
        const shell = await this.#shell();
        const cwd = await realpath(request.cwd);
        const cwdStat = await stat(cwd);
        if (!cwdStat.isDirectory()) {
            throw new Error(`Shell cwd is not a directory: ${cwd}`);
        }
        const processId = this.#idFactory();
        const processArtifactDir = join(this.#artifactRoot, processId);
        await mkdir(processArtifactDir, { recursive: false, mode: 0o700 });
        const artifactPath = join(processArtifactDir, "output.log");
        const artifact = await open(artifactPath, "wx", 0o600);
        const started = this.#clock();
        const env = { ...this.#baseEnv, ...request.envDelta };
        const child = await this.#spawn(request, shell.path, cwd, env);
        if (child.pid === undefined) {
            await artifact.close();
            throw new Error("Shell process started without a PID");
        }
        const pid = child.pid;
        const stdoutSummary = new HeadTailBuffer(this.#summaryBytesPerStream);
        const stderrSummary = new HeadTailBuffer(this.#summaryBytesPerStream);
        const stdoutRedactor = new StreamingSecretRedactor();
        const stderrRedactor = new StreamingSecretRedactor();
        const digest = createHash("sha256");
        const mutable = { state: "running", capturedBytes: 0 };
        let writeChain = Promise.resolve();
        let timedOut = false;
        let aborted = false;
        let outputLimitExceeded = false;
        let settled = false;
        let timeout;
        const enqueueArtifact = (buffer) => {
            if (buffer.length === 0)
                return;
            digest.update(buffer);
            writeChain = writeChain.then(async () => {
                await artifact.write(buffer);
            });
        };
        const terminate = (signal) => {
            if (mutable.state === "settled")
                return;
            killProcessGroup(child, signal);
        };
        const persistOutput = (stream, buffer) => {
            if (buffer.length === 0)
                return;
            enqueueArtifact(buffer);
            if (stream === "stdout")
                stdoutSummary.append(buffer);
            else
                stderrSummary.append(buffer);
            onChunk?.({
                processId,
                stream,
                data: buffer.toString("utf8"),
                ts: this.#clock().toISOString(),
            });
        };
        const capture = (stream, chunk) => {
            if (mutable.state === "settled")
                return;
            const remaining = request.maxOutputBytes - mutable.capturedBytes;
            const accepted = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0);
            if (accepted.length > 0) {
                mutable.capturedBytes += accepted.length;
                const redactor = stream === "stdout" ? stdoutRedactor : stderrRedactor;
                persistOutput(stream, redactor.push(accepted));
            }
            if (accepted.length < chunk.length && !outputLimitExceeded) {
                outputLimitExceeded = true;
                const marker = Buffer.from("\n[pSpore: output limit exceeded; process terminated]\n", "utf8");
                enqueueArtifact(marker);
                terminate("SIGTERM");
            }
        };
        child.stdout.on("data", (chunk) => capture("stdout", Buffer.from(chunk)));
        child.stderr.on("data", (chunk) => capture("stderr", Buffer.from(chunk)));
        if (request.timeoutMs > 0) {
            timeout = setTimeout(() => {
                timedOut = true;
                terminate("SIGTERM");
                setTimeout(() => terminate("SIGKILL"), 1_000).unref();
            }, request.timeoutMs);
            timeout.unref();
        }
        const completion = new Promise((resolve) => {
            const finish = async (exitCode, signal, spawnError) => {
                if (settled)
                    return;
                settled = true;
                mutable.state = "settled";
                if (timeout)
                    clearTimeout(timeout);
                if (spawnError) {
                    const message = Buffer.from(`\n[pSpore: spawn error: ${spawnError.message}]\n`, "utf8");
                    enqueueArtifact(message);
                    stderrSummary.append(message);
                }
                persistOutput("stdout", stdoutRedactor.flush());
                persistOutput("stderr", stderrRedactor.flush());
                await writeChain;
                await artifact.sync();
                await artifact.close();
                const ended = this.#clock();
                resolve({
                    processId,
                    pid,
                    shell: shell.path,
                    mode: request.mode,
                    exitCode,
                    signal,
                    durationMs: Math.max(0, ended.getTime() - started.getTime()),
                    timedOut,
                    aborted,
                    outputLimitExceeded,
                    stdout: stdoutSummary.toString(),
                    stderr: stderrSummary.toString(),
                    capturedBytes: mutable.capturedBytes,
                    artifactPath,
                    artifactSha256: digest.digest("hex"),
                });
            };
            child.once("error", (error) => void finish(null, null, error));
            child.once("close", (code, signal) => void finish(code, signal));
        });
        const handle = {
            id: processId,
            pid,
            completion,
            write: async (data, options) => {
                if (mutable.state !== "running" || !child.stdin.writable) {
                    throw new Error(`Process ${processId} is not accepting input`);
                }
                const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
                if (options?.secret) {
                    stdoutRedactor.addSecret(buffer);
                    stderrRedactor.addSecret(buffer);
                }
                await new Promise((resolve, reject) => {
                    child.stdin.write(buffer, (error) => (error ? reject(error) : resolve()));
                });
            },
            signal: (signal) => {
                aborted = true;
                terminate(signal);
            },
            poll: () => ({
                processId,
                pid,
                state: mutable.state,
                capturedBytes: mutable.capturedBytes,
                startedAt: started.toISOString(),
            }),
        };
        completion.catch(() => undefined);
        return handle;
    }
    async #spawn(request, shellPath, cwd, env) {
        if (request.mode === "pipe") {
            return spawn(shellPath, ["-l", "-c", request.command], {
                cwd,
                env,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
        }
        const scriptPath = await this.#scriptPath(true);
        const bridgeCommand = `${quoteShellWord(process.execPath)} --input-type=commonjs -e ${quoteShellWord(PTY_BRIDGE_SOURCE)}`;
        return spawn(scriptPath, ["-qefc", bridgeCommand, "/dev/null"], {
            cwd,
            env: {
                ...env,
                PSPORE_PTY_SHELL: shellPath,
                PSPORE_PTY_COMMAND: request.command,
                PSPORE_PTY_CWD: cwd,
            },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
    }
    async #shell() {
        return this.#resolvedShell ?? this.initialize();
    }
    async #scriptPath(required) {
        if (this.#resolvedScriptPath)
            return this.#resolvedScriptPath;
        const configured = this.#configuredScriptPath;
        if (configured) {
            this.#resolvedScriptPath = await validateExecutable(configured);
            return this.#resolvedScriptPath;
        }
        const discovered = await findExecutable("script", this.#baseEnv["PATH"]);
        if (discovered) {
            this.#resolvedScriptPath = discovered;
            return discovered;
        }
        if (required) {
            throw new Error("PTY mode requires the util-linux `script` executable");
        }
        return undefined;
    }
}
export async function resolveUserShell(options = {}) {
    const env = options.env ?? process.env;
    if (options.configuredShell) {
        return { path: await validateExecutable(options.configuredShell), source: "config" };
    }
    const environmentShell = env["SHELL"];
    if (environmentShell && isAbsolute(environmentShell)) {
        try {
            return { path: await validateExecutable(environmentShell), source: "environment" };
        }
        catch {
            // Invalid inherited SHELL is ignored; passwd remains authoritative fallback.
        }
    }
    const uid = options.uid ?? userInfo().uid;
    try {
        const passwd = await readFile(options.passwdPath ?? "/etc/passwd", "utf8");
        for (const line of passwd.split("\n")) {
            if (!line || line.startsWith("#"))
                continue;
            const fields = line.split(":");
            if (Number(fields[2]) !== uid)
                continue;
            const shell = fields[6];
            if (shell && isAbsolute(shell)) {
                return { path: await validateExecutable(shell), source: "passwd" };
            }
        }
    }
    catch {
        // Fall through to a known POSIX shell.
    }
    return { path: await validateExecutable("/bin/sh"), source: "fallback" };
}
async function validateExecutable(path) {
    if (!isAbsolute(path)) {
        throw new Error(`Executable path must be absolute: ${path}`);
    }
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) {
        throw new Error(`Executable path is not a file: ${canonical}`);
    }
    await access(canonical, constants.X_OK);
    return canonical;
}
async function findExecutable(name, pathValue) {
    for (const directory of (pathValue ?? "/usr/local/bin:/usr/bin:/bin").split(":")) {
        if (!directory)
            continue;
        try {
            return await validateExecutable(join(directory, name));
        }
        catch {
            // Continue to the next PATH entry.
        }
    }
    return undefined;
}
function validateRequest(request) {
    if (!request.command.trim())
        throw new Error("Shell command cannot be empty");
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0) {
        throw new Error("timeoutMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
        throw new Error("maxOutputBytes must be a positive safe integer");
    }
    for (const key of Object.keys(request.envDelta ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.startsWith("PSPORE_PTY_")) {
            throw new Error(`Invalid or reserved environment variable name: ${key}`);
        }
    }
}
function killProcessGroup(child, signal) {
    if (child.pid === undefined)
        return;
    try {
        process.kill(-child.pid, signal);
    }
    catch {
        try {
            child.kill(signal);
        }
        catch {
            // The process already exited.
        }
    }
}
function quoteShellWord(value) {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
class HeadTailBuffer {
    #limit;
    #head = Buffer.alloc(0);
    #tail = Buffer.alloc(0);
    #total = 0;
    constructor(limit) {
        this.#limit = Math.max(256, limit);
    }
    append(chunk) {
        this.#total += chunk.length;
        if (this.#head.length < this.#limit) {
            const needed = this.#limit - this.#head.length;
            this.#head = Buffer.concat([this.#head, chunk.subarray(0, needed)]);
        }
        this.#tail = Buffer.concat([this.#tail, chunk]);
        if (this.#tail.length > this.#limit) {
            this.#tail = this.#tail.subarray(this.#tail.length - this.#limit);
        }
    }
    toString() {
        if (this.#total <= this.#limit)
            return this.#head.toString("utf8");
        if (this.#total <= this.#limit * 2) {
            const overlap = this.#limit * 2 - this.#total;
            return Buffer.concat([this.#head, this.#tail.subarray(Math.max(0, overlap))]).toString("utf8");
        }
        return `${this.#head.toString("utf8")}\n… ${this.#total - this.#limit * 2} bytes omitted …\n${this.#tail.toString("utf8")}`;
    }
}
class StreamingSecretRedactor {
    static #marker = Buffer.from("[REDACTED]", "utf8");
    #patterns = [];
    #carry = Buffer.alloc(0);
    addSecret(input) {
        let end = input.length;
        while (end > 0 && (input[end - 1] === 0x0a || input[end - 1] === 0x0d))
            end--;
        if (end === 0)
            return;
        const pattern = Buffer.from(input.subarray(0, end));
        if (!this.#patterns.some((existing) => existing.equals(pattern))) {
            this.#patterns.push(pattern);
            this.#patterns.sort((left, right) => right.length - left.length);
        }
    }
    push(chunk) {
        if (this.#patterns.length === 0)
            return chunk;
        const combined = Buffer.concat([this.#carry, chunk]);
        const longest = this.#patterns[0]?.length ?? 1;
        const safeBoundary = Math.max(0, combined.length - longest + 1);
        const { output, consumed } = this.#redactUntil(combined, safeBoundary);
        this.#carry = combined.subarray(consumed);
        return output;
    }
    flush() {
        const { output } = this.#redactUntil(this.#carry, this.#carry.length, true);
        this.#carry = Buffer.alloc(0);
        this.#patterns = [];
        return output;
    }
    #redactUntil(input, boundary, flush = false) {
        const parts = [];
        let cursor = 0;
        const target = flush ? input.length : boundary;
        while (cursor < target) {
            const match = this.#nextMatch(input, cursor);
            if (!match || match.index >= target) {
                parts.push(input.subarray(cursor, target));
                cursor = target;
                break;
            }
            if (match.index > cursor)
                parts.push(input.subarray(cursor, match.index));
            parts.push(_a.#marker);
            cursor = match.index + match.length;
        }
        return { output: Buffer.concat(parts), consumed: cursor };
    }
    #nextMatch(input, offset) {
        let best;
        for (const pattern of this.#patterns) {
            const index = input.indexOf(pattern, offset);
            if (index === -1)
                continue;
            if (!best || index < best.index || (index === best.index && pattern.length > best.length)) {
                best = { index, length: pattern.length };
            }
        }
        return best;
    }
}
_a = StreamingSecretRedactor;
export function shellDisplayName(path) {
    return basename(path);
}
//# sourceMappingURL=shell-service.js.map