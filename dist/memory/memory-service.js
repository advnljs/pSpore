import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../storage/atomic.js";
export class MemoryService {
    #workspaceRoot;
    #clock;
    #idFactory;
    #timeZone;
    #tail = Promise.resolve();
    constructor(options) {
        this.#workspaceRoot = options.workspaceRoot;
        this.#clock = options.clock ?? (() => new Date());
        this.#idFactory = options.idFactory ?? randomUUID;
        this.#timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    append(fact, source) {
        return this.#serialize(async () => {
            const normalized = validateFact(fact);
            validateSourceId(source.sessionId, "sessionId");
            if (source.runId !== undefined)
                validateSourceId(source.runId, "runId");
            const now = this.#clock();
            const parts = dateParts(now, this.#timeZone);
            const directory = join(this.#workspaceRoot, "memory", parts.year, parts.month);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await chmod(directory, 0o700);
            const path = join(directory, `${parts.day}.md`);
            const id = this.#idFactory();
            const sourceText = `session:${source.sessionId}${source.runId ? ` run:${source.runId}` : ""}`;
            const line = `- ${now.toISOString()} [${sourceText}] ${normalized} <!-- pSpore-memory:${id} -->\n`;
            const file = await open(path, "a", 0o600);
            try {
                await file.writeFile(line, "utf8");
                await file.sync();
            }
            finally {
                await file.close();
            }
            return { path, id, sha256: createHash("sha256").update(line).digest("hex") };
        });
    }
    curate(expectedSha256, entries) {
        return this.#serialize(async () => {
            if (entries.length === 0 || entries.length > 50)
                throw new Error("memory_curate requires 1 to 50 entries");
            const path = join(this.#workspaceRoot, "MEMORY.md");
            const current = await readFile(path, "utf8");
            const previousSha256 = createHash("sha256").update(current).digest("hex");
            if (expectedSha256 !== previousSha256) {
                throw new Error(`Memory conflict: expected ${expectedSha256}, current ${previousSha256}. Read MEMORY.md again.`);
            }
            const existingMarkers = new Set([...current.matchAll(/pSpore-memory-entry:([a-f0-9]{64})/g)].map((match) => match[1]));
            const existingFacts = new Set(current
                .split("\n")
                .filter((line) => /^\s*-\s+/.test(line))
                .map((line) => normalizeFactForDedup(line.replace(/^\s*-\s+/, "").replace(/_\(sources:.*$/, ""))));
            const additions = [];
            const pending = new Set();
            for (const entry of entries) {
                const fact = validateFact(entry.fact);
                if (entry.sources.length === 0 || entry.sources.length > 20) {
                    throw new Error("Every curated memory entry requires 1 to 20 source references");
                }
                const sources = [...new Set(entry.sources.map((source) => validateSourceReference(source)))].sort();
                const normalizedFact = normalizeFactForDedup(fact);
                const marker = createHash("sha256").update(normalizedFact).digest("hex");
                if (existingMarkers.has(marker) || existingFacts.has(normalizedFact) || pending.has(marker)) {
                    throw new Error(`Duplicate curated memory fact: ${fact}`);
                }
                pending.add(marker);
                additions.push(`- ${fact} _(sources: ${sources.map((source) => `\`${source}\``).join(", ")})_\n  <!-- pSpore-memory-entry:${marker} -->`);
            }
            const heading = /^## Entries\s*$/m.test(current) ? "" : "\n\n## Entries";
            const content = `${current.trimEnd()}${heading}\n\n${additions.join("\n")}\n`;
            await atomicWriteFile(path, content, 0o600);
            return {
                path,
                previousSha256,
                sha256: createHash("sha256").update(content).digest("hex"),
                added: additions.length,
            };
        });
    }
    #serialize(operation) {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
function validateFact(value) {
    const fact = value.replace(/\s+/g, " ").trim();
    if (!fact || fact.length > 2_000)
        throw new Error("Memory fact must contain 1 to 2000 characters");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(fact))
        throw new Error("Private key material cannot be stored in memory");
    if (/(?:api[_-]?key|token|password|secret)\s*[:=]\s*[A-Za-z0-9_\-/.+]{16,}/i.test(fact)) {
        throw new Error("Credential-like values cannot be stored in memory");
    }
    if (/[A-Za-z0-9+/]{256,}={0,2}/.test(fact))
        throw new Error("Large base64-like payloads cannot be stored in memory");
    return fact;
}
function normalizeFactForDedup(value) {
    return value.normalize("NFKC").toLocaleLowerCase("und").replace(/[\s。.!！?？]+$/g, "").replace(/\s+/g, " ").trim();
}
function validateSourceReference(value) {
    const source = value.trim();
    if (!/^(?:session|run|file):[A-Za-z0-9._/:@-]{1,240}$/.test(source)) {
        throw new Error(`Invalid memory source reference: ${value}`);
    }
    return source;
}
function validateSourceId(value, path) {
    if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(value))
        throw new Error(`${path} is invalid`);
}
function dateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    const year = get("year");
    const month = get("month");
    const day = get("day");
    if (!year || !month || !day)
        throw new Error(`Could not format memory date in timezone ${timeZone}`);
    return { year, month, day };
}
//# sourceMappingURL=memory-service.js.map