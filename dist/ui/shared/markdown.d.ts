/**
 * Minimal CommonMark/GFM subset parser shared by the desktop renderer.
 *
 * It produces a plain data tree so the renderer can build DOM nodes with
 * `document.createElement`/`textContent` only — the desktop client never uses
 * `innerHTML`, so markdown must never round-trip through an HTML string.
 *
 * Supported: ATX headings, fenced code (including the still-open fence that
 * streaming produces), blockquotes, ordered/unordered/task lists, thematic
 * breaks, GFM pipe tables, and inline code/strong/emphasis/strikethrough/links.
 */
export type MarkdownInline = {
    kind: "text";
    value: string;
} | {
    kind: "code";
    value: string;
} | {
    kind: "strong";
    children: MarkdownInline[];
} | {
    kind: "emphasis";
    children: MarkdownInline[];
} | {
    kind: "strike";
    children: MarkdownInline[];
} | {
    kind: "link";
    href: string;
    children: MarkdownInline[];
} | {
    kind: "break";
};
export type MarkdownAlignment = "left" | "center" | "right" | undefined;
export interface MarkdownListItem {
    /** `undefined` for a plain bullet, boolean for a `- [ ]` / `- [x]` task item. */
    checked?: boolean;
    blocks: MarkdownBlock[];
}
export type MarkdownBlock = {
    kind: "paragraph";
    inline: MarkdownInline[];
} | {
    kind: "heading";
    level: 1 | 2 | 3 | 4 | 5 | 6;
    inline: MarkdownInline[];
} | {
    kind: "code";
    language: string;
    value: string;
    closed: boolean;
} | {
    kind: "quote";
    blocks: MarkdownBlock[];
} | {
    kind: "list";
    ordered: boolean;
    start: number;
    items: MarkdownListItem[];
} | {
    kind: "rule";
} | {
    kind: "table";
    alignments: MarkdownAlignment[];
    head: MarkdownInline[][];
    rows: MarkdownInline[][][];
};
export declare function parseMarkdown(source: string, depth?: number): MarkdownBlock[];
export declare function parseInline(source: string, depth?: number): MarkdownInline[];
//# sourceMappingURL=markdown.d.ts.map