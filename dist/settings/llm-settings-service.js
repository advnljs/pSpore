import { access, mkdir, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../config/config.js";
import { atomicWriteFile, atomicWriteJson } from "../storage/atomic.js";
import { loadConfig } from "../storage/home.js";
import { decodeLlmSettingsUpdate, PROVIDER_OPTIONS, RESERVED_HEADER_NAMES, } from "./llm-settings.js";
const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-v4-flash";
const MAX_MODELS_FILE_BYTES = 1_048_576;
const SUPPORTED_APIS = new Set([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
]);
export class LlmSettingsService {
    #home;
    #paths;
    constructor(home, paths) {
        this.#home = home;
        this.#paths = paths;
    }
    /**
     * Mirrors the daemon's own gate: without a persisted model it answers every prompt
     * with `model_not_configured`, so this is what "not configured yet" means to a client.
     */
    async isModelConfigured() {
        const config = await loadConfig(this.#home);
        return config.model !== null;
    }
    /**
     * `config.json` is authoritative for every field the settings panel edits.
     * `state/pi/models.json` is a derived catalog for the Pi runtime, so it is only
     * consulted to recover endpoint values written by a pre-0.1.15 build that had
     * nowhere else to store them.
     */
    async get() {
        const config = await loadConfig(this.#home);
        const provider = providerOption(config.model?.provider ?? DEFAULT_PROVIDER);
        const model = config.model?.model ?? DEFAULT_MODEL;
        const models = await this.#readModels();
        const providerConfig = record(models.providers[provider]);
        const legacyCustomModel = Array.isArray(providerConfig?.["models"])
            && providerConfig["models"].some((candidate) => record(candidate)?.["id"] === model);
        const baseUrl = config.model?.baseUrl
            ?? (typeof providerConfig?.["baseUrl"] === "string" ? providerConfig["baseUrl"] : "");
        const api = config.model?.api ?? modelApi(providerConfig?.["api"]);
        const apiKeyPath = config.model?.apiKeyFile ?? this.#credentialPath(provider);
        const cookiePath = config.model?.cookieFile ?? this.#cookiePath(provider);
        return {
            version: 1,
            provider,
            model,
            baseUrl,
            api,
            thinking: config.model?.thinking ?? "off",
            customModel: config.model?.customModel ?? legacyCustomModel,
            permissionMode: config.permissions.mode,
            autoCompactionEnabled: config.context.autoCompaction.enabled,
            autoCompactionTriggerTokens: config.context.autoCompaction.triggerTokens,
            autoCompactionReserveTokens: config.context.autoCompaction.reserveTokens,
            autoCompactionKeepRecentTokens: config.context.autoCompaction.keepRecentTokens,
            hasApiKey: await this.#hasApiKey(apiKeyPath, providerConfig),
            hasCookie: await this.#hasCookie(cookiePath, providerConfig),
            configPath: this.#paths.config,
            apiKeyPath,
            cookiePath,
            customHeaders: await this.#customHeaders(provider, providerConfig),
            modelsPath: this.#modelsPath(),
        };
    }
    /**
     * The header names live in the Pi catalog, which is what actually sends them;
     * the values live one file each, so what comes back says a value exists
     * without carrying it.
     */
    async #customHeaders(provider, providerConfig) {
        const headers = record(providerConfig?.["headers"]) ?? {};
        const settings = [];
        for (const name of Object.keys(headers)) {
            if (RESERVED_HEADER_NAMES.includes(name.toLowerCase()))
                continue;
            const path = this.#headerPath(provider, name);
            settings.push({ name, hasValue: await exists(path), path });
        }
        return settings;
    }
    #headerPath(provider, name) {
        return join(this.#paths.credentials, `${provider}.header-${name.toLowerCase()}`);
    }
    async save(update) {
        update = decodeLlmSettingsUpdate(update);
        const currentConfig = await loadConfig(this.#home);
        const models = await this.#readModels();
        const providerConfig = { ...(record(models.providers[update.provider]) ?? {}) };
        const credentialPath = this.#credentialPath(update.provider);
        const cookiePath = this.#cookiePath(update.provider);
        const credentialExists = await exists(credentialPath);
        const cookieExists = await exists(cookiePath);
        if (update.baseUrl)
            providerConfig["baseUrl"] = update.baseUrl;
        else
            delete providerConfig["baseUrl"];
        if (update.customModel) {
            providerConfig["api"] = update.api;
            providerConfig["models"] = upsertCustomModel(providerConfig["models"], update.model);
        }
        else {
            if (update.api === "provider-default")
                delete providerConfig["api"];
            else
                providerConfig["api"] = update.api;
            const remainingModels = removeCustomModel(providerConfig["models"], update.model);
            if (Array.isArray(remainingModels) && remainingModels.length > 0)
                providerConfig["models"] = remainingModels;
            else
                delete providerConfig["models"];
        }
        if (update.apiKey || (credentialExists && !update.clearApiKey)) {
            providerConfig["apiKey"] = credentialCommand(credentialPath);
        }
        else if (update.clearApiKey && isManagedCredentialCommand(providerConfig["apiKey"], credentialPath)) {
            delete providerConfig["apiKey"];
        }
        const headers = { ...(record(providerConfig["headers"]) ?? {}) };
        if (update.cookie || (cookieExists && !update.clearCookie)) {
            headers["Cookie"] = credentialCommand(cookiePath);
        }
        else {
            delete headers["Cookie"];
        }
        // A client that predates custom headers omits the field and keeps whatever
        // is stored; one that sends it is describing the complete set.
        const headerWrites = [];
        const headerRemovals = [];
        if (update.customHeaders) {
            const kept = new Set(update.customHeaders.map((header) => header.name.toLowerCase()));
            for (const name of Object.keys(headers)) {
                if (RESERVED_HEADER_NAMES.includes(name.toLowerCase()))
                    continue;
                if (kept.has(name.toLowerCase()))
                    continue;
                headerRemovals.push(this.#headerPath(update.provider, name));
                delete headers[name];
            }
            for (const header of update.customHeaders) {
                const path = this.#headerPath(update.provider, header.name);
                if (header.value === undefined && !(await exists(path))) {
                    throw new Error(`Header ${header.name} has no stored value; send one with it.`);
                }
                if (header.value !== undefined)
                    headerWrites.push({ path, value: header.value });
                // Re-keying by the name as typed keeps a rename from leaving both behind.
                for (const existing of Object.keys(headers)) {
                    if (existing !== header.name && existing.toLowerCase() === header.name.toLowerCase())
                        delete headers[existing];
                }
                headers[header.name] = credentialCommand(path);
            }
        }
        if (Object.keys(headers).length > 0)
            providerConfig["headers"] = headers;
        else
            delete providerConfig["headers"];
        const nextModels = { ...models, providers: { ...models.providers } };
        if (Object.keys(providerConfig).length > 0)
            nextModels.providers[update.provider] = providerConfig;
        else
            delete nextModels.providers[update.provider];
        const nextConfig = parseConfig({
            ...currentConfig,
            model: {
                provider: update.provider,
                model: update.model,
                thinking: update.thinking,
                ...(update.baseUrl ? { baseUrl: update.baseUrl } : {}),
                api: update.api,
                customModel: update.customModel,
                // Record where the secrets live, never the secrets themselves.
                apiKeyFile: credentialPath,
                cookieFile: cookiePath,
            },
            permissions: { ...currentConfig.permissions, mode: update.permissionMode },
            context: {
                ...currentConfig.context,
                autoCompaction: {
                    enabled: update.autoCompactionEnabled ?? currentConfig.context.autoCompaction.enabled,
                    triggerTokens: update.autoCompactionTriggerTokens ?? currentConfig.context.autoCompaction.triggerTokens,
                    reserveTokens: update.autoCompactionReserveTokens ?? currentConfig.context.autoCompaction.reserveTokens,
                    keepRecentTokens: update.autoCompactionKeepRecentTokens ?? currentConfig.context.autoCompaction.keepRecentTokens,
                },
            },
        }, this.#home);
        await this.#validateModel(nextModels, update.provider, update.model);
        if (update.apiKey || update.cookie || headerWrites.length > 0) {
            await mkdir(this.#paths.credentials, { recursive: true, mode: 0o700 });
        }
        for (const write of headerWrites)
            await atomicWriteFile(write.path, write.value, 0o600);
        if (update.apiKey) {
            await atomicWriteFile(credentialPath, update.apiKey, 0o600);
        }
        if (update.cookie) {
            await atomicWriteFile(cookiePath, update.cookie, 0o600);
        }
        await atomicWriteJson(this.#modelsPath(), nextModels, 0o600);
        await atomicWriteJson(this.#paths.config, nextConfig, 0o600);
        if (update.clearApiKey)
            await unlink(credentialPath).catch(ignoreMissingFile);
        if (update.clearCookie)
            await unlink(cookiePath).catch(ignoreMissingFile);
        for (const path of headerRemovals)
            await unlink(path).catch(ignoreMissingFile);
        return this.get();
    }
    async #readModels() {
        const path = this.#modelsPath();
        let source;
        try {
            source = await readFile(path, "utf8");
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT")
                return { providers: {} };
            throw error;
        }
        if (Buffer.byteLength(source, "utf8") > MAX_MODELS_FILE_BYTES) {
            throw new Error("models.json is too large to edit safely from pSpore settings");
        }
        const parsed = JSON.parse(source);
        const root = record(parsed);
        const providers = record(root?.["providers"]);
        if (!root || !providers)
            throw new Error("models.json must contain a providers object");
        return { ...root, providers };
    }
    async #validateModel(models, provider, model) {
        const temporaryDirectory = await mkdtemp(join(this.#paths.agentDir, ".settings-validate-"));
        try {
            const modelsPath = join(temporaryDirectory, "models.json");
            const authPath = join(temporaryDirectory, "auth.json");
            await atomicWriteJson(modelsPath, models, 0o600);
            await atomicWriteJson(authPath, {}, 0o600);
            const runtime = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
            if (!runtime.getModel(provider, model)) {
                throw new Error(`Model ${provider}/${model} is not built in; enable custom model and select a compatible API`);
            }
            const compositionError = runtime.getError();
            if (compositionError)
                throw new Error(`Model configuration is invalid: ${compositionError}`);
        }
        finally {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }
    async #hasApiKey(path, providerConfig) {
        if (await exists(path))
            return true;
        return typeof providerConfig?.["apiKey"] === "string" && providerConfig["apiKey"].length > 0;
    }
    async #hasCookie(path, providerConfig) {
        if (await exists(path))
            return true;
        const headers = record(providerConfig?.["headers"]);
        return typeof headers?.["Cookie"] === "string" && headers["Cookie"].length > 0;
    }
    #credentialPath(provider) {
        return join(this.#paths.credentials, `${provider}.api-key`);
    }
    #cookiePath(provider) {
        return join(this.#paths.credentials, `${provider}.cookie`);
    }
    #modelsPath() {
        return join(this.#paths.agentDir, "models.json");
    }
}
function upsertCustomModel(value, model) {
    const models = Array.isArray(value) ? [...value] : [];
    const index = models.findIndex((candidate) => record(candidate)?.["id"] === model);
    const current = index >= 0 ? (record(models[index]) ?? {}) : {};
    const next = { ...current, id: model, name: typeof current["name"] === "string" ? current["name"] : model };
    if (index >= 0)
        models[index] = next;
    else
        models.push(next);
    return models;
}
function removeCustomModel(value, model) {
    if (!Array.isArray(value))
        return value;
    return value.filter((candidate) => record(candidate)?.["id"] !== model);
}
function modelApi(value) {
    return typeof value === "string" && SUPPORTED_APIS.has(value) ? value : "provider-default";
}
function providerOption(value) {
    if (PROVIDER_OPTIONS.includes(value))
        return value;
    throw new Error(`Unsupported provider ${value}; choose deepseek, openai, or custom-openai`);
}
function credentialCommand(path) {
    return `!cat -- ${shellQuote(path)}`;
}
function isManagedCredentialCommand(value, path) {
    return value === credentialCommand(path);
}
function shellQuote(value) {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return false;
        throw error;
    }
}
function ignoreMissingFile(error) {
    if (!isNodeError(error) || error.code !== "ENOENT")
        throw error;
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
//# sourceMappingURL=llm-settings-service.js.map