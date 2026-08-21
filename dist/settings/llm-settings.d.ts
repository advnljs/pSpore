import type { PermissionMode } from "../config/config.js";
export type ModelApi = "provider-default" | "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
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
    hasApiKey: boolean;
    hasCookie: boolean;
}
export interface LlmSettingsUpdate {
    provider: ProviderOption;
    model: string;
    baseUrl: string;
    api: ModelApi;
    thinking: ThinkingLevel;
    customModel: boolean;
    permissionMode: PermissionMode;
    apiKey?: string;
    cookie?: string;
    clearApiKey: boolean;
    clearCookie: boolean;
}
export declare const MODEL_APIS: readonly ModelApi[];
export declare const THINKING_LEVELS: readonly ThinkingLevel[];
export declare const PROVIDER_OPTIONS: readonly ProviderOption[];
export declare const PERMISSION_MODES: readonly PermissionMode[];
/** `allow_all` runs every tool with the daemon user's own privileges and no confirmation. */
export declare const BYPASS_PERMISSION_MODE: PermissionMode;
export declare function permissionModeSummary(mode: PermissionMode): string;
export declare function defaultModelFor(provider: ProviderOption): string;
export declare function decodeLlmSettingsUpdate(value: unknown, label?: string): LlmSettingsUpdate;
//# sourceMappingURL=llm-settings.d.ts.map