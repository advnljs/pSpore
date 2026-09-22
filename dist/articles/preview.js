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
     * the first time this call has text, and at most once per interval after that.
     * Identical repeats stay quiet so a token that did not extend `content` does
     * not wake the panel.
     */
    note(draft, now) {
        const previous = this.#drafts.get(draft.toolCallId);
        this.#drafts.set(draft.toolCallId, draft);
        const changed = !previous
            || previous.content !== draft.content
            || previous.title !== draft.title
            || previous.articleId !== draft.articleId;
        if (!changed)
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
//# sourceMappingURL=preview.js.map