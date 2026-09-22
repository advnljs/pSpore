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
export interface ArticleDraftBlock {
    source: string;
    /** True when this block is not one the previous version already had. */
    changed: boolean;
}
export interface ArticleDraftAlignment {
    /** Blocks the draft has produced so far, in order. */
    written: ArticleDraftBlock[];
    /** Blocks of the previous version the draft has not reached, still worth showing. */
    pending: string[];
}
/**
 * Lines a partly-written draft up against the version it is replacing.
 *
 * A model rewriting a document sends it from the top, so early in the write the
 * draft is a few characters and the saved version is the whole article. Showing
 * only the draft empties the panel and retypes the document from nothing, which
 * is exactly what a reader watching a revision does not want to see.
 *
 * The blocks after the last one the draft has reached are therefore kept: what
 * is on screen stays the old version until the draft actually gets there, and
 * the part already rewritten says whether it changed. Whether the tail was
 * deleted or simply not reached yet cannot be known until the version lands, and
 * leaving it up is the answer that does not make the document disappear.
 */
export declare function alignArticleDraft(previous: string, draft: string): ArticleDraftAlignment;
//# sourceMappingURL=diff.d.ts.map