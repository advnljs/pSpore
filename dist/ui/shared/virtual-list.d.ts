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
    range(scrollTop: number, viewportSize: number, overscan?: number): VirtualRange;
    totalSize(): number;
}
//# sourceMappingURL=virtual-list.d.ts.map