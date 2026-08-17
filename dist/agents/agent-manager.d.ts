import type { RunBudget } from "../automation/types.js";
import type { AgentSessionSpec, AgentSnapshot, RuntimeEvent } from "../domain/runtime.js";
import type { AgentMessage, AgentMessageMode, AgentRecord, AgentSpawnRequest } from "./types.js";
export interface AgentSessionHost {
    createAgentSession(sessionId: string, cwd: string, authorization: NonNullable<AgentSessionSpec["authorization"]>): Promise<void>;
    hasAgentSession(sessionId: string): boolean;
    startAgentPrompt(sessionId: string, text: string): Promise<void>;
    sendAgentMessage(sessionId: string, text: string, mode: AgentMessageMode): Promise<void>;
    waitForAgentIdle(sessionId: string): Promise<void>;
    abortAgentSession(sessionId: string, reason: string): Promise<void>;
    snapshotAgentSession(sessionId: string): AgentSnapshot;
    subscribeAgentSession(sessionId: string, sink: (event: RuntimeEvent) => void): () => void;
    closeAgentSession(sessionId: string): Promise<void>;
}
export interface AgentManagerOptions {
    workspaceRoot: string;
    host: AgentSessionHost;
    maxConcurrentAgents: number;
    maxDepth?: number;
    maxChildrenPerParent?: number;
    defaultRootBudget?: RunBudget;
    clock?: () => Date;
    idFactory?: () => string;
    onAgent?: (agent: AgentRecord) => void;
    onMessage?: (message: AgentMessage) => void;
    onError?: (error: Error) => void;
}
export declare class AgentManager {
    #private;
    private constructor();
    static create(options: AgentManagerOptions): Promise<AgentManager>;
    registerRoot(input: {
        id: string;
        budget: RunBudget;
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
    stop(): Promise<void>;
}
//# sourceMappingURL=agent-manager.d.ts.map