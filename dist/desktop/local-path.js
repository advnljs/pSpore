import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
/** The renderer may request only a local, existing regular file or directory. */
export async function decodeOpenLocalPath(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\x00-\x1f\x7f]/.test(value)) {
        throw new Error("无效的本地路径");
    }
    let path = value;
    if (value.startsWith("file:")) {
        try {
            path = fileURLToPath(value);
        }
        catch {
            throw new Error("只支持本机 file:// 链接");
        }
    }
    if (!isAbsolute(path))
        throw new Error("只支持绝对本地路径");
    let details;
    try {
        details = await stat(path);
    }
    catch {
        throw new Error("文件或目录不存在，或无法访问");
    }
    if (!details.isFile() && !details.isDirectory())
        throw new Error("只支持普通文件和目录");
    // shell.openPath may run an executable instead of showing its contents. Agent
    // output is untrusted even though the user explicitly clicks the link.
    if (details.isFile() && ((details.mode & 0o111) !== 0 || path.toLowerCase().endsWith(".desktop"))) {
        throw new Error("可执行文件不能通过对话链接直接打开");
    }
    return path;
}
//# sourceMappingURL=local-path.js.map