export interface AutoCompactionConfig {
    enabled: boolean;
    /** Compact after the active model context grows beyond this many tokens. */
    triggerTokens: number;
    reserveTokens: number;
    keepRecentTokens: number;
}
export declare const DEFAULT_AUTO_COMPACTION: Readonly<AutoCompactionConfig>;
export declare const MAX_COMPACTION_TOKENS = 1000000;
//# sourceMappingURL=compaction-settings.d.ts.map