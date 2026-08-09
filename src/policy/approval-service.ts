import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ToolAuthorizationRequest, ToolAuthorizationResult, ToolGate } from "../domain/runtime.js";
import { appendJsonLine, atomicWriteJson } from "../storage/atomic.js";
import type { Capability, PolicyEngine, PolicyEvaluation } from "./policy.js";

export type ApprovalScope = "once" | "session" | "job";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  agentPath: string[];
  toolCallId: string;
  runId?: string;
  jobId?: string;
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

export interface JobGrant {
  version: 1;
  id: string;
  jobId: string;
  capability: Capability;
  canonicalTarget?: string;
  actor: string;
  createdAt: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (resolution: ApprovalResolution) => void;
  timer: NodeJS.Timeout;
}

export interface ApprovalServiceOptions {
  pendingPath: string;
  auditPath: string;
  grantsPath?: string;
  timeoutMs: number;
  clock?: () => Date;
  idFactory?: () => string;
  onRequested?: (request: ApprovalRequest) => void;
  onResolved?: (request: ApprovalRequest, resolution: ApprovalResolution | { interrupted: true }) => void;
}

export class ApprovalService {
  readonly #pendingPath: string;
  readonly #auditPath: string;
  readonly #grantsPath: string;
  readonly #timeoutMs: number;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #onRequested: ((request: ApprovalRequest) => void) | undefined;
  readonly #onResolved: ApprovalServiceOptions["onResolved"] | undefined;
  readonly #pending = new Map<string, PendingApproval>();
  readonly #resolved = new Set<string>();
  readonly #jobGrants = new Map<string, JobGrant>();
  #mutation = Promise.resolve();

  constructor(options: ApprovalServiceOptions) {
    this.#pendingPath = options.pendingPath;
    this.#auditPath = options.auditPath;
    this.#grantsPath = options.grantsPath ?? join(dirname(options.pendingPath), "job-grants.json");
    this.#timeoutMs = options.timeoutMs;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#onRequested = options.onRequested;
    this.#onResolved = options.onResolved;
  }

  async initialize(): Promise<void> {
    const grants = await readJobGrants(this.#grantsPath);
    this.#jobGrants.clear();
    for (const grant of grants) {
      const key = jobGrantKey(grant.jobId, grant);
      if (this.#jobGrants.has(key)) throw new Error(`Duplicate durable job grant: ${grant.jobId}/${grant.capability}`);
      this.#jobGrants.set(key, grant);
    }
    const recovered = await readPending(this.#pendingPath);
    for (const request of recovered) {
      await this.#audit(request, { interrupted: true });
      notifyObserver(() => this.#onResolved?.(request, { interrupted: true }));
    }
    await atomicWriteJson(this.#pendingPath, { version: 1, approvals: [] }, 0o600);
    await this.#persistJobGrants();
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
  ): Promise<{ status: "resolved" | "already_resolved" | "not_found" | "invalid_scope" }> {
    return this.#serialize(async () => {
      const pending = this.#pending.get(id);
      if (!pending) return { status: this.#resolved.has(id) ? "already_resolved" : "not_found" };
      if (!pending.request.allowedScopes.includes(resolution.scope)) return { status: "invalid_scope" };
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      this.#resolved.add(id);
      try {
        await this.#persist();
        await this.#audit(pending.request, resolution);
        if (resolution.approved && resolution.scope === "job") {
          if (!pending.request.jobId) throw new Error("Job-scoped approval is missing jobId");
          const grant: JobGrant = {
            version: 1,
            id: this.#idFactory(),
            jobId: pending.request.jobId,
            capability: pending.request.capability,
            ...(pending.request.canonicalTarget === undefined
              ? {}
              : { canonicalTarget: pending.request.canonicalTarget }),
            actor: resolution.actor,
            createdAt: this.#clock().toISOString(),
          };
          const key = jobGrantKey(grant.jobId, grant);
          const previous = this.#jobGrants.get(key);
          this.#jobGrants.set(key, grant);
          try {
            await this.#persistJobGrants();
          } catch (error) {
            if (previous) this.#jobGrants.set(key, previous);
            else this.#jobGrants.delete(key);
            throw error;
          }
        }
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

  listJobGrants(): JobGrant[] {
    return [...this.#jobGrants.values()].map((grant) => structuredClone(grant));
  }

  hasJobGrant(jobId: string, evaluation: Pick<PolicyEvaluation, "capability" | "canonicalTarget">): boolean {
    return this.#jobGrants.has(jobGrantKey(jobId, evaluation));
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

  async #persistJobGrants(): Promise<void> {
    await atomicWriteJson(this.#grantsPath, { version: 1, grants: this.listJobGrants() }, 0o600);
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
        runId: request.runId ?? null,
        jobId: request.jobId ?? null,
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
    if (request.deniedCapabilities?.includes(evaluation.capability)) {
      return { decision: "deny", reason: "Denied by parent agent permission ceiling", terminate: false };
    }
    if (evaluation.decision === "deny") {
      return { decision: "deny", reason: "Denied by pSpore policy", terminate: false };
    }
    if (evaluation.decision === "allow") return { decision: "allow" };

    const grantKey = policyGrantKey(request.sessionId, evaluation);
    if (this.#sessionGrants.has(grantKey)) return { decision: "allow" };
    if (request.jobId && this.#approvals.hasJobGrant(request.jobId, evaluation)) return { decision: "allow" };

    const allowedScopes = normalizeAllowedScopes(request.allowedApprovalScopes, request.jobId);

    const resolution = await this.#approvals.request({
      sessionId: request.sessionId,
      agentPath: [...(request.agentPath ?? ["main"])],
      toolCallId: request.toolCallId,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
      capability: evaluation.capability,
      ...(evaluation.canonicalTarget ? { canonicalTarget: evaluation.canonicalTarget } : {}),
      display: {
        summary: evaluation.summary,
        ...(evaluation.command ? { command: evaluation.command } : {}),
        ...(evaluation.cwd ? { cwd: evaluation.cwd } : {}),
      },
      riskReasons: evaluation.riskReasons,
      allowedScopes,
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

function jobGrantKey(
  jobId: string,
  evaluation: Pick<PolicyEvaluation, "capability" | "canonicalTarget">,
): string {
  return `${jobId}\0${evaluation.capability}\0${evaluation.canonicalTarget ?? ""}`;
}

function normalizeAllowedScopes(
  requested: readonly ApprovalScope[] | undefined,
  jobId: string | undefined,
): ApprovalScope[] {
  const scopes = requested ?? ["once", "session"];
  const allowed = new Set<ApprovalScope>(["once"]);
  for (const scope of scopes) {
    if (scope === "once" || scope === "session" || (scope === "job" && jobId !== undefined)) allowed.add(scope);
  }
  return [...allowed];
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

async function readJobGrants(path: string): Promise<JobGrant[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["grants"])) {
      throw new Error(`Invalid durable job grant store: ${path}`);
    }
    return value["grants"].map((grant, index) => parseJobGrant(grant, `${path}.grants[${index}]`));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function parseJobGrant(value: unknown, path: string): JobGrant {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const allowed = new Set(["version", "id", "jobId", "capability", "canonicalTarget", "actor", "createdAt"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown keys: ${unknown.join(", ")}`);
  if (value["version"] !== 1) throw new Error(`${path}.version must be 1`);
  const capability = value["capability"];
  if (!isCapability(capability)) throw new Error(`${path}.capability is invalid`);
  const canonicalTarget = value["canonicalTarget"];
  if (canonicalTarget !== undefined && typeof canonicalTarget !== "string") {
    throw new Error(`${path}.canonicalTarget must be a string`);
  }
  const grant: JobGrant = {
    version: 1,
    id: requiredString(value["id"], `${path}.id`),
    jobId: requiredString(value["jobId"], `${path}.jobId`),
    capability,
    actor: requiredString(value["actor"], `${path}.actor`),
    createdAt: requiredString(value["createdAt"], `${path}.createdAt`),
  };
  return canonicalTarget === undefined ? grant : { ...grant, canonicalTarget };
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

const CAPABILITIES = new Set<Capability>([
  "fs.read",
  "fs.write",
  "fs.delete",
  "process.exec",
  "process.signal",
  "process.pty",
  "network.connect",
  "network.publish",
  "privilege.escalate",
  "schedule.read",
  "schedule.write",
  "agent.spawn",
  "agent.message",
  "memory.read",
  "memory.write",
  "external.side_effect",
]);

function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && CAPABILITIES.has(value as Capability);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
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
