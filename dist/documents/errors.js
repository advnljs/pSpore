/**
 * Thrown when a file is a format this build cannot read, as opposed to a
 * document that failed to parse.
 *
 * The two need different advice — "save it as .docx" against "this file is
 * damaged" — so callers distinguish them by type rather than by inspecting a
 * message. It lives in its own module because the PDF path raises it too, and a
 * shared error should not make the two import each other.
 */
export class UnsupportedDocumentError extends Error {
}
//# sourceMappingURL=errors.js.map