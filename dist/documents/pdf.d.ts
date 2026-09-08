/**
 * PDF text through pdf.js.
 *
 * A PDF does not contain text so much as instructions for placing glyphs, and a
 * Chinese one places them through an embedded CID font whose codes mean nothing
 * without the font's own ToUnicode table. Reimplementing that is how extraction
 * ends up returning confident mojibake, so this is the one format that leans on
 * a library — used for text only, with no rendering and no network fetches.
 */
export interface PdfDocument {
    text: string;
    pageCount: number;
    sections: readonly {
        name: string;
        text: string;
    }[];
}
export declare function extractPdf(data: Buffer): Promise<PdfDocument>;
export declare function looksLikePdf(buffer: Buffer): boolean;
//# sourceMappingURL=pdf.d.ts.map