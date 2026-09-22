import type { ArticleStore } from "../articles/store.js";
import type { AgentSessionHost } from "../agents/agent-manager.js";
import type { AgentMessage, AgentMessageMode, AgentRecord, AgentSpawnRequest } from "../agents/types.js";
import type { JobDefinition, RunBudget, RunRecord } from "../automation/types.js";
import type { AgentRuntimePort, AgentSessionSpec, RuntimeEvent, SessionView } from "../domain/runtime.js";
import type { KernelLoop } from "../kernel/loop.js";
import type { McpHealthRecord, McpToolDescriptor } from "../mcp/types.js";
import type { NotificationService } from "../notifications/notification-service.js";
import type { ApprovalService } from "../policy/approval-service.js";
import type { ResourceCatalogEntry, ResourceKind, SkillCatalogEntry, StagedResourceInspection } from "../plugins/types.js";
import type { CommandEnvelope } from "../protocol/schema.js";
import type { SessionCatalog } from "../sessions/session-catalog.js";
/** What a client is told about one fixed tool. */
export interface BuiltinToolSummary {
    name: string;
    label?: string;
    description?: string;
}
export interface AgentApplicationOptions {
    runtime: AgentRuntimePort;
    kernel: KernelLoop;
    approvals: ApprovalService;
    notifications: Pick<NotificationService, "list">;
    sessionCatalog: SessionCatalog;
    sessionTemplate: Omit<AgentSessionSpec, "sessionId">;
    modelConfigured: boolean;
    /**
     * The fixed tools every session is given. Supplied as a list rather than read
     * off a session, because a client asks what this build can do before it has
     * created one.
     */
    builtinTools: readonly {
        name: string;
        label?: string;
        description?: string;
    }[];
    onShutdownRequested?: () => void;
    /** Article panel storage. Commands that read it fail closed when it was not wired. */
    articles?: ArticleStore;
    clock?: () => Date;
    idFactory?: () => string;
    onError?: (error: Error) => void;
}
export interface AutomationControl {
    listJobs(): JobDefinition[];
    listRuns(): RunRecord[];
    putJob(value: unknown, expectedSha256: string | null): Promise<JobDefinition>;
    triggerJob(jobId: string, scheduledFor: Date, source: "user"): Promise<RunRecord>;
    cancel(runId: string, reason?: string): Promise<RunRecord>;
}
export interface AgentControl {
    registerRoot(input: {
        id: string;
        budget?: RunBudget;
        jobId?: string;
        agentPath?: readonly string[];
    }): void;
    unregisterRoot(id: string): void;
    parentIdForSession(sessionId: string): string;
    spawn(input: AgentSpawnRequest): Promise<AgentRecord>;
    send(input: {
        senderId: string;
        recipientId: string;
        text: string;
        mode: AgentMessageMode;
        priority?: "normal" | "high";
        correlationId?: string;
    }): Promise<AgentMessage>;
    join(agentIds: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<AgentRecord[]>;
    cancel(agentId: string, reason?: string): Promise<AgentRecord>;
    cancelChildren(parentId: string, reason: string): Promise<void>;
    sessionAvailable(sessionId: string): Promise<void>;
    list(): AgentRecord[];
    listMessages(): AgentMessage[];
}
export interface McpControl {
    listServers(): McpHealthRecord[];
    listTools(): McpToolDescriptor[];
    discover(serverId: string, signal?: AbortSignal): Promise<McpToolDescriptor[]>;
    ping(serverId: string, signal?: AbortSignal): Promise<McpHealthRecord>;
}
export interface ResourceControl {
    inspect(stagingPath: string): Promise<StagedResourceInspection>;
    install(stagingPath: string, expectedDigest: string): Promise<ResourceCatalogEntry>;
    disable(kind: ResourceKind, name: string, expectedDigest: string): Promise<ResourceCatalogEntry>;
    list(): ResourceCatalogEntry[];
    skillCatalog(): Promise<SkillCatalogEntry[]>;
}
export declare class AgentRunBudgetError extends Error {
    constructor(message: string);
}
export declare class AgentApplication implements AgentSessionHost {
    #private;
    constructor(options: AgentApplicationOptions);
    handleCommand(command: CommandEnvelope): Promise<unknown>;
    setAutomation(automation: AutomationControl): void;
    setAgents(agents: AgentControl): void;
    restoreRootSessions(): Promise<Error[]>;
    setMcp(mcp: McpControl): void;
    setResources(resources: ResourceControl): void;
    executeAgentRun(run: RunRecord, signal: AbortSignal): Promise<SessionView>;
    createAgentSession(sessionId: string, cwd: string, authorization: NonNullable<AgentSessionSpec["authorization"]>): Promise<void>;
    hasAgentSession(sessionId: string): boolean;
    startAgentPrompt(sessionId: string, text: string): Promise<void>;
    sendAgentMessage(sessionId: string, text: string, mode: AgentMessageMode): Promise<void>;
    waitForAgentIdle(sessionId: string): Promise<void>;
    abortAgentSession(sessionId: string, reason: string): Promise<void>;
    snapshotAgentSession(sessionId: string): SessionView;
    subscribeAgentSession(sessionId: string, sink: (event: RuntimeEvent) => void): () => void;
    closeAgentSession(sessionId: string): Promise<void>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=agent-application.d.ts.map