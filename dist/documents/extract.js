import { readFile, stat } from "node:fs/promises";
import { UnsupportedDocumentError } from "./errors.js";
import { detectLegacyKind, extractLegacy } from "./legacy-office.js";
import { OleDocument, looksLikeOle } from "./ole.js";
import { detectOoxmlKind, extractOoxml } from "./ooxml.js";
import { extractPdf, looksLikePdf } from "./pdf.js";
import { decodeText, looksLikeText } from "./plain-text.js";
import { ZipArchive, looksLikeZip } from "./zip.js";
export { UnsupportedDocumentError } from "./errors.js";
export const DEFAULT_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TEXT_LIMIT = 200_000;
const FORMAT_LABELS = {
    docx: "Word 文档",
    xlsx: "Excel 工作簿",
    pptx: "PowerPoint 演示文稿",
    doc: "Word 97-2003 文档",
    xls: "Excel 97-2003 工作簿",
    ppt: "PowerPoint 97-2003 演示文稿",
    pdf: "PDF 文档",
    text: "纯文本",
};
export async function extractDocument(path, options = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    const limit = options.limit ?? DEFAULT_TEXT_LIMIT;
    const stats = await stat(path);
    if (!stats.isFile())
        throw new UnsupportedDocumentError(`不是普通文件: ${path}`);
    if (stats.size > maxBytes) {
        throw new UnsupportedDocumentError(`文件超过 ${maxBytes} 字节的抽取上限: ${path}`);
    }
    const buffer = await readFile(path);
    const extracted = await extractBuffer(buffer, path);
    return applyLimit({ ...extracted, bytes: buffer.length }, limit);
}
async function extractBuffer(buffer, path) {
    if (looksLikeZip(buffer)) {
        const archive = ZipArchive.open(buffer);
        const kind = detectOoxmlKind(archive);
        if (!kind) {
            throw new UnsupportedDocumentError(`${path} 是 zip 包，但不是 Word/Excel/PowerPoint 文档（顶层内容：${archive.names().slice(0, 8).join(", ")}）`);
        }
        const document = extractOoxml(archive, kind);
        return { path, format: kind, formatLabel: FORMAT_LABELS[kind], text: document.text, sections: document.sections };
    }
    if (looksLikeOle(buffer)) {
        const document = OleDocument.open(buffer);
        const kind = detectLegacyKind(document);
        if (!kind) {
            // WPS's own `.wps`/`.et`/`.dps` land here: a compound document whose
            // streams are Kingsoft's rather than Microsoft's.
            throw new UnsupportedDocumentError(`${path} 是旧版复合文档，但不是 Word/Excel/PowerPoint 格式（内部流：${document.names().slice(0, 8).join(", ")}）。`
                + "如果是 WPS 私有格式，请在 WPS 里另存为 .docx/.xlsx/.pptx 后重试。");
        }
        const document_ = extractLegacy(document, kind);
        return { path, format: kind, formatLabel: FORMAT_LABELS[kind], text: document_.text, sections: document_.sections };
    }
    if (looksLikePdf(buffer)) {
        const document = await extractPdf(buffer);
        return { path, format: "pdf", formatLabel: FORMAT_LABELS.pdf, text: document.text, sections: document.sections };
    }
    if (looksLikeText(buffer)) {
        const decoded = decodeText(buffer);
        return {
            path,
            format: "text",
            formatLabel: FORMAT_LABELS.text,
            text: decoded.text,
            sections: [],
            encoding: decoded.encoding,
        };
    }
    throw new UnsupportedDocumentError(`无法识别的二进制格式: ${path}（前 8 字节 ${[...buffer.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}）`);
}
/**
 * Cuts the text to what a caller asked for and says how much there was.
 *
 * Sections are cut to match, so a reader is never shown a per-page breakdown
 * that disagrees with the text above it.
 */
function applyLimit(document, limit) {
    if (document.text.length <= limit)
        return document;
    return {
        ...document,
        text: document.text.slice(0, limit),
        sections: [],
        truncatedFrom: document.text.length,
    };
}
//# sourceMappingURL=extract.js.map