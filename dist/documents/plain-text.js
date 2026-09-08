/**
 * Decoding for files that are already text.
 *
 * Encoding cannot be assumed to be UTF-8 here. Documents that reach this agent
 * are the user's own, written on Windows or by WPS, where a Chinese plain-text
 * file is routinely GB18030; decoding one as UTF-8 yields a page of replacement
 * characters that reads as corruption rather than as a wrong guess.
 */
/** Legacy encoding tried when the bytes are not valid UTF-8. */
const CHINESE_FALLBACK = "gb18030";
export function decodeText(buffer) {
    const withBom = decodeByteOrderMark(buffer);
    if (withBom)
        return withBom;
    // UTF-8 is self-verifying: a byte sequence that decodes without producing a
    // replacement character is UTF-8 in practice, so it is tried before guessing.
    const utf8 = decodeStrict(buffer, "utf-8");
    if (utf8 !== undefined)
        return { text: utf8, encoding: "utf-8" };
    const legacy = decodeStrict(buffer, CHINESE_FALLBACK);
    if (legacy !== undefined)
        return { text: legacy, encoding: CHINESE_FALLBACK };
    // Nothing decoded cleanly. UTF-8 with replacement characters is the honest
    // result: it keeps the ASCII structure a reader can still use.
    return { text: buffer.toString("utf8"), encoding: "utf-8 (有无法解码的字节)" };
}
function decodeByteOrderMark(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        return { text: buffer.subarray(3).toString("utf8"), encoding: "utf-8" };
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
        return { text: new TextDecoder("utf-16le").decode(buffer.subarray(2)), encoding: "utf-16le" };
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
        return { text: new TextDecoder("utf-16be").decode(buffer.subarray(2)), encoding: "utf-16be" };
    }
    return undefined;
}
/** Decodes only when every byte was representable; otherwise reports failure. */
function decodeStrict(buffer, encoding) {
    try {
        return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    }
    catch {
        return undefined;
    }
}
/**
 * True when the bytes hold no NUL, which is the standard test for text.
 *
 * It is also the test that matters downstream: a NUL is the one character
 * clients refuse, and `read` rejects files carrying one for the same reason.
 */
export function looksLikeText(buffer) {
    return !buffer.includes(0);
}
//# sourceMappingURL=plain-text.js.map