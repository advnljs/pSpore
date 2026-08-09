import { randomUUID } from "node:crypto";

import type {
  AgentRuntimePort,
  AgentSessionSpec,
  AgentSnapshot,
  RuntimeEvent,
  SessionId,
} from "../domain/runtime.js";
import type { KernelLoop } from "../kernel/loop.js";
import type { ApprovalService } from "../policy/approval-service.js";
import { CommandError } from "../protocol/errors.js";
import type { CommandEnvelope } from "../protocol/schema.js";

export interface AgentApplicationOptions {
  runtime: AgentRuntimePort;
  kernel: KernelLoop;
  approvals: ApprovalService;
  sessionTemplate: Omit<AgentSessionSpec, "sessionId">;
  modelConfigured: boolean;
  onShutdownRequested?: () => void;
  clock?: () => Date;
  idFactory?: () => string;
}

export class AgentApplication {
  readonly #runtime: AgentRuntimePort;
  readonly #kernel: KernelLoop;
  readonly #approvals: ApprovalService;
  readonly #sessionTemplate: Omit<AgentSessionSpec, "sessionId">;
  readonly #modelConfigured: boolean;
  readonly #onShutdownRequested: (() => void) | undefined;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #sessions = new Set<SessionId>();
  readonly #unsubscribers = new Map<SessionId, () => void>();
  readonly #sessionTails = new Map<SessionId, Promise<void>>();

  constructor(options: AgentApplicationOptions) {
    this.#runtime = options.runtime;
    this.#kernel = options.kernel;
    this.#approvals = options.approvals;
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
      case "daemon.shutdown":
        exactPayload(command.payload, [], command.type);
        this.#onShutdownRequested?.();
        return { draining: true };
      default:
        throw new CommandError("unknown_command", `Unknown command type: ${command.type}`);
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#sessionTails.values()]);
    for (const unsubscribe of this.#unsubscribers.values()) unsubscribe();
    this.#unsubscribers.clear();
    await Promise.all([...this.#sessions].map(async (sessionId) => this.#runtime.dispose(sessionId)));
    this.#sessions.clear();
  }

  async #ensureSession(sessionId: SessionId): Promise<void> {
    if (this.#sessions.has(sessionId)) return;
    if (!this.#modelConfigured) {
      throw new CommandError(
        "model_not_configured",
        "No model is configured. Set config.model.provider, config.model.model, and credentials before prompting.",
      );
    }
    await this.#runtime.create({ sessionId, ...this.#sessionTemplate });
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

  #assertSession(sessionId: SessionId): void {
    if (!this.#sessions.has(sessionId)) throw new CommandError("session_not_found", `Session does not exist: ${sessionId}`);
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
