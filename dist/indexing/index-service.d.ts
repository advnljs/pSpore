import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { type IndexingStatus } from "../domain/indexing.js";
export { initialIndexingStatus } from "../domain/indexing.js";
export type { IndexingPhase, IndexingStatus } from "../domain/indexing.js";
/**
 * Drives the bundled `aegis-search` CLI so the local full-text index stays
 * current while the daemon runs. The CLI writes the same index directory the
 * Aegis Searcher desktop application uses, so an interactive search sees
 * everything the daemon has indexed and vice versa.
 *
 * Indexing is incremental: the CLI skips files whose mtime and size are
 * unchanged, so a pass over an already-indexed tree is cheap.
 *
 * This module reaches for the filesystem and spawns a process, so nothing the
 * sandboxed renderer imports may import it; the status shape it publishes lives
 * in `domain/indexing.ts` for exactly that reason.
 */
/** The subset of a spawned indexer this service actually reads. */
export interface IndexerProcess extends ChildProcess {
    stdout: Readable;
    stderr: Readable;
}
export interface IndexServiceOptions {
    /** Absolute path of the `aegis-search` binary, usually inside the bundled skill. */
    binaryPath: string;
    directories: readonly string[];
    extensions: readonly string[];
    intervalMs: number;
    enabled: boolean;
    onStatus: (status: IndexingStatus) => void;
    clock?: () => Date;
    /** Injected for tests so a pass can be driven without a real binary. */
    spawnProcess?: (command: string, args: readonly string[]) => IndexerProcess;
}
export declare class IndexService {
    #private;
    constructor(options: IndexServiceOptions);
    status(): IndexingStatus;
    /**
     * Begins periodic indexing. Returns once the service knows whether it can run;
     * the first pass proceeds in the background so daemon startup is never blocked
     * behind a filesystem walk.
     */
    start(): Promise<void>;
    /**
     * Runs a pass now and resolves when it ends. Going through the timer would
     * return before the pass had even been created, so the pass is started here
     * directly; a pass already in flight is awaited rather than duplicated.
     */
    runNow(): Promise<void>;
    stop(): Promise<void>;
}
/** Path of the indexing binary shipped inside a bundled skill directory. */
export declare function bundledIndexerPath(skillPath: string): string;
//# sourceMappingURL=index-service.d.ts.map