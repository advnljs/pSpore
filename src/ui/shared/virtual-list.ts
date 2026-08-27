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
export function isScrollNearEnd(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 24,
): boolean {
  if (![scrollHeight, scrollTop, clientHeight, threshold].every(Number.isFinite)) return false;
  const maximumTop = Math.max(0, scrollHeight - Math.max(0, clientHeight));
  const currentTop = Math.min(maximumTop, Math.max(0, scrollTop));
  return maximumTop - currentTop <= Math.max(0, threshold);
}

/**
 * Variable-height list index backed by a Fenwick tree. Message measurements are
 * retained by stable key, while viewport lookup and height updates stay O(log n).
 */
export class VirtualHeightIndex {
  readonly #estimatedSize: number;
  readonly #measured = new Map<string, number>();
  #keys: string[] = [];
  #positions = new Map<string, number>();
  #sizes: number[] = [];
  #tree: number[] = [0];

  constructor(estimatedSize = 160) {
    if (!Number.isFinite(estimatedSize) || estimatedSize <= 0) {
      throw new Error("estimatedSize must be positive");
    }
    this.#estimatedSize = estimatedSize;
  }

  get count(): number {
    return this.#keys.length;
  }

  sync(keys: readonly string[]): void {
    if (sameKeys(this.#keys, keys)) return;
    this.#keys = [...keys];
    this.#positions = new Map(keys.map((key, index) => [key, index]));
    this.#sizes = keys.map((key) => this.#measured.get(key) ?? this.#estimatedSize);
    this.#tree = Array.from({ length: keys.length + 1 }, () => 0);
    for (const [index, size] of this.#sizes.entries()) this.#add(index, size);

    // Measurements from replaced/compacted histories should not retain DOM-sized
    // state forever. Keep only keys that still exist in the current transcript.
    for (const key of this.#measured.keys()) {
      if (!this.#positions.has(key)) this.#measured.delete(key);
    }
  }

  update(key: string, size: number): boolean {
    const index = this.#positions.get(key);
    if (index === undefined || !Number.isFinite(size) || size <= 0) return false;
    const previous = this.#sizes[index] ?? this.#estimatedSize;
    if (Math.abs(previous - size) < 0.5) return false;
    this.#sizes[index] = size;
    this.#measured.set(key, size);
    this.#add(index, size - previous);
    return true;
  }

  range(scrollTop: number, viewportSize: number, overscan = 600): VirtualRange {
    const count = this.#keys.length;
    const totalSize = this.totalSize();
    if (count === 0) return { start: 0, end: 0, paddingStart: 0, paddingEnd: 0, totalSize: 0 };
    const safeTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
    const safeViewport = Math.max(0, Number.isFinite(viewportSize) ? viewportSize : 0);
    const safeOverscan = Math.max(0, Number.isFinite(overscan) ? overscan : 0);
    const start = this.#indexAtOffset(Math.max(0, safeTop - safeOverscan));
    const last = this.#indexAtOffset(Math.min(totalSize, safeTop + safeViewport + safeOverscan));
    const end = Math.min(count, last + 1);
    const paddingStart = this.#prefix(start);
    const paddingEnd = Math.max(0, totalSize - this.#prefix(end));
    return { start, end, paddingStart, paddingEnd, totalSize };
  }

  totalSize(): number {
    return this.#prefix(this.#keys.length);
  }

  #add(index: number, delta: number): void {
    for (let cursor = index + 1; cursor < this.#tree.length; cursor += cursor & -cursor) {
      this.#tree[cursor] = (this.#tree[cursor] ?? 0) + delta;
    }
  }

  #prefix(end: number): number {
    let total = 0;
    for (let cursor = Math.min(end, this.#keys.length); cursor > 0; cursor -= cursor & -cursor) {
      total += this.#tree[cursor] ?? 0;
    }
    return total;
  }

  #indexAtOffset(offset: number): number {
    if (offset <= 0) return 0;
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

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function highestPowerOfTwoAtMost(value: number): number {
  if (value <= 0) return 0;
  return 2 ** Math.floor(Math.log2(value));
}
