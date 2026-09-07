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
    /**
     * `config.json` is authoritative for every field the settings panel edits.
     * `state/pi/models.json` is a derived catalog for the Pi runtime, so it is only
     * consulted to recover endpoint values written by a pre-0.1.15 build that had
     * nowhere else to store them.
     */
    get(): Promise<LlmSettings>;
    save(update: LlmSettingsUpdate): Promise<LlmSettings>;
}
//# sourceMappingURL=llm-settings-service.d.ts.map