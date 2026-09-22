import type { PermissionMode } from "../config/config.js";
import { type ModelApi } from "./model-api.js";
export { MODEL_APIS } from "./model-api.js";
export type { ModelApi } from "./model-api.js";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ProviderOption = "deepseek" | "openai" | "custom-openai";
/**
 * One header added to every request to the model endpoint.
 *
 * The value is kept in its own file next to the API key and the cookie, and
 * referenced from the Pi model catalog the same way, so it never sits in a
 * config file and never travels back to a client.
 */
export interface CustomHeaderSetting {
    name: string;
    hasValue: boolean;
    /** Absolute file the value is read from. Shown in clients; never the value itself. */
    path: string;
}
/** A header to keep, set or replace. Omitting `value` keeps whatever is stored. */
export interface CustomHeaderUpdate {
    name: string;
    value?: string;
}
/** Header names reserved for settings that have their own field. */
export declare const RESERVED_HEADER_NAMES: readonly string[];
export declare const MAX_CUSTOM_HEADERS = 16;
export declare const MAX_HEADER_VALUE_CHARS = 4096;
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
    /** Extra headers sent with every model request, newest configuration first. */
    customHeaders: CustomHeaderSetting[];
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
    /**
     * The complete set of extra headers. Present means "make it look like this":
     * a name that is absent is removed along with its stored value. Omitting the
     * field entirely leaves the stored headers alone, so a client that predates
     * them can still save every other setting.
     */
    customHeaders?: CustomHeaderUpdate[];
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
/**
 * A header name that is not a token, or a value carrying CR/LF, would let a
 * pasted string add headers of its own to every request. Both are rejected
 * here rather than sanitised, so the setting a client saved is the one sent.
 */
export declare function decodeCustomHeaders(value: unknown, label: string): CustomHeaderUpdate[];
//# sourceMappingURL=llm-settings.d.ts.map