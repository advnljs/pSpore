import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "../storage/atomic.js";
import { resolveSessionFile } from "./session-file.js";
export class SessionCatalog {
    #path;
    #sessionsRoot;
    #workspaceId;
    #cwd;
    #clock;
    #records = new Map();
    #tail = Promise.resolve();
    constructor(options, sessionsRoot, cwd) {
        this.#path = options.path;
        this.#sessionsRoot = sessionsRoot;
        this.#workspaceId = options.workspaceId;
        this.#cwd = cwd;
        this.#clock = options.clock ?? (() => new Date());
    }
    static async open(options) {
        const catalog = new SessionCatalog(options, await realpath(options.sessionsRoot), await realpath(options.cwd));
        await catalog.#initialize();
        return catalog;
    }
    list() {
        return [...this.#records.values()]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
            .map((record) => structuredClone(record));
    }
    get(id) {
        const record = this.#records.get(id);
        return record ? structuredClone(record) : undefined;
    }
    async idle() {
        await this.#tail;
    }
    async add(input) {
        const id = sessionId(input.id, "session.id");
        const sessionFile = await this.#sessionFile(input.sessionFile);
        const cwd = await realpath(input.cwd);
        const now = this.#clock().toISOString();
        const suppliedTitle = input.title?.trim();
        const record = {
            id,
            sessionFile,
            cwd,
            title: suppliedTitle ? boundedTitle(suppliedTitle) : defaultTitle(id),
            titleSource: suppliedTitle ? "user" : "default",
            createdAt: now,
            updatedAt: now,
        };
        await this.#mutate((next) => {
            if (next.has(id))
                throw new Error(`Root session already exists: ${id}`);
            next.set(id, record);
        });
        return structuredClone(record);
    }
    /**
     * Forgets a root session and deletes the transcript it owns.
     *
     * The stored path is re-resolved against the sessions root before anything is
     * unlinked, so a catalog entry that points outside the root loses its record
     * without the filesystem being touched. Deleting is the point of the command,
     * so a transcript that is already gone is not an error.
     */
    async remove(id) {
        const existing = this.#records.get(id);
        if (!existing)
            return undefined;
        const record = structuredClone(existing);
        await this.#mutate((records) => {
            records.delete(id);
        });
        let transcriptRemoved = false;
        try {
            const path = await this.#sessionFile(record.sessionFile);
            await rm(path, { force: true });
            transcriptRemoved = true;
        }
        catch {
            // The record is gone either way; an unreachable or out-of-root transcript
            // is left on disk rather than resolved through an unchecked path.
        }
        return { record, transcriptRemoved };
    }
    async touch(id, options = {}) {
        const existing = this.#records.get(id);
        if (!existing)
            return undefined;
        const nextSessionFile = options.sessionFile === undefined ? undefined : await this.#sessionFile(options.sessionFile);
        let updated;
        await this.#mutate((records) => {
            const current = records.get(id);
            if (!current)
                return;
            const promptTitle = current.titleSource === "default" && options.prompt
                ? titleFromPrompt(options.prompt)
                : undefined;
            updated = {
                ...current,
                sessionFile: nextSessionFile ?? current.sessionFile,
                updatedAt: this.#clock().toISOString(),
                ...(promptTitle ? { title: promptTitle, titleSource: "prompt" } : {}),
            };
            records.set(id, updated);
        });
        return updated ? structuredClone(updated) : undefined;
    }
    async #initialize() {
        let value;
        try {
            value = JSON.parse(await readFile(this.#path, "utf8"));
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT")
                throw error;
            const legacy = await this.#discoverLegacy();
            if (legacy)
                this.#records.set(legacy.id, legacy);
            await this.#write(this.#records);
            return;
        }
        const parsed = parseCatalog(value);
        const records = new Map();
        for (const record of parsed.sessions) {
            const sessionFile = await this.#sessionFile(record.sessionFile);
            const cwd = await realpath(record.cwd);
            if (records.has(record.id))
                throw new Error(`Session catalog contains duplicate id: ${record.id}`);
            records.set(record.id, { ...record, sessionFile, cwd });
        }
        this.#records = records;
    }
    async #discoverLegacy() {
        const directory = join(this.#sessionsRoot, this.#workspaceId);
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT")
                return undefined;
            throw error;
        }
        const candidates = await Promise.all(entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map(async (entry) => {
            const path = await this.#sessionFile(join(directory, entry.name));
            return { path, stats: await stat(path) };
        }));
        candidates.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs || left.path.localeCompare(right.path));
        const latest = candidates[0];
        if (!latest)
            return undefined;
        const created = latest.stats.birthtimeMs > 0 ? latest.stats.birthtime : latest.stats.mtime;
        return {
            id: "main",
            sessionFile: latest.path,
            cwd: this.#cwd,
            title: defaultTitle("main"),
            titleSource: "default",
            createdAt: created.toISOString(),
            updatedAt: latest.stats.mtime.toISOString(),
        };
    }
    async #sessionFile(path) {
        return resolveSessionFile(path, { root: this.#sessionsRoot, allowMissing: true });
    }
    #mutate(operation) {
        const task = this.#tail.then(async () => {
            const next = new Map([...this.#records].map(([id, record]) => [id, structuredClone(record)]));
            operation(next);
            await this.#write(next);
            this.#records = next;
        });
        this.#tail = task.catch(() => undefined);
        return task;
    }
    async #write(records) {
        const file = {
            version: 1,
            sessions: [...records.values()]
                .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
        };
        await atomicWriteJson(this.#path, file, 0o600);
    }
}
function parseCatalog(value) {
    const file = object(value, "session catalog");
    exactKeys(file, ["version", "sessions"], "session catalog");
    if (file["version"] !== 1)
        throw new Error("Session catalog version must be 1");
    if (!Array.isArray(file["sessions"]) || file["sessions"].length > 1_000) {
        throw new Error("Session catalog sessions must be an array of at most 1000 entries");
    }
    return {
        version: 1,
        sessions: file["sessions"].map((value, index) => parseRecord(value, `session catalog.sessions[${index}]`)),
    };
}
function parseRecord(value, path) {
    const record = object(value, path);
    exactKeys(record, ["id", "sessionFile", "cwd", "title", "titleSource", "createdAt", "updatedAt"], path);
    const titleSource = record["titleSource"];
    if (titleSource !== "default" && titleSource !== "user" && titleSource !== "prompt") {
        throw new Error(`${path}.titleSource is invalid`);
    }
    return {
        id: sessionId(record["id"], `${path}.id`),
        sessionFile: boundedString(record["sessionFile"], `${path}.sessionFile`, 4_096),
        cwd: boundedString(record["cwd"], `${path}.cwd`, 4_096),
        title: boundedTitle(boundedString(record["title"], `${path}.title`, 120)),
        titleSource,
        createdAt: timestamp(record["createdAt"], `${path}.createdAt`),
        updatedAt: timestamp(record["updatedAt"], `${path}.updatedAt`),
    };
}
function object(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${path} must be an object`);
    return value;
}
function exactKeys(value, expectedKeys, path) {
    const expected = new Set(expectedKeys);
    const actual = Object.keys(value);
    const unknown = actual.filter((key) => !expected.has(key));
    const missing = expectedKeys.filter((key) => !(key in value));
    if (unknown.length > 0)
        throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
    if (missing.length > 0)
        throw new Error(`${path} is missing fields: ${missing.join(", ")}`);
}
function sessionId(value, path) {
    const id = boundedString(value, path, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))
        throw new Error(`${path} contains unsupported characters`);
    return id;
}
function boundedString(value, path, maximum) {
    if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
        throw new Error(`${path} must be a non-empty string of at most ${maximum} characters without controls`);
    }
    return value;
}
function boundedTitle(value) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 120)
        throw new Error("Session title must contain 1-120 characters");
    return normalized;
}
function titleFromPrompt(value) {
    const normalized = value.replace(/\s+/g, " ").trim();
    const chars = [...normalized];
    return boundedTitle(chars.length > 72 ? `${chars.slice(0, 71).join("")}…` : normalized);
}
function defaultTitle(id) {
    return id === "main" ? "Main session" : "New session";
}
function timestamp(value, path) {
    const text = boundedString(value, path, 64);
    const date = new Date(text);
    if (Number.isNaN(date.valueOf()) || date.toISOString() !== text)
        throw new Error(`${path} must be an ISO timestamp`);
    return text;
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=session-catalog.js.map