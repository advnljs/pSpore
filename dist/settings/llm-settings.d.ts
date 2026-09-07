import type { PermissionMode } from "../config/config.js";
import { type ModelApi } from "./model-api.js";
export { MODEL_APIS } from "./model-api.js";
export type { ModelApi } from "./model-api.js";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ProviderOption = "deepseek" | "openai" | "custom-openai";
export interface LlmSettings {
    version: 1;
    provider: ProviderOption;
    model: string;
    baseUrl: string;
    api: ModelApi;
    thinking: ThinkingLevel;
    customModel: boolean;
    /** Daemon-wide approval policy; `allow_all` bypasses every approval prompt. */
    permissionMode: PermissionMode;
    autoCompactionEnabled: boolean;
    autoCompactionTriggerTokens: number;
    autoCompactionReserveTokens: number;
    autoCompactionKeepRecentTokens: number;
    hasApiKey: boolean;
    hasCookie: boolean;
    /** Absolute path of `config.json`, the authoritative store for every field above. */
    configPath: string;
    /** Absolute file the API key is read from. Shown in clients; never the secret itself. */
    apiKeyPath: string;
    /** Absolute file the `Cookie` header value is read from. */
    cookiePath: string;
    /** Absolute path of the derived Pi model catalog written from `config.json`. */
    modelsPath: string;
}
export interface LlmSettingsUpdate {
    provider: ProviderOption;
    model: string;
    baseUrl: string;
    api: ModelApi;
    thinking: ThinkingLevel;
    customModel: boolean;
    permissionMode: PermissionMode;
    /** Optional so a pre-upgrade GUI/TUI can save another setting without resetting compact values. */
    autoCompactionEnabled?: boolean;
    autoCompactionTriggerTokens?: number;
    autoCompactionReserveTokens?: number;
    autoCompactionKeepRecentTokens?: number;
    apiKey?: string;
    cookie?: string;
    clearApiKey: boolean;
    clearCookie: boolean;
}
export declare const THINKING_LEVELS: readonly ThinkingLevel[];
export declare const PROVIDER_OPTIONS: readonly ProviderOption[];
export declare const PERMISSION_MODES: readonly PermissionMode[];
/** `allow_all` runs every tool with the daemon user's own privileges and no confirmation. */
export declare const BYPASS_PERMISSION_MODE: PermissionMode;
export declare function permissionModeSummary(mode: PermissionMode): string;
export declare function defaultModelFor(provider: ProviderOption): string;
export declare function decodeLlmSettingsUpdate(value: unknown, label?: string): LlmSettingsUpdate;
//# sourceMappingURL=llm-settings.d.ts.map