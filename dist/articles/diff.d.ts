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
//# sourceMappingURL=diff.d.ts.map