export interface ArticleEdit {
    find: string;
    replace: string;
}
/**
 * What an `update` with edits commits: each `find` is replaced at its first
 * occurrence, in order, so a later edit sees the text the earlier ones left.
 */
export declare function applyArticleEdits(content: string, edits: readonly ArticleEdit[]): string;
/**
 * The document as it will read once the edits written so far land, for a panel
 * that shows the revision while the model is still typing it.
 *
 * Same rules as a commit, except that an edit whose text cannot be found is
 * skipped rather than fatal — the commit will report it — and the last edit's
 * replacement may still be arriving (`open`). A replacement that has not yet
 * departed from the text it replaces leaves that text alone, so a paragraph the
 * model is extending does not vanish and get typed back in.
 */
export declare function previewArticleEdits(content: string, edits: readonly ArticleEdit[], open: boolean): {
    text: string;
    applied: number;
};
//# sourceMappingURL=edits.d.ts.map