import { randomUUID } from "node:crypto";
import { CommandError } from "../protocol/errors.js";
export class AgentRunBudgetError extends Error {
    constructor(message) {
        super(message);
        this.name = "AgentRunBudgetError";
    }
}
export class AgentApplication {
    #runtime;
    #kernel;
    #approvals;
    #notifications;
    #sessionCatalog;
    #sessionTemplate;
    #modelConfigured;
    #onShutdownRequested;
    #clock;
    #idFactory;
    #onError;
    #sessions = new Set();
    #rootSessions = new Map();
    #unsubscribers = new Map();
    #sessionTails = new Map();
    #automation;
    #agents;
    #mcp;
    #resources;
    constructor(options) {
        this.#runtime = options.runtime;
        this.#kernel = options.kernel;
        this.#approvals = options.approvals;
        this.#notifications = options.notifications;
        this.#sessionCatalog = options.sessionCatalog;
        this.#sessionTemplate = options.sessionTemplate;
        this.#modelConfigured = options.modelConfigured;
        this.#onShutdownRequested = options.onShutdownRequested;
        this.#clock = options.clock ?? (() => new Date());
        this.#idFactory = options.idFactory ?? randomUUID;
        this.#onError = options.onError ?? (() => undefined);
    }
    async handleCommand(command) {
        switch (command.type) {
            case "status.get":
                exactPayload(command.payload, [], command.type);
                return this.#kernel.snapshot();
            case "session.snapshot": {
                exactPayload(command.payload, [], command.type);
                const sessionId = requiredSessionId(command);
                return this.#sessions.has(sessionId) ? this.#snapshot(sessionId) : null;
            }
            case "session.create": {
                const payload = exactPayload(command.payload, ["title"], command.type);
                const title = optionalSessionTitle(payload["title"], "payload.title");
                const sessionId = generatedRootSessionId(this.#idFactory());
                return this.#serializeSession(sessionId, async () => {
                    await this.#createRootSession(sessionId, title);
                    return this.#snapshot(sessionId);
                });
            }
            case "session.prompt": {
                const payload = exactPayload(command.payload, ["text", "mode"], command.type);
                const text = nonEmptyString(payload["text"], "payload.text");
                const mode = optionalEnum(payload["mode"], ["auto", "prompt", "steer", "follow_up"], "payload.mode") ?? "auto";
                const sessionId = requiredSessionId(command);
                return this.#serializeSession(sessionId, async () => {
                    await this.#ensureRootSession(sessionId);
                    const record = await this.#sessionCatalog.touch(sessionId, { prompt: text });
                    if (record)
                        this.#rootSessions.set(sessionId, rootMetadata(record));
                    const automaticMode = mode === "auto"
                        ? this.#runtime.snapshot(sessionId).status === "running" ? "follow_up" : "prompt"
                        : mode;
                    const accepted = automaticMode === "steer"
                        ? await this.#runtime.steer(sessionId, text)
                        : automaticMode === "follow_up"
                            ? await this.#runtime.followUp(sessionId, text)
                            : await this.#runtime.prompt(sessionId, text);
                    setImmediate(() => void this.#agents?.sessionAvailable(sessionId));
                    return accepted;
                });
            }
            case "session.queue.send-now": {
                const payload = exactPayload(command.payload, ["index"], command.type);
                const index = nonNegativeIntegerValue(payload["index"], "payload.index", 10_000);
                const sessionId = requiredSessionId(command);
                return this.#serializeSession(sessionId, async () => {
                    this.#assertRootSession(sessionId);
                    return this.#runtime.promoteFollowUp(sessionId, index);
                });
            }
            case "session.abort": {
                const payload = exactPayload(command.payload, ["reason"], command.type);
                const reason = optionalString(payload["reason"], "payload.reason") ?? "user requested abort";
                const sessionId = requiredSessionId(command);
                return this.#serializeSession(sessionId, async () => {
                    this.#assertSession(sessionId);
                    await this.#approvals.cancelSession(sessionId);
                    await this.#agents?.cancelChildren(this.#agents.parentIdForSession(sessionId), reason);
                    await this.#runtime.abort(sessionId, reason);
                    return { aborted: true };
                });
            }
            case "session.compact": {
                const payload = exactPayload(command.payload, ["instructions"], command.type);
                const instructions = optionalString(payload["instructions"], "payload.instructions");
                const sessionId = requiredSessionId(command);
                return this.#serializeSession(sessionId, async () => {
                    this.#assertSession(sessionId);
                    if (instructions === undefined)
                        await this.#runtime.compact(sessionId);
                    else
                        await this.#runtime.compact(sessionId, instructions);
                    return { compacted: true };
                });
            }
            case "approval.resolve": {
                const payload = exactPayload(command.payload, ["approvalId", "approved", "scope"], command.type);
                const approvalId = nonEmptyString(payload["approvalId"], "payload.approvalId");
                const approved = booleanValue(payload["approved"], "payload.approved");
                const scope = optionalEnum(payload["scope"], ["once", "session", "job"], "payload.scope") ?? "once";
                return this.#approvals.resolve(approvalId, { approved, scope, actor: command.clientId });
            }
            case "jobs.list":
                exactPayload(command.payload, [], command.type);
                return this.#requireAutomation().listJobs();
            case "runs.list":
                exactPayload(command.payload, [], command.type);
                return this.#requireAutomation().listRuns();
            case "notifications.list":
                exactPayload(command.payload, [], command.type);
                return this.#notifications.list();
            case "agents.list":
                exactPayload(command.payload, [], command.type);
                return this.#requireAgents().list();
            case "agent.messages":
                exactPayload(command.payload, [], command.type);
                return this.#requireAgents().listMessages();
            case "agent.spawn": {
                const payload = exactPayload(command.payload, ["parentId", "objective", "cwd", "workspaceMode", "budget"], command.type);
                return this.#requireAgents().spawn({
                    parentId: optionalString(payload["parentId"], "payload.parentId") ?? "main",
                    objective: nonEmptyString(payload["objective"], "payload.objective"),
                    cwd: optionalString(payload["cwd"], "payload.cwd") ?? this.#sessionTemplate.cwd,
                    workspaceMode: requiredEnum(payload["workspaceMode"], ["shared-read", "shared-write"], "payload.workspaceMode"),
                    budget: parseRunBudget(payload["budget"], "payload.budget"),
                });
            }
            case "agent.send": {
                const payload = exactPayload(command.payload, ["agentId", "message", "mode"], command.type);
                return this.#requireAgents().send({
                    senderId: "user",
                    recipientId: nonEmptyString(payload["agentId"], "payload.agentId"),
                    text: nonEmptyString(payload["message"], "payload.message"),
                    mode: requiredEnum(payload["mode"], ["steer", "follow_up", "next"], "payload.mode"),
                    priority: "high",
                });
            }
            case "agent.join": {
                const payload = exactPayload(command.payload, ["agentIds", "timeoutMs"], command.type);
                return this.#requireAgents().join(stringArray(payload["agentIds"], "payload.agentIds", 32), positiveIntegerValue(payload["timeoutMs"], "payload.timeoutMs", 600_000));
            }
            case "agent.cancel": {
                const payload = exactPayload(command.payload, ["agentId", "reason"], command.type);
                return this.#requireAgents().cancel(nonEmptyString(payload["agentId"], "payload.agentId"), optionalString(payload["reason"], "payload.reason"));
            }
            case "mcp.servers":
                exactPayload(command.payload, [], command.type);
                return this.#requireMcp().listServers();
            case "mcp.tools":
                exactPayload(command.payload, [], command.type);
                return this.#requireMcp().listTools();
            case "mcp.discover": {
                const payload = exactPayload(command.payload, ["serverId"], command.type);
                return this.#requireMcp().discover(nonEmptyString(payload["serverId"], "payload.serverId"));
            }
            case "mcp.ping": {
                const payload = exactPayload(command.payload, ["serverId"], command.type);
                return this.#requireMcp().ping(nonEmptyString(payload["serverId"], "payload.serverId"));
            }
            case "resources.list":
                exactPayload(command.payload, [], command.type);
                return this.#requireResources().list();
            case "skills.list":
                exactPayload(command.payload, [], command.type);
                return this.#requireResources().list().filter((entry) => entry.record.kind === "skill");
            case "plugins.list":
                exactPayload(command.payload, [], command.type);
                return this.#requireResources().list().filter((entry) => entry.record.kind === "host-plugin");
            case "resources.inspect": {
                const payload = exactPayload(command.payload, ["stagingPath"], command.type);
                return this.#requireResources().inspect(nonEmptyString(payload["stagingPath"], "payload.stagingPath"));
            }
            case "resources.install": {
                const payload = exactPayload(command.payload, ["stagingPath", "expectedDigest"], command.type);
                return this.#requireResources().install(nonEmptyString(payload["stagingPath"], "payload.stagingPath"), sha256Value(payload["expectedDigest"], "payload.expectedDigest"));
            }
            case "resources.disable": {
                const payload = exactPayload(command.payload, ["kind", "name", "expectedDigest"], command.type);
                return this.#requireResources().disable(requiredEnum(payload["kind"], ["skill", "host-plugin"], "payload.kind"), nonEmptyString(payload["name"], "payload.name"), sha256Value(payload["expectedDigest"], "payload.expectedDigest"));
            }
            case "job.put": {
                const payload = exactPayload(command.payload, ["job", "expectedSha256"], command.type);
                return this.#requireAutomation().putJob(payload["job"], nullableSha256(payload["expectedSha256"], "payload.expectedSha256"));
            }
            case "job.run": {
                const payload = exactPayload(command.payload, ["jobId"], command.type);
                return this.#requireAutomation().triggerJob(nonEmptyString(payload["jobId"], "payload.jobId"), this.#clock(), "user");
            }
            case "run.cancel": {
                const payload = exactPayload(command.payload, ["runId", "reason"], command.type);
                return this.#requireAutomation().cancel(nonEmptyString(payload["runId"], "payload.runId"), optionalString(payload["reason"], "payload.reason"));
            }
            case "daemon.shutdown":
                exactPayload(command.payload, [], command.type);
                this.#onShutdownRequested?.();
                return { draining: true };
            default:
                throw new CommandError("unknown_command", `Unknown command type: ${command.type}`);
        }
    }
    setAutomation(automation) {
        if (this.#automation)
            throw new Error("Automation control is already configured");
        this.#automation = automation;
    }
    setAgents(agents) {
        if (this.#agents)
            throw new Error("Agent control is already configured");
        this.#agents = agents;
        for (const sessionId of this.#rootSessions.keys()) {
            agents.registerRoot({ id: sessionId, agentPath: [sessionId] });
        }
    }
    async restoreRootSessions() {
        const failures = [];
        for (const record of this.#sessionCatalog.list()) {
            try {
                await this.#serializeSession(record.id, async () => this.#resumeRootSession(record));
            }
            catch (error) {
                const failure = toError(error);
                failures.push(failure);
                this.#onError(failure);
            }
        }
        return failures;
    }
    setMcp(mcp) {
        if (this.#mcp)
            throw new Error("MCP control is already configured");
        this.#mcp = mcp;
    }
    setResources(resources) {
        if (this.#resources)
            throw new Error("Resource control is already configured");
        this.#resources = resources;
    }
    executeAgentRun(run, signal) {
        const activity = run.activity;
        if (activity.kind !== "agent")
            throw new Error(`Run ${run.id} is not an agent activity`);
        const sessionId = `run:${run.id}`;
        return this.#serializeSession(sessionId, async () => {
            const agentPath = ["automation", run.jobId ?? run.source, run.id];
            this.#agents?.registerRoot({
                id: sessionId,
                budget: run.budget,
                ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
                agentPath,
            });
            let turns = 0;
            let toolCalls = 0;
            let violation;
            const checkBudget = (event) => {
                if (event.type === "run.started")
                    turns += 1;
                if (event.type === "tool.started")
                    toolCalls += 1;
                const usage = this.#runtime.snapshot(sessionId).usage;
                const reason = budgetViolation(run.budget, { turns, toolCalls, input: usage.input, output: usage.output, cost: usage.costUsd });
                if (!reason || violation)
                    return;
                violation = new AgentRunBudgetError(reason);
                void abortSession(reason);
            };
            let unsubscribeBudget = () => undefined;
            let abortTask;
            const abortSession = (reason) => {
                abortTask ??= Promise.allSettled([
                    this.#approvals.cancelSession(sessionId),
                    this.#runtime.abort(sessionId, reason),
                ]).then(() => undefined);
                return abortTask;
            };
            const abort = () => void abortSession("automation run aborted");
            signal.addEventListener("abort", abort, { once: true });
            try {
                await this.#ensureSession(sessionId, activity.cwd, {
                    agentPath,
                    runId: run.id,
                    ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
                    allowedApprovalScopes: run.jobId === undefined ? ["once", "session"] : ["once", "session", "job"],
                });
                unsubscribeBudget = this.#runtime.subscribe(sessionId, checkBudget);
                if (signal.aborted)
                    throw signal.reason instanceof Error ? signal.reason : new Error("Automation run aborted");
                await this.#runtime.prompt(sessionId, activity.prompt);
                await this.#runtime.waitForIdle(sessionId);
                if (violation)
                    throw violation;
                if (signal.aborted)
                    throw signal.reason instanceof Error ? signal.reason : new Error("Automation run aborted");
                const snapshot = this.#runtime.snapshot(sessionId);
                const finalViolation = budgetViolation(run.budget, {
                    turns,
                    toolCalls,
                    input: snapshot.usage.input,
                    output: snapshot.usage.output,
                    cost: snapshot.usage.costUsd,
                });
                if (finalViolation)
                    throw new AgentRunBudgetError(finalViolation);
                return snapshot;
            }
            finally {
                signal.removeEventListener("abort", abort);
                unsubscribeBudget();
                if (abortTask)
                    await abortTask;
                await this.#agents?.cancelChildren(sessionId, `automation run ${run.id} stopped`).catch(() => undefined);
                await this.#disposeSession(sessionId);
                this.#agents?.unregisterRoot(sessionId);
            }
        });
    }
    async createAgentSession(sessionId, cwd, authorization) {
        await this.#serializeSession(sessionId, async () => this.#ensureSession(sessionId, cwd, authorization));
    }
    hasAgentSession(sessionId) {
        return this.#sessions.has(sessionId);
    }
    async startAgentPrompt(sessionId, text) {
        await this.#serializeSession(sessionId, async () => {
            this.#assertSession(sessionId);
            await this.#runtime.prompt(sessionId, text);
        });
        await this.#agents?.sessionAvailable(sessionId);
    }
    async sendAgentMessage(sessionId, text, mode) {
        await this.#serializeSession(sessionId, async () => {
            this.#assertSession(sessionId);
            if (mode === "steer")
                await this.#runtime.steer(sessionId, text);
            else if (mode === "follow_up")
                await this.#runtime.followUp(sessionId, text);
            else if (this.#runtime.snapshot(sessionId).status === "running")
                await this.#runtime.followUp(sessionId, text);
            else
                await this.#runtime.prompt(sessionId, text);
        });
    }
    async waitForAgentIdle(sessionId) {
        this.#assertSession(sessionId);
        await this.#runtime.waitForIdle(sessionId);
    }
    async abortAgentSession(sessionId, reason) {
        if (!this.#sessions.has(sessionId))
            return;
        await this.#approvals.cancelSession(sessionId);
        await this.#agents?.cancelChildren(this.#agents.parentIdForSession(sessionId), reason);
        await this.#runtime.abort(sessionId, reason);
    }
    snapshotAgentSession(sessionId) {
        this.#assertSession(sessionId);
        return this.#runtime.snapshot(sessionId);
    }
    subscribeAgentSession(sessionId, sink) {
        this.#assertSession(sessionId);
        return this.#runtime.subscribe(sessionId, sink);
    }
    async closeAgentSession(sessionId) {
        await this.#disposeSession(sessionId);
    }
    async dispose() {
        await Promise.allSettled([...this.#sessionTails.values()]);
        await Promise.all([...this.#sessions].map(async (sessionId) => this.#disposeSession(sessionId)));
        await this.#sessionCatalog.idle();
    }
    async #ensureSession(sessionId, cwd, authorization) {
        if (this.#sessions.has(sessionId))
            return;
        this.#assertModelConfigured();
        await this.#runtime.create({
            sessionId,
            ...this.#sessionTemplate,
            ...(cwd === undefined ? {} : { cwd }),
            ...(authorization === undefined ? {} : { authorization }),
        });
        await this.#attachSession(sessionId);
    }
    async #ensureRootSession(sessionId) {
        if (this.#sessions.has(sessionId)) {
            this.#assertRootSession(sessionId);
            return;
        }
        const record = this.#sessionCatalog.get(sessionId);
        if (record) {
            await this.#resumeRootSession(record);
            return;
        }
        if (sessionId !== "main") {
            throw new CommandError("session_not_found", `Root session does not exist: ${sessionId}`);
        }
        await this.#createRootSession(sessionId);
    }
    async #createRootSession(sessionId, title) {
        if (this.#sessions.has(sessionId) || this.#sessionCatalog.get(sessionId)) {
            throw new CommandError("session_exists", `Root session already exists: ${sessionId}`);
        }
        this.#assertModelConfigured();
        const handle = await this.#runtime.create({ sessionId, ...this.#sessionTemplate });
        let rootRegistered = false;
        try {
            const now = this.#clock().toISOString();
            let metadata = {
                title: title ?? (sessionId === "main" ? "Main session" : "New session"),
                createdAt: now,
                updatedAt: now,
            };
            if (handle.sessionFile) {
                metadata = rootMetadata(await this.#sessionCatalog.add({
                    id: sessionId,
                    sessionFile: handle.sessionFile,
                    cwd: this.#sessionTemplate.cwd,
                    ...(title === undefined ? {} : { title }),
                }));
            }
            this.#rootSessions.set(sessionId, metadata);
            this.#agents?.registerRoot({ id: sessionId, agentPath: [sessionId] });
            rootRegistered = Boolean(this.#agents);
            await this.#attachSession(sessionId);
        }
        catch (error) {
            this.#rootSessions.delete(sessionId);
            if (rootRegistered)
                this.#agents?.unregisterRoot(sessionId);
            await this.#runtime.dispose(sessionId).catch(() => undefined);
            throw error;
        }
    }
    async #resumeRootSession(record) {
        if (this.#sessions.has(record.id))
            return;
        this.#assertModelConfigured();
        await this.#runtime.resume({
            sessionId: record.id,
            ...this.#sessionTemplate,
            cwd: record.cwd,
            sessionFile: record.sessionFile,
        });
        let rootRegistered = false;
        try {
            this.#rootSessions.set(record.id, rootMetadata(record));
            this.#agents?.registerRoot({ id: record.id, agentPath: [record.id] });
            rootRegistered = Boolean(this.#agents);
            await this.#attachSession(record.id);
        }
        catch (error) {
            this.#rootSessions.delete(record.id);
            if (rootRegistered)
                this.#agents?.unregisterRoot(record.id);
            await this.#runtime.dispose(record.id).catch(() => undefined);
            throw error;
        }
    }
    async #attachSession(sessionId) {
        this.#sessions.add(sessionId);
        this.#unsubscribers.set(sessionId, this.#runtime.subscribe(sessionId, (event) => this.#onRuntimeEvent(event)));
        await this.#publishSnapshot(this.#snapshot(sessionId));
    }
    #onRuntimeEvent(event) {
        const snapshot = this.#snapshot(event.sessionId);
        void this.#kernel.dispatch({
            id: event.id,
            ts: event.ts,
            type: "runtime.received",
            event,
            snapshot,
        });
        if (this.#rootSessions.has(event.sessionId) && (event.type === "run.settled" || event.type === "session.replaced")) {
            void this.#sessionCatalog.touch(event.sessionId, {
                ...(snapshot.sessionFile === undefined ? {} : { sessionFile: snapshot.sessionFile }),
            }).then((record) => {
                if (record)
                    this.#rootSessions.set(event.sessionId, rootMetadata(record));
            }).catch((error) => this.#onError(toError(error)));
        }
    }
    #snapshot(sessionId) {
        const snapshot = this.#runtime.snapshot(sessionId);
        const rootSession = this.#rootSessions.get(sessionId);
        return rootSession ? { ...snapshot, rootSession: structuredClone(rootSession) } : snapshot;
    }
    async #publishSnapshot(snapshot) {
        await this.#kernel.dispatch({
            id: this.#idFactory(),
            ts: this.#clock().toISOString(),
            type: "session.snapshot",
            snapshot,
        });
    }
    async #disposeSession(sessionId) {
        if (!this.#sessions.has(sessionId))
            return;
        this.#unsubscribers.get(sessionId)?.();
        this.#unsubscribers.delete(sessionId);
        this.#sessions.delete(sessionId);
        this.#rootSessions.delete(sessionId);
        let failure;
        try {
            await this.#runtime.dispose(sessionId);
        }
        catch (error) {
            failure = error;
        }
        await this.#kernel.dispatch({
            id: this.#idFactory(),
            ts: this.#clock().toISOString(),
            type: "session.closed",
            sessionId,
        });
        if (failure !== undefined)
            throw failure;
    }
    #assertSession(sessionId) {
        if (!this.#sessions.has(sessionId))
            throw new CommandError("session_not_found", `Session does not exist: ${sessionId}`);
    }
    #assertRootSession(sessionId) {
        this.#assertSession(sessionId);
        if (!this.#rootSessions.has(sessionId)) {
            throw new CommandError("invalid_session", `Session is not an interactive root session: ${sessionId}`);
        }
    }
    #assertModelConfigured() {
        if (!this.#modelConfigured) {
            throw new CommandError("model_not_configured", "No model is configured. Set config.model.provider, config.model.model, and credentials before prompting.");
        }
    }
    #requireAutomation() {
        if (!this.#automation)
            throw new CommandError("automation_unavailable", "Scheduler is not initialized");
        return this.#automation;
    }
    #requireAgents() {
        if (!this.#agents)
            throw new CommandError("agents_unavailable", "Agent manager is not initialized");
        return this.#agents;
    }
    #requireMcp() {
        if (!this.#mcp)
            throw new CommandError("mcp_unavailable", "MCP manager is not initialized");
        return this.#mcp;
    }
    #requireResources() {
        if (!this.#resources)
            throw new CommandError("resources_unavailable", "Resource manager is not initialized");
        return this.#resources;
    }
    #serializeSession(sessionId, operation) {
        const previous = this.#sessionTails.get(sessionId) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        const tail = result.then(() => undefined, () => undefined);
        this.#sessionTails.set(sessionId, tail);
        void tail.finally(() => {
            if (this.#sessionTails.get(sessionId) === tail)
                this.#sessionTails.delete(sessionId);
        });
        return result;
    }
}
function requiredSessionId(command) {
    if (!command.sessionId)
        throw new CommandError("invalid_command", `${command.type} requires sessionId`);
    return command.sessionId;
}
function exactPayload(value, allowed, type) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new CommandError("invalid_command", `${type} payload must be an object`);
    }
    const record = value;
    const accepted = new Set(allowed);
    const unknown = Object.keys(record).filter((key) => !accepted.has(key));
    if (unknown.length > 0) {
        throw new CommandError("invalid_command", `${type} payload contains unknown fields: ${unknown.join(", ")}`);
    }
    return record;
}
function nonEmptyString(value, path) {
    if (typeof value !== "string" || !value.trim())
        throw new CommandError("invalid_command", `${path} must be non-empty`);
    return value;
}
function optionalString(value, path) {
    if (value === undefined)
        return undefined;
    return nonEmptyString(value, path);
}
function optionalSessionTitle(value, path) {
    if (value === undefined)
        return undefined;
    const title = nonEmptyString(value, path).replace(/\s+/g, " ").trim();
    if ([...title].length > 120 || /[\u0000-\u001f]/.test(title)) {
        throw new CommandError("invalid_command", `${path} must contain at most 120 characters without controls`);
    }
    return title;
}
function generatedRootSessionId(value) {
    const id = `session-${value}`;
    if (id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
        throw new Error("Generated root session id is invalid");
    }
    return id;
}
function rootMetadata(record) {
    return {
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
function optionalEnum(value, allowed, path) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw new CommandError("invalid_command", `${path} must be one of: ${allowed.join(", ")}`);
    }
    return value;
}
function requiredEnum(value, allowed, path) {
    const parsed = optionalEnum(value, allowed, path);
    if (parsed === undefined)
        throw new CommandError("invalid_command", `${path} is required`);
    return parsed;
}
function booleanValue(value, path) {
    if (typeof value !== "boolean")
        throw new CommandError("invalid_command", `${path} must be boolean`);
    return value;
}
function nullableSha256(value, path) {
    if (value === null)
        return null;
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
        throw new CommandError("invalid_command", `${path} must be null or a 64-character SHA-256`);
    }
    return value.toLowerCase();
}
function sha256Value(value, path) {
    const parsed = nullableSha256(value, path);
    if (parsed === null)
        throw new CommandError("invalid_command", `${path} must be a 64-character SHA-256`);
    return parsed;
}
function parseRunBudget(value, path) {
    const budget = exactPayload(value, ["maxTurns", "maxToolCalls", "maxInputTokens", "maxOutputTokens", "maxChildren", "maxCostUsd"], path);
    const maxCostUsd = budget["maxCostUsd"];
    if (maxCostUsd !== undefined && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) {
        throw new CommandError("invalid_command", `${path}.maxCostUsd must be positive`);
    }
    return {
        maxTurns: positiveIntegerValue(budget["maxTurns"], `${path}.maxTurns`, 10_000),
        maxToolCalls: positiveIntegerValue(budget["maxToolCalls"], `${path}.maxToolCalls`, 100_000),
        maxInputTokens: positiveIntegerValue(budget["maxInputTokens"], `${path}.maxInputTokens`, 100_000_000),
        maxOutputTokens: positiveIntegerValue(budget["maxOutputTokens"], `${path}.maxOutputTokens`, 100_000_000),
        maxChildren: nonNegativeIntegerValue(budget["maxChildren"], `${path}.maxChildren`, 1_000),
        ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    };
}
function stringArray(value, path, maximum) {
    if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
        throw new CommandError("invalid_command", `${path} must contain between 1 and ${maximum} strings`);
    }
    return value.map((item, index) => nonEmptyString(item, `${path}[${index}]`));
}
function positiveIntegerValue(value, path, maximum) {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
        throw new CommandError("invalid_command", `${path} must be an integer between 1 and ${maximum}`);
    }
    return Number(value);
}
function nonNegativeIntegerValue(value, path, maximum) {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
        throw new CommandError("invalid_command", `${path} must be an integer between 0 and ${maximum}`);
    }
    return Number(value);
}
function budgetViolation(budget, usage) {
    if (usage.turns > budget.maxTurns)
        return `maxTurns exceeded: ${usage.turns}/${budget.maxTurns}`;
    if (usage.toolCalls > budget.maxToolCalls)
        return `maxToolCalls exceeded: ${usage.toolCalls}/${budget.maxToolCalls}`;
    if (usage.input > budget.maxInputTokens)
        return `maxInputTokens exceeded: ${usage.input}/${budget.maxInputTokens}`;
    if (usage.output > budget.maxOutputTokens)
        return `maxOutputTokens exceeded: ${usage.output}/${budget.maxOutputTokens}`;
    if (budget.maxCostUsd !== undefined && usage.cost > budget.maxCostUsd) {
        return `maxCostUsd exceeded: ${usage.cost}/${budget.maxCostUsd}`;
    }
    return undefined;
}
//# sourceMappingURL=agent-application.js.map