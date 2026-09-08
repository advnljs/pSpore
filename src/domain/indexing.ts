/**
 * Continuous local document indexing, as seen by every client.
 *
 * This lives in `domain/` rather than beside the service that produces it
 * because `KernelState` embeds it, and `KernelState` is imported by the Electron
 * renderer. The renderer runs sandboxed with Node integration disabled, so any
 * module it can reach must stay free of Node built-ins; the service itself
 * (which spawns a process and touches the filesystem) is deliberately kept in a
 * separate module the renderer never imports.
 */
export type IndexingPhase =
  /** Switched off in `config.indexing.enabled`. */
  | "disabled"
  /** Switched on, but no directory has been chosen, so no pass can run. */
  | "unconfigured"
  /** Switched on and configured, but the release shipped no indexer binary. */
  | "unavailable"
  | "idle"
  | "scanning"
  | "indexing"
  | "failed";

export interface IndexingStatus {
  version: 1;
  /**
   * What `config.indexing.enabled` says, independent of whether a pass can
   * actually run. Without it a client cannot tell the settings panel's "on"
   * apart from the several reasons a switched-on indexer stays idle, which is
   * how a configured indexer came to be reported as unconfigured.
   */
  enabled: boolean;
  phase: IndexingPhase;
  directories: readonly string[];
  total: number;
  processed: number;
  failed: number;
  skipped: number;
  currentFile?: string;
  startedAt?: string;
  finishedAt?: string;
  nextRunAt?: string;
  message?: string;
}

export function initialIndexingStatus(): IndexingStatus {
  return {
    version: 1,
    enabled: false,
    phase: "disabled",
    directories: [],
    total: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
  };
}
