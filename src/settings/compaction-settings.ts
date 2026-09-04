export interface AutoCompactionConfig {
  enabled: boolean;
  /** Compact after the active model context grows beyond this many tokens. */
  triggerTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_AUTO_COMPACTION: Readonly<AutoCompactionConfig> = {
  enabled: true,
  triggerTokens: 100_000,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export const MAX_COMPACTION_TOKENS = 1_000_000;
