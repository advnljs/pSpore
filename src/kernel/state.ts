import type { AgentSnapshot, RuntimeEvent } from "../domain/runtime.js";
import type { AgentMessage, AgentRecord } from "../agents/types.js";
import type { RunRecord } from "../automation/types.js";
import type { NotificationRecord } from "../notifications/notification-service.js";
import type { McpHealthRecord } from "../mcp/types.js";
import type { ResourceHealthRecord } from "../plugins/types.js";
import type { ApprovalRequest, ApprovalResolution } from "../policy/approval-service.js";

export type DaemonPhase = "starting" | "ready" | "degraded" | "draining" | "failed" | "stopped";

export interface DaemonSnapshot {
  phase: DaemonPhase;
  instanceId?: string;
  startedAt?: string;
  error?: string;
}

export interface KernelState {
  revision: number;
  daemon: DaemonSnapshot;
  sessions: Readonly<Record<string, AgentSnapshot>>;
  approvals: Readonly<Record<string, ApprovalRequest>>;
  runs: Readonly<Record<string, RunRecord>>;
  notifications: readonly NotificationRecord[];
  agents: Readonly<Record<string, AgentRecord>>;
  agentMessages: readonly AgentMessage[];
  mcpServers: Readonly<Record<string, McpHealthRecord>>;
  resources: Readonly<Record<string, ResourceHealthRecord>>;
}

interface EventMetadata {
  id: string;
  ts: string;
  correlationId?: string;
  causationId?: string;
}

export type KernelEvent =
  | (EventMetadata & { type: "daemon.transition"; daemon: DaemonSnapshot })
  | (EventMetadata & { type: "session.snapshot"; snapshot: AgentSnapshot })
  | (EventMetadata & { type: "session.closed"; sessionId: string })
  | (EventMetadata & { type: "runtime.received"; event: RuntimeEvent; snapshot?: AgentSnapshot })
  | (EventMetadata & { type: "approval.requested"; request: ApprovalRequest })
  | (EventMetadata & { type: "automation.run"; run: RunRecord })
  | (EventMetadata & { type: "notification.created"; notification: NotificationRecord })
  | (EventMetadata & { type: "agent.updated"; agent: AgentRecord })
  | (EventMetadata & { type: "agent.message"; message: AgentMessage })
  | (EventMetadata & { type: "mcp.health"; health: McpHealthRecord })
  | (EventMetadata & { type: "resource.health"; health: ResourceHealthRecord })
  | (EventMetadata & {
      type: "approval.resolved";
      request: ApprovalRequest;
      resolution: ApprovalResolution | { interrupted: true };
    });

export interface PublicKernelEvent {
  id: string;
  ts: string;
  correlationId?: string;
  causationId?: string;
  durable: boolean;
  type: string;
  payload: Readonly<Record<string, unknown>>;
}

export type KernelEffect = { type: "client.broadcast"; event: PublicKernelEvent };

export interface Reduction {
  state: KernelState;
  effects: readonly KernelEffect[];
}

export function initialKernelState(): KernelState {
  return {
    revision: 0,
    daemon: { phase: "starting" },
    sessions: {},
    approvals: {},
    runs: {},
    notifications: [],
    agents: {},
    agentMessages: [],
    mcpServers: {},
    resources: {},
  };
}
