import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { atomicWriteFile, atomicWriteJson } from "../storage/atomic.js";
import { articleChangeCounts, diffArticleBlocks } from "./diff.js";
import { applyArticleEdits } from "./edits.js";
/** `art_` plus 12 hex characters. Short enough to say, long enough not to guess. */
export const ARTICLE_ID_PATTERN = /^art_[a-f0-9]{12}$/;
/** A long article, not a book. Past this the tool asks for a tighter draft. */
export const MAX_ARTICLE_CHARS = 400_000;
/** Versions kept for one article. Each one is a full snapshot so any of them can be reopened. */
export const MAX_ARTICLE_VERSIONS = 100;
const NUL = /\u0000/g;
export class ArticleStore {
    #root;
    #clock;
    #idFactory;
    constructor(root, clock = () => new Date(), idFactory) {
        this.#root = root;
        this.#clock = clock;
        this.#idFactory = idFactory ?? (() => `art_${randomBytes(6).toString("hex")}`);
    }
    get root() {
        return this.#root;
    }
    async ready() {
        await mkdir(this.#root, { recursive: true, mode: 0o700 });
    }
    async create(input) {
        const title = cleanTitle(input.title);
        const content = cleanContent(input.content);
        await this.ready();
        const id = await this.#freshId();
        const now = this.#clock().toISOString();
        const version = versionInfo(1, content, now);
        const record = {
            id,
            title,
            sessionId: input.sessionId,
            createdAt: now,
            updatedAt: now,
            versions: [version],
        };
        const path = await this.#writeVersion(record, content);
        return commitOf(record, content, path, { added: diffArticleBlocks("", content).filter((block) => block.kind === "add").length, removed: 0, unchanged: false });
    }
    async update(input) {
        const current = await this.#load(input.id);
        if (!current || current.record.sessionId !== input.sessionId) {
            throw new Error(`No article ${input.id} in this session. Create one, or read the id from the previous article result.`);
        }
        const base = input.content === undefined ? current.content : cleanContent(input.content);
        const next = input.edits && input.edits.length > 0 ? applyArticleEdits(base, input.edits) : base;
        const content = cleanContent(next);
        const title = input.title === undefined ? current.record.title : cleanTitle(input.title);
        if (content === current.content && title === current.record.title) {
            return commitOf(current.record, content, await this.#contained(input.id, "current.md"), { added: 0, removed: 0, unchanged: true });
        }
        if (current.record.versions.length >= MAX_ARTICLE_VERSIONS) {
            throw new Error(`Article ${input.id} already has ${MAX_ARTICLE_VERSIONS} versions. Create a new article for the next draft.`);
        }
        const counts = articleChangeCounts(diffArticleBlocks(current.content, content));
        const now = this.#clock().toISOString();
        const version = versionInfo(current.record.versions.length + 1, content, now);
        const record = {
            ...current.record,
            title,
            updatedAt: now,
            versions: [...current.record.versions, version],
        };
        const path = await this.#writeVersion(record, content);
        return commitOf(record, content, path, { ...counts, unchanged: false });
    }
    async read(input) {
        const loaded = await this.#load(input.id, input.version);
        if (!loaded || loaded.record.sessionId !== input.sessionId)
            return undefined;
        const offset = Math.min(Math.max(0, input.offset ?? 0), loaded.content.length);
        const limit = Math.max(0, input.limit);
        return {
            id: loaded.record.id,
            title: loaded.record.title,
            sessionId: loaded.record.sessionId,
            version: loaded.version,
            versions: loaded.record.versions,
            offset,
            length: loaded.content.length,
            text: loaded.content.slice(offset, offset + limit),
        };
    }
    /** Absolute path of one immutable version file, after it has been checked to stay inside the store. */
    async versionPath(id, version) {
        const file = await this.#versionFile(id, version);
        await readFile(file);
        return file;
    }
    async readVersion(id, version) {
        const loaded = await this.#load(id, version);
        if (!loaded)
            return undefined;
        return { title: loaded.record.title, version: loaded.version, content: loaded.content };
    }
    async list(sessionId) {
        let names;
        try {
            names = await readdir(this.#root);
        }
        catch (error) {
            if (isMissing(error))
                return [];
            throw error;
        }
        const summaries = [];
        for (const name of names) {
            if (!ARTICLE_ID_PATTERN.test(name))
                continue;
            const loaded = await this.#load(name);
            if (!loaded || loaded.record.sessionId !== sessionId)
                continue;
            const latest = loaded.record.versions.at(-1);
            if (!latest)
                continue;
            summaries.push({
                id: loaded.record.id,
                title: loaded.record.title,
                sessionId: loaded.record.sessionId,
                version: latest.version,
                chars: latest.chars,
                updatedAt: loaded.record.updatedAt,
            });
        }
        summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
        return summaries.slice(0, 40);
    }
    async #freshId() {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const id = this.#idFactory();
            if (!ARTICLE_ID_PATTERN.test(id))
                throw new Error("Article id factory produced an invalid id");
            try {
                await lstat(join(this.#root, id));
            }
            catch (error) {
                if (isMissing(error))
                    return id;
                throw error;
            }
        }
        throw new Error("Could not allocate an article id");
    }
    async #writeVersion(record, content) {
        const directory = await this.#directory(record.id, true);
        const latest = record.versions.at(-1);
        if (!latest)
            throw new Error("Article record has no version");
        const file = join(directory, versionName(latest.version));
        const current = join(directory, "current.md");
        await atomicWriteFile(file, content, 0o600);
        await atomicWriteFile(current, content, 0o600);
        await atomicWriteJson(join(directory, "meta.json"), record, 0o600);
        return current;
    }
    async #load(id, version) {
        if (!ARTICLE_ID_PATTERN.test(id))
            return undefined;
        let metaRaw;
        try {
            metaRaw = await readFile(await this.#contained(id, "meta.json"), "utf8");
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            throw error;
        }
        const record = parseRecord(metaRaw, id);
        if (!record)
            return undefined;
        const chosen = version ?? record.versions.at(-1)?.version;
        if (chosen === undefined || !record.versions.some((entry) => entry.version === chosen))
            return undefined;
        try {
            const content = await readFile(await this.#versionFile(id, chosen), "utf8");
            return { record, content, version: chosen };
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            throw error;
        }
    }
    async #versionFile(id, version) {
        if (!Number.isInteger(version) || version < 1 || version > MAX_ARTICLE_VERSIONS) {
            throw new Error("Article version is out of range");
        }
        return this.#contained(id, versionName(version));
    }
    async #directory(id, create) {
        if (!ARTICLE_ID_PATTERN.test(id))
            throw new Error("Article id is invalid");
        const root = await realpath(this.#root);
        const directory = join(root, id);
        if (create)
            await mkdir(directory, { recursive: true, mode: 0o700 });
        const resolved = await realpath(directory);
        if (!isInside(root, resolved))
            throw new Error("Article directory escaped the store");
        return resolved;
    }
    async #contained(id, name) {
        if (name.includes("/") || name.includes("\\") || name.includes("\0"))
            throw new Error("Article file name is invalid");
        const directory = await this.#directory(id, false);
        const file = join(directory, name);
        const resolved = await realpath(file);
        if (!isInside(directory, resolved))
            throw new Error("Article file escaped the store");
        return resolved;
    }
}
function commitOf(record, content, path, change) {
    const latest = record.versions.at(-1);
    return {
        id: record.id,
        title: record.title,
        version: latest?.version ?? 1,
        chars: content.length,
        added: change.added,
        removed: change.removed,
        unchanged: change.unchanged,
        path,
    };
}
function versionInfo(version, content, createdAt) {
    return {
        version,
        createdAt,
        chars: content.length,
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    };
}
function versionName(version) {
    return `v${String(version).padStart(4, "0")}.md`;
}
export function cleanTitle(title) {
    const cleaned = title.replace(NUL, "\uFFFD").replace(/\s+/g, " ").trim();
    if (!cleaned)
        throw new Error("Article title is empty");
    if (cleaned.length > 120)
        throw new Error("Article title is longer than 120 characters");
    return cleaned;
}
function cleanContent(content) {
    const cleaned = content.replace(NUL, "\uFFFD");
    if (cleaned.trim() === "")
        throw new Error("Article content is empty");
    if (cleaned.length > MAX_ARTICLE_CHARS) {
        throw new Error(`Article is longer than ${MAX_ARTICLE_CHARS} characters. Split it or cut it down.`);
    }
    return cleaned;
}
function parseRecord(raw, id) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value) || value["id"] !== id || typeof value["title"] !== "string" || typeof value["sessionId"] !== "string") {
        return undefined;
    }
    if (typeof value["createdAt"] !== "string" || typeof value["updatedAt"] !== "string" || !Array.isArray(value["versions"])) {
        return undefined;
    }
    const versions = [];
    for (const entry of value["versions"]) {
        if (!isRecord(entry) || !Number.isInteger(entry["version"]) || typeof entry["createdAt"] !== "string")
            return undefined;
        if (!Number.isInteger(entry["chars"]) || typeof entry["sha256"] !== "string")
            return undefined;
        versions.push({
            version: entry["version"],
            createdAt: entry["createdAt"],
            chars: entry["chars"],
            sha256: entry["sha256"],
        });
    }
    if (versions.length === 0)
        return undefined;
    return {
        id,
        title: value["title"],
        sessionId: value["sessionId"],
        createdAt: value["createdAt"],
        updatedAt: value["updatedAt"],
        versions,
    };
}
function isInside(parent, child) {
    return child === parent || child.startsWith(`${parent}${sep}`);
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=store.js.map