/**
 * Decoding for files that are already text.
 *
 * Encoding cannot be assumed to be UTF-8 here. Documents that reach this agent
 * are the user's own, written on Windows or by WPS, where a Chinese plain-text
 * file is routinely GB18030; decoding one as UTF-8 yields a page of replacement
 * characters that reads as corruption rather than as a wrong guess.
 */
export interface DecodedText {
    text: string;
    /** Encoding the bytes were read as, so a reader can see what was assumed. */
    encoding: string;
}
export declare function decodeText(buffer: Buffer): DecodedText;
/**
 * True when the bytes hold no NUL, which is the standard test for text.
 *
 * It is also the test that matters downstream: a NUL is the one character
 * clients refuse, and `read` rejects files carrying one for the same reason.
 */
export declare function looksLikeText(buffer: Buffer): boolean;
//# sourceMappingURL=plain-text.d.ts.map