/**
 * Reports whether a scroll viewport is close enough to its lower boundary to
 * keep following newly appended content. Non-scrollable viewports are at end.
 */
export function isScrollNearEnd(scrollHeight, scrollTop, clientHeight, threshold = 24) {
    if (![scrollHeight, scrollTop, clientHeight, threshold].every(Number.isFinite))
        return false;
    const maximumTop = Math.max(0, scrollHeight - Math.max(0, clientHeight));
    const currentTop = Math.min(maximumTop, Math.max(0, scrollTop));
    return maximumTop - currentTop <= Math.max(0, threshold);
}
/**
 * How far outside the viewport an item may be dragged back in by `keep`.
 *
 * Keeping one item means keeping everything between it and the viewport, since
 * the window is contiguous. A reader holding a selection is looking at
 * something near what is on screen; past this many items it is scrollback they
 * have left behind, and the list stops paying to render the gap.
 */
const KEEP_SPAN_LIMIT = 40;
/**
 * Variable-height list index backed by a Fenwick tree. Message measurements are
 * retained by stable key, while viewport lookup and height updates stay O(log n).
 */
export class VirtualHeightIndex {
    #estimatedSize;
    #measured = new Map();
    #keys = [];
    #positions = new Map();
    #sizes = [];
    #tree = [0];
    constructor(estimatedSize = 160) {
        if (!Number.isFinite(estimatedSize) || estimatedSize <= 0) {
            throw new Error("estimatedSize must be positive");
        }
        this.#estimatedSize = estimatedSize;
    }
    get count() {
        return this.#keys.length;
    }
    sync(keys) {
        if (sameKeys(this.#keys, keys))
            return;
        this.#keys = [...keys];
        this.#positions = new Map(keys.map((key, index) => [key, index]));
        this.#sizes = keys.map((key) => this.#measured.get(key) ?? this.#estimatedSize);
        this.#tree = Array.from({ length: keys.length + 1 }, () => 0);
        for (const [index, size] of this.#sizes.entries())
            this.#add(index, size);
        // Measurements from replaced/compacted histories should not retain DOM-sized
        // state forever. Keep only keys that still exist in the current transcript.
        for (const key of this.#measured.keys()) {
            if (!this.#positions.has(key))
                this.#measured.delete(key);
        }
    }
    update(key, size) {
        const index = this.#positions.get(key);
        if (index === undefined || !Number.isFinite(size) || size <= 0)
            return false;
        const previous = this.#sizes[index] ?? this.#estimatedSize;
        if (Math.abs(previous - size) < 0.5)
            return false;
        this.#sizes[index] = size;
        this.#measured.set(key, size);
        this.#add(index, size - previous);
        return true;
    }
    /**
     * `keep` names one item that must stay in the window even if the viewport has
     * moved off it — the item holding the reader's selection. Dropping its element
     * would collapse the selection, and a growing message at the tail is enough to
     * shift the window by an item while they are still dragging.
     */
    range(scrollTop, viewportSize, overscan = 600, keep) {
        const count = this.#keys.length;
        const totalSize = this.totalSize();
        if (count === 0)
            return { start: 0, end: 0, paddingStart: 0, paddingEnd: 0, totalSize: 0 };
        const safeTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
        const safeViewport = Math.max(0, Number.isFinite(viewportSize) ? viewportSize : 0);
        const safeOverscan = Math.max(0, Number.isFinite(overscan) ? overscan : 0);
        let start = this.#indexAtOffset(Math.max(0, safeTop - safeOverscan));
        const last = this.#indexAtOffset(Math.min(totalSize, safeTop + safeViewport + safeOverscan));
        let end = Math.min(count, last + 1);
        if (keep !== undefined && Number.isInteger(keep) && keep >= 0 && keep < count) {
            if (keep < start && start - keep <= KEEP_SPAN_LIMIT)
                start = keep;
            if (keep >= end && keep - end < KEEP_SPAN_LIMIT)
                end = keep + 1;
        }
        const paddingStart = this.#prefix(start);
        const paddingEnd = Math.max(0, totalSize - this.#prefix(end));
        return { start, end, paddingStart, paddingEnd, totalSize };
    }
    totalSize() {
        return this.#prefix(this.#keys.length);
    }
    /** Pixel offset of an item, used to scroll a match into the virtual window. */
    offsetAt(index) {
        if (!Number.isInteger(index) || index <= 0)
            return 0;
        return this.#prefix(Math.min(index, this.#keys.length));
    }
    #add(index, delta) {
        for (let cursor = index + 1; cursor < this.#tree.length; cursor += cursor & -cursor) {
            this.#tree[cursor] = (this.#tree[cursor] ?? 0) + delta;
        }
    }
    #prefix(end) {
        let total = 0;
        for (let cursor = Math.min(end, this.#keys.length); cursor > 0; cursor -= cursor & -cursor) {
            total += this.#tree[cursor] ?? 0;
        }
        return total;
    }
    #indexAtOffset(offset) {
        if (offset <= 0)
            return 0;
        let index = 0;
        let accumulated = 0;
        let bit = highestPowerOfTwoAtMost(this.#keys.length);
        while (bit > 0) {
            const next = index + bit;
            const value = next < this.#tree.length ? this.#tree[next] ?? 0 : 0;
            if (next <= this.#keys.length && accumulated + value <= offset) {
                index = next;
                accumulated += value;
            }
            bit >>= 1;
        }
        return Math.min(this.#keys.length - 1, index);
    }
}
function sameKeys(left, right) {
    return left.length === right.length && left.every((key, index) => key === right[index]);
}
function highestPowerOfTwoAtMost(value) {
    if (value <= 0)
        return 0;
    return 2 ** Math.floor(Math.log2(value));
}
//# sourceMappingURL=virtual-list.js.map