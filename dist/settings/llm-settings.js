export const MODEL_APIS = [
    "provider-default",
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const PROVIDER_OPTIONS = ["deepseek", "openai", "custom-openai"];
export function defaultModelFor(provider) {
    if (provider === "deepseek")
        return "deepseek-v4-flash";
    if (provider === "openai")
        return "gpt-5.6-terra";
    return "custom-model";
}
export function decodeLlmSettingsUpdate(value, label = "LLM settings") {
    const input = object(value, label);
    exactShape(input, ["provider", "model", "baseUrl", "api", "thinking", "customModel", "clearApiKey"], ["apiKey"], label);
    const provider = enumeration(input["provider"], PROVIDER_OPTIONS, `${label}.provider`);
    const model = modelIdentifier(input["model"], `${label}.model`, true);
    const baseUrl = optionalString(input["baseUrl"], `${label}.baseUrl`, 2_048);
    if (baseUrl)
        validateBaseUrl(baseUrl, label);
    const customModel = booleanValue(input["customModel"], `${label}.customModel`);
    const api = enumeration(input["api"], MODEL_APIS, `${label}.api`);
    if (provider === "custom-openai" && !customModel)
        throw new Error(`${label}.customModel must be enabled for custom-openai`);
    if (provider !== "custom-openai" && customModel)
        throw new Error(`${label}.customModel is only available for custom-openai`);
    if (provider === "custom-openai" && api !== "openai-completions" && api !== "openai-responses") {
        throw new Error(`${label}.api must be an OpenAI-compatible API for custom-openai`);
    }
    if (provider !== "custom-openai" && (baseUrl || api !== "provider-default")) {
        throw new Error(`${label} only allows Base URL and API overrides for custom-openai`);
    }
    if (customModel && !baseUrl)
        throw new Error(`${label}.baseUrl is required for a custom model`);
    if (customModel && api === "provider-default")
        throw new Error(`${label}.api must be selected for a custom model`);
    const apiKeyValue = input["apiKey"];
    let apiKey;
    if (apiKeyValue !== undefined) {
        apiKey = optionalString(apiKeyValue, `${label}.apiKey`, 16_384);
        if (!apiKey)
            apiKey = undefined;
        if (apiKey && /[\r\n\u0000]/.test(apiKey))
            throw new Error(`${label}.apiKey cannot contain line breaks`);
    }
    const clearApiKey = booleanValue(input["clearApiKey"], `${label}.clearApiKey`);
    if (apiKey && clearApiKey)
        throw new Error(`${label} cannot set and clear the API key together`);
    return {
        provider,
        model,
        baseUrl,
        api,
        thinking: enumeration(input["thinking"], THINKING_LEVELS, `${label}.thinking`),
        customModel,
        ...(apiKey ? { apiKey } : {}),
        clearApiKey,
    };
}
function object(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${path} must be an object`);
    return value;
}
function exactShape(value, required, optional, path) {
    const allowed = new Set([...required, ...optional]);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0)
        throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
    for (const key of required)
        if (!(key in value))
            throw new Error(`${path}.${key} is required`);
}
function optionalString(value, path, maximum) {
    if (typeof value !== "string" || value.length > maximum || /[\u0000]/.test(value)) {
        throw new Error(`${path} must be a string of at most ${maximum} characters`);
    }
    return value.trim();
}
function booleanValue(value, path) {
    if (typeof value !== "boolean")
        throw new Error(`${path} must be boolean`);
    return value;
}
function modelIdentifier(value, path, allowSlash) {
    const identifier = optionalString(value, path, 128);
    const expression = allowSlash ? /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/ : /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    if (!identifier || !expression.test(identifier))
        throw new Error(`${path} contains unsupported characters`);
    return identifier;
}
function enumeration(value, allowed, path) {
    if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
    return value;
}
function validateBaseUrl(value, label) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`${label}.baseUrl must be a valid URL`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
        throw new Error(`${label}.baseUrl must be an HTTP(S) URL without credentials, query, or fragment`);
    }
}
//# sourceMappingURL=llm-settings.js.map