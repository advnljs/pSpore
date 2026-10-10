/** Find local paths in ordinary assistant prose, outside Markdown code spans. */
export type LocalTextPart = {
    text: string;
    href?: string;
};
export declare function localTextParts(value: string): LocalTextPart[];
//# sourceMappingURL=local-links.d.ts.map