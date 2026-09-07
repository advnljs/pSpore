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
  | "disabled"
  | "unavailable"
  | "idle"
  | "scanning"
  | "indexing"
  | "failed";

export interface IndexingStatus {
  version: 1;
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
    phase: "disabled",
    directories: [],
    total: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
  };
}
