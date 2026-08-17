import type { McpCallOutput, McpHealthRecord, McpServerConfig, McpToolDescriptor } from "./types.js";
export interface McpRemoteTool {
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, unknown> & {
        type: "object";
    };
    annotations?: McpToolDescriptor["annotations"];
}
export interface McpConnection {
    listTools(cursor: string | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<{
        tools: McpRemoteTool[];
        nextCursor?: string;
    }>;
    callTool(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown>;
    ping(signal: AbortSignal | undefined, timeoutMs: number): Promise<void>;
    close(): Promise<void>;
}
export interface McpConnectionFactoryContext {
    signal: AbortSignal;
    timeoutMs: number;
    environment: Readonly<Record<string, string | undefined>>;
    onClose: () => void;
    onError: (error: Error) => void;
}
export type McpConnectionFactory = (config: McpServerConfig, context: McpConnectionFactoryContext) => Promise<McpConnection>;
export interface McpManagerOptions {
    configs: readonly McpServerConfig[];
    artifactRoot: string;
    auditPath: string;
    environment?: Readonly<Record<string, string | undefined>>;
    connectionFactory?: McpConnectionFactory;
    maxResultBytes?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    connectTimeoutMs?: number;
    clock?: () => Date;
    idFactory?: () => string;
    onHealth?: (health: McpHealthRecord) => void;
    onError?: (error: Error) => void;
}
export declare class McpManager {
    #private;
    private constructor();
    static create(options: McpManagerOptions): Promise<McpManager>;
    listServers(): McpHealthRecord[];
    listTools(): McpToolDescriptor[];
    discover(serverId: string, signal?: AbortSignal): Promise<McpToolDescriptor[]>;
    ping(serverId: string, signal?: AbortSignal): Promise<McpHealthRecord>;
    call(serverId: string, toolName: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<McpCallOutput>;
    stop(): Promise<void>;
}
export declare function normalizeMcpToolName(serverId: string, toolName: string): string;
//# sourceMappingURL=mcp-manager.d.ts.map