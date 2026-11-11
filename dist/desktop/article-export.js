import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, dialog } from "electron";
import { markdownToDocx } from "../articles/docx.js";
import { markdownToPdfHtml } from "../articles/html.js";
import { markdownToPlainText } from "../articles/plain.js";
import { ArticleStore } from "../articles/store.js";
import { mt } from "./main-i18n.js";
const FORMAT_EXTENSION = {
    txt: "txt",
    md: "md",
    docx: "docx",
    pdf: "pdf",
};
const FORMAT_LABEL = {
    txt: "纯文本",
    md: "Markdown",
    docx: "Word",
    pdf: "PDF",
};
/**
 * Turns one saved article version into a file the user picked.
 *
 * txt drops markdown markers. md is the source. docx and pdf keep headings,
 * emphasis, lists, tables and code. pdf is Chromium's print of the HTML, so
 * Chinese uses the desktop's fonts instead of an embedded face.
 */
export async function exportArticleFile(articles, request, owner) {
    if (request.version < 1)
        return { saved: false, message: mt("导出版本无效") };
    const document = await articles.readVersion(request.id, request.version);
    if (!document || document.version !== request.version) {
        return { saved: false, message: mt("没有找到这一版文稿") };
    }
    const extension = FORMAT_EXTENSION[request.format];
    const chosen = await dialog.showSaveDialog(owner, {
        title: mt("导出{format}", { format: mt(FORMAT_LABEL[request.format]) }),
        defaultPath: `${safeFileName(document.title)}.${extension}`,
        filters: [{ name: mt(FORMAT_LABEL[request.format]), extensions: [extension] }],
    });
    if (chosen.canceled || !chosen.filePath)
        return { saved: false, message: mt("已取消导出") };
    const bytes = request.format === "pdf"
        ? await renderPdf(document.title, document.content)
        : await renderBytes(request.format, document.title, document.content);
    await writeFile(chosen.filePath, bytes);
    return { saved: true, path: chosen.filePath, message: mt("已导出 {path}", { path: chosen.filePath }) };
}
async function renderBytes(format, title, content) {
    if (format === "md")
        return Buffer.from(content, "utf8");
    if (format === "txt")
        return Buffer.from(markdownToPlainText(content), "utf8");
    return markdownToDocx(content, title);
}
async function renderPdf(title, content) {
    const directory = await mkdtemp(join(tmpdir(), "pspore-article-"));
    const htmlPath = join(directory, "article.html");
    const preview = new BrowserWindow({
        show: false,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            javascript: false,
        },
    });
    try {
        await writeFile(htmlPath, markdownToPdfHtml(content, title), { encoding: "utf8", mode: 0o600 });
        await preview.loadURL(pathToFileURL(htmlPath).href);
        return await preview.webContents.printToPDF({
            printBackground: true,
            pageSize: "A4",
            margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
        });
    }
    finally {
        preview.destroy();
        await rm(directory, { recursive: true, force: true });
    }
}
function safeFileName(title) {
    const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
    return cleaned.slice(0, 80) || mt("文稿");
}
//# sourceMappingURL=article-export.js.map