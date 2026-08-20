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
    apiKey?: string;
    cookie?: string;
    clearApiKey: boolean;
    clearCookie: boolean;
}
export declare const MODEL_APIS: readonly ModelApi[];
export declare const THINKING_LEVELS: readonly ThinkingLevel[];
export declare const PROVIDER_OPTIONS: readonly ProviderOption[];
export declare function defaultModelFor(provider: ProviderOption): string;
export declare function decodeLlmSettingsUpdate(value: unknown, label?: string): LlmSettingsUpdate;
//# sourceMappingURL=llm-settings.d.ts.map