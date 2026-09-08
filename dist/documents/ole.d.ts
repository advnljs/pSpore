/**
 * The container every pre-2007 Office file is written in.
 *
 * A `.doc`, `.xls` or `.ppt` is a Compound File Binary document: a FAT-style
 * filesystem inside one file, whose named streams hold the actual format. The
 * reader is here so the three legacy parsers share one implementation of the
 * container and only differ in how they read their own stream.
 */
export declare class OleDocument {
    #private;
    private constructor();
    static open(buffer: Buffer): OleDocument;
    /** Stream names present in the document, for diagnostics and format sniffing. */
    names(): string[];
    has(name: string): boolean;
    /** Reads a whole named stream, or undefined when the document has no such stream. */
    read(name: string): Buffer | undefined;
}
export declare function looksLikeOle(buffer: Buffer): boolean;
//# sourceMappingURL=ole.d.ts.map