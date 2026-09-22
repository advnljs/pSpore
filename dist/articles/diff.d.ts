/**
 * Block diff for article versions.
 *
 * Blocks are blank-line separated, and a fenced code block stays in one piece,
 * so a rewrite of one paragraph does not mark the rest of the document as new.
 * The desktop panel uses the result both for the "+N −M" line and to decide
 * which rendered blocks to animate.
 */
export type ArticleBlockChange = "same" | "add" | "remove";
export interface ArticleBlockDiff {
    kind: ArticleBlockChange;
    source: string;
}
export declare function splitArticleBlocks(source: string): string[];
export declare function diffArticleBlocks(before: string, after: string): ArticleBlockDiff[];
export declare function articleChangeCounts(diff: readonly ArticleBlockDiff[]): {
    added: number;
    removed: number;
};
export type ArticleLineGranularity = "line" | "token";
export interface ArticleTextSegment {
    kind: ArticleBlockChange;
    text: string;
}
export interface ArticleLineDiff {
    kind: ArticleBlockChange;
    text: string;
    /**
     * Present when this line was paired with its counterpart and the two are
     * close enough that marking the difference inside them says more than marking
     * the whole line. A removed line carries its `same`/`remove` segments, an
     * added line its `same`/`add` ones.
     */
    segments?: readonly ArticleTextSegment[];
    /** 1-based line number in the version this line belongs to. */
    number: number;
}
export declare function splitArticleLines(source: string): string[];
export declare function diffArticleLines(before: string, after: string, granularity?: ArticleLineGranularity): ArticleLineDiff[];
export declare function articleLineChangeCounts(diff: readonly ArticleLineDiff[]): {
    added: number;
    removed: number;
};
//# sourceMappingURL=diff.d.ts.map