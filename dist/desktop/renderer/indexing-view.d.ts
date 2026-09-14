import type { IndexingPhase, IndexingStatus } from "../../domain/indexing.js";
/**
 * What the indexing panel shows for a status, kept free of the DOM so the rules
 * can be tested. The panel used to show an empty bar and "正在扫描目录…" for as
 * long as the CLI walked the directories — which reports no counts and can take
 * minutes — and "尚未开始" after a pass that found nothing new, so a working
 * indexer read as stuck or never run.
 */
export interface IndexingView {
    phase: IndexingPhase;
    phaseLabel: string;
    /** 0–100, or undefined while the indexer cannot say how far along it is. */
    percent: number | undefined;
    counts: string;
    current: string;
    note: string;
    /** The text changes with the clock alone, so the caller has to re-render on a timer. */
    ticking: boolean;
}
export declare function presentIndexing(status: IndexingStatus | undefined, now: number): IndexingView;
export declare function formatElapsed(seconds: number): string;
//# sourceMappingURL=indexing-view.d.ts.map