/**
 * Markdown to a WordprocessingML package.
 *
 * Headings, emphasis, lists, tables, quotes and code keep their roles as
 * styles and runs, so Word and WPS open a formatted document rather than a
 * dump of markdown source. No production dependency: the package is a ZIP of
 * XML, written with the same reader the document extractor already trusts.
 */
export declare function markdownToDocx(source: string, title: string): Buffer;
//# sourceMappingURL=docx.d.ts.map