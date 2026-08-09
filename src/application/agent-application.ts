import { randomUUID } from "node:crypto";

import type { JobDefinition, RunBudget, RunRecord } from "../automation/types.js";
import type {
  AgentRuntimePort,
  AgentSessionSpec,
  AgentSnapshot,
  RuntimeEvent,
  SessionId,
} from "../domain/runtime.js";
import type { KernelLoop } from "../kernel/loop.js";
import type { NotificationService } from "../notifications/notification-service.js";
import type { ApprovalService } from "../policy/approval-service.js";
import { CommandError } from "../protocol/errors.js";
import type { CommandEnvelope } from "../protocol/schema.js";

export interface AgentApplicationOptions {
  runtime: AgentRuntimePort;
  kernel: KernelLoop;
  approvals: ApprovalService;
  notifications: Pick<NotificationService, "list">;
  sessionTemplate: Omit<AgentSessionSpec, "sessionId">;
  modelConfigured: boolean;
  onShutdownRequested?: () => void;
  clock?: () => Date;
  idFactory?: () => string;
}

export interface AutomationControl {
  listJobs(): JobDefinition[];
  listRuns(): RunRecord[];
  putJob(value: unknown, expectedSha256: string | null): Promise<JobDefinition>;
  triggerJob(jobId: string, scheduledFor: Date, source: "user"): Promise<RunRecord>;
  cancel(runId: string, reason?: string): Promise<RunRecord>;
}

export class AgentRunBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunBudgetError";
  }
}

export class AgentApplication {
  readonly #runtime: AgentRuntimePort;
  readonly #kernel: KernelLoop;
  readonly #approvals: ApprovalService;
  readonly #notifications: Pick<NotificationService, "list">;
  readonly #sessionTemplate: Omit<AgentSessionSpec, "sessionId">;
  readonly #modelConfigured: boolean;
  readonly #onShutdownRequested: (() => void) | undefined;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #sessions = new Set<SessionId>();
  readonly #unsubscribers = new Map<SessionId, () => void>();
  readonly #sessionTails = new Map<SessionId, Promise<void>>();
  #automation: AutomationControl | undefined;

  constructor(options: AgentApplicationOptions) {
    this.#runtime = options.runtime;
    this.#kernel = options.kernel;
    this.#approvals = options.approvals;
    this.#notifications = options.notifications;
    this.#sessionTemplate = options.sessionTemplate;
    this.#modelConfigured = options.modelConfigured;
    this.#onShutdownRequested = options.onShutdownRequested;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async handleCommand(command: CommandEnvelope): Promise<unknown> {
    switch (command.type) {
      case "status.get":
        exactPayload(command.payload, [], command.type);
        return this.#kernel.snapshot();
      case "session.snapshot": {
        exactPayload(command.payload, [], command.type);
        const sessionId = requiredSessionId(command);
        return this.#sessions.has(sessionId) ? this.#runtime.snapshot(sessionId) : null;
      }
      case "session.prompt": {
        const payload = exactPayload(command.payload, ["text", "mode"], command.type);
        const text = nonEmptyString(payload["text"], "payload.text");
        const mode = optionalEnum(payload["mode"], ["prompt", "steer", "follow_up"], "payload.mode") ?? "prompt";
        const sessionId = requiredSessionId(command);
        return this.#serializeSession(sessionId, async () => {
          await this.#ensureSession(sessionId);
          if (mode === "steer") return this.#runtime.steer(sessionId, text);
          if (mode === "follow_up") return this.#runtime.followUp(sessionId, text);
          return this.#runtime.prompt(sessionId, text);
        });
      }
      case "session.abort": {
        const payload = exactPayload(command.payload, ["reason"], command.type);
        const reason = optionalString(payload["reason"], "payload.reason") ?? "user requested abort";
        const sessionId = requiredSessionId(command);
        return this.#serializeSession(sessionId, async () => {
          this.#assertSession(sessionId);
          await this.#approvals.cancelSession(sessionId);
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
          if (instructions === undefined) await this.#runtime.compact(sessionId);
          else await this.#runtime.compact(sessionId, instructions);
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
      case "job.put": {
        const payload = exactPayload(command.payload, ["job", "expectedSha256"], command.type);
        return this.#requireAutomation().putJob(
          payload["job"],
          nullableSha256(payload["expectedSha256"], "payload.expectedSha256"),
        );
      }
      case "job.run": {
        const payload = exactPayload(command.payload, ["jobId"], command.type);
        return this.#requireAutomation().triggerJob(nonEmptyString(payload["jobId"], "payload.jobId"), this.#clock(), "user");
      }
      case "run.cancel": {
        const payload = exactPayload(command.payload, ["runId", "reason"], command.type);
        return this.#requireAutomation().cancel(
          nonEmptyString(payload["runId"], "payload.runId"),
          optionalString(payload["reason"], "payload.reason"),
        );
      }
      case "daemon.shutdown":
        exactPayload(command.payload, [], command.type);
        this.#onShutdownRequested?.();
        return { draining: true };
      default:
        throw new CommandError("unknown_command", `Unknown command type: ${command.type}`);
    }
  }

  setAutomation(automation: AutomationControl): void {
    if (this.#automation) throw new Error("Automation control is already configured");
    this.#automation = automation;
  }

  executeAgentRun(run: RunRecord, signal: AbortSignal): Promise<AgentSnapshot> {
    const activity = run.activity;
    if (activity.kind !== "agent") throw new Error(`Run ${run.id} is not an agent activity`);
    const sessionId = `run:${run.id}`;
    return this.#serializeSession(sessionId, async () => {
      await this.#ensureSession(sessionId, activity.cwd, {
        agentPath: ["automation", run.jobId ?? run.source, run.id],
        runId: run.id,
        ...(run.jobId === undefined ? {} : { jobId: run.jobId }),
        allowedApprovalScopes: run.jobId === undefined ? ["once", "session"] : ["once", "session", "job"],
      });
      let turns = 0;
      let toolCalls = 0;
      let violation: AgentRunBudgetError | undefined;
      const checkBudget = (event: RuntimeEvent) => {
        if (event.type === "run.started") turns += 1;
        if (event.type === "tool.started") toolCalls += 1;
        const usage = this.#runtime.snapshot(sessionId).usage;
        const reason = budgetViolation(run.budget, { turns, toolCalls, input: usage.input, output: usage.output, cost: usage.costUsd });
        if (!reason || violation) return;
        violation = new AgentRunBudgetError(reason);
        void abortSession(reason);
      };
      const unsubscribeBudget = this.#runtime.subscribe(sessionId, checkBudget);
      let abortTask: Promise<void> | undefined;
      const abortSession = (reason: string): Promise<void> => {
        abortTask ??= Promise.allSettled([
          this.#approvals.cancelSession(sessionId),
          this.#runtime.abort(sessionId, reason),
        ]).then(() => undefined);
        return abortTask;
      };
      const abort = () => void abortSession("automation run aborted");
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Automation run aborted");
        await this.#runtime.prompt(sessionId, activity.prompt);
        await this.#runtime.waitForIdle(sessionId);
        if (violation) throw violation;
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Automation run aborted");
        const snapshot = this.#runtime.snapshot(sessionId);
        const finalViolation = budgetViolation(run.budget, {
          turns,
          toolCalls,
          input: snapshot.usage.input,
          output: snapshot.usage.output,
          cost: snapshot.usage.costUsd,
        });
        if (finalViolation) throw new AgentRunBudgetError(finalViolation);
        return snapshot;
      } finally {
        signal.removeEventListener("abort", abort);
        unsubscribeBudget();
        if (abortTask) await abortTask;
        await this.#disposeSession(sessionId);
      }
    });
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#sessionTails.values()]);
    await Promise.all([...this.#sessions].map(async (sessionId) => this.#disposeSession(sessionId)));
  }

  async #ensureSession(
    sessionId: SessionId,
    cwd?: string,
    authorization?: AgentSessionSpec["authorization"],
  ): Promise<void> {
    if (this.#sessions.has(sessionId)) return;
    if (!this.#modelConfigured) {
      throw new CommandError(
        "model_not_configured",
        "No model is configured. Set config.model.provider, config.model.model, and credentials before prompting.",
      );
    }
    await this.#runtime.create({
      sessionId,
      ...this.#sessionTemplate,
      ...(cwd === undefined ? {} : { cwd }),
      ...(authorization === undefined ? {} : { authorization }),
    });
    this.#sessions.add(sessionId);
    this.#unsubscribers.set(sessionId, this.#runtime.subscribe(sessionId, (event) => this.#onRuntimeEvent(event)));
    await this.#publishSnapshot(this.#runtime.snapshot(sessionId));
  }

  #onRuntimeEvent(event: RuntimeEvent): void {
    const snapshot = this.#runtime.snapshot(event.sessionId);
    void this.#kernel.dispatch({
      id: event.id,
      ts: event.ts,
      type: "runtime.received",
      event,
      snapshot,
    });
  }

  async #publishSnapshot(snapshot: AgentSnapshot): Promise<void> {
    await this.#kernel.dispatch({
      id: this.#idFactory(),
      ts: this.#clock().toISOString(),
      type: "session.snapshot",
      snapshot,
    });
  }

  async #disposeSession(sessionId: SessionId): Promise<void> {
    if (!this.#sessions.has(sessionId)) return;
    this.#unsubscribers.get(sessionId)?.();
    this.#unsubscribers.delete(sessionId);
    this.#sessions.delete(sessionId);
    let failure: unknown;
    try {
      await this.#runtime.dispose(sessionId);
    } catch (error) {
      failure = error;
    }
    await this.#kernel.dispatch({
      id: this.#idFactory(),
      ts: this.#clock().toISOString(),
      type: "session.closed",
      sessionId,
    });
    if (failure !== undefined) throw failure;
  }

  #assertSession(sessionId: SessionId): void {
    if (!this.#sessions.has(sessionId)) throw new CommandError("session_not_found", `Session does not exist: ${sessionId}`);
  }

  #requireAutomation(): AutomationControl {
    if (!this.#automation) throw new CommandError("automation_unavailable", "Scheduler is not initialized");
    return this.#automation;
  }

  #serializeSession<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionTails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.#sessionTails.get(sessionId) === tail) this.#sessionTails.delete(sessionId);
    });
    return result;
  }
}

function requiredSessionId(command: CommandEnvelope): string {
  if (!command.sessionId) throw new CommandError("invalid_command", `${command.type} requires sessionId`);
  return command.sessionId;
}

function exactPayload(value: unknown, allowed: readonly string[], type: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError("invalid_command", `${type} payload must be an object`);
  }
  const record = value as Record<string, unknown>;
  const accepted = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !accepted.has(key));
  if (unknown.length > 0) {
    throw new CommandError("invalid_command", `${type} payload contains unknown fields: ${unknown.join(", ")}`);
  }
  return record;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CommandError("invalid_command", `${path} must be non-empty`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, path);
}

function optionalEnum<const T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CommandError("invalid_command", `${path} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new CommandError("invalid_command", `${path} must be boolean`);
  return value;
}

function nullableSha256(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new CommandError("invalid_command", `${path} must be null or a 64-character SHA-256`);
  }
  return value.toLowerCase();
}

function budgetViolation(
  budget: RunBudget,
  usage: { turns: number; toolCalls: number; input: number; output: number; cost: number },
): string | undefined {
  if (usage.turns > budget.maxTurns) return `maxTurns exceeded: ${usage.turns}/${budget.maxTurns}`;
  if (usage.toolCalls > budget.maxToolCalls) return `maxToolCalls exceeded: ${usage.toolCalls}/${budget.maxToolCalls}`;
  if (usage.input > budget.maxInputTokens) return `maxInputTokens exceeded: ${usage.input}/${budget.maxInputTokens}`;
  if (usage.output > budget.maxOutputTokens) return `maxOutputTokens exceeded: ${usage.output}/${budget.maxOutputTokens}`;
  if (budget.maxCostUsd !== undefined && usage.cost > budget.maxCostUsd) {
    return `maxCostUsd exceeded: ${usage.cost}/${budget.maxCostUsd}`;
  }
  return undefined;
}
