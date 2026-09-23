import type { ArticleDraft } from "./preview.js";
/**
 * Pulls the article being written out of a streaming tool-call update.
 *
 * Pi repairs partial JSON as tokens arrive, so the arguments grow while the
 * model is still writing. A call counts as soon as it says it will write —
 * `create` or `update` — so the panel can open before the first word of the
 * body, and an `update` made of edits is followed as the edits arrive. `read`
 * writes nothing and is ignored, as is anything that is not an `article` call.
 */
export declare function articleDraftFromUpdate(sessionId: string, update: {
    type: string;
    contentIndex?: number;
    partial?: unknown;
}, message: unknown): ArticleDraft | undefined;
//# sourceMappingURL=draft.d.ts.map