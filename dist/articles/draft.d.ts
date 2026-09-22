import type { ArticleDraft } from "./preview.js";
/**
 * Pulls the article markdown out of a streaming tool-call update.
 *
 * Pi repairs partial JSON as tokens arrive, so `arguments.content` grows while
 * the model is still writing. Anything that is not an `article` call, or that
 * has not produced a content string yet, is ignored.
 */
export declare function articleDraftFromUpdate(sessionId: string, update: {
    type: string;
    contentIndex?: number;
    partial?: unknown;
}, message: unknown): Omit<ArticleDraft, "sessionId"> & {
    sessionId: string;
} | undefined;
//# sourceMappingURL=draft.d.ts.map