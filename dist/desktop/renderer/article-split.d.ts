/**
 * How the conversation and the document share the space beside the session rail.
 *
 * Kept free of the DOM so the rules can be tested. The panel used to bound its
 * width by the viewport alone, which ignored the session rail and the gaps, so a
 * drag, a reopen or a smaller window could leave the conversation a sliver: its
 * content clipped under the document as though the document were floating over it.
 */
/** A readable measure for prose. */
export declare const MIN_ARTICLE_WIDTH = 360;
/** Enough for the composer's controls and a message to stay a conversation. */
export declare const MIN_CONVERSATION_WIDTH = 440;
/** Until the reader drags the boundary, the two halves share the space evenly. */
export declare const DEFAULT_ARTICLE_SHARE = 0.5;
/**
 * The narrowest and widest the document column may be, given the width both
 * columns share. When even the two minimums do not fit, both give way in
 * proportion rather than one of them disappearing.
 */
export declare function articleWidthBounds(available: number): {
    min: number;
    max: number;
};
export declare function clampArticleWidth(width: number, available: number): number;
/**
 * The reader's choice is kept as a share of the space rather than in pixels, so
 * a window that grows or shrinks scales both halves together instead of handing
 * the whole change to the conversation.
 */
export declare function articleWidthForShare(share: number | undefined, available: number): number;
export declare function articleShareForWidth(width: number, available: number): number | undefined;
//# sourceMappingURL=article-split.d.ts.map