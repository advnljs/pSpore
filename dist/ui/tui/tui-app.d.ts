import { type LlmSettings, type LlmSettingsUpdate } from "../../settings/llm-settings.js";
export interface TuiSettingsPort {
    get(): Promise<LlmSettings>;
    save(update: LlmSettingsUpdate): Promise<LlmSettings>;
    isModelConfigured?(): Promise<boolean>;
}
export declare const MODEL_SETUP_OFFER_PROMPT = "Run the model setup wizard now? [Y/n]";
export declare const MODEL_SETUP_OFFER_LINES: string[];
/** Empty input accepts the recommendation; only an explicit no declines. */
export declare function acceptsModelSetupOffer(answer: string | undefined): boolean;
export interface TuiAppOptions {
    socketPath: string;
    clientId?: string;
    settings?: TuiSettingsPort;
    onSettingsSaved?: () => Promise<{
        applied: boolean;
        restartRequired: boolean;
        message: string;
    }>;
}
export declare class PsporeTuiApp {
    #private;
    constructor(options: TuiAppOptions);
    run(): Promise<void>;
}
//# sourceMappingURL=tui-app.d.ts.map