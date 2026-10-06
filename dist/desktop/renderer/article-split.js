/**
 * How the conversation and the document share the space beside the session rail.
 *
 * Kept free of the DOM so the rules can be tested. The panel used to bound its
 * width by the viewport alone, which ignored the session rail and the gaps, so a
 * drag, a reopen or a smaller window could leave the conversation a sliver: its
 * content clipped under the document as though the document were floating over it.
 */
/** A readable measure for prose. */
export const MIN_ARTICLE_WIDTH = 360;
/** Enough for the composer's controls and a message to stay a conversation. */
export const MIN_CONVERSATION_WIDTH = 440;
/** Until the reader drags the boundary, the two halves share the space evenly. */
export const DEFAULT_ARTICLE_SHARE = 0.5;
/**
 * The narrowest and widest the document column may be, given the width both
 * columns share. When even the two minimums do not fit, both give way in
 * proportion rather than one of them disappearing.
 */
export function articleWidthBounds(available) {
    const space = Math.max(0, available);
    if (space < MIN_ARTICLE_WIDTH + MIN_CONVERSATION_WIDTH) {
        const width = Math.round((space * MIN_ARTICLE_WIDTH) / (MIN_ARTICLE_WIDTH + MIN_CONVERSATION_WIDTH));
        return { min: width, max: width };
    }
    return { min: MIN_ARTICLE_WIDTH, max: Math.round(space - MIN_CONVERSATION_WIDTH) };
}
export function clampArticleWidth(width, available) {
    const { min, max } = articleWidthBounds(available);
    const value = Number.isFinite(width) ? width : min;
    return Math.round(Math.min(Math.max(value, min), max));
}
/**
 * The reader's choice is kept as a share of the space rather than in pixels, so
 * a window that grows or shrinks scales both halves together instead of handing
 * the whole change to the conversation.
 */
export function articleWidthForShare(share, available) {
    const fraction = share !== undefined && Number.isFinite(share) && share > 0 && share < 1 ? share : DEFAULT_ARTICLE_SHARE;
    return clampArticleWidth(available * fraction, available);
}
export function articleShareForWidth(width, available) {
    if (!(available > 0) || !Number.isFinite(width))
        return undefined;
    const share = width / available;
    return share > 0 && share < 1 ? share : undefined;
}
//# sourceMappingURL=article-split.js.map