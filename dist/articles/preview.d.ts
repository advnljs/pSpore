/**
 * In-memory draft of an article the model is still streaming into a tool call.
 *
 * The arguments are not a file yet — the tool has not run — but the panel
 * should already be rendering them. Only metadata is published; the text stays
 * here and is read back in slices, the same way an oversized message is.
 */
export interface ArticleDraftEdit {
    find: string;
    replace: string;
}
export interface ArticleDraft {
    toolCallId: string;
    sessionId: string;
    action: "create" | "update";
    title?: string;
    articleId?: string;
    /** A full draft of the document, written from the top. */
    content?: string;
    /** Local changes to the saved version, each with its `find` written in full. */
    edits?: readonly ArticleDraftEdit[];
    /** The last edit's replacement is still arriving. */
    editOpen?: boolean;
}
export declare const ARTICLE_PREVIEW_INTERVAL_MS = 120;
export declare class ArticlePreviewBus {
    #private;
    /**
     * Records the latest draft. Returns true when a preview event should go out:
     * the first time this call is seen, and at most once per interval after that.
     * Identical repeats stay quiet so a token that did not extend the draft does
     * not wake the panel.
     */
    note(draft: ArticleDraft, now: number): boolean;
    get(toolCallId: string): ArticleDraft | undefined;
    clear(toolCallId: string): void;
}
//# sourceMappingURL=preview.d.ts.map