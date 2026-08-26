export interface AutoCompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_AUTO_COMPACTION: Readonly<AutoCompactionConfig> = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

export const MAX_COMPACTION_TOKENS = 1_000_000;
