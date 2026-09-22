/**
 * Markdown to a self-contained HTML document for print-to-PDF.
 *
 * The hidden export window loads this file with JavaScript disabled. Every
 * piece of article text is escaped, and link targets are limited to http(s)
 * and mailto so a model-written document cannot navigate that window.
 */
export declare function markdownToPdfHtml(source: string, title: string): string;
export declare function escapeHtml(value: string): string;
//# sourceMappingURL=html.d.ts.map