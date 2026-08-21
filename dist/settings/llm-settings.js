export const MODEL_APIS = [
    "provider-default",
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const PROVIDER_OPTIONS = ["deepseek", "openai", "custom-openai"];
export const PERMISSION_MODES = ["ask_risky", "ask_all", "allow_all", "deny"];
/** `allow_all` runs every tool with the daemon user's own privileges and no confirmation. */
export const BYPASS_PERMISSION_MODE = "allow_all";
export function permissionModeSummary(mode) {
    switch (mode) {
        case "ask_risky":
            return "ask before risky operations (default)";
        case "ask_all":
            return "ask before every mutating operation";
        case "allow_all":
            return "bypass all approvals — every tool runs unconfirmed";
        case "deny":
            return "deny every gated operation";
    }
}
export function defaultModelFor(provider) {
    if (provider === "deepseek")
        return "deepseek-v4-flash";
    if (provider === "openai")
        return "gpt-5.6-terra";
    return "custom-model";
}
export function decodeLlmSettingsUpdate(value, label = "LLM settings") {
    const input = object(value, label);
    exactShape(input, ["provider", "model", "baseUrl", "api", "thinking", "customModel", "permissionMode", "clearApiKey", "clearCookie"], ["apiKey", "cookie"], label);
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
    const apiKey = optionalSecret(input["apiKey"], `${label}.apiKey`);
    const cookie = optionalSecret(input["cookie"], `${label}.cookie`);
    const clearApiKey = booleanValue(input["clearApiKey"], `${label}.clearApiKey`);
    const clearCookie = booleanValue(input["clearCookie"], `${label}.clearCookie`);
    if (apiKey && clearApiKey)
        throw new Error(`${label} cannot set and clear the API key together`);
    if (cookie && clearCookie)
        throw new Error(`${label} cannot set and clear the cookie together`);
    return {
        provider,
        model,
        baseUrl,
        api,
        thinking: enumeration(input["thinking"], THINKING_LEVELS, `${label}.thinking`),
        customModel,
        permissionMode: enumeration(input["permissionMode"], PERMISSION_MODES, `${label}.permissionMode`),
        ...(apiKey ? { apiKey } : {}),
        ...(cookie ? { cookie } : {}),
        clearApiKey,
        clearCookie,
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
function optionalSecret(value, path) {
    if (value === undefined)
        return undefined;
    const secret = optionalString(value, path, 16_384);
    if (!secret)
        return undefined;
    if (/[\r\n\u0000]/.test(secret))
        throw new Error(`${path} cannot contain line breaks`);
    return secret;
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