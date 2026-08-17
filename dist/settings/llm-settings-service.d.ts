import { type PsporePaths } from "../storage/home.js";
import { type LlmSettings, type LlmSettingsUpdate } from "./llm-settings.js";
export declare class LlmSettingsService {
    #private;
    constructor(home: string, paths: PsporePaths);
    /**
     * Mirrors the daemon's own gate: without a persisted model it answers every prompt
     * with `model_not_configured`, so this is what "not configured yet" means to a client.
     */
    isModelConfigured(): Promise<boolean>;
    get(): Promise<LlmSettings>;
    save(update: LlmSettingsUpdate): Promise<LlmSettings>;
}
//# sourceMappingURL=llm-settings-service.d.ts.map