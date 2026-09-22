import { MAX_COMPACTION_TOKENS } from "./compaction-settings.js";
import { MODEL_APIS } from "./model-api.js";
export { MODEL_APIS } from "./model-api.js";
/** Header names reserved for settings that have their own field. */
export const RESERVED_HEADER_NAMES = ["cookie"];
export const MAX_CUSTOM_HEADERS = 16;
export const MAX_HEADER_VALUE_CHARS = 4_096;
/** RFC 7230 token characters, minus the ones that would make an awkward file name. */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
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
    exactShape(input, [
        "provider", "model", "baseUrl", "api", "thinking", "customModel", "permissionMode",
        "clearApiKey", "clearCookie",
    ], [
        "apiKey", "cookie", "customHeaders", "autoCompactionEnabled", "autoCompactionTriggerTokens",
        "autoCompactionReserveTokens", "autoCompactionKeepRecentTokens",
    ], label);
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
    const customHeaders = optionalCustomHeaders(input["customHeaders"], `${label}.customHeaders`);
    const autoCompactionEnabled = optionalBooleanValue(input["autoCompactionEnabled"], `${label}.autoCompactionEnabled`);
    const autoCompactionTriggerTokens = optionalBoundedPositiveInteger(input["autoCompactionTriggerTokens"], `${label}.autoCompactionTriggerTokens`, MAX_COMPACTION_TOKENS);
    const autoCompactionReserveTokens = optionalBoundedPositiveInteger(input["autoCompactionReserveTokens"], `${label}.autoCompactionReserveTokens`, MAX_COMPACTION_TOKENS);
    const autoCompactionKeepRecentTokens = optionalBoundedPositiveInteger(input["autoCompactionKeepRecentTokens"], `${label}.autoCompactionKeepRecentTokens`, MAX_COMPACTION_TOKENS);
    return {
        provider,
        model,
        baseUrl,
        api,
        thinking: enumeration(input["thinking"], THINKING_LEVELS, `${label}.thinking`),
        customModel,
        permissionMode: enumeration(input["permissionMode"], PERMISSION_MODES, `${label}.permissionMode`),
        ...(autoCompactionEnabled === undefined ? {} : { autoCompactionEnabled }),
        ...(autoCompactionTriggerTokens === undefined ? {} : { autoCompactionTriggerTokens }),
        ...(autoCompactionReserveTokens === undefined ? {} : { autoCompactionReserveTokens }),
        ...(autoCompactionKeepRecentTokens === undefined ? {} : { autoCompactionKeepRecentTokens }),
        ...(apiKey ? { apiKey } : {}),
        ...(cookie ? { cookie } : {}),
        ...(customHeaders === undefined ? {} : { customHeaders }),
        clearApiKey,
        clearCookie,
    };
}
/**
 * A header name that is not a token, or a value carrying CR/LF, would let a
 * pasted string add headers of its own to every request. Both are rejected
 * here rather than sanitised, so the setting a client saved is the one sent.
 */
export function decodeCustomHeaders(value, label) {
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array`);
    if (value.length > MAX_CUSTOM_HEADERS)
        throw new Error(`${label} allows at most ${MAX_CUSTOM_HEADERS} headers`);
    const headers = [];
    const seen = new Set();
    for (const [index, entry] of value.entries()) {
        const path = `${label}[${index}]`;
        const header = object(entry, path);
        exactShape(header, ["name"], ["value"], path);
        const name = header["name"];
        if (typeof name !== "string" || !HEADER_NAME.test(name)) {
            throw new Error(`${path}.name must be a header token of at most 63 characters`);
        }
        const lowered = name.toLowerCase();
        if (RESERVED_HEADER_NAMES.includes(lowered))
            throw new Error(`${path}.name is configured by its own setting`);
        if (seen.has(lowered))
            throw new Error(`${path}.name is listed twice`);
        seen.add(lowered);
        const raw = header["value"];
        if (raw === undefined) {
            headers.push({ name });
            continue;
        }
        if (typeof raw !== "string")
            throw new Error(`${path}.value must be a string`);
        if (raw.length > MAX_HEADER_VALUE_CHARS)
            throw new Error(`${path}.value is longer than ${MAX_HEADER_VALUE_CHARS} characters`);
        if (/[\u0000-\u001f\u007f]/.test(raw))
            throw new Error(`${path}.value cannot contain control characters`);
        if (raw.trim() === "")
            throw new Error(`${path}.value cannot be blank`);
        headers.push({ name, value: raw });
    }
    return headers;
}
function optionalCustomHeaders(value, label) {
    if (value === undefined)
        return undefined;
    return decodeCustomHeaders(value, label);
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
function optionalBooleanValue(value, path) {
    return value === undefined ? undefined : booleanValue(value, path);
}
function boundedPositiveInteger(value, path, maximum) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
        throw new Error(`${path} must be a positive integer no greater than ${maximum}`);
    }
    return Number(value);
}
function optionalBoundedPositiveInteger(value, path, maximum) {
    return value === undefined ? undefined : boundedPositiveInteger(value, path, maximum);
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