/**
 * Continuous indexing settings as edited by a client.
 *
 * Kept separate from the LLM settings because it is a different config section
 * with different validation, and mixing them would make one decoder responsible
 * for two unrelated shapes.
 */
export interface IndexingSettings {
    version: 1;
    enabled: boolean;
    directories: string[];
    intervalMinutes: number;
    extensions: string[];
    /** Absolute path of the file these values are stored in, shown to the user. */
    configPath: string;
    /** True when the release shipped an indexer binary the daemon can run. */
    indexerAvailable: boolean;
    /** Absolute path of the indexer, whether or not it is present. */
    indexerPath: string;
}
export interface IndexingSettingsUpdate {
    enabled: boolean;
    directories: string[];
    intervalMinutes: number;
    extensions: string[];
}
export declare const MAX_INDEX_DIRECTORIES = 64;
export declare const MAX_INDEX_INTERVAL_MINUTES = 10080;
export declare function decodeIndexingSettingsUpdate(value: unknown, label?: string): IndexingSettingsUpdate;
//# sourceMappingURL=indexing-settings.d.ts.map