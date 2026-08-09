import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ToolAuthorizationRequest, ToolAuthorizationResult, ToolGate } from "../domain/runtime.js";
import { appendJsonLine, atomicWriteJson } from "../storage/atomic.js";
import type { Capability, PolicyEngine, PolicyEvaluation } from "./policy.js";

export type ApprovalScope = "once" | "session" | "job";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  agentPath: string[];
  toolCallId: string;
  capability: Capability;
  canonicalTarget?: string;
  display: {
    summary: string;
    command?: string;
    cwd?: string;
  };
  riskReasons: string[];
  requestedAt: string;
  expiresAt: string;
  allowedScopes: ApprovalScope[];
}

export interface ApprovalResolution {
  approved: boolean;
  scope: ApprovalScope;
  actor: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (resolution: ApprovalResolution) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalServiceOptions {
  pendingPath: string;
  auditPath: string;
  timeoutMs: number;
  clock?: () => Date;
  idFactory?: () => string;
  onRequested?: (request: ApprovalRequest) => void;
  onResolved?: (request: ApprovalRequest, resolution: ApprovalResolution | { interrupted: true }) => void;
}

export class ApprovalService {
  readonly #pendingPath: string;
  readonly #auditPath: string;
  readonly #timeoutMs: number;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #onRequested: ((request: ApprovalRequest) => void) | undefined;
  readonly #onResolved: ApprovalServiceOptions["onResolved"] | undefined;
  readonly #pending = new Map<string, PendingApproval>();
  readonly #resolved = new Set<string>();
  #mutation = Promise.resolve();

  constructor(options: ApprovalServiceOptions) {
    this.#pendingPath = options.pendingPath;
    this.#auditPath = options.auditPath;
    this.#timeoutMs = options.timeoutMs;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#onRequested = options.onRequested;
    this.#onResolved = options.onResolved;
  }

  async initialize(): Promise<void> {
    const recovered = await readPending(this.#pendingPath);
    for (const request of recovered) {
      await this.#audit(request, { interrupted: true });
      notifyObserver(() => this.#onResolved?.(request, { interrupted: true }));
    }
    await atomicWriteJson(this.#pendingPath, { version: 1, approvals: [] }, 0o600);
  }

  async request(input: Omit<ApprovalRequest, "id" | "requestedAt" | "expiresAt">): Promise<ApprovalResolution> {
    const requestedAt = this.#clock();
    const request: ApprovalRequest = {
      ...input,
      id: this.#idFactory(),
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(requestedAt.getTime() + this.#timeoutMs).toISOString(),
    };
    let resolveWaiter!: (resolution: ApprovalResolution) => void;
    const waiter = new Promise<ApprovalResolution>((resolve) => {
      resolveWaiter = resolve;
    });
    await this.#serialize(async () => {
      const timer = setTimeout(() => void this.#expire(request.id), this.#timeoutMs);
      timer.unref();
      this.#pending.set(request.id, { request, resolve: resolveWaiter, timer });
      try {
        await this.#persist();
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(request.id);
        throw error;
      }
      notifyObserver(() => this.#onRequested?.(request));
    });
    return waiter;
  }

  async resolve(
    id: string,
    resolution: ApprovalResolution,
  ): Promise<{ status: "resolved" | "already_resolved" | "not_found" }> {
    return this.#serialize(async () => {
      const pending = this.#pending.get(id);
      if (!pending) return { status: this.#resolved.has(id) ? "already_resolved" : "not_found" };
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      this.#resolved.add(id);
      try {
        await this.#persist();
        await this.#audit(pending.request, resolution);
        notifyObserver(() => this.#onResolved?.(pending.request, resolution));
        pending.resolve(resolution);
      } catch (error) {
        const failed: ApprovalResolution = {
          approved: false,
          scope: "once",
          actor: "approval-persistence-failed",
        };
        notifyObserver(() => this.#onResolved?.(pending.request, failed));
        pending.resolve(failed);
        throw error;
      }
      return { status: "resolved" };
    });
  }

  list(): ApprovalRequest[] {
    return [...this.#pending.values()].map((pending) => structuredClone(pending.request));
  }

  async cancelSession(sessionId: string): Promise<void> {
    const ids = this.list()
      .filter((request) => request.sessionId === sessionId)
      .map((request) => request.id);
    for (const id of ids) {
      await this.resolve(id, { approved: false, scope: "once", actor: "session-abort" });
    }
  }

  async close(): Promise<void> {
    for (const request of this.list()) {
      await this.resolve(request.id, { approved: false, scope: "once", actor: "daemon-shutdown" });
    }
  }

  async #expire(id: string): Promise<void> {
    await this.resolve(id, { approved: false, scope: "once", actor: "approval-timeout" });
  }

  async #persist(): Promise<void> {
    await atomicWriteJson(this.#pendingPath, { version: 1, approvals: this.list() }, 0o600);
  }

  async #audit(request: ApprovalRequest, resolution: ApprovalResolution | { interrupted: true }): Promise<void> {
    const command = request.display.command ?? "";
    await appendJsonLine(
      this.#auditPath,
      {
        version: 1,
        id: this.#idFactory(),
        approvalId: request.id,
        sessionId: request.sessionId,
        capability: request.capability,
        canonicalTarget: request.canonicalTarget ?? null,
        commandHash: command ? createHash("sha256").update(command).digest("hex") : null,
        resolution,
        ts: this.#clock().toISOString(),
      },
      0o600,
    );
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class PolicyToolGate implements ToolGate {
  readonly #policy: PolicyEngine;
  readonly #approvals: ApprovalService;
  readonly #sessionGrants = new Set<string>();

  constructor(policy: PolicyEngine, approvals: ApprovalService) {
    this.#policy = policy;
    this.#approvals = approvals;
  }

  async authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult> {
    const evaluation = await this.#policy.evaluate(request);
    const grantKey = policyGrantKey(request.sessionId, evaluation);
    if (this.#sessionGrants.has(grantKey)) return { decision: "allow" };
    if (evaluation.decision === "allow") return { decision: "allow" };
    if (evaluation.decision === "deny") {
      return { decision: "deny", reason: "Denied by pSpore policy", terminate: false };
    }

    const resolution = await this.#approvals.request({
      sessionId: request.sessionId,
      agentPath: ["main"],
      toolCallId: request.toolCallId,
      capability: evaluation.capability,
      ...(evaluation.canonicalTarget ? { canonicalTarget: evaluation.canonicalTarget } : {}),
      display: {
        summary: evaluation.summary,
        ...(evaluation.command ? { command: evaluation.command } : {}),
        ...(evaluation.cwd ? { cwd: evaluation.cwd } : {}),
      },
      riskReasons: evaluation.riskReasons,
      allowedScopes: ["once", "session"],
    });
    if (!resolution.approved) {
      return { decision: "deny", reason: `Approval denied by ${resolution.actor}`, terminate: false };
    }
    if (resolution.scope === "session") this.#sessionGrants.add(grantKey);
    return { decision: "allow" };
  }
}

function policyGrantKey(sessionId: string, evaluation: PolicyEvaluation): string {
  return `${sessionId}\0${evaluation.capability}\0${evaluation.canonicalTarget ?? ""}`;
}

async function readPending(path: string): Promise<ApprovalRequest[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["approvals"])) return [];
    return value["approvals"].filter(isApprovalRequest);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function isApprovalRequest(value: unknown): value is ApprovalRequest {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["sessionId"] === "string" &&
    typeof value["toolCallId"] === "string" &&
    typeof value["capability"] === "string" &&
    typeof value["requestedAt"] === "string" &&
    typeof value["expiresAt"] === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function notifyObserver(observer: () => void): void {
  try {
    observer();
  } catch {
    // Observers cannot change approval persistence or the first-resolution result.
  }
}
