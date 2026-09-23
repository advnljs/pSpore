/**
 * In-memory draft of an article the model is still streaming into a tool call.
 *
 * The arguments are not a file yet — the tool has not run — but the panel
 * should already be rendering them. Only metadata is published; the text stays
 * here and is read back in slices, the same way an oversized message is.
 */
export const ARTICLE_PREVIEW_INTERVAL_MS = 120;
export class ArticlePreviewBus {
    #drafts = new Map();
    #emittedAt = new Map();
    /**
     * Records the latest draft. Returns true when a preview event should go out:
     * the first time this call is seen, and at most once per interval after that.
     * Identical repeats stay quiet so a token that did not extend the draft does
     * not wake the panel.
     */
    note(draft, now) {
        const previous = this.#drafts.get(draft.toolCallId);
        this.#drafts.set(draft.toolCallId, draft);
        if (previous && sameDraft(previous, draft))
            return false;
        const last = this.#emittedAt.get(draft.toolCallId);
        if (last !== undefined && now - last < ARTICLE_PREVIEW_INTERVAL_MS)
            return false;
        this.#emittedAt.set(draft.toolCallId, now);
        return true;
    }
    get(toolCallId) {
        const draft = this.#drafts.get(toolCallId);
        return draft ? { ...draft } : undefined;
    }
    clear(toolCallId) {
        this.#drafts.delete(toolCallId);
        this.#emittedAt.delete(toolCallId);
    }
}
/**
 * Arguments only ever grow while they stream, so an edit that kept its lengths
 * kept its text; comparing lengths spares re-reading every quoted passage on
 * every token.
 */
function sameDraft(before, after) {
    return before.action === after.action
        && before.title === after.title
        && before.articleId === after.articleId
        && before.content === after.content
        && before.editOpen === after.editOpen
        && (before.edits?.length ?? -1) === (after.edits?.length ?? -1)
        && (before.edits ?? []).every((edit, index) => {
            const next = after.edits?.[index];
            return next !== undefined && next.find.length === edit.find.length && next.replace.length === edit.replace.length;
        });
}
//# sourceMappingURL=preview.js.map