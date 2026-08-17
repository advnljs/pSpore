import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { atomicWriteFile } from "../storage/atomic.js";
import { validateFiveFieldCron } from "./cron-adapter.js";
export class JobStore {
    #jobsDirectory;
    #workspaceRoot;
    #tail = Promise.resolve();
    constructor(options) {
        this.#jobsDirectory = options.jobsDirectory;
        this.#workspaceRoot = options.workspaceRoot;
    }
    async loadAll() {
        const entries = await readdir(this.#jobsDirectory, { withFileTypes: true });
        const jobs = [];
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            if (!entry.isFile() || !entry.name.endsWith(".json"))
                continue;
            const expectedId = basename(entry.name, ".json");
            const content = await readFile(join(this.#jobsDirectory, entry.name));
            const value = JSON.parse(content.toString("utf8"));
            jobs.push({ ...(await parseJob(value, expectedId, this.#workspaceRoot)), sourceSha256: sha256(content) });
        }
        return jobs;
    }
    put(value, expectedSha256) {
        return this.#serialize(async () => {
            const root = object(value, "job");
            const id = identifier(root["id"], "job.id");
            const parsed = await parseJob(value, id, this.#workspaceRoot);
            const path = join(this.#jobsDirectory, `${id}.json`);
            let current;
            try {
                const metadata = await lstat(path);
                if (!metadata.isFile() || metadata.isSymbolicLink())
                    throw new Error(`Job source must be a regular file: ${path}`);
                current = await readFile(path);
            }
            catch (error) {
                if (!isNodeError(error) || error.code !== "ENOENT")
                    throw error;
            }
            const currentSha256 = current ? sha256(current) : null;
            if (expectedSha256 !== currentSha256) {
                throw new Error(`Job update conflict for ${id}: expected ${expectedSha256 ?? "missing"}, current ${currentSha256 ?? "missing"}`);
            }
            const content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
            await atomicWriteFile(path, content, 0o600);
            return { ...parsed, sourceSha256: sha256(content) };
        });
    }
    #serialize(operation) {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
export async function parseJob(value, expectedId, workspaceRoot) {
    const job = object(value, "job");
    exactKeys(job, ["version", "id", "enabled", "schedule", "cwd", "policyRef", "concurrency", "misfire", "timeoutMs", "budget", "delivery", "kind", "payload"], "job");
    if (job["version"] !== 1)
        throw new Error("job.version must be 1");
    const id = identifier(job["id"], "job.id");
    if (id !== expectedId)
        throw new Error(`job.id ${id} must match filename ${expectedId}.json`);
    const schedule = object(job["schedule"], "job.schedule");
    exactKeys(schedule, ["cron", "timezone"], "job.schedule");
    const cron = string(schedule["cron"], "job.schedule.cron");
    const timezone = string(schedule["timezone"], "job.schedule.timezone");
    validateFiveFieldCron(cron, timezone);
    const cwdInput = string(job["cwd"], "job.cwd");
    const cwd = await realpath(resolve(workspaceRoot, cwdInput));
    if (!(await stat(cwd)).isDirectory())
        throw new Error(`job.cwd must resolve to a directory: ${cwd}`);
    const budget = parseBudget(job["budget"]);
    const delivery = parseDelivery(job["delivery"]);
    const kind = enumeration(job["kind"], ["agent", "command"], "job.kind");
    const payload = object(job["payload"], "job.payload");
    let activity;
    if (kind === "agent") {
        exactKeys(payload, ["prompt"], "job.payload");
        activity = { kind, prompt: string(payload["prompt"], "job.payload.prompt"), cwd };
    }
    else {
        exactKeys(payload, ["command"], "job.payload");
        activity = { kind, command: string(payload["command"], "job.payload.command"), cwd };
    }
    return {
        version: 1,
        id,
        enabled: boolean(job["enabled"], "job.enabled"),
        schedule: { cron, timezone },
        policyRef: string(job["policyRef"], "job.policyRef"),
        concurrency: enumeration(job["concurrency"], ["forbid", "replace", "allow"], "job.concurrency"),
        misfire: enumeration(job["misfire"], ["skip", "run_once"], "job.misfire"),
        timeoutMs: positiveInteger(job["timeoutMs"], "job.timeoutMs", 86_400_000),
        budget,
        delivery,
        activity,
    };
}
function parseBudget(value) {
    const budget = object(value, "job.budget");
    exactKeys(budget, ["maxTurns", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "maxCostUsd", "maxChildren"], "job.budget", ["maxCostUsd"]);
    const maxCostUsd = budget["maxCostUsd"];
    return {
        maxTurns: positiveInteger(budget["maxTurns"], "job.budget.maxTurns", 10_000),
        maxToolCalls: positiveInteger(budget["maxToolCalls"], "job.budget.maxToolCalls", 100_000),
        maxInputTokens: positiveInteger(budget["maxInputTokens"], "job.budget.maxInputTokens", 100_000_000),
        maxOutputTokens: positiveInteger(budget["maxOutputTokens"], "job.budget.maxOutputTokens", 100_000_000),
        maxChildren: nonNegativeInteger(budget["maxChildren"], "job.budget.maxChildren", 1_000),
        ...(maxCostUsd === undefined ? {} : { maxCostUsd: positiveNumber(maxCostUsd, "job.budget.maxCostUsd") }),
    };
}
function parseDelivery(value) {
    const delivery = object(value, "job.delivery");
    const kind = enumeration(delivery["kind"], ["session", "local-notification", "none"], "job.delivery.kind");
    if (kind === "session") {
        exactKeys(delivery, ["kind", "sessionId"], "job.delivery");
        return { kind, sessionId: identifier(delivery["sessionId"], "job.delivery.sessionId") };
    }
    exactKeys(delivery, ["kind"], "job.delivery");
    return { kind };
}
function object(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${path} must be an object`);
    return value;
}
function exactKeys(value, allowed, path, optional = []) {
    const allowedSet = new Set(allowed);
    const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
    if (unknown.length > 0)
        throw new Error(`${path} contains unknown keys: ${unknown.join(", ")}`);
    const optionalSet = new Set(optional);
    for (const key of allowed)
        if (!optionalSet.has(key) && !(key in value))
            throw new Error(`${path}.${key} is required`);
}
function string(value, path) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${path} must be a non-empty string`);
    return value;
}
function identifier(value, path) {
    const result = string(value, path);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result))
        throw new Error(`${path} is not a valid identifier`);
    return result;
}
function boolean(value, path) {
    if (typeof value !== "boolean")
        throw new Error(`${path} must be boolean`);
    return value;
}
function enumeration(value, allowed, path) {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
    return value;
}
function positiveInteger(value, path, maximum) {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
        throw new Error(`${path} must be an integer between 1 and ${maximum}`);
    }
    return Number(value);
}
function nonNegativeInteger(value, path, maximum) {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
        throw new Error(`${path} must be an integer between 0 and ${maximum}`);
    }
    return Number(value);
}
function positiveNumber(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        throw new Error(`${path} must be positive`);
    return value;
}
function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=job-store.js.map