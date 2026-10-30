export interface VirtualRange {
    start: number;
    end: number;
    paddingStart: number;
    paddingEnd: number;
    totalSize: number;
}
/**
 * Reports whether a scroll viewport is close enough to its lower boundary to
 * keep following newly appended content. Non-scrollable viewports are at end.
 */
export declare function isScrollNearEnd(scrollHeight: number, scrollTop: number, clientHeight: number, threshold?: number): boolean;
/**
 * Variable-height list index backed by a Fenwick tree. Message measurements are
 * retained by stable key, while viewport lookup and height updates stay O(log n).
 */
export declare class VirtualHeightIndex {
    #private;
    constructor(estimatedSize?: number);
    get count(): number;
    sync(keys: readonly string[]): void;
    update(key: string, size: number): boolean;
    /**
     * `keep` names one item that must stay in the window even if the viewport has
     * moved off it — the item holding the reader's selection. Dropping its element
     * would collapse the selection, and a growing message at the tail is enough to
     * shift the window by an item while they are still dragging.
     */
    range(scrollTop: number, viewportSize: number, overscan?: number, keep?: number): VirtualRange;
    totalSize(): number;
    /** Pixel offset of an item, used to scroll a match into the virtual window. */
    offsetAt(index: number): number;
}
//# sourceMappingURL=virtual-list.d.ts.map