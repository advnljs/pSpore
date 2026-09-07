/**
 * Model endpoint shape shared by `config.json`, the settings service and every
 * client. It lives in its own module so `src/config/config.ts` can validate the
 * persisted value without importing the settings surface that depends on it.
 */
export type ModelApi = "provider-default" | "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export declare const MODEL_APIS: readonly ModelApi[];
/** Endpoint overrides only make sense for the OpenAI-compatible custom provider. */
export declare const CUSTOM_MODEL_APIS: readonly ModelApi[];
//# sourceMappingURL=model-api.d.ts.map