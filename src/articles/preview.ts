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

export const ARTICLE_PREVIEW_INTERVAL_MS = 120;

export class ArticlePreviewBus {
  readonly #drafts = new Map<string, ArticleDraft>();
  readonly #emittedAt = new Map<string, number>();
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly publish: (draft: ArticleDraft) => void = () => {},
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Records the latest draft. Returns true when a preview is published now:
   * the first time this call is seen, and at most once per interval after that.
   * Identical repeats stay quiet so a token that did not extend the draft does
   * not wake the panel. A suppressed change is published at the trailing edge,
   * even when the provider pauses without sending another token.
   */
  note(draft: ArticleDraft, now: number): boolean {
    const previous = this.#drafts.get(draft.toolCallId);
    this.#drafts.set(draft.toolCallId, draft);
    if (previous && sameDraft(previous, draft)) return false;
    const last = this.#emittedAt.get(draft.toolCallId);
    if (last !== undefined && now - last < ARTICLE_PREVIEW_INTERVAL_MS) {
      // A gateway can deliver a burst and then go quiet. Flush its last draft
      // without requiring another token to arrive and wake the panel.
      if (!this.#pending.has(draft.toolCallId)) {
        const timer = setTimeout(() => {
          this.#pending.delete(draft.toolCallId);
          const latest = this.#drafts.get(draft.toolCallId);
          if (latest) this.#publish(latest, this.clock());
        }, ARTICLE_PREVIEW_INTERVAL_MS - (now - last));
        timer.unref();
        this.#pending.set(draft.toolCallId, timer);
      }
      return false;
    }
    this.#publish(draft, now);
    return true;
  }

  #publish(draft: ArticleDraft, now: number): void {
    clearTimeout(this.#pending.get(draft.toolCallId));
    this.#pending.delete(draft.toolCallId);
    this.#emittedAt.set(draft.toolCallId, now);
    this.publish(draft);
  }

  get(toolCallId: string): ArticleDraft | undefined {
    const draft = this.#drafts.get(toolCallId);
    return draft ? { ...draft } : undefined;
  }

  clear(toolCallId: string): void {
    clearTimeout(this.#pending.get(toolCallId));
    this.#pending.delete(toolCallId);
    this.#drafts.delete(toolCallId);
    this.#emittedAt.delete(toolCallId);
  }

  clearSession(sessionId: string): void {
    for (const draft of this.#drafts.values()) {
      if (draft.sessionId === sessionId) this.clear(draft.toolCallId);
    }
  }
}

/**
 * Arguments only ever grow while they stream, so an edit that kept its lengths
 * kept its text; comparing lengths spares re-reading every quoted passage on
 * every token.
 */
function sameDraft(before: ArticleDraft, after: ArticleDraft): boolean {
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
