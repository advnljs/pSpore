import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { estimateTokens } from "../memory/tokenizer.js";
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "budget_exhausted"]);
const READ_ONLY_DENIED_CAPABILITIES = [
    "fs.write",
    "fs.delete",
    "process.exec",
    "process.pty",
    "network.connect",
    "network.publish",
    "privilege.escalate",
    "schedule.write",
    "memory.write",
    "external.side_effect",
];
class AgentBudgetError extends Error {
    constructor(message) {
        super(message);
        this.name = "AgentBudgetError";
    }
}
export class AgentManager {
    #workspaceRoot;
    #host;
    #maxConcurrentAgents;
    #maxDepth;
    #maxChildrenPerParent;
    #defaultRootBudget;
    #clock;
    #idFactory;
    #onAgent;
    #onMessage;
    #onError;
    #agents = new Map();
    #roots = new Map();
    #active = new Map();
    #deferred = new Map();
    #queue = [];
    #recipientSequences = new Map();
    #mailboxes = new Map();
    #messageHistory = [];
    #mailboxTails = new Map();
    #stopping = false;
    constructor(options, workspaceRoot) {
        this.#workspaceRoot = workspaceRoot;
        this.#host = options.host;
        this.#maxConcurrentAgents = positiveInteger(options.maxConcurrentAgents, "maxConcurrentAgents");
        this.#maxDepth = positiveInteger(options.maxDepth ?? 2, "maxDepth");
        this.#maxChildrenPerParent = positiveInteger(options.maxChildrenPerParent ?? 4, "maxChildrenPerParent");
        this.#defaultRootBudget = structuredClone(options.defaultRootBudget ?? {
            maxTurns: 64,
            maxToolCalls: 256,
            maxInputTokens: 500_000,
            maxOutputTokens: 100_000,
            maxChildren: 32,
        });
        validateBudget(this.#defaultRootBudget, "defaultRootBudget");
        this.#clock = options.clock ?? (() => new Date());
        this.#idFactory = options.idFactory ?? randomUUID;
        this.#onAgent = options.onAgent;
        this.#onMessage = options.onMessage;
        this.#onError = options.onError;
    }
    static async create(options) {
        return new AgentManager(options, await realpath(options.workspaceRoot));
    }
    registerRoot(input) {
        if (this.#roots.has(input.id))
            throw new Error(`Agent root is already registered: ${input.id}`);
        validateBudget(input.budget, `root ${input.id} budget`);
        this.#roots.set(input.id, {
            id: input.id,
            budget: structuredClone(input.budget),
            ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
            agentPath: [...(input.agentPath ?? [input.id])],
        });
    }
    unregisterRoot(id) {
        if (this.list().some((agent) => agent.rootId === id && !TERMINAL.has(agent.status))) {
            throw new Error(`Cannot unregister agent root with active children: ${id}`);
        }
        this.#roots.delete(id);
    }
    parentIdForSession(sessionId) {
        return [...this.#agents.values()].find((agent) => agent.sessionId === sessionId)?.id ?? sessionId;
    }
    async spawn(input) {
        if (this.#stopping)
            throw new Error("Agent manager is stopping");
        const parent = this.#parentContext(input.parentId);
        const depth = parent.depth + 1;
        if (depth > this.#maxDepth)
            throw new Error(`Agent depth ${depth} exceeds maximum ${this.#maxDepth}`);
        validateBudget(input.budget, "agent budget");
        assertBudgetWithin(input.budget, parent.budget, `parent ${input.parentId}`);
        const siblings = this.list().filter((agent) => agent.parentId === input.parentId && !TERMINAL.has(agent.status));
        if (siblings.length >= Math.min(this.#maxChildrenPerParent, parent.budget.maxChildren)) {
            throw new Error(`Parent ${input.parentId} active child limit is exhausted`);
        }
        const root = this.#rootContext(parent.rootId);
        const rootChildren = this.list().filter((agent) => agent.rootId === root.id).length;
        if (rootChildren >= root.budget.maxChildren)
            throw new Error(`Root ${root.id} child budget is exhausted`);
        assertBudgetWithin(input.budget, root.budget, `root ${root.id}`);
        const cwd = await this.#canonicalWorkspaceDirectory(input.cwd);
        const id = this.#idFactory();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
            throw new Error(`Generated agent id is invalid: ${id}`);
        const record = {
            version: 1,
            id,
            sessionId: `agent:${id}`,
            parentId: input.parentId,
            rootId: root.id,
            objective: boundedText(input.objective, "agent objective", 8_000),
            cwd,
            depth,
            workspaceMode: input.workspaceMode,
            budget: structuredClone(input.budget),
            status: "queued",
            createdAt: this.#clock().toISOString(),
        };
        this.#agents.set(id, record);
        this.#deferred.set(id, deferredRecord());
        this.#queue.push(id);
        this.#publishAgent(record);
        this.#pump();
        return structuredClone(record);
    }
    async send(input) {
        const recipientId = this.#resolveRecipient(input.senderId, input.recipientId);
        this.#assertMessageRoute(input.senderId, recipientId);
        const sequence = (this.#recipientSequences.get(recipientId) ?? 0) + 1;
        this.#recipientSequences.set(recipientId, sequence);
        const message = {
            version: 1,
            id: this.#idFactory(),
            senderId: input.senderId,
            recipientId,
            sequence,
            correlationId: input.correlationId ?? this.#idFactory(),
            priority: input.priority ?? "normal",
            mode: input.mode,
            text: boundedText(input.text, "agent message", 8_000),
            tokenEstimate: estimateTokens(input.text),
            ts: this.#clock().toISOString(),
        };
        const mailbox = this.#mailboxes.get(recipientId) ?? [];
        mailbox.push(message);
        this.#mailboxes.set(recipientId, mailbox);
        this.#messageHistory.push(message);
        this.#publishMessage(message);
        await this.#flushMailbox(recipientId);
        return structuredClone(message);
    }
    async join(agentIds, timeoutMs, signal) {
        if (agentIds.length === 0 || agentIds.length > 32)
            throw new Error("agent_join requires between 1 and 32 agent IDs");
        const unique = [...new Set(agentIds)];
        const waits = unique.map((id) => {
            const record = this.#agents.get(id);
            if (!record)
                throw new Error(`Unknown agent: ${id}`);
            if (TERMINAL.has(record.status))
                return Promise.resolve(structuredClone(record));
            const deferred = this.#deferred.get(id);
            if (!deferred)
                throw new Error(`Agent completion is unavailable: ${id}`);
            return deferred.promise.then((finished) => structuredClone(finished));
        });
        return withDeadline(Promise.all(waits), timeoutMs, signal);
    }
    async cancel(agentId, reason = "cancelled by user") {
        const record = this.#agents.get(agentId);
        if (!record)
            throw new Error(`Unknown agent: ${agentId}`);
        if (TERMINAL.has(record.status))
            return structuredClone(record);
        const descendants = this.list()
            .filter((candidate) => candidate.parentId === agentId && !TERMINAL.has(candidate.status))
            .map((candidate) => candidate.id);
        await Promise.all(descendants.map(async (id) => this.cancel(id, `parent ${agentId} cancelled`)));
        const active = this.#active.get(agentId);
        if (active) {
            active.controller.abort(new Error(reason));
            return active.completion;
        }
        const queueIndex = this.#queue.indexOf(agentId);
        if (queueIndex >= 0)
            this.#queue.splice(queueIndex, 1);
        return this.#finish(record, "cancelled", { summary: reason, error: reason, counters: emptyCounters() });
    }
    async cancelChildren(parentId, reason) {
        const children = this.list().filter((agent) => agent.parentId === parentId && !TERMINAL.has(agent.status));
        await Promise.all(children.map(async (agent) => this.cancel(agent.id, reason)));
    }
    async sessionAvailable(sessionId) {
        await this.#flushMailbox(this.parentIdForSession(sessionId));
    }
    list() {
        return [...this.#agents.values()]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
            .map((agent) => structuredClone(agent));
    }
    listMessages() {
        return this.#messageHistory.map((message) => structuredClone(message));
    }
    async stop() {
        if (this.#stopping) {
            await Promise.allSettled([...this.#active.values()].map((active) => active.completion));
            return;
        }
        this.#stopping = true;
        const pending = this.list().filter((agent) => !TERMINAL.has(agent.status));
        await Promise.allSettled(pending.map(async (agent) => this.cancel(agent.id, "agent manager shutdown")));
    }
    #pump() {
        if (this.#stopping)
            return;
        while (this.#active.size < this.#maxConcurrentAgents && this.#queue.length > 0) {
            const id = this.#queue.shift();
            if (!id)
                continue;
            const record = this.#agents.get(id);
            if (!record || record.status !== "queued")
                continue;
            const controller = new AbortController();
            let completion;
            completion = this.#run(record, controller.signal).finally(() => {
                const active = this.#active.get(id);
                if (active?.completion === completion)
                    this.#active.delete(id);
                this.#pump();
            });
            this.#active.set(id, { controller, completion });
            void completion.catch((error) => this.#error(error));
        }
    }
    async #run(initial, signal) {
        const running = this.#updateAgent(initial.id, { status: "running", startedAt: this.#clock().toISOString() });
        const root = this.#rootContext(running.rootId);
        const agentPath = [...root.agentPath, ...this.#ancestry(running.id)];
        let counters = emptyCounters();
        let violation;
        let unsubscribe = () => undefined;
        const abort = () => void this.#host.abortAgentSession(running.sessionId, "agent task aborted");
        try {
            await this.#host.createAgentSession(running.sessionId, running.cwd, {
                agentPath,
                ...(root.jobId === undefined ? {} : { jobId: root.jobId }),
                allowedApprovalScopes: root.jobId === undefined ? ["once", "session"] : ["once", "session", "job"],
                ...(running.workspaceMode === "shared-read"
                    ? { deniedCapabilities: [...READ_ONLY_DENIED_CAPABILITIES] }
                    : {}),
            });
            unsubscribe = this.#host.subscribeAgentSession(running.sessionId, (event) => {
                if (event.type === "run.started")
                    counters.turns += 1;
                if (event.type === "tool.started")
                    counters.toolCalls += 1;
                const usage = this.#host.snapshotAgentSession(running.sessionId).usage;
                counters = { ...counters, input: usage.input, output: usage.output, cost: usage.costUsd };
                const reason = budgetViolation(running.budget, counters);
                if (!reason || violation)
                    return;
                violation = new AgentBudgetError(reason);
                void this.#host.abortAgentSession(running.sessionId, reason);
            });
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted)
                throw signal.reason;
            await this.#host.startAgentPrompt(running.sessionId, `${running.objective}\n\nReturn a concise result with summary, evidence references, changed files, and open questions. Stay within the delegated budget and workspace mode.`);
            await this.#host.waitForAgentIdle(running.sessionId);
            if (violation)
                throw violation;
            if (signal.aborted)
                throw signal.reason;
            await this.cancelChildren(running.id, `parent agent ${running.id} completed`);
            const snapshot = this.#host.snapshotAgentSession(running.sessionId);
            counters = {
                ...counters,
                input: snapshot.usage.input,
                output: snapshot.usage.output,
                cost: snapshot.usage.costUsd,
            };
            const finalViolation = budgetViolation(running.budget, counters);
            if (finalViolation)
                throw new AgentBudgetError(finalViolation);
            const summary = snapshot.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "Agent completed.";
            return await this.#finish(running, "succeeded", { summary, snapshot, counters });
        }
        catch (error) {
            await this.cancelChildren(running.id, `parent agent ${running.id} stopped`).catch(() => undefined);
            const normalized = toError(error);
            const status = violation || normalized instanceof AgentBudgetError ? "budget_exhausted" : signal.aborted ? "cancelled" : "failed";
            return await this.#finish(running, status, { summary: normalized.message, error: normalized.message, counters });
        }
        finally {
            signal.removeEventListener("abort", abort);
            unsubscribe();
            await this.#host.closeAgentSession(running.sessionId).catch((error) => this.#error(error));
        }
    }
    async #finish(record, status, input) {
        const usage = input.snapshot?.usage ?? {
            input: input.counters.input,
            output: input.counters.output,
            cacheRead: 0,
            cacheWrite: 0,
            total: input.counters.input + input.counters.output,
            costUsd: input.counters.cost,
        };
        const result = {
            status,
            summary: input.summary,
            evidenceRefs: [],
            changedFiles: [],
            openQuestions: [],
            usage,
        };
        const finished = this.#updateAgent(record.id, {
            status,
            finishedAt: this.#clock().toISOString(),
            result,
            ...(input.error === undefined ? {} : { error: input.error }),
        });
        this.#deferred.get(record.id)?.resolve(structuredClone(finished));
        await this.send({
            senderId: record.id,
            recipientId: "parent",
            text: JSON.stringify(result),
            mode: "next",
            priority: "high",
            correlationId: record.id,
        }).catch(() => undefined);
        return finished;
    }
    #updateAgent(id, patch) {
        const current = this.#agents.get(id);
        if (!current)
            throw new Error(`Unknown agent: ${id}`);
        const next = { ...current, ...structuredClone(patch) };
        this.#agents.set(id, next);
        this.#publishAgent(next);
        return structuredClone(next);
    }
    #parentContext(parentId) {
        const parent = this.#agents.get(parentId);
        if (parent) {
            if (TERMINAL.has(parent.status))
                throw new Error(`Parent agent is already terminal: ${parentId}`);
            return { rootId: parent.rootId, depth: parent.depth, budget: parent.budget };
        }
        const root = this.#rootContext(parentId);
        return { rootId: root.id, depth: 0, budget: root.budget };
    }
    #rootContext(id) {
        const existing = this.#roots.get(id);
        if (existing)
            return existing;
        if (id !== "main")
            throw new Error(`Unknown agent parent/root: ${id}`);
        const root = { id, budget: structuredClone(this.#defaultRootBudget), agentPath: ["main"] };
        this.#roots.set(id, root);
        return root;
    }
    #ancestry(id) {
        const path = [];
        let current = this.#agents.get(id);
        while (current) {
            path.unshift(current.id);
            current = this.#agents.get(current.parentId);
        }
        return path;
    }
    #resolveRecipient(senderId, recipientId) {
        if (recipientId !== "parent")
            return recipientId;
        const sender = this.#agents.get(senderId);
        if (!sender)
            throw new Error(`Only a child agent can address parent: ${senderId}`);
        return sender.parentId;
    }
    #assertMessageRoute(senderId, recipientId) {
        if (senderId === "user") {
            const recipient = this.#agents.get(recipientId);
            if (recipientId !== "main" && !recipient)
                throw new Error(`Unknown recipient: ${recipientId}`);
            if (recipient && TERMINAL.has(recipient.status))
                throw new Error(`Recipient agent is already terminal: ${recipientId}`);
            return;
        }
        const sender = this.#agents.get(senderId);
        const recipient = this.#agents.get(recipientId);
        if (sender) {
            if (sender.parentId === recipientId || recipient?.parentId === senderId)
                return;
            throw new Error(`Agent ${senderId} may only message its parent or direct children`);
        }
        if (this.#roots.has(senderId) || senderId === "main") {
            if (recipient?.parentId === senderId)
                return;
            throw new Error(`Root ${senderId} may only message direct children`);
        }
        throw new Error(`Unknown sender: ${senderId}`);
    }
    async #flushMailbox(recipientId) {
        const previous = this.#mailboxTails.get(recipientId) ?? Promise.resolve();
        const task = previous.then(async () => this.#drainMailbox(recipientId));
        const tail = task.catch(() => undefined);
        this.#mailboxTails.set(recipientId, tail);
        try {
            await task;
        }
        finally {
            if (this.#mailboxTails.get(recipientId) === tail)
                this.#mailboxTails.delete(recipientId);
        }
    }
    async #drainMailbox(recipientId) {
        const mailbox = this.#mailboxes.get(recipientId);
        if (!mailbox || mailbox.length === 0)
            return;
        const sessionId = this.#agents.get(recipientId)?.sessionId ?? recipientId;
        if (!this.#host.hasAgentSession(sessionId))
            return;
        while (mailbox.length > 0) {
            const message = mailbox[0];
            if (!message)
                break;
            await this.#host.sendAgentMessage(sessionId, message.text, message.mode);
            mailbox.shift();
        }
    }
    async #canonicalWorkspaceDirectory(input) {
        const path = await realpath(isAbsolute(input) ? input : resolve(this.#workspaceRoot, input));
        const relation = relative(this.#workspaceRoot, path);
        if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
            throw new Error(`Agent cwd escapes workspace: ${path}`);
        }
        return path;
    }
    #publishAgent(agent) {
        try {
            this.#onAgent?.(structuredClone(agent));
        }
        catch {
            // Agent state is authoritative even if an observer fails.
        }
    }
    #publishMessage(message) {
        try {
            this.#onMessage?.(structuredClone(message));
        }
        catch {
            // Mailbox delivery is independent from UI observation.
        }
    }
    #error(error) {
        try {
            this.#onError?.(toError(error));
        }
        catch {
            // Error observers cannot break the agent manager.
        }
    }
}
function validateBudget(budget, path) {
    positiveInteger(budget.maxTurns, `${path}.maxTurns`);
    positiveInteger(budget.maxToolCalls, `${path}.maxToolCalls`);
    positiveInteger(budget.maxInputTokens, `${path}.maxInputTokens`);
    positiveInteger(budget.maxOutputTokens, `${path}.maxOutputTokens`);
    if (!Number.isSafeInteger(budget.maxChildren) || budget.maxChildren < 0) {
        throw new Error(`${path}.maxChildren must be a non-negative safe integer`);
    }
    if (budget.maxCostUsd !== undefined && (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd <= 0)) {
        throw new Error(`${path}.maxCostUsd must be positive`);
    }
}
function assertBudgetWithin(child, ceiling, path) {
    const checks = [
        ["maxTurns", child.maxTurns, ceiling.maxTurns],
        ["maxToolCalls", child.maxToolCalls, ceiling.maxToolCalls],
        ["maxInputTokens", child.maxInputTokens, ceiling.maxInputTokens],
        ["maxOutputTokens", child.maxOutputTokens, ceiling.maxOutputTokens],
        ["maxChildren", child.maxChildren, ceiling.maxChildren],
    ];
    for (const [name, value, maximum] of checks) {
        if (value > maximum)
            throw new Error(`Agent ${name} ${value} exceeds ${path} ceiling ${maximum}`);
    }
    if (ceiling.maxCostUsd !== undefined && (child.maxCostUsd === undefined || child.maxCostUsd > ceiling.maxCostUsd)) {
        throw new Error(`Agent maxCostUsd exceeds ${path} ceiling`);
    }
}
function budgetViolation(budget, counters) {
    if (counters.turns > budget.maxTurns)
        return `maxTurns exceeded: ${counters.turns}/${budget.maxTurns}`;
    if (counters.toolCalls > budget.maxToolCalls)
        return `maxToolCalls exceeded: ${counters.toolCalls}/${budget.maxToolCalls}`;
    if (counters.input > budget.maxInputTokens)
        return `maxInputTokens exceeded: ${counters.input}/${budget.maxInputTokens}`;
    if (counters.output > budget.maxOutputTokens)
        return `maxOutputTokens exceeded: ${counters.output}/${budget.maxOutputTokens}`;
    if (budget.maxCostUsd !== undefined && counters.cost > budget.maxCostUsd) {
        return `maxCostUsd exceeded: ${counters.cost}/${budget.maxCostUsd}`;
    }
    return undefined;
}
function emptyCounters() {
    return { turns: 0, toolCalls: 0, input: 0, output: 0, cost: 0 };
}
function positiveInteger(value, path) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${path} must be a positive safe integer`);
    return value;
}
function boundedText(value, path, maximum) {
    if (!value.trim() || value.length > maximum)
        throw new Error(`${path} must be between 1 and ${maximum} characters`);
    return value;
}
function deferredRecord() {
    let resolve;
    const promise = new Promise((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}
async function withDeadline(task, timeoutMs, signal) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
        throw new Error("agent_join timeoutMs must be between 1 and 600000");
    }
    if (signal?.aborted)
        throw signal.reason;
    let timer;
    let abort;
    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`agent_join timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
        abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("agent_join aborted"));
        signal?.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([task, deadline]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (abort)
            signal?.removeEventListener("abort", abort);
    }
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=agent-manager.js.map