import type { ModelRef, ThinkingLevel } from "../domain/runtime.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { HostPluginActivationConfig } from "../plugins/types.js";
import { type AutoCompactionConfig } from "../settings/compaction-settings.js";
import { type ModelApi } from "../settings/model-api.js";
export { DEFAULT_AUTO_COMPACTION, MAX_COMPACTION_TOKENS } from "../settings/compaction-settings.js";
export type { AutoCompactionConfig } from "../settings/compaction-settings.js";
export { CUSTOM_MODEL_APIS, MODEL_APIS } from "../settings/model-api.js";
export type { ModelApi } from "../settings/model-api.js";
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
    /**
     * Everything the settings panel persists about the active model, including the
     * endpoint overrides that used to live only in `state/pi/models.json`. Pi still
     * reads `models.json`, but `config.json` is now the single authoritative source
     * and the settings service derives `models.json` from it.
     */
    model: (ModelRef & {
        thinking: ThinkingLevel;
        /** Endpoint override; empty/absent means the provider default. */
        baseUrl?: string;
        api?: ModelApi;
        /** True when `model` is user-declared rather than part of a built-in catalog. */
        customModel?: boolean;
        /** Absolute file holding the API key. The file, never the secret, is recorded here. */
        apiKeyFile?: string;
        /** Absolute file holding the raw `Cookie` header value. */
        cookieFile?: string;
    }) | null;
    context: {
        pinnedFiles: string[];
        maxPinnedTokens: number;
        autoCompaction: AutoCompactionConfig;
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
/**
 * Incremental upgrade merge: an existing value always wins, and only genuinely
 * absent keys inherit the current default. Unknown keys are deliberately left in
 * place so the strict parse below still rejects typos instead of silently
 * dropping them.
 */
export declare function withConfigDefaults(value: unknown, home: string): Record<string, unknown>;
export declare function parseConfig(value: unknown, home: string): PsporeConfig;
export declare function resolvePsporeHome(input?: string | undefined): string;
//# sourceMappingURL=config.d.ts.map