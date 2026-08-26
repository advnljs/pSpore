export type SessionId = string;
export interface ModelRef {
    provider: string;
    model: string;
}
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface PinnedContextFile {
    path: string;
    content: string;
}
export interface AgentSessionSpec {
    sessionId: SessionId;
    workspaceId: string;
    cwd: string;
    model?: ModelRef;
    thinking?: ThinkingLevel;
    systemPrompt?: string;
    contextFiles?: readonly PinnedContextFile[];
    enabledTools?: readonly string[];
    authorization?: {
        agentPath: readonly string[];
        runId?: string;
        jobId?: string;
        allowedApprovalScopes: readonly ("once" | "session" | "job")[];
        deniedCapabilities?: readonly string[];
    };
}
export interface ResumeSessionSpec extends AgentSessionSpec {
    sessionFile: string;
}
export interface AgentHandle {
    sessionId: SessionId;
    upstreamSessionId: string;
    sessionFile?: string;
}
export interface Accepted {
    accepted: true;
    commandId: string;
    acceptedAt: string;
}
export interface RuntimeUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    costUsd: number;
}
export interface RuntimeMessage {
    id?: string;
    role: string;
    text: string;
}
export interface RuntimeQueueSnapshot {
    steering: readonly string[];
    followUp: readonly string[];
}
export interface RootSessionMetadata {
    title: string;
    createdAt: string;
    updatedAt: string;
}
export interface AgentSnapshot {
    sessionId: SessionId;
    upstreamSessionId: string;
    sessionFile?: string;
    cwd: string;
    status: "idle" | "running" | "failed";
    model?: ModelRef;
    thinking: ThinkingLevel;
    messages: readonly RuntimeMessage[];
    entries: readonly RuntimeMessage[];
    queue: RuntimeQueueSnapshot;
    usage: RuntimeUsage;
    rootSession?: RootSessionMetadata;
    lastError?: string;
}
export type RuntimeEventType = "session.replaced" | "run.started" | "run.settled" | "message.started" | "message.delta" | "message.thinking.delta" | "message.completed" | "tool.started" | "tool.updated" | "tool.completed" | "queue.updated" | "compaction.started" | "compaction.completed" | "retry.started" | "retry.completed" | "runtime.error";
export interface RuntimeEvent {
    id: string;
    sessionId: SessionId;
    upstreamSessionId: string;
    type: RuntimeEventType;
    ts: string;
    transient: boolean;
    payload: Readonly<Record<string, unknown>>;
}
export interface ToolAuthorizationRequest {
    sessionId: SessionId;
    toolCallId: string;
    toolName: string;
    input: Readonly<Record<string, unknown>>;
    agentPath?: readonly string[];
    runId?: string;
    jobId?: string;
    allowedApprovalScopes?: readonly ("once" | "session" | "job")[];
    deniedCapabilities?: readonly string[];
}
export type ToolAuthorizationResult = {
    decision: "allow";
} | {
    decision: "deny";
    reason: string;
    terminate?: boolean;
};
export interface ToolGate {
    authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult>;
}
export interface AgentRuntimePort {
    create(spec: AgentSessionSpec): Promise<AgentHandle>;
    resume(spec: ResumeSessionSpec): Promise<AgentHandle>;
    prompt(sessionId: SessionId, input: string): Promise<Accepted>;
    steer(sessionId: SessionId, input: string): Promise<Accepted>;
    followUp(sessionId: SessionId, input: string): Promise<Accepted>;
    promoteFollowUp(sessionId: SessionId, index: number): Promise<Accepted>;
    abort(sessionId: SessionId, reason: string): Promise<void>;
    compact(sessionId: SessionId, instructions?: string): Promise<void>;
    snapshot(sessionId: SessionId): AgentSnapshot;
    subscribe(sessionId: SessionId, sink: (event: RuntimeEvent) => void): () => void;
    waitForIdle(sessionId: SessionId): Promise<void>;
    dispose(sessionId: SessionId): Promise<void>;
}
//# sourceMappingURL=runtime.d.ts.map