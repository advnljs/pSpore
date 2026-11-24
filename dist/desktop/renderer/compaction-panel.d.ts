import type { RuntimeCompaction } from "../../domain/runtime.js";
/**
 * Pi refuses a manual compaction that has nothing to summarize. That is a
 * quiet "not needed yet", not an error the user has to act on.
 */
export declare function compactionNotNeeded(state: RuntimeCompaction | undefined): "small" | "recent" | undefined;
/** The model reports no measurable intermediate percentage; never invent one. */
export declare class CompactionPanel {
    #private;
    constructor(root: HTMLElement);
    render(sessionId: string, state: RuntimeCompaction | undefined): void;
}
//# sourceMappingURL=compaction-panel.d.ts.map