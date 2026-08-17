import type { ModelRef, ThinkingLevel } from "../domain/runtime.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { HostPluginActivationConfig } from "../plugins/types.js";
export type PermissionMode = "deny" | "ask_all" | "ask_risky" | "allow_all";
export interface PermissionRule {
    effect: "allow" | "ask" | "deny";
    capability: string;
    target?: string;
}
export interface PsporeConfig {
    version: 1;
    runtime: {
        workspace: string;
        maxConcurrentAgents: number;
        shutdownGraceMs: number;
    };
    model: (ModelRef & {
        thinking: ThinkingLevel;
    }) | null;
    context: {
        pinnedFiles: string[];
        maxPinnedTokens: number;
    };
    permissions: {
        mode: PermissionMode;
        approvalTimeoutMs: number;
        rules: PermissionRule[];
    };
    memory: {
        provider: "lexical";
        maxResults: number;
        maxReturnedTokens: number;
    };
    shell: {
        executable?: string;
        defaultTimeoutMs: number;
        maxOutputBytes: number;
    };
    scheduler: {
        enabled: boolean;
        maxConcurrentRuns: number;
    };
    boot: {
        enabled: boolean;
    };
    plugins: HostPluginActivationConfig[];
    mcpServers: McpServerConfig[];
}
export declare function defaultConfig(home: string): PsporeConfig;
export declare function parseConfig(value: unknown, home: string): PsporeConfig;
export declare function resolvePsporeHome(input?: string | undefined): string;
//# sourceMappingURL=config.d.ts.map