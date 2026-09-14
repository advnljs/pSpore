import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../storage/atomic.js";
import { inspectResourceDirectory, installSnapshot, resourceInstallPath, resourceKey, resolveStagedResource, validateDigest, validateName, } from "./resource-inspector.js";
import { linkBundledSkills, readBundledSkills, } from "./bundled-skills.js";
import { scanWorkspaceSkills } from "./workspace-skills.js";
export class ExtensionManager {
    #stagingRoot;
    #skillsRoot;
    #pluginsRoot;
    #trustPath;
    #activations;
    #lifecycleTimeoutMs;
    #clock;
    #onHealth;
    #onError;
    #health = new Map();
    #running = new Map();
    #store;
    #tail = Promise.resolve();
    #stopping = false;
    #bundled = [];
    #bundledLinks = [];
    constructor(options, store) {
        this.#stagingRoot = options.stagingRoot;
        this.#skillsRoot = options.skillsRoot;
        this.#pluginsRoot = options.pluginsRoot;
        this.#trustPath = options.trustPath;
        this.#activations = structuredClone(options.activations);
        this.#lifecycleTimeoutMs = positiveInteger(options.lifecycleTimeoutMs ?? 5_000, "lifecycleTimeoutMs");
        this.#clock = options.clock ?? (() => new Date());
        this.#onHealth = options.onHealth;
        this.#onError = options.onError;
        this.#store = store;
    }
    static async create(options) {
        await Promise.all([
            mkdir(options.stagingRoot, { recursive: true, mode: 0o700 }),
            mkdir(options.skillsRoot, { recursive: true, mode: 0o700 }),
            mkdir(options.pluginsRoot, { recursive: true, mode: 0o700 }),
            mkdir(dirname(options.trustPath), { recursive: true, mode: 0o700 }),
        ]);
        const store = await loadTrustStore(options.trustPath);
        const manager = new ExtensionManager(options, store);
        await manager.#verifyInstalled();
        await manager.#linkBundledSkills(options.bundledSkillsRoot);
        return manager;
    }
    /**
     * Materializes the release's skills into the workspace. Failures are reported
     * but never block startup: a missing bundled skill degrades the agent's
     * abilities, it does not make the daemon unusable.
     */
    async #linkBundledSkills(root) {
        if (!root)
            return;
        try {
            this.#bundled = await readBundledSkills(root);
            this.#bundledLinks = await linkBundledSkills(this.#bundled, this.#skillsRoot);
            for (const link of this.#bundledLinks) {
                if (!isLinked(link)) {
                    this.#onError?.(new Error(`Bundled skill ${link.name}: ${link.message ?? link.action}`));
                }
            }
        }
        catch (error) {
            this.#onError?.(toError(error));
        }
    }
    /** Bundled skills shipped by this release, with how each was reconciled. */
    listBundledSkills() {
        return this.#bundledLinks.map((link) => structuredClone(link));
    }
    async inspect(stagingPath) {
        const directory = await resolveStagedResource(this.#stagingRoot, stagingPath);
        const snapshot = await inspectResourceDirectory(directory);
        return structuredClone(snapshot.inspection);
    }
    async install(stagingPath, expectedDigest) {
        validateDigest(expectedDigest, "expectedDigest");
        return this.#serialize(async () => {
            this.#assertRunning();
            const directory = await resolveStagedResource(this.#stagingRoot, stagingPath);
            const snapshot = await inspectResourceDirectory(directory);
            if (snapshot.inspection.digest !== expectedDigest) {
                throw new Error(`Staged resource changed: expected ${expectedDigest}, current ${snapshot.inspection.digest}`);
            }
            if (!snapshot.inspection.installable) {
                throw new Error(`Staged resource is not installable: ${snapshot.inspection.diagnostics.join("; ")}`);
            }
            const destination = resourceInstallPath(snapshot.inspection.kind, snapshot.inspection.name, snapshot.inspection.digest, this.#skillsRoot, this.#pluginsRoot);
            await installSnapshot(snapshot, destination);
            const record = {
                version: 1,
                kind: snapshot.inspection.kind,
                name: snapshot.inspection.name,
                resourceVersion: snapshot.inspection.resourceVersion,
                ...(snapshot.inspection.description === undefined ? {} : { description: snapshot.inspection.description }),
                digest: snapshot.inspection.digest,
                entry: snapshot.inspection.entry,
                capabilities: [...snapshot.inspection.capabilities],
                contributes: [...snapshot.inspection.contributes],
                trusted: true,
                installedAt: this.#clock().toISOString(),
            };
            const resources = this.#store.resources.filter((candidate) => candidate.kind !== record.kind || candidate.name !== record.name);
            this.#store = { version: 1, resources: [...resources, record].sort(compareRecords) };
            await atomicWriteJson(this.#trustPath, this.#store, 0o600);
            const health = this.#setHealth(record, {
                status: record.kind === "skill" ? "active" : "installed",
                restartRequired: record.kind === "host-plugin",
                message: record.kind === "host-plugin"
                    ? "Trusted and installed; add an exact config.plugins activation and restart the daemon"
                    : "Trusted skill will be visible from the next session boundary",
            });
            return { record: structuredClone(record), health, installPath: destination };
        });
    }
    async disable(kind, name, expectedDigest) {
        validateName(name, "resource name");
        validateDigest(expectedDigest, "expectedDigest");
        if (kind !== "skill" && kind !== "host-plugin")
            throw new Error(`Unknown resource kind: ${String(kind)}`);
        return this.#serialize(async () => {
            this.#assertRunning();
            const index = this.#store.resources.findIndex((record) => record.kind === kind && record.name === name);
            const current = this.#store.resources[index];
            if (!current)
                throw new Error(`Trusted resource does not exist: ${resourceKey(kind, name)}`);
            if (current.digest !== expectedDigest) {
                throw new Error(`Resource digest conflict: expected ${expectedDigest}, current ${current.digest}`);
            }
            const record = { ...current, trusted: false };
            const resources = [...this.#store.resources];
            resources[index] = record;
            this.#store = { version: 1, resources };
            await atomicWriteJson(this.#trustPath, this.#store, 0o600);
            const running = this.#running.has(name);
            const health = this.#setHealth(record, {
                status: running ? "ready" : "disabled",
                restartRequired: kind === "host-plugin" && running,
                message: running
                    ? "Trust revoked; the already loaded host plugin stops at daemon restart"
                    : "Trust revoked; existing sessions keep their immutable resource catalog",
            });
            return {
                record: structuredClone(record),
                health,
                installPath: this.#installPath(record),
            };
        });
    }
    list() {
        const entries = this.#store.resources.map((record) => ({
            record: structuredClone(record),
            health: structuredClone(this.#health.get(resourceKey(record.kind, record.name)) ?? this.#defaultHealth(record)),
            installPath: this.#installPath(record),
        }));
        for (const activation of this.#activations) {
            if (entries.some((entry) => entry.record.kind === "host-plugin" && entry.record.name === activation.name))
                continue;
            const record = syntheticRecord(activation, this.#clock().toISOString());
            entries.push({
                record,
                health: structuredClone(this.#health.get(resourceKey(record.kind, record.name)) ?? this.#defaultHealth(record)),
                installPath: this.#installPath(record),
            });
        }
        return entries.sort((left, right) => compareRecords(left.record, right.record));
    }
    listHealth() {
        return [...this.#health.values()]
            .sort((left, right) => left.key.localeCompare(right.key))
            .map((health) => structuredClone(health));
    }
    async skillPaths() {
        const paths = [];
        for (const record of this.#store.resources.filter((candidate) => candidate.kind === "skill" && candidate.trusted)) {
            const verified = await this.#verifyRecord(record);
            if (verified) {
                paths.push(this.#installPath(record));
                this.#setHealth(record, {
                    status: "active",
                    restartRequired: false,
                    message: "Included in new sessions through Pi progressive disclosure",
                });
            }
        }
        // Bundled skills are surfaced from their workspace link, so Pi sees exactly
        // the directory the user can inspect.
        for (const link of this.#bundledLinks) {
            if (isLinked(link))
                paths.push(link.targetPath);
        }
        return paths.sort();
    }
    /**
     * Skills the user put under `workspace/skills/` without the staged install
     * flow. Re-read on every call, so one added while the daemon runs reaches the
     * next session instead of waiting for a restart.
     */
    async sessionSkills() {
        return (await this.#scanWorkspaceSkills()).skills;
    }
    /**
     * Every skill a new session would be offered, from all three sources, plus
     * the ones found but not offered and why — the answer to "why can't the
     * agent see my skill" without reading daemon logs.
     */
    async skillCatalog() {
        const entries = [];
        for (const record of this.#store.resources.filter((candidate) => candidate.kind === "skill")) {
            const health = this.#health.get(resourceKey(record.kind, record.name)) ?? this.#defaultHealth(record);
            const active = record.trusted && health.status === "active";
            entries.push({
                name: record.name,
                source: "installed",
                status: active ? "active" : "skipped",
                path: join(this.#installPath(record), record.entry),
                ...(record.description === undefined ? {} : { description: record.description }),
                ...(active ? {} : { message: health.message ?? (record.trusted ? `trusted resource is ${health.status}` : "trust is revoked") }),
            });
        }
        const bundledByName = new Map(this.#bundled.map((skill) => [skill.name, skill]));
        for (const link of this.#bundledLinks) {
            const description = bundledByName.get(link.name)?.description;
            entries.push({
                name: link.name,
                source: "bundled",
                status: isLinked(link) ? "active" : "skipped",
                path: join(link.targetPath, "SKILL.md"),
                ...(description === undefined ? {} : { description }),
                ...(isLinked(link)
                    ? {}
                    : {
                        message: link.action === "kept-user-copy"
                            ? `${link.targetPath} is your own directory, so it is read as a workspace skill instead`
                            : link.message ?? "could not be linked into the workspace",
                    }),
            });
        }
        entries.push(...(await this.#scanWorkspaceSkills()).catalog);
        const order = { installed: 0, bundled: 1, workspace: 2 };
        return entries.sort((left, right) => order[left.source] - order[right.source] || left.name.localeCompare(right.name));
    }
    async #scanWorkspaceSkills() {
        const reserved = new Map();
        for (const record of this.#store.resources) {
            if (record.kind !== "skill" || !record.trusted)
                continue;
            // Only a skill sessions actually get can take a name away from the user's.
            if (this.#health.get(resourceKey(record.kind, record.name))?.status === "active")
                reserved.set(record.name, "installed");
        }
        const managed = new Set();
        for (const link of this.#bundledLinks) {
            // A user's own directory under a bundled name is theirs to load; every
            // other outcome leaves pSpore's link (or its failed attempt) in that slot.
            if (link.action === "kept-user-copy")
                continue;
            managed.add(link.name);
            if (isLinked(link) && !reserved.has(link.name))
                reserved.set(link.name, "bundled");
        }
        try {
            return await scanWorkspaceSkills(this.#skillsRoot, { managedNames: managed, reservedNames: reserved });
        }
        catch (error) {
            // A workspace that cannot be read costs the user's own skills, not the session.
            this.#error(new Error(`Workspace skills could not be read: ${bounded(toError(error).message, 1_000)}`));
            return { skills: [], catalog: [] };
        }
    }
    async startHostPlugins() {
        this.#assertRunning();
        const configuredNames = new Set(this.#activations.map((activation) => activation.name));
        for (const record of this.#store.resources.filter((candidate) => candidate.kind === "host-plugin" && candidate.trusted)) {
            if (!configuredNames.has(record.name)) {
                this.#setHealth(record, {
                    status: "installed",
                    restartRequired: true,
                    message: "Trusted but not activated in config.plugins",
                });
            }
        }
        for (const activation of [...this.#activations].sort((left, right) => left.name.localeCompare(right.name))) {
            await this.#startActivation(activation);
        }
    }
    async stop(reason = "daemon shutdown") {
        if (this.#stopping)
            return;
        this.#stopping = true;
        await this.#tail.catch(() => undefined);
        const running = [...this.#running.values()].reverse();
        this.#running.clear();
        await Promise.allSettled(running.map(async (item) => {
            item.controller.abort(new Error(reason));
            let message;
            try {
                await withTimeout(Promise.resolve(item.plugin.stop(reason)), this.#lifecycleTimeoutMs, `Plugin ${item.record.name} stop`);
            }
            catch (error) {
                message = bounded(toError(error).message, 1_000);
                this.#error(new Error(`Host plugin ${item.record.name} stop failed: ${message}`));
            }
            this.#setHealth(item.record, {
                status: "stopped",
                restartRequired: false,
                ...(message === undefined ? {} : { message }),
            });
        }));
    }
    async #startActivation(activation) {
        const record = this.#store.resources.find((candidate) => candidate.kind === "host-plugin" && candidate.name === activation.name && candidate.digest === activation.digest);
        const synthetic = record ?? syntheticRecord(activation, this.#clock().toISOString());
        if (!activation.enabled) {
            this.#setHealth(synthetic, { status: "disabled", restartRequired: false, message: "Disabled by config.plugins" });
            return;
        }
        if (!record?.trusted) {
            this.#blocked(synthetic, "Configured host plugin is not installed and trusted at the exact digest");
            return;
        }
        if (!(await this.#verifyRecord(record)))
            return;
        const declared = new Set(record.capabilities);
        const granted = new Set(activation.grantedCapabilities);
        const missing = record.capabilities.filter((capability) => !granted.has(capability));
        const extra = activation.grantedCapabilities.filter((capability) => !declared.has(capability));
        if (missing.length > 0 || extra.length > 0) {
            this.#blocked(record, `Capability grant must exactly match the trusted manifest (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
            return;
        }
        this.#setHealth(record, { status: "starting", restartRequired: false });
        const controller = new AbortController();
        let plugin;
        try {
            plugin = await this.#loadPlugin(record);
            const context = Object.freeze({
                apiVersion: 1,
                name: record.name,
                version: record.resourceVersion,
                digest: record.digest,
                capabilities: Object.freeze([...record.capabilities]),
                contributes: Object.freeze([...record.contributes]),
                signal: controller.signal,
                report: (message) => {
                    if (typeof message !== "string")
                        return;
                    const current = this.#health.get(resourceKey(record.kind, record.name));
                    this.#setHealth(record, {
                        status: current?.status === "degraded" ? "degraded" : "ready",
                        restartRequired: false,
                        message: bounded(message, 1_000),
                    });
                },
            });
            await withTimeout(Promise.resolve(plugin.start(context, controller.signal)), this.#lifecycleTimeoutMs, `Plugin ${record.name} start`);
            let reported = { status: "ready" };
            if (plugin.health) {
                reported = await withTimeout(Promise.resolve(plugin.health()), this.#lifecycleTimeoutMs, `Plugin ${record.name} health`);
                validatePluginHealth(reported, record.name);
            }
            this.#running.set(record.name, { record, plugin, controller });
            this.#setHealth(record, {
                status: reported.status,
                restartRequired: false,
                ...(reported.message === undefined ? {} : { message: bounded(reported.message, 1_000) }),
            });
        }
        catch (error) {
            controller.abort(error);
            const message = bounded(toError(error).message, 1_000);
            if (plugin) {
                await withTimeout(Promise.resolve(plugin.stop("startup failed")), this.#lifecycleTimeoutMs, `Plugin ${record.name} failed-start cleanup`).catch((cleanupError) => this.#error(new Error(`Host plugin ${record.name} failed-start cleanup failed: ${bounded(toError(cleanupError).message, 1_000)}`)));
            }
            this.#setHealth(record, { status: "degraded", restartRequired: false, message });
            this.#error(new Error(`Host plugin ${record.name} failed: ${message}`));
        }
    }
    async #loadPlugin(record) {
        const entry = join(this.#installPath(record), record.entry);
        const loaded = await import(`${pathToFileURL(entry).href}?sha256=${record.digest}`);
        const exported = loaded["createPlugin"] ?? loaded["default"];
        const candidate = typeof exported === "function" ? await exported() : exported;
        if (!isRecord(candidate) || typeof candidate["start"] !== "function" || typeof candidate["stop"] !== "function") {
            throw new Error("Host plugin must export default/createPlugin with start() and stop() methods");
        }
        return candidate;
    }
    async #verifyInstalled() {
        for (const record of this.#store.resources) {
            if (!record.trusted) {
                this.#setHealth(record, { status: "disabled", restartRequired: false, message: "Trust is revoked" });
                continue;
            }
            const verified = await this.#verifyRecord(record);
            if (!verified)
                continue;
            this.#setHealth(record, {
                status: record.kind === "skill" ? "active" : "installed",
                restartRequired: record.kind === "host-plugin",
            });
        }
    }
    async #verifyRecord(record) {
        try {
            const snapshot = await inspectResourceDirectory(this.#installPath(record));
            const actual = snapshot.inspection;
            if (actual.kind !== record.kind ||
                actual.name !== record.name ||
                actual.resourceVersion !== record.resourceVersion ||
                actual.digest !== record.digest ||
                actual.entry !== record.entry ||
                !sameStrings(actual.capabilities, record.capabilities) ||
                !sameStrings(actual.contributes, record.contributes)) {
                throw new Error("installed content or manifest no longer matches its trusted digest record");
            }
            return true;
        }
        catch (error) {
            this.#blocked(record, bounded(toError(error).message, 1_000));
            return false;
        }
    }
    #blocked(record, message) {
        this.#setHealth(record, { status: "blocked", restartRequired: false, message });
        this.#error(new Error(`Resource ${resourceKey(record.kind, record.name)} blocked: ${message}`));
    }
    #setHealth(record, update) {
        const key = resourceKey(record.kind, record.name);
        const previous = this.#health.get(key);
        if (previous &&
            previous.resourceVersion === record.resourceVersion &&
            previous.digest === record.digest &&
            previous.status === update.status &&
            previous.restartRequired === update.restartRequired &&
            previous.message === update.message) {
            return structuredClone(previous);
        }
        const health = {
            version: 1,
            key,
            kind: record.kind,
            name: record.name,
            resourceVersion: record.resourceVersion,
            digest: record.digest,
            status: update.status,
            updatedAt: this.#clock().toISOString(),
            restartRequired: update.restartRequired,
            ...(update.message === undefined ? {} : { message: update.message }),
        };
        this.#health.set(health.key, health);
        try {
            this.#onHealth?.(structuredClone(health));
        }
        catch {
            // Observers do not own resource lifecycle.
        }
        return structuredClone(health);
    }
    #defaultHealth(record) {
        return {
            version: 1,
            key: resourceKey(record.kind, record.name),
            kind: record.kind,
            name: record.name,
            resourceVersion: record.resourceVersion,
            digest: record.digest,
            status: record.trusted ? "installed" : "disabled",
            updatedAt: record.installedAt,
            restartRequired: record.kind === "host-plugin" && record.trusted,
        };
    }
    #installPath(record) {
        return resourceInstallPath(record.kind, record.name, record.digest, this.#skillsRoot, this.#pluginsRoot);
    }
    #serialize(operation) {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(() => undefined, () => undefined);
        return result;
    }
    #assertRunning() {
        if (this.#stopping)
            throw new Error("Extension manager is stopping");
    }
    #error(error) {
        try {
            this.#onError?.(error);
        }
        catch {
            // Error observers cannot break extension isolation.
        }
    }
}
export async function readResourceTrustSummary(trustPath) {
    try {
        const store = await loadTrustStore(trustPath, false);
        return {
            trusted: store.resources.filter((record) => record.trusted).length,
            disabled: store.resources.filter((record) => !record.trusted).length,
            skills: store.resources.filter((record) => record.kind === "skill").length,
            hostPlugins: store.resources.filter((record) => record.kind === "host-plugin").length,
        };
    }
    catch (error) {
        if (isMissing(error))
            return { trusted: 0, disabled: 0, skills: 0, hostPlugins: 0 };
        throw error;
    }
}
async function loadTrustStore(path, create = true) {
    let value;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    }
    catch (error) {
        if (!isMissing(error))
            throw error;
        if (!create)
            throw error;
        const empty = { version: 1, resources: [] };
        await atomicWriteJson(path, empty, 0o600);
        return empty;
    }
    const root = record(value, "resource trust store");
    exactKeys(root, ["version", "resources"], "resource trust store");
    if (root["version"] !== 1)
        throw new Error("resource trust store version must be 1");
    if (!Array.isArray(root["resources"]) || root["resources"].length > 512) {
        throw new Error("resource trust store resources must contain at most 512 records");
    }
    const resources = root["resources"].map((item, index) => parseTrustedRecord(item, index));
    const keys = resources.map((item) => resourceKey(item.kind, item.name));
    if (new Set(keys).size !== keys.length)
        throw new Error("resource trust store contains duplicate kind/name records");
    return { version: 1, resources: resources.sort(compareRecords) };
}
function parseTrustedRecord(value, index) {
    const path = `resource trust store.resources[${index}]`;
    const item = record(value, path);
    exactShape(item, ["version", "kind", "name", "resourceVersion", "digest", "entry", "capabilities", "contributes", "trusted", "installedAt"], ["description"], path);
    if (item["version"] !== 1)
        throw new Error(`${path}.version must be 1`);
    const kind = enumeration(item["kind"], ["skill", "host-plugin"], `${path}.kind`);
    const name = string(item["name"], `${path}.name`);
    validateName(name, `${path}.name`);
    const digest = string(item["digest"], `${path}.digest`);
    validateDigest(digest, `${path}.digest`);
    const capabilities = stringArray(item["capabilities"], `${path}.capabilities`);
    const contributes = stringArray(item["contributes"], `${path}.contributes`).map((contribution, contributionIndex) => enumeration(contribution, ["trigger", "tool", "retrieval", "executor", "transport"], `${path}.contributes[${contributionIndex}]`));
    const description = item["description"];
    return {
        version: 1,
        kind,
        name,
        resourceVersion: string(item["resourceVersion"], `${path}.resourceVersion`),
        ...(description === undefined ? {} : { description: string(description, `${path}.description`) }),
        digest,
        entry: string(item["entry"], `${path}.entry`),
        capabilities,
        contributes,
        trusted: boolean(item["trusted"], `${path}.trusted`),
        installedAt: isoTimestamp(item["installedAt"], `${path}.installedAt`),
    };
}
function syntheticRecord(config, installedAt) {
    return {
        version: 1,
        kind: "host-plugin",
        name: config.name,
        resourceVersion: "unknown",
        digest: config.digest,
        entry: "unknown",
        capabilities: [],
        contributes: [],
        trusted: false,
        installedAt,
    };
}
function validatePluginHealth(value, name) {
    if (!isRecord(value) || (value["status"] !== "ready" && value["status"] !== "degraded")) {
        throw new Error(`Host plugin ${name} returned invalid health`);
    }
    if (value["message"] !== undefined && typeof value["message"] !== "string") {
        throw new Error(`Host plugin ${name} health message must be a string`);
    }
}
function compareRecords(left, right) {
    return left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name);
}
/** Whether a bundled skill ended up in the workspace as pSpore's own link or copy. */
function isLinked(link) {
    return link.action !== "failed" && link.action !== "kept-user-copy";
}
function sameStrings(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
async function withTimeout(task, timeoutMs, label) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
    });
    try {
        return await Promise.race([task, timeout]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function exactKeys(value, keys, path) {
    exactShape(value, keys, [], path);
}
function exactShape(value, required, optional, path) {
    const allowed = new Set([...required, ...optional]);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
        throw new Error(`${path} contains unknown keys: ${unknown.join(", ")}`);
    for (const key of required)
        if (!(key in value))
            throw new Error(`${path}.${key} is required`);
}
function record(value, path) {
    if (!isRecord(value))
        throw new Error(`${path} must be an object`);
    return value;
}
function string(value, path) {
    if (typeof value !== "string" || !value.trim() || value.length > 4_096)
        throw new Error(`${path} must be a non-empty bounded string`);
    return value;
}
function stringArray(value, path) {
    if (!Array.isArray(value) || value.length > 64)
        throw new Error(`${path} must contain at most 64 strings`);
    const result = value.map((item, index) => string(item, `${path}[${index}]`));
    if (new Set(result).size !== result.length)
        throw new Error(`${path} must not contain duplicates`);
    return result;
}
function boolean(value, path) {
    if (typeof value !== "boolean")
        throw new Error(`${path} must be a boolean`);
    return value;
}
function enumeration(value, allowed, path) {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
    return value;
}
function isoTimestamp(value, path) {
    const text = string(value, path);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text) || !Number.isFinite(Date.parse(text))) {
        throw new Error(`${path} must be an ISO UTC timestamp`);
    }
    return text;
}
function positiveInteger(value, path) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${path} must be a positive safe integer`);
    return value;
}
function bounded(value, maximum) {
    return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=extension-manager.js.map