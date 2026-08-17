import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonLine } from "../storage/atomic.js";
import { readJsonLinesRecovering } from "../storage/jsonl.js";
const TERMINAL = new Set([
    "succeeded",
    "failed",
    "blocked",
    "cancelled",
    "budget_exhausted",
    "unknown",
    "skipped",
]);
export class RunLedger {
    #root;
    #recoveryDirectory;
    #clock;
    #idFactory;
    #runs = new Map();
    #slots = new Map();
    #tail = Promise.resolve();
    constructor(options) {
        this.#root = options.root;
        this.#recoveryDirectory = options.recoveryDirectory;
        this.#clock = options.clock ?? (() => new Date());
        this.#idFactory = options.idFactory ?? randomUUID;
    }
    async initialize() {
        await mkdir(this.#root, { recursive: true, mode: 0o700 });
        const files = (await readdir(this.#root, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map((entry) => join(this.#root, entry.name))
            .sort();
        for (const path of files) {
            const values = await readJsonLinesRecovering(path, this.#recoveryDirectory, this.#idFactory);
            for (const value of values) {
                if (!isRunRecord(value))
                    throw new Error(`Invalid run record in ${path}`);
                const previous = this.#runs.get(value.id);
                if (!previous || value.revision > previous.revision)
                    this.#runs.set(value.id, value);
            }
        }
        for (const record of this.#runs.values())
            this.#slots.set(record.slotKey, record.id);
        const recoveredUnknown = [];
        for (const record of this.list()) {
            if (record.status !== "running")
                continue;
            recoveredUnknown.push(await this.transition(record.id, {
                status: "unknown",
                finishedAt: this.#clock().toISOString(),
                reason: "daemon restarted while external side effects may have been in flight",
            }));
        }
        return { recoveredUnknown, queued: this.list().filter((record) => record.status === "queued") };
    }
    claim(spec) {
        return this.#serialize(async () => {
            const existingId = this.#slots.get(spec.slotKey);
            if (existingId) {
                const existing = this.#runs.get(existingId);
                if (!existing)
                    throw new Error(`Run ledger slot points to missing run: ${spec.slotKey}`);
                return { claimed: false, record: structuredClone(existing) };
            }
            const record = {
                version: 1,
                revision: 1,
                id: this.#idFactory(),
                ...structuredClone(spec),
                status: "queued",
            };
            await this.#append(record);
            this.#runs.set(record.id, record);
            this.#slots.set(record.slotKey, record.id);
            return { claimed: true, record: structuredClone(record) };
        });
    }
    transition(id, patch) {
        return this.#serialize(async () => {
            const current = this.#runs.get(id);
            if (!current)
                throw new Error(`Unknown run: ${id}`);
            assertTransition(current.status, patch.status);
            const next = { ...current, ...structuredClone(patch), revision: current.revision + 1 };
            await this.#append(next);
            this.#runs.set(id, next);
            return structuredClone(next);
        });
    }
    get(id) {
        const record = this.#runs.get(id);
        return record ? structuredClone(record) : undefined;
    }
    findSlot(slotKey) {
        const id = this.#slots.get(slotKey);
        return id ? this.get(id) : undefined;
    }
    latestForJob(jobId) {
        return this.list()
            .filter((record) => record.jobId === jobId)
            .sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor))[0];
    }
    list() {
        return [...this.#runs.values()]
            .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt) || left.id.localeCompare(right.id))
            .map((record) => structuredClone(record));
    }
    async #append(record) {
        const date = new Date(record.scheduledFor);
        if (Number.isNaN(date.getTime()))
            throw new Error(`Invalid scheduledFor timestamp: ${record.scheduledFor}`);
        const file = join(this.#root, `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
        await appendJsonLine(file, record, 0o600);
    }
    #serialize(operation) {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
function assertTransition(from, to) {
    if (TERMINAL.has(from))
        throw new Error(`Run is already terminal: ${from}`);
    if (from === "queued" && to !== "running" && !TERMINAL.has(to))
        throw new Error(`Invalid run transition: ${from} -> ${to}`);
    if (from === "running" && !TERMINAL.has(to))
        throw new Error(`Invalid run transition: ${from} -> ${to}`);
}
function isRunRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const record = value;
    return (record["version"] === 1 &&
        typeof record["revision"] === "number" &&
        typeof record["id"] === "string" &&
        typeof record["slotKey"] === "string" &&
        typeof record["source"] === "string" &&
        typeof record["scheduledFor"] === "string" &&
        typeof record["receivedAt"] === "string" &&
        typeof record["objective"] === "string" &&
        typeof record["status"] === "string" &&
        typeof record["activity"] === "object" &&
        record["activity"] !== null);
}
//# sourceMappingURL=run-ledger.js.map