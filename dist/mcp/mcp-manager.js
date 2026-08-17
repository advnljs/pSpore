import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment, } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { appendJsonLine, atomicWriteFile } from "../storage/atomic.js";
import { PSPORE_VERSION } from "../version.js";
const MAX_TOOL_COUNT = 256;
const MAX_TOOL_PAGES = 16;
const MAX_SCHEMA_BYTES = 65_536;
const MAX_ARGUMENT_BYTES = 262_144;
export class McpManager {
    #artifactDirectory;
    #auditPath;
    #environment;
    #factory;
    #maxResultBytes;
    #initialBackoffMs;
    #maxBackoffMs;
    #connectTimeoutMs;
    #clock;
    #idFactory;
    #onHealth;
    #onError;
    #servers = new Map();
    #stopping = false;
    constructor(options) {
        this.#artifactDirectory = join(options.artifactRoot, "mcp");
        this.#auditPath = options.auditPath;
        this.#environment = options.environment ?? process.env;
        this.#factory = options.connectionFactory ?? createSdkConnection;
        this.#maxResultBytes = positiveInteger(options.maxResultBytes ?? 65_536, "maxResultBytes");
        this.#initialBackoffMs = positiveInteger(options.initialBackoffMs ?? 1_000, "initialBackoffMs");
        this.#maxBackoffMs = positiveInteger(options.maxBackoffMs ?? 30_000, "maxBackoffMs");
        if (this.#maxBackoffMs < this.#initialBackoffMs)
            throw new Error("maxBackoffMs cannot be below initialBackoffMs");
        this.#connectTimeoutMs = positiveInteger(options.connectTimeoutMs ?? 15_000, "connectTimeoutMs");
        this.#clock = options.clock ?? (() => new Date());
        this.#idFactory = options.idFactory ?? randomUUID;
        this.#onHealth = options.onHealth;
        this.#onError = options.onError;
        for (const config of options.configs) {
            if (this.#servers.has(config.id))
                throw new Error(`Duplicate MCP server id: ${config.id}`);
            const status = !config.enabled
                ? "disabled"
                : config.trust === "sandboxed"
                    ? "untrusted"
                    : "idle";
            this.#servers.set(config.id, {
                config: structuredClone(config),
                status,
                tools: new Map(),
                connection: undefined,
                connecting: undefined,
                connectController: undefined,
                idleTimer: undefined,
                activeCalls: 0,
                generation: 0,
                failureCount: 0,
                connectedAt: undefined,
                retryAtMs: undefined,
                lastError: undefined,
            });
        }
    }
    static async create(options) {
        const manager = new McpManager(options);
        await mkdir(dirname(options.auditPath), { recursive: true, mode: 0o700 });
        for (const entry of manager.#servers.values())
            manager.#publish(entry);
        return manager;
    }
    listServers() {
        return [...this.#servers.values()]
            .sort((left, right) => left.config.id.localeCompare(right.config.id))
            .map((entry) => this.#health(entry));
    }
    listTools() {
        return [...this.#servers.values()]
            .flatMap((entry) => [...entry.tools.values()])
            .sort((left, right) => left.serverId.localeCompare(right.serverId) || left.normalizedName.localeCompare(right.normalizedName))
            .map((tool) => structuredClone(tool));
    }
    async discover(serverId, signal) {
        const entry = this.#available(serverId);
        const connection = await this.#connection(entry, signal);
        const remote = [];
        let cursor;
        try {
            for (let page = 0; page < MAX_TOOL_PAGES; page++) {
                throwIfAborted(signal);
                const result = await connection.listTools(cursor, signal, entry.config.requestTimeoutMs);
                remote.push(...result.tools);
                if (remote.length > MAX_TOOL_COUNT)
                    throw new Error(`MCP server ${serverId} exposes more than ${MAX_TOOL_COUNT} tools`);
                cursor = result.nextCursor;
                if (!cursor)
                    break;
                if (page === MAX_TOOL_PAGES - 1)
                    throw new Error(`MCP server ${serverId} tool pagination exceeds ${MAX_TOOL_PAGES} pages`);
            }
        }
        catch (error) {
            const original = toError(error);
            const normalized = new Error(this.#redact(original.message));
            if (!signal?.aborted && isConnectionFailure(original))
                this.#markFailure(entry, normalized);
            throw normalized;
        }
        const next = this.#validateTools(entry, remote);
        entry.tools = new Map(next.map((tool) => [tool.name, tool]));
        entry.status = "ready";
        entry.lastError = undefined;
        entry.retryAtMs = undefined;
        this.#publish(entry);
        this.#scheduleIdle(entry);
        return next.map((tool) => structuredClone(tool));
    }
    async ping(serverId, signal) {
        const entry = this.#available(serverId);
        const connection = await this.#connection(entry, signal);
        try {
            await connection.ping(signal, entry.config.requestTimeoutMs);
        }
        catch (error) {
            const original = toError(error);
            const normalized = new Error(this.#redact(original.message));
            if (!signal?.aborted && isConnectionFailure(original))
                this.#markFailure(entry, normalized);
            throw normalized;
        }
        this.#scheduleIdle(entry);
        return this.#health(entry);
    }
    async call(serverId, toolName, args, signal) {
        throwIfAborted(signal);
        const argumentJson = JSON.stringify(args);
        if (Buffer.byteLength(argumentJson) > MAX_ARGUMENT_BYTES) {
            throw new Error(`MCP tool arguments exceed ${MAX_ARGUMENT_BYTES} bytes`);
        }
        const entry = this.#available(serverId);
        let descriptor = findTool(entry.tools, toolName);
        if (!descriptor) {
            await this.discover(serverId, signal);
            descriptor = findTool(entry.tools, toolName);
        }
        if (!descriptor)
            throw new Error(`MCP tool is not allowed or does not exist: ${serverId}/${toolName}`);
        const startedAt = this.#clock();
        entry.activeCalls += 1;
        this.#clearIdle(entry);
        let outcome = "failed";
        let connectionAcquired = false;
        try {
            const connection = await this.#connection(entry, signal);
            connectionAcquired = true;
            const raw = await connection.callTool(descriptor.name, args, signal, entry.config.requestTimeoutMs);
            const isError = isRecord(raw) && raw["isError"] === true;
            outcome = isError ? "tool_error" : "succeeded";
            return await this.#boundedResult(descriptor, raw, isError);
        }
        catch (error) {
            const original = toError(error);
            const normalized = new Error(this.#redact(original.message));
            outcome = signal?.aborted ? "aborted" : "failed";
            if (connectionAcquired && !signal?.aborted && isConnectionFailure(original) && entry.status !== "backoff") {
                this.#markFailure(entry, normalized);
            }
            throw normalized;
        }
        finally {
            entry.activeCalls -= 1;
            this.#scheduleIdle(entry);
            await this.#audit({
                serverId,
                toolName: descriptor.name,
                normalizedName: descriptor.normalizedName,
                argumentSha256: createHash("sha256").update(argumentJson).digest("hex"),
                outcome,
                durationMs: Math.max(0, this.#clock().getTime() - startedAt.getTime()),
            });
        }
    }
    async stop() {
        if (this.#stopping)
            return;
        this.#stopping = true;
        const closes = [];
        for (const entry of this.#servers.values()) {
            this.#clearIdle(entry);
            entry.connectController?.abort(new Error("MCP manager shutdown"));
            entry.generation += 1;
            const connection = entry.connection;
            entry.connection = undefined;
            if (connection)
                closes.push(connection.close().catch((error) => this.#error(error)));
            entry.status = "stopped";
            entry.connectedAt = undefined;
            entry.retryAtMs = undefined;
            this.#publish(entry);
        }
        await Promise.allSettled(closes);
    }
    #available(serverId) {
        if (this.#stopping)
            throw new Error("MCP manager is stopping");
        const entry = this.#servers.get(serverId);
        if (!entry)
            throw new Error(`Unknown MCP server: ${serverId}`);
        if (!entry.config.enabled)
            throw new Error(`MCP server is disabled: ${serverId}`);
        if (entry.config.trust !== "trusted-local") {
            throw new Error(`MCP server ${serverId} requires a sandbox executor, which is not available in v1`);
        }
        return entry;
    }
    async #connection(entry, signal) {
        throwIfAborted(signal);
        if (entry.connection)
            return entry.connection;
        if (entry.connecting)
            return withAbort(entry.connecting, signal);
        const now = this.#clock().getTime();
        if (entry.retryAtMs !== undefined && now < entry.retryAtMs) {
            throw new Error(`MCP server ${entry.config.id} is in backoff until ${new Date(entry.retryAtMs).toISOString()}`);
        }
        const controller = new AbortController();
        const relayAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", relayAbort, { once: true });
        entry.connectController = controller;
        entry.status = "connecting";
        entry.lastError = undefined;
        entry.retryAtMs = undefined;
        const generation = ++entry.generation;
        this.#publish(entry);
        const task = this.#factory(entry.config, {
            signal: controller.signal,
            timeoutMs: Math.min(this.#connectTimeoutMs, entry.config.requestTimeoutMs),
            environment: this.#environment,
            onClose: () => {
                if (entry.generation === generation && entry.connection)
                    this.#markFailure(entry, new Error("MCP transport closed"));
            },
            onError: (error) => {
                if (entry.generation === generation && entry.connection)
                    this.#markFailure(entry, error);
            },
        }).then((connection) => {
            if (this.#stopping || controller.signal.aborted) {
                void connection.close().catch(() => undefined);
                throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error("MCP connection aborted");
            }
            entry.connection = connection;
            entry.failureCount = 0;
            entry.connectedAt = this.#clock().toISOString();
            entry.status = "ready";
            entry.lastError = undefined;
            this.#publish(entry);
            this.#scheduleIdle(entry);
            return connection;
        }).catch((error) => {
            const normalized = new Error(this.#redact(toError(error).message));
            if (!controller.signal.aborted || !signal?.aborted)
                this.#markFailure(entry, normalized);
            throw normalized;
        }).finally(() => {
            signal?.removeEventListener("abort", relayAbort);
            if (entry.connecting === task)
                entry.connecting = undefined;
            if (entry.connectController === controller)
                entry.connectController = undefined;
        });
        entry.connecting = task;
        return withAbort(task, signal);
    }
    #validateTools(entry, tools) {
        const allowed = new Set(entry.config.allowedTools);
        const denied = new Set(entry.config.deniedTools);
        const normalized = new Set();
        const existing = new Set([...this.#servers.values()]
            .filter((candidate) => candidate !== entry)
            .flatMap((candidate) => [...candidate.tools.values()].map((tool) => tool.normalizedName)));
        const result = [];
        for (const tool of tools) {
            if (!tool.name.trim() || tool.name.length > 128)
                throw new Error(`MCP server ${entry.config.id} returned an invalid tool name`);
            if (denied.has(tool.name) || (allowed.size > 0 && !allowed.has(tool.name)))
                continue;
            if (!isRecord(tool.inputSchema) || tool.inputSchema["type"] !== "object") {
                throw new Error(`MCP tool ${entry.config.id}/${tool.name} inputSchema must be an object schema`);
            }
            if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > MAX_SCHEMA_BYTES) {
                throw new Error(`MCP tool ${entry.config.id}/${tool.name} schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
            }
            const normalizedName = normalizeMcpToolName(entry.config.id, tool.name);
            if (normalized.has(normalizedName) || existing.has(normalizedName)) {
                throw new Error(`MCP normalized tool name collision: ${normalizedName}`);
            }
            normalized.add(normalizedName);
            result.push({
                version: 1,
                serverId: entry.config.id,
                name: tool.name,
                normalizedName,
                ...(tool.title === undefined ? {} : { title: bounded(tool.title, 256) }),
                ...(tool.description === undefined ? {} : { description: bounded(tool.description, 4_096) }),
                inputSchema: structuredClone(tool.inputSchema),
                ...(tool.annotations === undefined ? {} : { annotations: structuredClone(tool.annotations) }),
            });
        }
        return result.sort((left, right) => left.normalizedName.localeCompare(right.normalizedName));
    }
    async #boundedResult(descriptor, raw, isError) {
        const json = `${JSON.stringify(raw, null, 2)}\n`;
        const content = Buffer.from(json, "utf8");
        if (content.byteLength <= this.#maxResultBytes) {
            return {
                text: json.trimEnd(),
                details: {
                    serverId: descriptor.serverId,
                    toolName: descriptor.name,
                    normalizedName: descriptor.normalizedName,
                    isError,
                    bytes: content.byteLength,
                    truncated: false,
                },
            };
        }
        const artifactSha256 = createHash("sha256").update(content).digest("hex");
        const artifactPath = join(this.#artifactDirectory, `${this.#clock().toISOString().replaceAll(":", "-")}-${createHash("sha256").update(this.#idFactory()).digest("hex").slice(0, 16)}.json`);
        await mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 });
        await atomicWriteFile(artifactPath, content, 0o600);
        const prefix = content.subarray(0, this.#maxResultBytes).toString("utf8");
        return {
            text: `${prefix}\n\n[MCP result truncated; full artifact: ${artifactPath}; sha256: ${artifactSha256}]`,
            details: {
                serverId: descriptor.serverId,
                toolName: descriptor.name,
                normalizedName: descriptor.normalizedName,
                isError,
                bytes: content.byteLength,
                truncated: true,
                artifactPath,
                artifactSha256,
            },
        };
    }
    #markFailure(entry, error) {
        if (this.#stopping)
            return;
        this.#clearIdle(entry);
        const connection = entry.connection;
        entry.connection = undefined;
        entry.generation += 1;
        if (connection)
            void connection.close().catch(() => undefined);
        entry.failureCount += 1;
        const delay = Math.min(this.#initialBackoffMs * 2 ** Math.max(0, entry.failureCount - 1), this.#maxBackoffMs);
        entry.retryAtMs = this.#clock().getTime() + delay;
        entry.connectedAt = undefined;
        entry.status = "backoff";
        entry.lastError = this.#redact(error.message);
        this.#publish(entry);
        this.#error(new Error(`MCP ${entry.config.id}: ${entry.lastError}`));
    }
    #scheduleIdle(entry) {
        this.#clearIdle(entry);
        if (!entry.connection || entry.activeCalls > 0 || this.#stopping)
            return;
        entry.idleTimer = setTimeout(() => void this.#closeIdle(entry), entry.config.idleTimeoutMs);
        entry.idleTimer.unref();
    }
    async #closeIdle(entry) {
        entry.idleTimer = undefined;
        if (!entry.connection || entry.activeCalls > 0 || this.#stopping)
            return;
        const connection = entry.connection;
        entry.connection = undefined;
        entry.generation += 1;
        await connection.close().catch((error) => this.#error(error));
        entry.status = "idle";
        entry.connectedAt = undefined;
        entry.lastError = undefined;
        this.#publish(entry);
    }
    #clearIdle(entry) {
        if (entry.idleTimer)
            clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
    }
    #health(entry) {
        return {
            version: 1,
            serverId: entry.config.id,
            status: entry.status,
            transport: entry.config.transport.type,
            toolCount: entry.tools.size,
            failureCount: entry.failureCount,
            updatedAt: this.#clock().toISOString(),
            ...(entry.connectedAt === undefined ? {} : { connectedAt: entry.connectedAt }),
            ...(entry.retryAtMs === undefined ? {} : { retryAt: new Date(entry.retryAtMs).toISOString() }),
            ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
        };
    }
    #publish(entry) {
        try {
            this.#onHealth?.(this.#health(entry));
        }
        catch {
            // Health observers do not own MCP lifecycle.
        }
    }
    async #audit(value) {
        try {
            await appendJsonLine(this.#auditPath, {
                version: 1,
                id: this.#idFactory(),
                ...value,
                ts: this.#clock().toISOString(),
            }, 0o600);
        }
        catch (error) {
            this.#error(new Error(`MCP audit write failed: ${this.#redact(toError(error).message)}`));
        }
    }
    #redact(message) {
        let redacted = message;
        for (const config of [...this.#servers.values()].map((entry) => entry.config)) {
            const refs = config.transport.type === "stdio"
                ? Object.values(config.transport.envRefs)
                : Object.values(config.transport.headerRefs).map((ref) => ref.env);
            for (const ref of refs) {
                const secret = this.#environment[ref];
                if (secret && secret.length >= 4)
                    redacted = redacted.replaceAll(secret, "[REDACTED]");
            }
        }
        return bounded(redacted, 2_000);
    }
    #error(error) {
        try {
            this.#onError?.(new Error(this.#redact(toError(error).message)));
        }
        catch {
            // Error observers cannot break lifecycle cleanup.
        }
    }
}
export function normalizeMcpToolName(serverId, toolName) {
    const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    const server = normalize(serverId);
    const tool = normalize(toolName);
    if (!server || !tool)
        throw new Error(`MCP name cannot be normalized: ${serverId}/${toolName}`);
    const name = `mcp__${server}__${tool}`;
    if (name.length > 128)
        throw new Error(`MCP normalized tool name exceeds 128 characters: ${name}`);
    return name;
}
async function createSdkConnection(config, context) {
    const client = new Client({ name: "pspore", version: PSPORE_VERSION }, { enforceStrictCapabilities: true });
    client.onclose = context.onClose;
    client.onerror = context.onError;
    const transport = config.transport.type === "stdio"
        ? new StdioClientTransport({
            command: config.transport.command,
            args: [...config.transport.args],
            ...(config.transport.cwd === undefined ? {} : { cwd: config.transport.cwd }),
            env: resolveStdioEnvironment(config, context.environment),
            stderr: "ignore",
            maxBufferSize: 1_048_576,
        })
        : new StreamableHTTPClientTransport(new URL(config.transport.url), {
            requestInit: { headers: resolveHttpHeaders(config, context.environment) },
            reconnectionOptions: {
                initialReconnectionDelay: 1_000,
                maxReconnectionDelay: 30_000,
                reconnectionDelayGrowFactor: 2,
                maxRetries: 2,
            },
        });
    await client.connect(transport, {
        signal: context.signal,
        timeout: context.timeoutMs,
        maxTotalTimeout: context.timeoutMs,
    });
    return {
        listTools: async (cursor, signal, timeoutMs) => {
            const result = await client.listTools(cursor === undefined ? undefined : { cursor }, requestOptions(signal, timeoutMs));
            return {
                tools: result.tools.map((tool) => ({
                    name: tool.name,
                    ...(tool.title === undefined ? {} : { title: tool.title }),
                    ...(tool.description === undefined ? {} : { description: tool.description }),
                    inputSchema: structuredClone(tool.inputSchema),
                    ...(tool.annotations === undefined ? {} : { annotations: normalizeAnnotations(tool.annotations) }),
                })),
                ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
            };
        },
        callTool: async (name, args, signal, timeoutMs) => client.callTool({ name, arguments: { ...args } }, undefined, requestOptions(signal, timeoutMs)),
        ping: async (signal, timeoutMs) => {
            await client.ping(requestOptions(signal, timeoutMs));
        },
        close: async () => client.close(),
    };
}
function resolveStdioEnvironment(config, environment) {
    if (config.transport.type !== "stdio")
        throw new Error("Expected stdio MCP config");
    const resolved = getDefaultEnvironment();
    for (const [target, source] of Object.entries(config.transport.envRefs)) {
        const value = environment[source];
        if (value === undefined)
            throw new Error(`MCP ${config.id} is missing environment reference ${source}`);
        resolved[target] = value;
    }
    return resolved;
}
function resolveHttpHeaders(config, environment) {
    if (config.transport.type !== "streamable-http")
        throw new Error("Expected HTTP MCP config");
    const headers = {};
    for (const [header, ref] of Object.entries(config.transport.headerRefs)) {
        const value = environment[ref.env];
        if (value === undefined)
            throw new Error(`MCP ${config.id} is missing environment reference ${ref.env}`);
        headers[header] = `${ref.prefix ?? ""}${value}`;
    }
    return headers;
}
function requestOptions(signal, timeoutMs) {
    return {
        ...(signal === undefined ? {} : { signal }),
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
    };
}
function normalizeAnnotations(value) {
    return {
        ...(value.readOnlyHint === undefined ? {} : { readOnlyHint: value.readOnlyHint }),
        ...(value.destructiveHint === undefined ? {} : { destructiveHint: value.destructiveHint }),
        ...(value.idempotentHint === undefined ? {} : { idempotentHint: value.idempotentHint }),
        ...(value.openWorldHint === undefined ? {} : { openWorldHint: value.openWorldHint }),
    };
}
function findTool(tools, name) {
    return tools.get(name) ?? [...tools.values()].find((tool) => tool.normalizedName === name);
}
function isConnectionFailure(error) {
    return !(error instanceof McpError) || error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout;
}
function bounded(value, maximum) {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
function positiveInteger(value, path) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${path} must be a positive safe integer`);
    return value;
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error("MCP operation aborted");
}
async function withAbort(task, signal) {
    if (!signal)
        return task;
    throwIfAborted(signal);
    let abort;
    const interrupted = new Promise((_resolve, reject) => {
        abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("MCP operation aborted"));
        signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([task, interrupted]);
    }
    finally {
        if (abort)
            signal.removeEventListener("abort", abort);
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=mcp-manager.js.map