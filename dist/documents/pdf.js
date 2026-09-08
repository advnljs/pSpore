import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { UnsupportedDocumentError } from "./errors.js";
/** Loaded on first use: pdf.js is large, and most documents are not PDFs. */
let engine;
async function loadEngine() {
    try {
        // Resolved rather than imported by specifier so the same code works from the
        // build output and from an Electron package, where the package sits in
        // different places relative to this module.
        const entry = createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs");
        return await import(pathToFileURL(entry).href);
    }
    catch (error) {
        // The standalone CLI is one bundled file with no package tree beside it, so
        // it cannot reach pdf.js. Every other format still works there, and saying
        // which build this is beats reporting a module resolution failure.
        throw new UnsupportedDocumentError(`本次运行的 pSpore 构建中没有 PDF 解析引擎（${error instanceof Error ? error.message : String(error)}）。`
            + "桌面版与服务进程支持 PDF；独立 CLI 二进制不支持，请改用桌面端或先把 PDF 转成文本。");
    }
}
/**
 * Data directories pdf.js loads from disk rather than from its own bundle.
 *
 * `cmaps` is what makes a Chinese PDF readable: one that names a predefined
 * CMap such as `UniGB-UCS2-H` maps its glyph codes through that table, and
 * without it the page comes back empty or as the wrong characters. Under Node
 * these are read with `fs`, so they are plain paths — a `file://` URL fails.
 */
function dataDirectories() {
    try {
        const require = createRequire(import.meta.url);
        const root = dirname(dirname(dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))));
        const cmaps = join(root, "cmaps");
        const fonts = join(root, "standard_fonts");
        return {
            ...(existsSync(cmaps) ? { cMapUrl: `${cmaps}/` } : {}),
            ...(existsSync(fonts) ? { standardFontDataUrl: `${fonts}/` } : {}),
        };
    }
    catch {
        // A build that ships pdf.js without its data files still reads any document
        // whose fonts are embedded, which is most of them.
        return {};
    }
}
export async function extractPdf(data) {
    engine ??= loadEngine();
    const pdfjs = await engine;
    const task = pdfjs.getDocument({
        // pdf.js takes ownership of the array it is given, so it gets its own copy.
        data: new Uint8Array(data),
        // Nothing here should reach the network or the font system, and no document
        // should be able to talk this process into evaluating its own code.
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        cMapPacked: true,
        ...dataDirectories(),
    });
    const document = await task.promise;
    try {
        const sections = [];
        for (let page = 1; page <= document.numPages; page += 1) {
            const content = await (await document.getPage(page)).getTextContent();
            // Items are glyph runs, not lines; pdf.js marks the ones that end a line.
            const text = content.items
                .map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : ""}`)
                .join("")
                .replace(/[ \t]+\n/g, "\n")
                .replace(/\n{3,}/g, "\n\n")
                .trim();
            sections.push({ name: `第 ${page} 页`, text });
        }
        return {
            pageCount: document.numPages,
            sections,
            text: sections
                .filter((section) => section.text !== "")
                .map((section) => `## ${section.name}\n${section.text}`)
                .join("\n\n"),
        };
    }
    finally {
        await task.destroy().catch(() => undefined);
    }
}
export function looksLikePdf(buffer) {
    // The header may sit behind a few junk bytes; readers tolerate that, and a
    // file that only reaches here because of its extension should too.
    return buffer.subarray(0, 1024).includes("%PDF-");
}
//# sourceMappingURL=pdf.js.map