/** Renders `source` as markdown into `container`, replacing nothing that is already there. */
export declare function appendMarkdown(container: HTMLElement, source: string): void;
/**
 * The streaming bubble needs its caret to sit at the end of the last rendered
 * line rather than on a line of its own, so it is appended inside the trailing
 * block whenever that block is normal prose.
 */
export declare function appendMarkdownWithTrailing(container: HTMLElement, source: string, trailing: HTMLElement): void;
//# sourceMappingURL=markdown-view.d.ts.map