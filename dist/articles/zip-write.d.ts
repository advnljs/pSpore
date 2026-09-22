export interface ZipMember {
    name: string;
    data: Buffer | string;
}
/**
 * Writes a ZIP that Office and WPS can open. Parts are deflated when that
 * actually shrinks them; everything else is stored. No extra fields, no
 * comment, so the central directory stays trivial to read back.
 */
export declare function writeZip(files: readonly ZipMember[]): Buffer;
//# sourceMappingURL=zip-write.d.ts.map