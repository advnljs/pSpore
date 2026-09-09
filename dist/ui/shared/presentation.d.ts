import type { KernelState } from "../../kernel/state.js";
import type { AgentRecord } from "../../agents/types.js";
export interface SessionListItem {
    id: string;
    sessionId: string;
    title: string;
    status: string;
    depth: number;
    selected: boolean;
    active: boolean;
    kind: "main" | "agent";
    /** When the session was created, for display and ordering; absent for a placeholder. */
    createdAt?: string;
}
export interface KernelMetrics {
    sessions: number;
    runningSessions: number;
    pendingApprovals: number;
    runs: number;
    activeRuns: number;
    readyMcpServers: number;
    mcpServers: number;
    activeResources: number;
    resources: number;
}
export type ComposerMode = "auto" | "prompt" | "steer" | "follow_up";
export type ConversationIntent = {
    target: "main";
    sessionId: string;
    text: string;
    mode: ComposerMode;
} | {
    target: "agent";
    agentId: string;
    sessionId: string;
    text: string;
    mode: "next" | "steer" | "follow_up";
};
export declare function presentSessions(kernel: KernelState, selectedSessionId: string): SessionListItem[];
export declare function kernelMetrics(kernel: KernelState): KernelMetrics;
export declare function selectedAgent(kernel: KernelState, selectedSessionId: string): AgentRecord | undefined;
export declare function conversationIntent(kernel: KernelState, selectedSessionId: string, text: string, mode: ComposerMode): ConversationIntent;
export declare function terminalAgentStatus(value: string): boolean;
export declare function shortId(value: string): string;
export declare function formatTokens(value: number): string;
export declare function formatBytes(value: number): string;
/**
 * A timestamp for a list row, where the column is narrow and the reader mostly
 * wants to know "how recent". Today shows the time, this year the date, and
 * anything older the year as well, so no two rows are ambiguous.
 */
export declare function listTime(value: string, now?: Date): string;
export declare function clockTime(value: string): string;
//# sourceMappingURL=presentation.d.ts.map