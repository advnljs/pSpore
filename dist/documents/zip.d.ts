export declare class ZipArchive {
    #private;
    private constructor();
    static open(buffer: Buffer): ZipArchive;
    has(name: string): boolean;
    /** Part names in the archive, in central-directory order. */
    names(): string[];
    /** Names matching `pattern`, sorted so `slide2` precedes `slide10`. */
    matching(pattern: RegExp): string[];
    /** Reads one part as UTF-8, or undefined when the package does not carry it. */
    readText(name: string): string | undefined;
}
/** True when the buffer starts with a local file header, so it is worth opening. */
export declare function looksLikeZip(buffer: Buffer): boolean;
//# sourceMappingURL=zip.d.ts.map