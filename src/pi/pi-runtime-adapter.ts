import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  Accepted,
  AgentHandle,
  AgentRuntimePort,
  AgentSessionSpec,
  AgentSnapshot,
  ModelRef,
  ResumeSessionSpec,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeMessage,
  SessionId,
  ToolGate,
} from "../domain/runtime.js";
import type { AutoCompactionConfig } from "../config/config.js";

type Clock = () => Date;
type IdFactory = () => string;

export interface PiRuntimeAdapterOptions {
  agentDir: string;
  sessionRoot: string;
  modelRuntime?: ModelRuntime;
  resolveModel?: (ref: ModelRef | undefined, runtime: ModelRuntime) => Model<string> | undefined;
  createTools?: (sessionId: SessionId) => readonly ToolDefinition[];
  createSkillPaths?: (sessionId: SessionId) => readonly string[] | Promise<readonly string[]>;
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
  lastError: string | undefined;
}

export class PiRuntimeAdapter implements AgentRuntimePort {
  readonly #agentDir: string;
  readonly #sessionRoot: string;
  readonly #modelRuntime: ModelRuntime;
  readonly #resolveModel: NonNullable<PiRuntimeAdapterOptions["resolveModel"]>;
  readonly #createTools: NonNullable<PiRuntimeAdapterOptions["createTools"]>;
  readonly #createSkillPaths: NonNullable<PiRuntimeAdapterOptions["createSkillPaths"]>;
  readonly #toolGate: ToolGate | undefined;
  readonly #clock: Clock;
  readonly #idFactory: IdFactory;
  readonly #autoCompaction: AutoCompactionConfig | undefined;
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
    const sessionFile = await realpath(spec.sessionFile);
    const sessionDir = join(this.#sessionRoot, normalized.workspaceId);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const sessionManager = SessionManager.open(sessionFile, sessionDir, normalized.cwd);
    return this.#openRuntime(normalized, sessionManager);
  }

  async prompt(sessionId: SessionId, input: string): Promise<Accepted> {
    const record = this.#record(sessionId);
    if (record.runtime.session.isStreaming) {
      throw new Error(`Session ${sessionId} is busy; use steer or followUp`);
    }
    if (!input.trim()) {
      throw new Error("Prompt cannot be empty");
    }

    const commandId = this.#idFactory();
    let resolveAccepted!: (accepted: Accepted) => void;
    let rejectAccepted!: (error: Error) => void;
    const accepted = new Promise<Accepted>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });

    const task = record.runtime.session
      .prompt(input, {
        source: "rpc",
        preflightResult: (success) => {
          if (success) {
            resolveAccepted({ accepted: true, commandId, acceptedAt: this.#clock().toISOString() });
          } else {
            rejectAccepted(new Error("Pi rejected the prompt during preflight"));
          }
        },
      })
      .catch((error: unknown) => {
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

  async steer(sessionId: SessionId, input: string): Promise<Accepted> {
    const record = this.#record(sessionId);
    await record.runtime.session.steer(input);
    return this.#accepted();
  }

  async followUp(sessionId: SessionId, input: string): Promise<Accepted> {
    const record = this.#record(sessionId);
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
    const queued = record.runtime.session.clearQueue();
    for (const message of queued.steering) await record.runtime.session.steer(message);
    await record.runtime.session.steer(selected);
    for (const [queuedIndex, message] of queued.followUp.entries()) {
      if (queuedIndex !== index) await record.runtime.session.followUp(message);
    }
    return this.#accepted();
  }

  async abort(sessionId: SessionId, _reason: string): Promise<void> {
    await this.#record(sessionId).runtime.session.abort();
  }

  async compact(sessionId: SessionId, instructions?: string): Promise<void> {
    const session = this.#record(sessionId).runtime.session;
    if (instructions === undefined) {
      await session.compact();
    } else {
      await session.compact(instructions);
    }
  }

  snapshot(sessionId: SessionId): AgentSnapshot {
    const record = this.#record(sessionId);
    const session = record.runtime.session;
    const stats = session.getSessionStats();
    const model = session.model;
    const sessionFile = session.sessionFile;
    const lastError = record.lastError;

    return {
      sessionId,
      upstreamSessionId: session.sessionId,
      ...(sessionFile ? { sessionFile } : {}),
      cwd: record.runtime.cwd,
      status: lastError ? "failed" : session.isStreaming ? "running" : "idle",
      ...(model ? { model: { provider: model.provider, model: model.id } } : {}),
      thinking: session.thinkingLevel,
      messages: session.messages.map(toRuntimeMessage),
      entries: session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => ({
          id: entry.id,
          role: entry.message.role,
          text: messageText(entry.message),
        })),
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
    const record: SessionRecord = {
      spec,
      runtime,
      upstreamSessionId: runtime.session.sessionId,
      listeners: new Set(),
      activeTask: undefined,
      queue: { steering: [], followUp: [] },
      lastError: undefined,
    };
    this.#sessions.set(spec.sessionId, record);
    this.#bind(record, runtime.session, false);
    runtime.setRebindSession(async (session) => this.#bind(record, session, true));
    return this.#handle(record);
  }

  #runtimeFactory(spec: AgentSessionSpec): CreateAgentSessionRuntimeFactory {
    return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const policyExtension = this.#policyExtension(spec);
      const contextFiles = spec.contextFiles ? [...spec.contextFiles] : [];
      const skillPaths = [...await this.#createSkillPaths(spec.sessionId)].sort();
      const extensionFactories = policyExtension ? [policyExtension] : [];
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        ...(this.#autoCompaction
          ? { settingsManager: SettingsManager.inMemory({ compaction: { ...this.#autoCompaction } }) }
          : {}),
        modelRuntime: this.#modelRuntime,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(skillPaths.length > 0 ? { additionalSkillPaths: skillPaths } : {}),
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
        this.#emit(record, "run.started", {}, false);
        break;
      case "agent_settled":
        this.#emit(record, "run.settled", {}, false);
        break;
      case "message_start":
        this.#emit(record, "message.started", messagePayload(event.message), false);
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          this.#emit(record, "message.delta", { delta: update.delta }, true);
        } else if (update.type === "thinking_delta") {
          this.#emit(record, "message.thinking.delta", { delta: update.delta }, true);
        }
        break;
      }
      case "message_end":
        this.#emit(record, "message.completed", messagePayload(event.message), false);
        break;
      case "tool_execution_start":
        this.#emit(
          record,
          "tool.started",
          { toolCallId: event.toolCallId, toolName: event.toolName, input: event.args },
          false,
        );
        break;
      case "tool_execution_update":
        this.#emit(
          record,
          "tool.updated",
          { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult },
          true,
        );
        break;
      case "tool_execution_end":
        this.#emit(
          record,
          "tool.completed",
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            result: event.result,
          },
          false,
        );
        break;
      case "queue_update":
        record.queue = { steering: [...event.steering], followUp: [...event.followUp] };
        this.#emit(record, "queue.updated", record.queue, false);
        break;
      case "compaction_start":
        this.#emit(record, "compaction.started", { reason: event.reason }, false);
        break;
      case "compaction_end":
        this.#emit(
          record,
          "compaction.completed",
          { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry },
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

  #handle(record: SessionRecord): AgentHandle {
    const sessionFile = record.runtime.session.sessionFile;
    return {
      sessionId: record.spec.sessionId,
      upstreamSessionId: record.runtime.session.sessionId,
      ...(sessionFile ? { sessionFile } : {}),
    };
  }
}

function toRuntimeMessage(message: unknown): RuntimeMessage {
  const candidate = asRecord(message);
  return {
    role: typeof candidate["role"] === "string" ? candidate["role"] : "unknown",
    text: messageText(message),
  };
}

function messagePayload(message: unknown): Record<string, unknown> {
  const candidate = asRecord(message);
  return {
    role: typeof candidate["role"] === "string" ? candidate["role"] : "unknown",
    text: messageText(message),
  };
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
