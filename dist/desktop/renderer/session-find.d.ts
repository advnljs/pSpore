/** One occurrence of the current query inside a session transcript. */
export interface TextHit {
    /** Index into the searched text list. */
    index: number;
    /** Occurrence within that text, starting at 0. */
    occurrence: number;
}
export interface TextHitResult {
    hits: TextHit[];
    /** True when matching stopped at the cap so a huge transcript cannot stall the UI. */
    capped: boolean;
}
/**
 * Finds non-overlapping, case-insensitive matches in transcript texts.
 * The texts are the session's message bodies in order, plus the live draft.
 */
export declare function findTextHits(texts: readonly string[], query: string): TextHitResult;
//# sourceMappingURL=session-find.d.ts.map