import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, createSyntheticSourceInfo, ModelRuntime, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { articleDraftFromUpdate } from "../articles/draft.js";
import { ArticlePreviewBus } from "../articles/preview.js";
import { publishedArticleValue } from "../articles/publish.js";
import { resolveSessionFile } from "../sessions/session-file.js";
export class PiRuntimeAdapter {
    #agentDir;
    #sessionRoot;
    #modelRuntime;
    #resolveModel;
    #createTools;
    #createSkillPaths;
    #createSkills;
    #toolGate;
    #clock;
    #idFactory;
    #autoCompaction;
    #articlePreviews = new ArticlePreviewBus();
    #sessions = new Map();
    constructor(options, modelRuntime) {
        this.#agentDir = options.agentDir;
        this.#sessionRoot = options.sessionRoot;
        this.#modelRuntime = modelRuntime;
        this.#resolveModel =
            options.resolveModel ??
                ((ref, runtime) => (ref ? runtime.getModel(ref.provider, ref.model) : undefined));
        this.#createTools = options.createTools ?? (() => []);
        this.#createSkillPaths = options.createSkillPaths ?? (() => []);
        this.#createSkills = options.createSkills ?? (() => []);
        this.#toolGate = options.toolGate;
        this.#clock = options.clock ?? (() => new Date());
        this.#idFactory = options.idFactory ?? randomUUID;
        this.#autoCompaction = options.autoCompaction ? { ...options.autoCompaction } : undefined;
    }
    static async create(options) {
        await mkdir(options.agentDir, { recursive: true, mode: 0o700 });
        await mkdir(options.sessionRoot, { recursive: true, mode: 0o700 });
        const modelRuntime = options.modelRuntime ??
            (await ModelRuntime.create({
                authPath: join(options.agentDir, "auth.json"),
                modelsPath: join(options.agentDir, "models.json"),
                refreshOnCreate: false,
            }));
        return new PiRuntimeAdapter(options, modelRuntime);
    }
    articlePreview(toolCallId) {
        return this.#articlePreviews.get(toolCallId);
    }
    async create(spec) {
        this.#assertNewSession(spec.sessionId);
        const normalized = await this.#normalizeSpec(spec);
        const sessionDir = join(this.#sessionRoot, normalized.workspaceId);
        await mkdir(sessionDir, { recursive: true, mode: 0o700 });
        const sessionManager = SessionManager.create(normalized.cwd, sessionDir);
        return this.#openRuntime(normalized, sessionManager);
    }
    async resume(spec) {
        this.#assertNewSession(spec.sessionId);
        const normalized = await this.#normalizeSpec(spec);
        const sessionFile = await resolveSessionFile(spec.sessionFile, { allowMissing: true });
        const sessionDir = join(this.#sessionRoot, normalized.workspaceId);
        await mkdir(sessionDir, { recursive: true, mode: 0o700 });
        const sessionManager = SessionManager.open(sessionFile, sessionDir, normalized.cwd);
        return this.#openRuntime(normalized, sessionManager);
    }
    async prompt(sessionId, input) {
        const record = this.#record(sessionId);
        if (record.runtime.session.isStreaming) {
            throw new Error(`Session ${sessionId} is busy; use steer or followUp`);
        }
        if (!input.trim()) {
            throw new Error("Prompt cannot be empty");
        }
        // A restored session may already be above the configured direct threshold.
        // Compact before sending another full context, then check again after the turn.
        await this.#compactAtConfiguredThreshold(record);
        const commandId = this.#idFactory();
        let resolveAccepted;
        let rejectAccepted;
        const accepted = new Promise((resolve, reject) => {
            resolveAccepted = resolve;
            rejectAccepted = reject;
        });
        const task = record.runtime.session
            .prompt(input, {
            source: "rpc",
            preflightResult: (success) => {
                if (success) {
                    resolveAccepted({ accepted: true, commandId, acceptedAt: this.#clock().toISOString() });
                }
                else {
                    rejectAccepted(new Error("Pi rejected the prompt during preflight"));
                }
            },
        })
            .then(async () => this.#compactAtConfiguredThreshold(record))
            .catch((error) => {
            const normalizedError = toError(error);
            record.lastError = normalizedError.message;
            this.#emit(record, "runtime.error", { message: normalizedError.message }, false);
            rejectAccepted(normalizedError);
            throw normalizedError;
        })
            .finally(() => {
            if (record.activeTask === task) {
                record.activeTask = undefined;
            }
        });
        record.activeTask = task;
        void task.catch(() => undefined);
        return accepted;
    }
    async steer(sessionId, input) {
        const record = this.#record(sessionId);
        await record.runtime.session.steer(input);
        return this.#accepted();
    }
    async followUp(sessionId, input) {
        const record = this.#record(sessionId);
        await record.runtime.session.followUp(input);
        return this.#accepted();
    }
    async promoteFollowUp(sessionId, index) {
        const record = this.#record(sessionId);
        if (!Number.isSafeInteger(index) || index < 0 || index >= record.queue.followUp.length) {
            throw new Error(`Follow-up queue index is out of range: ${index}`);
        }
        const selected = record.queue.followUp[index];
        if (selected === undefined)
            throw new Error(`Follow-up queue entry is unavailable: ${index}`);
        const queued = record.runtime.session.clearQueue();
        for (const message of queued.steering)
            await record.runtime.session.steer(message);
        await record.runtime.session.steer(selected);
        for (const [queuedIndex, message] of queued.followUp.entries()) {
            if (queuedIndex !== index)
                await record.runtime.session.followUp(message);
        }
        return this.#accepted();
    }
    async abort(sessionId, _reason) {
        await this.#record(sessionId).runtime.session.abort();
    }
    async compact(sessionId, instructions) {
        const session = this.#record(sessionId).runtime.session;
        if (instructions === undefined) {
            await session.compact();
        }
        else {
            await session.compact(instructions);
        }
    }
    snapshot(sessionId) {
        const record = this.#record(sessionId);
        const session = record.runtime.session;
        const stats = session.getSessionStats();
        const model = session.model;
        const sessionFile = session.sessionFile;
        const lastError = record.lastError;
        // Counting entries walks the branch but renders no text, so session state
        // stays cheap no matter how long the conversation has grown.
        const entries = this.#branchEntries(record);
        const firstUserText = this.#firstUserText(record, entries);
        return {
            sessionId,
            upstreamSessionId: session.sessionId,
            ...(sessionFile ? { sessionFile } : {}),
            cwd: record.runtime.cwd,
            status: lastError ? "failed" : session.isStreaming ? "running" : "idle",
            ...(model ? { model: { provider: model.provider, model: model.id } } : {}),
            thinking: session.thinkingLevel,
            messageCount: entries.length,
            ...(firstUserText === undefined ? {} : { firstUserText }),
            queue: {
                steering: [...record.queue.steering],
                followUp: [...record.queue.followUp],
            },
            usage: {
                input: stats.tokens.input,
                output: stats.tokens.output,
                cacheRead: stats.tokens.cacheRead,
                cacheWrite: stats.tokens.cacheWrite,
                total: stats.tokens.total,
                costUsd: stats.cost,
            },
            ...(lastError ? { lastError } : {}),
        };
    }
    subscribe(sessionId, sink) {
        const listeners = this.#record(sessionId).listeners;
        listeners.add(sink);
        return () => listeners.delete(sink);
    }
    async waitForIdle(sessionId) {
        const record = this.#record(sessionId);
        const activeTask = record.activeTask;
        if (activeTask) {
            await activeTask;
        }
        await record.runtime.session.agent.waitForIdle();
    }
    async newSession(sessionId) {
        const record = this.#record(sessionId);
        const result = await record.runtime.newSession();
        if (result.cancelled) {
            throw new Error("Pi cancelled new-session replacement");
        }
        return this.#handle(record);
    }
    async switchSession(sessionId, sessionFile) {
        const record = this.#record(sessionId);
        const result = await record.runtime.switchSession(await realpath(sessionFile));
        if (result.cancelled) {
            throw new Error("Pi cancelled session switch");
        }
        return this.#handle(record);
    }
    /**
     * A slice of the persisted branch, which keeps entries a compaction has
     * already dropped from the model's context. Only the requested slice is
     * rendered to text: doing that for the whole branch is what made every
     * streamed token cost as much as the conversation was long.
     */
    transcript(sessionId, options) {
        const record = this.#record(sessionId);
        const entries = this.#branchEntries(record);
        const limit = Math.max(0, options.limit);
        const from = Math.min(Math.max(0, options.from ?? Math.max(0, entries.length - limit)), entries.length);
        return {
            from,
            count: entries.length,
            messages: entries.slice(from, from + limit).map(toBranchMessage),
        };
    }
    /**
     * One message's full text, sliced. The transcript on the wire is bounded per
     * string, so a message longer than that ceiling arrives cut; this is how a
     * client asks for the rest of it without widening the ceiling for everything.
     */
    transcriptMessage(sessionId, options) {
        const record = this.#record(sessionId);
        const entries = this.#branchEntries(record);
        const index = options.id === undefined
            ? options.index ?? -1
            : entries.findIndex((entry) => entry.id === options.id);
        const entry = index >= 0 ? entries[index] : undefined;
        if (!entry) {
            throw new Error(`Transcript message is unavailable: ${options.id ?? String(options.index)}`);
        }
        const message = toBranchMessage(entry);
        const offset = Math.min(Math.max(0, options.offset ?? 0), message.text.length);
        return {
            ...(message.id === undefined ? {} : { id: message.id }),
            index,
            role: message.role,
            offset,
            length: message.text.length,
            text: message.text.slice(offset, offset + Math.max(0, options.limit)),
        };
    }
    /** The persisted branch's message entries, unrendered. */
    branch(sessionId) {
        return this.#branchEntries(this.#record(sessionId)).map(toBranchMessage);
    }
    #branchEntries(record) {
        return record.runtime.session.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message");
    }
    #firstUserText(record, entries) {
        if (record.firstUserText !== undefined)
            return record.firstUserText || undefined;
        const first = entries.find((entry) => asRecord(entry.message)["role"] === "user");
        // Nothing is cached until a user message exists: a session snapshotted at
        // creation has none yet, and caching that absence would leave it untitled
        // for the rest of its life.
        if (!first)
            return undefined;
        // Only ever used as a session title, so it never needs the whole message.
        const text = messageText(first.message).trim().slice(0, 200);
        record.firstUserText = text;
        return text || undefined;
    }
    async fork(sessionId, entryId, position = "at") {
        const record = this.#record(sessionId);
        const result = await record.runtime.fork(entryId, { position });
        if (result.cancelled) {
            throw new Error("Pi cancelled session fork");
        }
        return this.#handle(record);
    }
    async dispose(sessionId) {
        const record = this.#record(sessionId);
        record.unsubscribe?.();
        record.listeners.clear();
        await record.runtime.dispose();
        this.#sessions.delete(sessionId);
    }
    async disposeAll() {
        await Promise.all([...this.#sessions.keys()].map(async (sessionId) => this.dispose(sessionId)));
    }
    async #openRuntime(spec, sessionManager) {
        const createRuntime = this.#runtimeFactory(spec);
        const runtime = await createAgentSessionRuntime(createRuntime, {
            cwd: spec.cwd,
            agentDir: this.#agentDir,
            sessionManager,
        });
        await this.#materializeSessionManager(runtime.session.sessionManager);
        const record = {
            spec,
            runtime,
            upstreamSessionId: runtime.session.sessionId,
            listeners: new Set(),
            activeTask: undefined,
            queue: { steering: [], followUp: [] },
            thresholdCompaction: false,
            lastError: undefined,
            streaming: undefined,
            itemSequence: 0,
            firstUserText: undefined,
        };
        this.#sessions.set(spec.sessionId, record);
        this.#bind(record, runtime.session, false);
        runtime.setRebindSession(async (session) => {
            await this.#materializeSessionManager(session.sessionManager);
            this.#bind(record, session, true);
        });
        return this.#handle(record);
    }
    async #materializeSessionManager(sessionManager) {
        const sessionFile = sessionManager.getSessionFile();
        if (!sessionFile)
            return;
        const contents = [sessionManager.getHeader(), ...sessionManager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n";
        try {
            await writeFile(sessionFile, contents, { flag: "wx", mode: 0o600 });
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== "EEXIST")
                throw error;
        }
        sessionManager.setSessionFile(await resolveSessionFile(sessionFile));
    }
    #runtimeFactory(spec) {
        return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
            const policyExtension = this.#policyExtension(spec);
            const contextFiles = spec.contextFiles ? [...spec.contextFiles] : [];
            const skillPaths = [...await this.#createSkillPaths(spec.sessionId)].sort();
            const resolvedSkills = [...await this.#createSkills(spec.sessionId)];
            const extensionFactories = policyExtension ? [policyExtension] : [];
            const services = await createAgentSessionServices({
                cwd,
                agentDir,
                ...(this.#autoCompaction
                    ? {
                        settingsManager: SettingsManager.inMemory({
                            compaction: {
                                enabled: this.#autoCompaction.enabled,
                                reserveTokens: this.#autoCompaction.reserveTokens,
                                keepRecentTokens: this.#autoCompaction.keepRecentTokens,
                            },
                        }),
                    }
                    : {}),
                modelRuntime: this.#modelRuntime,
                resourceLoaderOptions: {
                    noExtensions: true,
                    noSkills: true,
                    noPromptTemplates: true,
                    noThemes: true,
                    noContextFiles: true,
                    ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
                    ...(resolvedSkills.length > 0
                        ? { skillsOverride: (base) => withResolvedSkills(base, resolvedSkills) }
                        : {}),
                    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
                    ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
                    ...(contextFiles.length > 0
                        ? {
                            agentsFilesOverride: () => ({
                                agentsFiles: contextFiles.map((file) => ({ path: file.path, content: file.content })),
                            }),
                        }
                        : {}),
                },
            });
            const model = this.#resolveModel(spec.model, this.#modelRuntime);
            if (spec.model && !model) {
                throw new Error(`Configured model is unavailable: ${spec.model.provider}/${spec.model.model}`);
            }
            const customTools = [...this.#createTools(spec.sessionId)];
            const enabledTools = spec.enabledTools ? [...spec.enabledTools] : customTools.map((tool) => tool.name);
            const result = await createAgentSessionFromServices({
                services,
                sessionManager,
                ...(sessionStartEvent ? { sessionStartEvent } : {}),
                ...(model ? { model } : {}),
                ...(spec.thinking ? { thinkingLevel: spec.thinking } : {}),
                ...(customTools.length > 0 ? { customTools } : {}),
                ...(enabledTools.length > 0 ? { tools: enabledTools } : { noTools: "all" }),
            });
            return { ...result, services, diagnostics: services.diagnostics };
        };
    }
    #policyExtension(spec) {
        const gate = this.#toolGate;
        if (!gate) {
            return undefined;
        }
        return {
            name: "pspore-policy",
            factory: (pi) => {
                pi.on("tool_call", async (event) => {
                    try {
                        const result = await gate.authorize({
                            sessionId: spec.sessionId,
                            toolCallId: event.toolCallId,
                            toolName: event.toolName,
                            input: { ...event.input },
                            ...(spec.authorization?.agentPath === undefined
                                ? {}
                                : { agentPath: [...spec.authorization.agentPath] }),
                            ...(spec.authorization?.runId === undefined ? {} : { runId: spec.authorization.runId }),
                            ...(spec.authorization?.jobId === undefined ? {} : { jobId: spec.authorization.jobId }),
                            ...(spec.authorization?.allowedApprovalScopes === undefined
                                ? {}
                                : { allowedApprovalScopes: [...spec.authorization.allowedApprovalScopes] }),
                            ...(spec.authorization?.deniedCapabilities === undefined
                                ? {}
                                : { deniedCapabilities: [...spec.authorization.deniedCapabilities] }),
                        });
                        if (result.decision === "allow") {
                            return undefined;
                        }
                        return {
                            block: true,
                            reason: result.reason,
                            ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
                        };
                    }
                    catch {
                        return { block: true, reason: "pSpore policy evaluation failed closed", terminate: true };
                    }
                });
            },
        };
    }
    #bind(record, session, replacement) {
        const previousUpstreamSessionId = record.upstreamSessionId;
        record.unsubscribe?.();
        record.upstreamSessionId = session.sessionId;
        record.lastError = undefined;
        record.queue = { steering: [], followUp: [] };
        record.streaming = undefined;
        record.firstUserText = undefined;
        record.unsubscribe = session.subscribe((event) => this.#onPiEvent(record, event));
        if (replacement) {
            this.#emit(record, "session.replaced", { previousUpstreamSessionId, upstreamSessionId: session.sessionId }, false);
        }
    }
    #onPiEvent(record, event) {
        switch (event.type) {
            case "agent_start":
                this.#emit(record, "run.started", {}, false);
                break;
            case "agent_settled":
                this.#emit(record, "run.settled", {}, false);
                break;
            case "message_start": {
                const streaming = this.#beginItem(record, event.message);
                this.#emit(record, "transcript.item.started", { item: this.#startedItem(streaming) }, false);
                break;
            }
            case "message_update": {
                const update = event.assistantMessageEvent;
                if (update.type === "toolcall_delta" || update.type === "toolcall_end") {
                    this.#noteArticleDraft(record, event.message, update);
                }
                if (update.type !== "text_delta" && update.type !== "thinking_delta")
                    break;
                const kind = update.type === "text_delta" ? "text" : "thinking";
                // A delta with no started item would have nowhere to land; opening one
                // keeps the stream addressable even if Pi skips the start event.
                const streaming = record.streaming ?? this.#beginItem(record, event.message);
                if (kind === "text")
                    streaming.text += update.delta;
                else
                    streaming.thinking += update.delta;
                this.#emit(record, "transcript.delta", { itemId: streaming.id, kind, delta: update.delta }, true);
                break;
            }
            case "message_end": {
                const item = this.#finishItem(record, event.message);
                this.#emit(record, "transcript.item.finished", { item }, false);
                break;
            }
            case "tool_execution_start":
                this.#emit(record, "tool.started", {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    input: publishedArticleValue(event.toolName, event.args),
                }, false);
                break;
            case "tool_execution_update":
                this.#emit(record, "tool.updated", { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult }, true);
                break;
            case "tool_execution_end":
                this.#articlePreviews.clear(event.toolCallId);
                this.#emit(record, "tool.completed", {
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    isError: event.isError,
                    result: publishedArticleValue(event.toolName, event.result),
                }, false);
                break;
            case "queue_update":
                record.queue = { steering: [...event.steering], followUp: [...event.followUp] };
                this.#emit(record, "queue.updated", record.queue, false);
                break;
            case "compaction_start":
                this.#emit(record, "compaction.started", { reason: record.thresholdCompaction && event.reason === "manual" ? "token_threshold" : event.reason }, false);
                break;
            case "compaction_end":
                this.#emit(record, "compaction.completed", {
                    reason: record.thresholdCompaction && event.reason === "manual" ? "token_threshold" : event.reason,
                    aborted: event.aborted,
                    willRetry: event.willRetry,
                }, false);
                break;
            case "auto_retry_start":
                this.#emit(record, "retry.started", { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs }, false);
                break;
            case "auto_retry_end":
                this.#emit(record, "retry.completed", { attempt: event.attempt, success: event.success }, false);
                break;
            default:
                break;
        }
    }
    #beginItem(record, message) {
        const candidate = asRecord(message);
        const streaming = {
            id: `${record.upstreamSessionId}:${++record.itemSequence}`,
            role: typeof candidate["role"] === "string" ? candidate["role"] : "assistant",
            text: messageText(message),
            thinking: "",
            startedAt: this.#clock().toISOString(),
        };
        record.streaming = streaming;
        return streaming;
    }
    /**
     * The item a `transcript.item.started` event announces. It is the same shape
     * a finished item has — clients and the desktop's frame validator both read a
     * `TranscriptItem` — only still open, so the status is `streaming`.
     */
    #startedItem(streaming) {
        return {
            id: streaming.id,
            role: streaming.role,
            text: streaming.text,
            ...(streaming.thinking ? { thinking: streaming.thinking } : {}),
            status: "streaming",
            ts: streaming.startedAt,
        };
    }
    #finishItem(record, message) {
        const streaming = record.streaming ?? this.#beginItem(record, message);
        record.streaming = undefined;
        return {
            id: streaming.id,
            role: typeof asRecord(message)["role"] === "string" ? asRecord(message)["role"] : streaming.role,
            text: messageText(message),
            status: "complete",
            ts: streaming.startedAt,
        };
    }
    #noteArticleDraft(record, message, update) {
        const draft = articleDraftFromUpdate(record.spec.sessionId, update, message);
        if (!draft)
            return;
        if (!this.#articlePreviews.note(draft, this.#clock().getTime()))
            return;
        this.#emit(record, "article.preview", {
            toolCallId: draft.toolCallId,
            ...(draft.title === undefined ? {} : { title: draft.title }),
            ...(draft.articleId === undefined ? {} : { articleId: draft.articleId }),
            chars: draft.content.length,
        }, true);
    }
    #emit(record, type, payload, transient) {
        const event = {
            id: this.#idFactory(),
            sessionId: record.spec.sessionId,
            upstreamSessionId: record.runtime.session.sessionId,
            type,
            ts: this.#clock().toISOString(),
            transient,
            payload,
        };
        for (const listener of record.listeners) {
            try {
                listener(event);
            }
            catch {
                // An observer is never allowed to break the Pi event stream.
            }
        }
    }
    async #normalizeSpec(spec) {
        if (!spec.sessionId.trim() || !spec.workspaceId.trim()) {
            throw new Error("sessionId and workspaceId are required");
        }
        const cwd = await realpath(spec.cwd);
        return { ...spec, cwd };
    }
    #record(sessionId) {
        const record = this.#sessions.get(sessionId);
        if (!record) {
            throw new Error(`Unknown session: ${sessionId}`);
        }
        return record;
    }
    #assertNewSession(sessionId) {
        if (this.#sessions.has(sessionId)) {
            throw new Error(`Session already exists: ${sessionId}`);
        }
    }
    #accepted() {
        return { accepted: true, commandId: this.#idFactory(), acceptedAt: this.#clock().toISOString() };
    }
    async #compactAtConfiguredThreshold(record) {
        const settings = this.#autoCompaction;
        if (!settings?.enabled)
            return;
        const usage = record.runtime.session.getContextUsage();
        if (usage?.tokens === null || usage?.tokens === undefined || usage.tokens < settings.triggerTokens)
            return;
        record.thresholdCompaction = true;
        try {
            await record.runtime.session.compact();
        }
        finally {
            record.thresholdCompaction = false;
        }
    }
    #handle(record) {
        const sessionFile = record.runtime.session.sessionFile;
        return {
            sessionId: record.spec.sessionId,
            upstreamSessionId: record.runtime.session.sessionId,
            ...(sessionFile ? { sessionFile } : {}),
        };
    }
}
/**
 * Adds skills resolved outside Pi to what Pi loaded from paths. A name Pi
 * already has keeps its skill — the same first-wins rule Pi applies among its
 * own paths — and the loser is reported the way Pi reports a collision.
 */
function withResolvedSkills(base, resolved) {
    const skills = [...base.skills];
    const diagnostics = [...base.diagnostics];
    for (const skill of resolved) {
        const winner = skills.find((candidate) => candidate.name === skill.name);
        if (winner) {
            diagnostics.push({
                type: "collision",
                message: `name "${skill.name}" collision`,
                path: skill.filePath,
                collision: { resourceType: "skill", name: skill.name, winnerPath: winner.filePath, loserPath: skill.filePath },
            });
            continue;
        }
        skills.push({
            ...skill,
            sourceInfo: createSyntheticSourceInfo(skill.filePath, { source: "local", scope: "user", baseDir: skill.baseDir }),
        });
    }
    return { skills, diagnostics };
}
function toBranchMessage(entry) {
    return { id: entry.id, ...toRuntimeMessage(entry.message) };
}
function toRuntimeMessage(message) {
    const candidate = asRecord(message);
    return {
        role: typeof candidate["role"] === "string" ? candidate["role"] : "unknown",
        text: messageText(message),
    };
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function messageText(message) {
    const candidate = asRecord(message);
    const content = candidate["content"];
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        if (typeof candidate["command"] === "string") {
            return candidate["command"];
        }
        return "";
    }
    return content
        .map((block) => {
        const value = asRecord(block);
        // Tool calls and hidden reasoning have dedicated runtime events. Mixing
        // synthetic markers into assistant prose leaks strings such as
        // `[tool:shell]` into Markdown and persisted history.
        if ((value["type"] === undefined || value["type"] === "text") && typeof value["text"] === "string") {
            return value["text"];
        }
        return "";
    })
        .filter(Boolean)
        .join("\n");
}
function asRecord(value) {
    return typeof value === "object" && value !== null ? value : {};
}
function toError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
//# sourceMappingURL=pi-runtime-adapter.js.map