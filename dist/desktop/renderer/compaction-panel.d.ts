import type { RuntimeCompaction } from "../../domain/runtime.js";
/** The model reports no measurable intermediate percentage; never invent one. */
export declare class CompactionPanel {
    #private;
    constructor(root: HTMLElement);
    render(sessionId: string, state: RuntimeCompaction | undefined): void;
}
//# sourceMappingURL=compaction-panel.d.ts.map