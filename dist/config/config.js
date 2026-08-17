import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
export function defaultConfig(home) {
    return {
        version: 1,
        runtime: {
            workspace: join(home, "workspace"),
            maxConcurrentAgents: 4,
            shutdownGraceMs: 15_000,
        },
        model: null,
        context: {
            pinnedFiles: ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"],
            maxPinnedTokens: 5_000,
        },
        permissions: {
            mode: "ask_risky",
            approvalTimeoutMs: 300_000,
            rules: [],
        },
        memory: {
            provider: "lexical",
            maxResults: 8,
            maxReturnedTokens: 3_000,
        },
        shell: {
            defaultTimeoutMs: 120_000,
            maxOutputBytes: 1_048_576,
        },
        scheduler: {
            enabled: true,
            maxConcurrentRuns: 2,
        },
        boot: {
            enabled: false,
        },
        plugins: [],
        mcpServers: [],
    };
}
export function parseConfig(value, home) {
    const root = object(value, "config");
    exactKeys(root, ["version", "runtime", "model", "context", "permissions", "memory", "shell", "scheduler", "boot", "plugins", "mcpServers"], "config");
    if (root["version"] !== 1)
        throw new Error("config.version must be 1");
    const runtime = object(root["runtime"], "config.runtime");
    exactKeys(runtime, ["workspace", "maxConcurrentAgents", "shutdownGraceMs"], "config.runtime");
    const context = object(root["context"], "config.context");
    exactKeys(context, ["pinnedFiles", "maxPinnedTokens"], "config.context");
    const permissions = object(root["permissions"], "config.permissions");
    exactKeys(permissions, ["mode", "approvalTimeoutMs", "rules"], "config.permissions");
    const memory = object(root["memory"], "config.memory");
    exactKeys(memory, ["provider", "maxResults", "maxReturnedTokens"], "config.memory");
    const shell = object(root["shell"], "config.shell");
    exactKeys(shell, ["executable", "defaultTimeoutMs", "maxOutputBytes"], "config.shell");
    const scheduler = object(root["scheduler"], "config.scheduler");
    exactKeys(scheduler, ["enabled", "maxConcurrentRuns"], "config.scheduler");
    const boot = object(root["boot"], "config.boot");
    exactKeys(boot, ["enabled"], "config.boot");
    const model = parseModel(root["model"]);
    const rules = array(permissions["rules"], "config.permissions.rules").map((rule, index) => parsePermissionRule(rule, index));
    const pinnedFiles = array(context["pinnedFiles"], "config.context.pinnedFiles").map((file, index) => string(file, `config.context.pinnedFiles[${index}]`));
    const plugins = array(root["plugins"], "config.plugins").map((plugin, index) => parsePluginActivation(plugin, index));
    const duplicatePlugins = duplicates(plugins.map((plugin) => plugin.name));
    if (duplicatePlugins.length > 0)
        throw new Error(`config.plugins contains duplicate names: ${duplicatePlugins.join(", ")}`);
    const mcpServers = array(root["mcpServers"], "config.mcpServers").map((server, index) => parseMcpServer(server, index, home));
    const duplicateMcpIds = duplicates(mcpServers.map((server) => server.id));
    if (duplicateMcpIds.length > 0)
        throw new Error(`config.mcpServers contains duplicate ids: ${duplicateMcpIds.join(", ")}`);
    const shellExecutable = shell["executable"];
    return {
        version: 1,
        runtime: {
            workspace: resolveConfiguredPath(string(runtime["workspace"], "config.runtime.workspace"), home),
            maxConcurrentAgents: positiveInteger(runtime["maxConcurrentAgents"], "config.runtime.maxConcurrentAgents"),
            shutdownGraceMs: positiveInteger(runtime["shutdownGraceMs"], "config.runtime.shutdownGraceMs"),
        },
        model,
        context: {
            pinnedFiles,
            maxPinnedTokens: positiveInteger(context["maxPinnedTokens"], "config.context.maxPinnedTokens"),
        },
        permissions: {
            mode: enumeration(permissions["mode"], ["deny", "ask_all", "ask_risky", "allow_all"], "config.permissions.mode"),
            approvalTimeoutMs: positiveInteger(permissions["approvalTimeoutMs"], "config.permissions.approvalTimeoutMs"),
            rules,
        },
        memory: {
            provider: enumeration(memory["provider"], ["lexical"], "config.memory.provider"),
            maxResults: positiveInteger(memory["maxResults"], "config.memory.maxResults"),
            maxReturnedTokens: positiveInteger(memory["maxReturnedTokens"], "config.memory.maxReturnedTokens"),
        },
        shell: {
            ...(shellExecutable === undefined
                ? {}
                : { executable: resolveConfiguredPath(string(shellExecutable, "config.shell.executable"), home) }),
            defaultTimeoutMs: positiveInteger(shell["defaultTimeoutMs"], "config.shell.defaultTimeoutMs"),
            maxOutputBytes: positiveInteger(shell["maxOutputBytes"], "config.shell.maxOutputBytes"),
        },
        scheduler: {
            enabled: boolean(scheduler["enabled"], "config.scheduler.enabled"),
            maxConcurrentRuns: positiveInteger(scheduler["maxConcurrentRuns"], "config.scheduler.maxConcurrentRuns"),
        },
        boot: { enabled: boolean(boot["enabled"], "config.boot.enabled") },
        plugins,
        mcpServers,
    };
}
export function resolvePsporeHome(input = process.env["PSPORE_HOME"]) {
    if (!input)
        return join(homedir(), ".pspore");
    return resolveConfiguredPath(input, homedir());
}
function parseModel(value) {
    if (value === null)
        return null;
    const model = object(value, "config.model");
    exactKeys(model, ["provider", "model", "thinking"], "config.model");
    return {
        provider: string(model["provider"], "config.model.provider"),
        model: string(model["model"], "config.model.model"),
        thinking: enumeration(model["thinking"], ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "config.model.thinking"),
    };
}
function parsePermissionRule(value, index) {
    const path = `config.permissions.rules[${index}]`;
    const rule = object(value, path);
    exactKeys(rule, ["effect", "capability", "target"], path);
    const target = rule["target"];
    return {
        effect: enumeration(rule["effect"], ["allow", "ask", "deny"], `${path}.effect`),
        capability: string(rule["capability"], `${path}.capability`),
        ...(target === undefined ? {} : { target: string(target, `${path}.target`) }),
    };
}
function parsePluginActivation(value, index) {
    const path = `config.plugins[${index}]`;
    const plugin = object(value, path);
    exactShape(plugin, ["name", "enabled", "digest", "grantedCapabilities"], [], path);
    const name = string(plugin["name"], `${path}.name`);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) || name.includes("--")) {
        throw new Error(`${path}.name must be 1-64 lowercase letters, numbers, or single hyphens`);
    }
    const digest = string(plugin["digest"], `${path}.digest`);
    if (!/^[a-f0-9]{64}$/.test(digest))
        throw new Error(`${path}.digest must be a lowercase SHA-256 digest`);
    const grantedCapabilities = optionalStringArray(plugin["grantedCapabilities"], `${path}.grantedCapabilities`);
    for (const [capabilityIndex, capability] of grantedCapabilities.entries()) {
        if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(capability)) {
            throw new Error(`${path}.grantedCapabilities[${capabilityIndex}] is not a valid capability`);
        }
    }
    return {
        name,
        enabled: boolean(plugin["enabled"], `${path}.enabled`),
        digest,
        grantedCapabilities,
    };
}
function parseMcpServer(value, index, home) {
    const path = `config.mcpServers[${index}]`;
    const server = object(value, path);
    exactShape(server, ["id", "enabled", "trust", "transport"], ["allowedTools", "deniedTools", "idleTimeoutMs", "requestTimeoutMs"], path);
    const id = string(server["id"], `${path}.id`);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) {
        throw new Error(`${path}.id must match ^[a-z][a-z0-9_-]{0,63}$`);
    }
    const allowedTools = optionalStringArray(server["allowedTools"], `${path}.allowedTools`);
    const deniedTools = optionalStringArray(server["deniedTools"], `${path}.deniedTools`);
    const overlap = allowedTools.filter((name) => deniedTools.includes(name));
    if (overlap.length > 0)
        throw new Error(`${path} allows and denies the same tools: ${overlap.join(", ")}`);
    return {
        id,
        enabled: boolean(server["enabled"], `${path}.enabled`),
        trust: enumeration(server["trust"], ["trusted-local", "sandboxed"], `${path}.trust`),
        transport: parseMcpTransport(server["transport"], `${path}.transport`, home),
        allowedTools,
        deniedTools,
        idleTimeoutMs: optionalPositiveInteger(server["idleTimeoutMs"], `${path}.idleTimeoutMs`) ?? 60_000,
        requestTimeoutMs: optionalPositiveInteger(server["requestTimeoutMs"], `${path}.requestTimeoutMs`) ?? 60_000,
    };
}
function parseMcpTransport(value, path, home) {
    const transport = object(value, path);
    const type = transport["type"];
    if (type === "stdio") {
        exactShape(transport, ["type", "command"], ["args", "cwd", "envRefs"], path);
        const cwd = transport["cwd"];
        return {
            type,
            command: string(transport["command"], `${path}.command`),
            args: optionalStringArray(transport["args"], `${path}.args`, true),
            ...(cwd === undefined ? {} : { cwd: resolveConfigPath(string(cwd, `${path}.cwd`), home) }),
            envRefs: parseReferenceMap(transport["envRefs"], `${path}.envRefs`),
        };
    }
    if (type === "streamable-http") {
        exactShape(transport, ["type", "url"], ["headerRefs"], path);
        const url = parseMcpUrl(string(transport["url"], `${path}.url`), `${path}.url`);
        return {
            type,
            url,
            headerRefs: parseHeaderRefs(transport["headerRefs"], `${path}.headerRefs`),
        };
    }
    throw new Error(`${path}.type must be one of: stdio, streamable-http`);
}
function parseMcpUrl(value, path) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`${path} must be an absolute URL`);
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error(`${path} cannot contain credentials, query parameters, or fragments`);
    }
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error(`${path} must use https, or http on loopback`);
    }
    return url.toString();
}
function parseReferenceMap(value, path) {
    if (value === undefined)
        return {};
    const refs = object(value, path);
    const result = {};
    for (const [target, source] of Object.entries(refs)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target))
            throw new Error(`${path} has an invalid target environment name: ${target}`);
        const name = string(source, `${path}.${target}`);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error(`${path}.${target} must name an environment variable`);
        result[target] = name;
    }
    return result;
}
function parseHeaderRefs(value, path) {
    if (value === undefined)
        return {};
    const refs = object(value, path);
    const result = {};
    for (const [header, raw] of Object.entries(refs)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header))
            throw new Error(`${path} has an invalid header name: ${header}`);
        const refPath = `${path}.${header}`;
        const ref = object(raw, refPath);
        exactShape(ref, ["env"], ["prefix"], refPath);
        const env = string(ref["env"], `${refPath}.env`);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env))
            throw new Error(`${refPath}.env must name an environment variable`);
        const prefix = ref["prefix"];
        result[header] = { env, ...(prefix === undefined ? {} : { prefix: string(prefix, `${refPath}.prefix`) }) };
    }
    return result;
}
function resolveConfiguredPath(input, home) {
    const expanded = input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
    return normalize(isAbsolute(expanded) ? expanded : resolve(expanded));
}
function resolveConfigPath(input, home) {
    const expanded = input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
    return normalize(isAbsolute(expanded) ? expanded : resolve(home, expanded));
}
function object(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
    return value;
}
function array(value, path) {
    if (!Array.isArray(value))
        throw new Error(`${path} must be an array`);
    return value;
}
function string(value, path) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${path} must be a non-empty string`);
    return value;
}
function boolean(value, path) {
    if (typeof value !== "boolean")
        throw new Error(`${path} must be a boolean`);
    return value;
}
function positiveInteger(value, path) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0)
        throw new Error(`${path} must be a positive safe integer`);
    return Number(value);
}
function optionalPositiveInteger(value, path) {
    return value === undefined ? undefined : positiveInteger(value, path);
}
function optionalStringArray(value, path, allowEmpty = false) {
    if (value === undefined)
        return [];
    const values = array(value, path).map((item, index) => string(item, `${path}[${index}]`));
    if (!allowEmpty && values.length !== new Set(values).size)
        throw new Error(`${path} must not contain duplicates`);
    if (values.length > 256)
        throw new Error(`${path} cannot contain more than 256 values`);
    return values;
}
function enumeration(value, allowed, path) {
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
    }
    return value;
}
function exactKeys(value, allowed, path) {
    const allowedKeys = new Set(allowed);
    const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
    if (unknown.length > 0)
        throw new Error(`${path} contains unknown keys: ${unknown.join(", ")}`);
    for (const required of allowed) {
        if (!(required in value) && required !== "executable" && required !== "target") {
            throw new Error(`${path}.${required} is required`);
        }
    }
}
function exactShape(value, required, optional, path) {
    const allowed = new Set([...required, ...optional]);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
        throw new Error(`${path} contains unknown keys: ${unknown.join(", ")}`);
    for (const key of required) {
        if (!(key in value))
            throw new Error(`${path}.${key} is required`);
    }
}
function duplicates(values) {
    const seen = new Set();
    const duplicate = new Set();
    for (const value of values) {
        if (seen.has(value))
            duplicate.add(value);
        seen.add(value);
    }
    return [...duplicate];
}
//# sourceMappingURL=config.js.map