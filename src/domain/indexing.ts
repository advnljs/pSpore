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
  /** Walking the directories. The CLI reports no counts here, however long it takes. */
  | "scanning"
  /** Checking what was found against the fingerprints of the last pass, also without counts. */
  | "comparing"
  | "indexing"
  | "failed";

/**
 * The outcome of the last pass that ran to completion. It survives the next
 * pass starting, so a rescan — which zeroes the live counters and can spend
 * minutes walking a large tree without reporting anything — does not make an
 * index that is already usable look as if it never ran.
 */
export interface IndexingPassSummary {
  finishedAt: string;
  durationMs: number;
  /** Files that were new or changed and so were (re)indexed. */
  processed: number;
  /** Files unchanged since the previous pass. */
  skipped: number;
  failed: number;
}

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
  lastPass?: IndexingPassSummary;
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
