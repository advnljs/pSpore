import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createSyntheticSourceInfo,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  estimateTokens,
  findCutPoint,
  getLatestCompactionEntry,
  sessionEntryToContextMessages,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
  type LoadSkillsResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  Accepted,
  AgentHandle,
  AgentRuntimePort,
  AgentSessionSpec,
  ModelRef,
  ResumeSessionSpec,
  ArticleDraftView,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeMessage,
  SessionId,
  SessionMetadata,
  ToolGate,
  TranscriptDeltaKind,
  TranscriptItem,
  TranscriptMessageSlice,
  TranscriptPage,
} from "../domain/runtime.js";
import { articleDraftFromToolUpdate, articleDraftFromUpdate } from "../articles/draft.js";
import type { ArticleWriterModels } from "../articles/writer.js";
import { ArticlePreviewBus, type ArticleDraft } from "../articles/preview.js";
import { publishedArticleValue } from "../articles/publish.js";
import type { AutoCompactionConfig } from "../config/config.js";
import type { SessionSkill } from "../plugins/types.js";
import { resolveSessionFile } from "../sessions/session-file.js";
import { toolInputText } from "../ui/shared/activity.js";
import { boundToolResult, estimateTextTokens } from "./context-budget.js";

type Clock = () => Date;
type IdFactory = () => string;

export interface PiRuntimeAdapterOptions {
  agentDir: string;
  sessionRoot: string;
  modelRuntime?: ModelRuntime;
  resolveModel?: (ref: ModelRef | undefined, runtime: ModelRuntime) => Model<string> | undefined;
  createTools?: (sessionId: SessionId, models: ArticleWriterModels) => readonly ToolDefinition[];
  createSkillPaths?: (sessionId: SessionId) => readonly string[] | Promise<readonly string[]>;
  /**
   * Skills already resolved outside Pi — the user's own workspace skills, which
   * Pi's strict loader would drop for loose frontmatter. They join the path-based
   * skills, which win any name collision.
   */
  createSkills?: (sessionId: SessionId) => readonly SessionSkill[] | Promise<readonly SessionSkill[]>;
  toolGate?: ToolGate;
  clock?: Clock;
  idFactory?: IdFactory;
  autoCompaction?: AutoCompactionConfig;
}

interface SessionRecord {
  spec: AgentSessionSpec;
  runtime: AgentSessionRuntime;
  upstreamSessionId: string;
  listeners: Set<(event: RuntimeEvent) => void>;
  unsubscribe?: () => void;
  activeTask: Promise<void> | undefined;
  queue: {
    steering: readonly string[];
    followUp: readonly string[];
  };
  thresholdCompaction: boolean;
  compactionPending: boolean;
  runStarted: boolean;
  abortRequested: boolean;
  heldQueue: { steering: string[]; followUp: string[] };
  lastError: string | undefined;
  /**
   * Pi's message objects carry no identity — only persisted branch entries do —
   * so the adapter mints one per streamed item and keeps it for that item's
   * whole lifecycle. Every delta then names the item it belongs to.
   */
  streaming: { id: string; role: string; text: string; thinking: string; startedAt: string } | undefined;
  itemSequence: number;
  /** Cached session title source; "" means "the first user message is empty". */
  firstUserText: string | undefined;
}

type BranchMessageEntry = { type: "message"; id: string; message: unknown };
const CONTEXT_RESUME_MESSAGE = "pspore-context-resume";

export class PiRuntimeAdapter implements AgentRuntimePort {
  readonly #agentDir: string;
  readonly #sessionRoot: string;
  readonly #modelRuntime: ModelRuntime;
  readonly #resolveModel: NonNullable<PiRuntimeAdapterOptions["resolveModel"]>;
  readonly #createTools: NonNullable<PiRuntimeAdapterOptions["createTools"]>;
  readonly #createSkillPaths: NonNullable<PiRuntimeAdapterOptions["createSkillPaths"]>;
  readonly #createSkills: NonNullable<PiRuntimeAdapterOptions["createSkills"]>;
  readonly #toolGate: ToolGate | undefined;
  readonly #clock: Clock;
  readonly #idFactory: IdFactory;
  readonly #autoCompaction: AutoCompactionConfig | undefined;
  readonly #articlePreviews = new ArticlePreviewBus((draft) => this.#publishArticleDraft(draft), () => this.#clock().getTime());
  readonly #sessions = new Map<SessionId, SessionRecord>();

  private constructor(options: PiRuntimeAdapterOptions, modelRuntime: ModelRuntime) {
    this.#agentDir = options.agentDir;
    this.#sessionRoot = options.sessionRoot;
    this.#modelRuntime = modelRuntime;
    this.#resolveModel =
      options.resolveModel ??
      ((ref, runtime) => (ref ? (runtime.getModel(ref.provider, ref.model) as Model<string> | undefined) : undefined));
    this.#createTools = options.createTools ?? (() => []);
    this.#createSkillPaths = options.createSkillPaths ?? (() => []);
    this.#createSkills = options.createSkills ?? (() => []);
    this.#toolGate = options.toolGate;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#autoCompaction = options.autoCompaction ? { ...options.autoCompaction } : undefined;
  }

  static async create(options: PiRuntimeAdapterOptions): Promise<PiRuntimeAdapter> {
    await mkdir(options.agentDir, { recursive: true, mode: 0o700 });
    await mkdir(options.sessionRoot, { recursive: true, mode: 0o700 });
    const modelRuntime =
      options.modelRuntime ??
      (await ModelRuntime.create({
        authPath: join(options.agentDir, "auth.json"),
        modelsPath: join(options.agentDir, "models.json"),
        refreshOnCreate: false,
      }));
    return new PiRuntimeAdapter(options, modelRuntime);
  }

  articlePreview(toolCallId: string): ArticleDraftView | undefined {
    return this.#articlePreviews.get(toolCallId);
  }

  async create(spec: AgentSessionSpec): Promise<AgentHandle> {
    this.#assertNewSession(spec.sessionId);
    const normalized = await this.#normalizeSpec(spec);
    const sessionDir = join(this.#sessionRoot, normalized.workspaceId);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const sessionManager = SessionManager.create(normalized.cwd, sessionDir);
    return this.#openRuntime(normalized, sessionManager);
  }

  async resume(spec: ResumeSessionSpec): Promise<AgentHandle> {
    this.#assertNewSession(spec.sessionId);
    const normalized = await this.#normalizeSpec(spec);
    const sessionFile = await resolveSessionFile(spec.sessionFile, { allowMissing: true });
    const sessionDir = join(this.#sessionRoot, normalized.workspaceId);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const sessionManager = SessionManager.open(sessionFile, sessionDir, normalized.cwd);
    return this.#openRuntime(normalized, sessionManager);
  }

  async prompt(sessionId: SessionId, input: string): Promise<Accepted> {
    const record = this.#record(sessionId);
    if (record.runtime.session.isStreaming || record.activeTask) {
      throw new Error(`Session ${sessionId} is busy; use steer or followUp`);
    }
    if (!input.trim()) {
      throw new Error("Prompt cannot be empty");
    }
    record.abortRequested = false;
    record.lastError = undefined;

    const commandId = this.#idFactory();
    let resolveAccepted!: (accepted: Accepted) => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<Accepted>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });

    // Own the logical task before any asynchronous compaction. Otherwise a
    // restored session blocks prompt acceptance (and the serialized abort
    // command behind it) for the entire summarization request.
    const task = Promise.resolve()
      .then(async () => {
        if (this.#needsThresholdCompaction(record)) {
          this.#startRun(record);
          resolveAccepted({ accepted: true, commandId, acceptedAt: this.#clock().toISOString() });
        }
        await this.#compactAtConfiguredThreshold(record);
        if (record.abortRequested) {
          rejectAccepted(new Error("Prompt cancelled during context compaction"));
          return;
        }
        await record.runtime.session.prompt(input, {
          source: "rpc",
          preflightResult: (success) => {
            if (success) resolveAccepted({ accepted: true, commandId, acceptedAt: this.#clock().toISOString() });
            else rejectAccepted(new Error("Pi rejected the prompt during preflight"));
          },
        });
        while (!record.abortRequested) {
          const resumeTask = record.compactionPending;
          await this.#compactAtConfiguredThreshold(record);
          if (record.abortRequested) break;
          await this.#restoreHeldQueue(record);
          record.compactionPending = false;
          if (resumeTask) {
            await record.runtime.session.sendCustomMessage({
              customType: CONTEXT_RESUME_MESSAGE,
              content: "Continue the original user task after context compaction. Use the summary and retained tool results; do not repeat completed actions.",
              display: false,
            }, { triggerTurn: true });
          } else {
            // A message can arrive while the *final answer* is compacting too.
            // Start with that queued user input, rather than replying to the
            // already-completed original request again.
            const session = record.runtime.session;
            if (!session.pendingMessageCount) break;
            const queue = session.clearQueue();
            const nextInput = queue.steering.shift() ?? queue.followUp.shift();
            if (nextInput === undefined) break;
            for (const message of queue.steering) await session.steer(message);
            for (const message of queue.followUp) await session.followUp(message);
            await session.prompt(nextInput, { source: "rpc", expandPromptTemplates: false });
          }
        }
        if (record.compactionPending) {
          await this.#restoreHeldQueue(record);
          record.compactionPending = false;
        }
      })
      .catch(async (error: unknown) => {
        await this.#restoreHeldQueue(record);
        if (record.abortRequested) {
          record.compactionPending = false;
          rejectAccepted(new Error("Prompt cancelled during context compaction"));
          return;
        }
        record.compactionPending = false;
        const normalizedError = toError(error);
        record.lastError = normalizedError.message;
        this.#emit(record, "runtime.error", { message: normalizedError.message }, false);
        rejectAccepted(normalizedError);
        throw normalizedError;
      })
      .finally(() => {
        if (record.activeTask === task) {
          record.activeTask = undefined;
          record.runStarted = false;
          if (!record.lastError) this.#emit(record, "run.settled", {}, false);
        }
      });

    record.activeTask = task;
    void task.catch(() => undefined);
    return accepted;
  }

  async steer(sessionId: SessionId, input: string): Promise<Accepted> {
    const record = this.#record(sessionId);
    if (record.compactionPending) {
      record.heldQueue.steering.push(input);
      this.#publishQueue(record);
      return this.#accepted();
    }
    await record.runtime.session.steer(input);
    return this.#accepted();
  }

  async followUp(sessionId: SessionId, input: string): Promise<Accepted> {
    const record = this.#record(sessionId);
    if (record.compactionPending) {
      record.heldQueue.followUp.push(input);
      this.#publishQueue(record);
      return this.#accepted();
    }
    await record.runtime.session.followUp(input);
    return this.#accepted();
  }

  async promoteFollowUp(sessionId: SessionId, index: number): Promise<Accepted> {
    const record = this.#record(sessionId);
    if (!Number.isSafeInteger(index) || index < 0 || index >= record.queue.followUp.length) {
      throw new Error(`Follow-up queue index is out of range: ${index}`);
    }
    const selected = record.queue.followUp[index];
    if (selected === undefined) throw new Error(`Follow-up queue entry is unavailable: ${index}`);
    if (record.compactionPending) {
      record.heldQueue.followUp.splice(index, 1);
      record.heldQueue.steering.push(selected);
      this.#publishQueue(record);
      return this.#accepted();
    }
    const queued = record.runtime.session.clearQueue();
    for (const message of queued.steering) await record.runtime.session.steer(message);
    await record.runtime.session.steer(selected);
    for (const [queuedIndex, message] of queued.followUp.entries()) {
      if (queuedIndex !== index) await record.runtime.session.followUp(message);
    }
    return this.#accepted();
  }

  async abort(sessionId: SessionId, _reason: string): Promise<void> {
    const record = this.#record(sessionId);
    record.abortRequested = true;
    record.runtime.session.abortCompaction();
    await record.runtime.session.abort();
    await record.activeTask?.catch(() => undefined);
  }

  async compact(sessionId: SessionId, instructions?: string): Promise<void> {
    await this.abort(sessionId, "manual compaction");
    const session = this.#record(sessionId).runtime.session;
    if (instructions === undefined) {
      await session.compact();
    } else {
      await session.compact(instructions);
    }
  }

  snapshot(sessionId: SessionId): SessionMetadata {
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
      status: lastError ? "failed" : session.isStreaming || record.activeTask || record.thresholdCompaction ? "running" : "idle",
      ...(model ? { model: { provider: model.provider, model: model.id } } : {}),
      thinking: session.thinkingLevel,
      ...(session.model ? { context: this.#contextUsage(record) } : {}),
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

  subscribe(sessionId: SessionId, sink: (event: RuntimeEvent) => void): () => void {
    const listeners = this.#record(sessionId).listeners;
    listeners.add(sink);
    return () => listeners.delete(sink);
  }

  async waitForIdle(sessionId: SessionId): Promise<void> {
    const record = this.#record(sessionId);
    const activeTask = record.activeTask;
    if (activeTask) {
      await activeTask;
    }
    await record.runtime.session.agent.waitForIdle();
  }

  async newSession(sessionId: SessionId): Promise<AgentHandle> {
    const record = this.#record(sessionId);
    const result = await record.runtime.newSession();
    if (result.cancelled) {
      throw new Error("Pi cancelled new-session replacement");
    }
    return this.#handle(record);
  }

  async switchSession(sessionId: SessionId, sessionFile: string): Promise<AgentHandle> {
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
  transcript(sessionId: SessionId, options: { from?: number; limit: number }): TranscriptPage {
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
  transcriptMessage(
    sessionId: SessionId,
    options: { id?: string; index?: number; offset?: number; limit: number },
  ): TranscriptMessageSlice {
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
  branch(sessionId: SessionId): readonly RuntimeMessage[] {
    return this.#branchEntries(this.#record(sessionId)).map(toBranchMessage);
  }

  #branchEntries(record: SessionRecord): readonly BranchMessageEntry[] {
    return record.runtime.session.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message") as unknown as readonly BranchMessageEntry[];
  }

  #firstUserText(record: SessionRecord, entries: readonly BranchMessageEntry[]): string | undefined {
    if (record.firstUserText !== undefined) return record.firstUserText || undefined;
    const first = entries.find((entry) => asRecord(entry.message)["role"] === "user");
    // Nothing is cached until a user message exists: a session snapshotted at
    // creation has none yet, and caching that absence would leave it untitled
    // for the rest of its life.
    if (!first) return undefined;
    // Only ever used as a session title, so it never needs the whole message.
    const text = messageText(first.message).trim().slice(0, 200);
    record.firstUserText = text;
    return text || undefined;
  }

  async fork(sessionId: SessionId, entryId: string, position: "before" | "at" = "at"): Promise<AgentHandle> {
    const record = this.#record(sessionId);
    const result = await record.runtime.fork(entryId, { position });
    if (result.cancelled) {
      throw new Error("Pi cancelled session fork");
    }
    return this.#handle(record);
  }

  async dispose(sessionId: SessionId): Promise<void> {
    const record = this.#record(sessionId);
    await this.abort(sessionId, "session disposed");
    this.#articlePreviews.clearSession(sessionId);
    record.unsubscribe?.();
    record.listeners.clear();
    await record.runtime.dispose();
    this.#sessions.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map(async (sessionId) => this.dispose(sessionId)));
  }

  async #openRuntime(spec: AgentSessionSpec, sessionManager: SessionManager): Promise<AgentHandle> {
    const createRuntime = this.#runtimeFactory(spec);
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: spec.cwd,
      agentDir: this.#agentDir,
      sessionManager,
    });
    await this.#materializeSessionManager(runtime.session.sessionManager);
    const record: SessionRecord = {
      spec,
      runtime,
      upstreamSessionId: runtime.session.sessionId,
      listeners: new Set(),
      activeTask: undefined,
      queue: { steering: [], followUp: [] },
      thresholdCompaction: false,
      compactionPending: false,
      runStarted: false,
      abortRequested: false,
      heldQueue: { steering: [], followUp: [] },
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

  async #materializeSessionManager(sessionManager: SessionManager): Promise<void> {
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) return;
    const contents = [sessionManager.getHeader(), ...sessionManager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    try {
      await writeFile(sessionFile, contents, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    sessionManager.setSessionFile(await resolveSessionFile(sessionFile));
  }

  #runtimeFactory(spec: AgentSessionSpec): CreateAgentSessionRuntimeFactory {
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
            ? { skillsOverride: (base: LoadSkillsResult) => withResolvedSkills(base, resolvedSkills) }
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
      const customTools = this.#createTools(spec.sessionId, this.#modelRuntime).map((tool): ToolDefinition => ({
        ...tool,
        execute: async (...args) => {
          const result = await tool.execute(...args);
          return { ...result, content: await boundToolResult(result.content, join(this.#sessionRoot, "artifacts", "tool-results")) };
        },
      }));
      const enabledTools = spec.enabledTools ? [...spec.enabledTools] : customTools.map((tool) => tool.name);
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
        ...(model ? { model } : {}),
        ...(spec.thinking ? { thinkingLevel: spec.thinking } : {}),
        ...(customTools.length > 0 ? { customTools } : {}),
        ...(enabledTools.length > 0 ? { tools: enabledTools } : { noTools: "all" as const }),
      });
      return { ...result, services, diagnostics: services.diagnostics };
    };
  }

  #policyExtension(spec: AgentSessionSpec): InlineExtension | undefined {
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
          } catch {
            return { block: true, reason: "pSpore policy evaluation failed closed", terminate: true };
          }
        });
      },
    };
  }

  #bind(record: SessionRecord, session: AgentSession, replacement: boolean): void {
    const previousUpstreamSessionId = record.upstreamSessionId;
    record.unsubscribe?.();
    record.upstreamSessionId = session.sessionId;
    record.lastError = undefined;
    record.queue = { steering: [], followUp: [] };
    record.streaming = undefined;
    record.firstUserText = undefined;
    const previousStop = session.agent.shouldStopAfterTurn;
    session.agent.shouldStopAfterTurn = async (turn, signal) => {
      if (await previousStop?.(turn, signal)) return true;
      if (signal?.aborted || record.abortRequested || !this.#autoCompaction?.enabled) return false;
      if (turn.toolResults.length === 0 && session.pendingMessageCount === 0) return false;
      if (this.#contextUsage(record).tokens < this.#compactionThreshold(record)) return false;
      record.compactionPending = true;
      // Pi drains queues at agent_end, so hold them outside the SDK until the
      // context has been compacted. New user messages join this same queue.
      record.heldQueue = { steering: [...session.getSteeringMessages()], followUp: [...session.getFollowUpMessages()] };
      session.clearQueue();
      return true;
    };
    record.unsubscribe = session.subscribe((event) => this.#onPiEvent(record, event));
    if (replacement) {
      this.#emit(
        record,
        "session.replaced",
        { previousUpstreamSessionId, upstreamSessionId: session.sessionId },
        false,
      );
    }
  }

  #onPiEvent(record: SessionRecord, event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.#startRun(record);
        break;
      case "agent_settled":
        this.#articlePreviews.clearSession(record.spec.sessionId);
        // The adapter's logical task also includes automatic compaction and
        // continuation. Publish settled only when that entire task finishes.
        if (!record.activeTask) this.#emit(record, "run.settled", {}, false);
        break;
      case "message_start": {
        if (asRecord(event.message)["customType"] === CONTEXT_RESUME_MESSAGE) break;
        const streaming = this.#beginItem(record, event.message);
        this.#emit(record, "transcript.item.started", { item: this.#startedItem(streaming) }, false);
        break;
      }
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "toolcall_delta" || update.type === "toolcall_end") {
          this.#noteArticleDraft(record, event.message, update);
        }
        if (update.type !== "text_delta" && update.type !== "thinking_delta") break;
        const kind: TranscriptDeltaKind = update.type === "text_delta" ? "text" : "thinking";
        // A delta with no started item would have nowhere to land; opening one
        // keeps the stream addressable even if Pi skips the start event.
        const streaming = record.streaming ?? this.#beginItem(record, event.message);
        if (kind === "text") streaming.text += update.delta;
        else streaming.thinking += update.delta;
        this.#emit(record, "transcript.delta", { itemId: streaming.id, kind, delta: update.delta }, true);
        break;
      }
      case "message_end": {
        if (asRecord(event.message)["customType"] === CONTEXT_RESUME_MESSAGE) break;
        const item = this.#finishItem(record, event.message);
        this.#emit(record, "transcript.item.finished", { item }, false);
        break;
      }
      case "tool_execution_start":
        this.#emit(
          record,
          "tool.started",
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: publishedArticleValue(event.toolName, event.args),
          },
          false,
        );
        break;
      case "tool_execution_update": {
        if (event.toolName === "article") {
          const draft = articleDraftFromToolUpdate(record.spec.sessionId, event.toolCallId, event.partialResult);
          if (draft) {
            this.#articlePreviews.note(draft, this.#clock().getTime());
            break;
          }
        }
        this.#emit(
          record,
          "tool.updated",
          { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: publishedArticleValue(event.toolName, event.partialResult) },
          true,
        );
        break;
      }
      case "tool_execution_end":
        this.#articlePreviews.clear(event.toolCallId);
        this.#emit(
          record,
          "tool.completed",
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            result: publishedArticleValue(event.toolName, event.result),
          },
          false,
        );
        break;
      case "queue_update":
        this.#publishQueue(record);
        break;
      case "compaction_start":
        this.#emit(
          record,
          "compaction.started",
          { reason: record.thresholdCompaction && event.reason === "manual" ? "token_threshold" : event.reason },
          false,
        );
        break;
      case "compaction_end":
        this.#emit(
          record,
          "compaction.completed",
          {
            reason: record.thresholdCompaction && event.reason === "manual" ? "token_threshold" : event.reason,
            aborted: event.aborted,
            willRetry: event.willRetry,
            ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
            ...(event.result ? { tokensBefore: event.result.tokensBefore, tokensAfter: event.result.estimatedTokensAfter } : {}),
          },
          false,
        );
        break;
      case "auto_retry_start":
        this.#emit(
          record,
          "retry.started",
          { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs },
          false,
        );
        break;
      case "auto_retry_end":
        this.#emit(record, "retry.completed", { attempt: event.attempt, success: event.success }, false);
        break;
      default:
        break;
    }
  }

  #beginItem(record: SessionRecord, message: unknown): NonNullable<SessionRecord["streaming"]> {
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
  #startedItem(streaming: NonNullable<SessionRecord["streaming"]>): TranscriptItem {
    return {
      id: streaming.id,
      role: streaming.role,
      text: streaming.text,
      ...(streaming.thinking ? { thinking: streaming.thinking } : {}),
      status: "streaming",
      ts: streaming.startedAt,
    };
  }

  #finishItem(record: SessionRecord, message: unknown): TranscriptItem {
    const streaming = record.streaming ?? this.#beginItem(record, message);
    record.streaming = undefined;
    return {
      ...toRuntimeMessage(message),
      id: streaming.id,
      status: "complete",
      ts: streaming.startedAt,
    };
  }

  #noteArticleDraft(record: SessionRecord, message: unknown, update: { type: string; contentIndex?: number; partial?: unknown }): void {
    const draft = articleDraftFromUpdate(record.spec.sessionId, update, message);
    if (!draft) return;
    this.#articlePreviews.note(draft, this.#clock().getTime());
  }

  #publishArticleDraft(draft: ArticleDraft): void {
    const record = this.#sessions.get(draft.sessionId);
    if (!record) return;
    this.#emit(
      record,
      "article.preview",
      {
        toolCallId: draft.toolCallId,
        ...(draft.title === undefined ? {} : { title: draft.title }),
        ...(draft.articleId === undefined ? {} : { articleId: draft.articleId }),
        chars: draft.content?.length ?? 0,
      },
      true,
    );
  }

  #emit(record: SessionRecord, type: RuntimeEventType, payload: Record<string, unknown>, transient: boolean): void {
    const event: RuntimeEvent = {
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
      } catch {
        // An observer is never allowed to break the Pi event stream.
      }
    }
  }

  async #normalizeSpec<T extends AgentSessionSpec>(spec: T): Promise<T> {
    if (!spec.sessionId.trim() || !spec.workspaceId.trim()) {
      throw new Error("sessionId and workspaceId are required");
    }
    const cwd = await realpath(spec.cwd);
    return { ...spec, cwd };
  }

  #record(sessionId: SessionId): SessionRecord {
    const record = this.#sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return record;
  }

  #assertNewSession(sessionId: SessionId): void {
    if (this.#sessions.has(sessionId)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }
  }

  #accepted(): Accepted {
    return { accepted: true, commandId: this.#idFactory(), acceptedAt: this.#clock().toISOString() };
  }

  #startRun(record: SessionRecord): void {
    if (record.runStarted) return;
    record.runStarted = true;
    this.#emit(record, "run.started", {}, false);
  }

  #needsThresholdCompaction(record: SessionRecord): boolean {
    const settings = this.#autoCompaction;
    if (!settings?.enabled) return false;
    const session = record.runtime.session;
    if (record.abortRequested || session.messages.length === 0) return false;
    // A just-compacted leaf cannot be compacted again without new work.
    if (session.sessionManager.getBranch().at(-1)?.type === "compaction") return false;
    return this.#contextUsage(record).tokens >= this.#compactionThreshold(record);
  }

  async #compactAtConfiguredThreshold(record: SessionRecord): Promise<void> {
    if (!this.#needsThresholdCompaction(record)) return;
    const session = record.runtime.session;
    if (session.messages.at(-1)?.role === "toolResult") {
      // Pi never cuts at a tool result. Add an invisible, user-like boundary
      // after the completed batch so even the first long task can be compacted.
      await session.sendCustomMessage({
        customType: CONTEXT_RESUME_MESSAGE,
        content: "The tool batch above has finished. Preserve the original user request, completed actions, evidence and remaining work in the context summary.",
        display: false,
      });
    }
    // Pi deliberately keeps whole recent messages. A single large retained
    // answer can still exceed our threshold, yet leave nothing new to summarize.
    // Use its public cut-point rules to avoid reporting that normal no-op as a
    // failed task ("Nothing to compact").
    const entries = session.sessionManager.getBranch();
    const previous = getLatestCompactionEntry(entries);
    const start = previous ? Math.max(0, entries.findIndex((entry) => entry.id === previous.firstKeptEntryId)) : 0;
    const cut = findCutPoint(entries, start, entries.length, session.settingsManager.getCompactionSettings().keepRecentTokens);
    if (!entries.slice(start, cut.firstKeptEntryIndex).some((entry) => entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0)) return;
    record.thresholdCompaction = true;
    try {
      await record.runtime.session.compact();
    } finally {
      record.thresholdCompaction = false;
    }
  }

  #compactionThreshold(record: SessionRecord): number {
    const settings = this.#autoCompaction;
    if (!settings) return Number.POSITIVE_INFINITY;
    const limit = record.runtime.session.model?.contextWindow ?? Number.POSITIVE_INFINITY;
    return Math.max(1, Math.min(settings.triggerTokens, limit - settings.reserveTokens));
  }

  #publishQueue(record: SessionRecord): void {
    record.queue = {
      steering: [...record.runtime.session.getSteeringMessages(), ...record.heldQueue.steering],
      followUp: [...record.runtime.session.getFollowUpMessages(), ...record.heldQueue.followUp],
    };
    this.#emit(record, "queue.updated", record.queue, false);
  }

  async #restoreHeldQueue(record: SessionRecord): Promise<void> {
    while (record.heldQueue.steering.length || record.heldQueue.followUp.length) {
      const queue = record.heldQueue;
      record.heldQueue = { steering: [], followUp: [] };
      for (const message of queue.steering) await record.runtime.session.steer(message);
      for (const message of queue.followUp) await record.runtime.session.followUp(message);
    }
  }

  #contextUsage(record: SessionRecord): NonNullable<SessionMetadata["context"]> {
    const session = record.runtime.session;
    const usage = session.getContextUsage();
    let tokens = usage?.tokens;
    const lastUsageIndex = session.messages.findLastIndex((message) => message.role === "assistant"
      && message.stopReason !== "error" && message.stopReason !== "aborted"
      && (message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite) > 0);
    if (tokens === undefined || tokens === null || lastUsageIndex < 0) {
      tokens = estimateTextTokens(session.systemPrompt)
        + estimateTextTokens(JSON.stringify(session.agent.state.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))));
      for (const message of session.messages) {
        tokens += estimateMessageTokens(message);
      }
    } else {
      // Pi estimates messages after the latest measured usage as chars / 4.
      // Correct only that unmeasured tail; never add the entire history again.
      for (const message of session.messages.slice(lastUsageIndex + 1)) {
        tokens += estimateMessageTokens(message) - estimateTokens(message);
      }
    }
    return {
      tokens,
      window: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
      estimated: true,
      ...(this.#autoCompaction?.enabled ? { triggerTokens: this.#compactionThreshold(record) } : {}),
    };
  }

  #handle(record: SessionRecord): AgentHandle {
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
function withResolvedSkills(base: LoadSkillsResult, resolved: readonly SessionSkill[]): LoadSkillsResult {
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

function toBranchMessage(entry: BranchMessageEntry): RuntimeMessage {
  return { id: entry.id, ...toRuntimeMessage(entry.message) };
}

function toRuntimeMessage(message: unknown): RuntimeMessage {
  const candidate = asRecord(message);
  const content = Array.isArray(candidate["content"]) ? candidate["content"].map(asRecord) : [];
  const thinking = content.filter((block) => block["type"] === "thinking" && typeof block["thinking"] === "string")
    .map((block) => block["thinking"]).join("\n");
  const toolCalls = content.flatMap((block) => {
    if (block["type"] !== "toolCall" || typeof block["id"] !== "string" || typeof block["name"] !== "string") return [];
    return [{ id: block["id"], name: block["name"], input: toolInputText(publishedArticleValue(block["name"], block["arguments"] ?? {})) }];
  });
  return {
    role: typeof candidate["role"] === "string" ? candidate["role"] : "unknown",
    text: messageText(message),
    ...(thinking ? { thinking } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(typeof candidate["toolCallId"] === "string" ? { toolCallId: candidate["toolCallId"] } : {}),
    ...(typeof candidate["toolName"] === "string" ? { toolName: candidate["toolName"] } : {}),
    ...(typeof candidate["isError"] === "boolean" ? { isError: candidate["isError"] } : {}),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function estimateMessageTokens(message: Parameters<typeof estimateTokens>[0]): number {
  let prose = messageText(message);
  if (message.role === "compactionSummary" || message.role === "branchSummary") prose += message.summary;
  if (message.role === "bashExecution") prose += message.output;
  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "thinking") prose += block.thinking;
      if (block.type === "toolCall") prose += block.name + JSON.stringify(block.arguments);
    }
  }
  return Math.max(estimateTokens(message), estimateTextTokens(prose));
}

function messageText(message: unknown): string {
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
