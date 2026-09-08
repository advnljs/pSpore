export { UnsupportedDocumentError } from "./errors.js";
/**
 * One entry point for turning a user's document into text.
 *
 * Formats are decided by what the bytes are, never by the extension. WPS writes
 * Word and Excel files under names of its own, mail attachments arrive with the
 * extension stripped, and a file called `.txt` is regularly a spreadsheet. The
 * magic number is the only thing that is actually true about a file.
 */
export type DocumentFormat = "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt" | "pdf" | "text";
export interface ExtractedDocument {
    path: string;
    format: DocumentFormat;
    /** How the format was named to the user, e.g. "Word 97-2003 文档". */
    formatLabel: string;
    text: string;
    bytes: number;
    /** Pages, slides or worksheets, when the format has them. */
    sections: readonly {
        name: string;
        text: string;
    }[];
    /** Set when the text was cut to `limit`, carrying the full length. */
    truncatedFrom?: number;
    /** Set for plain text, saying which encoding the bytes were read as. */
    encoding?: string;
}
export interface ExtractOptions {
    /** Largest file to open, so a huge one fails fast instead of filling memory. */
    maxBytes?: number;
    /** Largest amount of text to return; the rest is reported, not returned. */
    limit?: number;
}
export declare const DEFAULT_MAX_DOCUMENT_BYTES: number;
export declare const DEFAULT_TEXT_LIMIT = 200000;
export declare function extractDocument(path: string, options?: ExtractOptions): Promise<ExtractedDocument>;
//# sourceMappingURL=extract.d.ts.map