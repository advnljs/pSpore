/** Renders `source` as markdown into `container`, replacing nothing that is already there. */
export declare function appendMarkdown(container: HTMLElement, source: string): void;
/**
 * The streaming bubble needs its caret to sit at the end of the last rendered
 * line rather than on a line of its own, so it is appended inside the trailing
 * block whenever that block is normal prose.
 */
export declare function appendMarkdownWithTrailing(container: HTMLElement, source: string, trailing: HTMLElement): void;
/**
 * A markdown body that can be re-rendered from a growing source without
 * discarding the part that did not change.
 *
 * `appendMarkdown` builds the whole body at once, which is right for a message
 * that is already complete. A streaming reply is re-rendered on every token,
 * and replacing the DOM each time collapses any selection the reader is holding
 * — so text they can already see is text they cannot copy until the reply ends.
 * This keeps the blocks whose parse is unchanged and rebuilds only the tail.
 */
export interface MarkdownSurface {
    update(source: string, trailing?: HTMLElement): void;
}
export declare function createMarkdownSurface(container: HTMLElement): MarkdownSurface;
//# sourceMappingURL=markdown-view.d.ts.map