/**
 * In-memory draft of an article the model is still streaming into a tool call.
 *
 * The arguments are not a file yet — the tool has not run — but the panel
 * should already be rendering them. Only metadata is published; the text stays
 * here and is read back in slices, the same way an oversized message is.
 */
export const ARTICLE_PREVIEW_INTERVAL_MS = 120;
export class ArticlePreviewBus {
    publish;
    clock;
    #drafts = new Map();
    #emittedAt = new Map();
    #pending = new Map();
    constructor(publish = () => { }, clock = Date.now) {
        this.publish = publish;
        this.clock = clock;
    }
    /**
     * Records the latest draft. Returns true when a preview is published now:
     * the first time this call is seen, and at most once per interval after that.
     * Identical repeats stay quiet so a token that did not extend the draft does
     * not wake the panel. A suppressed change is published at the trailing edge,
     * even when the provider pauses without sending another token.
     */
    note(draft, now) {
        const previous = this.#drafts.get(draft.toolCallId);
        this.#drafts.set(draft.toolCallId, draft);
        if (previous && sameDraft(previous, draft))
            return false;
        const last = this.#emittedAt.get(draft.toolCallId);
        if (last !== undefined && now - last < ARTICLE_PREVIEW_INTERVAL_MS) {
            // A gateway can deliver a burst and then go quiet. Flush its last draft
            // without requiring another token to arrive and wake the panel.
            if (!this.#pending.has(draft.toolCallId)) {
                const timer = setTimeout(() => {
                    this.#pending.delete(draft.toolCallId);
                    const latest = this.#drafts.get(draft.toolCallId);
                    if (latest)
                        this.#publish(latest, this.clock());
                }, ARTICLE_PREVIEW_INTERVAL_MS - (now - last));
                timer.unref();
                this.#pending.set(draft.toolCallId, timer);
            }
            return false;
        }
        this.#publish(draft, now);
        return true;
    }
    #publish(draft, now) {
        clearTimeout(this.#pending.get(draft.toolCallId));
        this.#pending.delete(draft.toolCallId);
        this.#emittedAt.set(draft.toolCallId, now);
        this.publish(draft);
    }
    get(toolCallId) {
        const draft = this.#drafts.get(toolCallId);
        return draft ? { ...draft } : undefined;
    }
    clear(toolCallId) {
        clearTimeout(this.#pending.get(toolCallId));
        this.#pending.delete(toolCallId);
        this.#drafts.delete(toolCallId);
        this.#emittedAt.delete(toolCallId);
    }
    clearSession(sessionId) {
        for (const draft of this.#drafts.values()) {
            if (draft.sessionId === sessionId)
                this.clear(draft.toolCallId);
        }
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