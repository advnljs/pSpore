import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { mt } from "./main-i18n.js";
/**
 * How long a launcher may stay alive before we treat it as having handed the
 * file off. `xdg-open` often does not exit until the opened application does,
 * and Electron's `shell.openPath` waits for an activation token that never
 * arrives here — the click then surfaced a timeout even when the file opened.
 */
const HANDOFF_MS = 700;
export function openerFailure(code) {
    if (code === 0 || code === null)
        return undefined;
    switch (code) {
        case 1:
            return mt("系统打开器无法识别这个路径");
        case 2:
            return mt("文件或目录不存在，或无法访问");
        case 3:
            return mt("系统缺少打开此文件所需的工具");
        case 4:
            return mt("没有可用于打开此文件的程序，可右键选择打开所在目录");
        default:
            return mt("系统打开器退出码 {code}", { code });
    }
}
/** Arguments for FileManager1.ShowItems, which selects the file in its folder. */
export function fileManagerShowItemsArgs(targetPath) {
    const uri = pathToFileURL(targetPath).href.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.FileManager1",
        "--object-path",
        "/org/freedesktop/FileManager1",
        "--method",
        "org.freedesktop.FileManager1.ShowItems",
        `['${uri}']`,
        "",
    ];
}
/**
 * Spawns a command without a shell. A process that is still running after the
 * grace period has handed off; only a quick non-zero exit or a missing binary
 * is a failure.
 */
export function launchCommand(command, args, graceMs = HANDOFF_MS) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore" });
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            child.unref();
            if (error)
                reject(error);
            else
                resolve();
        };
        const timer = setTimeout(() => finish(), graceMs);
        child.once("error", (error) => {
            finish(new Error(error.code === "ENOENT" ? mt("未找到 {command}", { command }) : error.message));
        });
        child.once("exit", (code) => {
            const message = openerFailure(code);
            finish(message ? new Error(message) : undefined);
        });
    });
}
export function openLocalItem(targetPath) {
    return launchCommand("xdg-open", [targetPath]);
}
/**
 * Asks the file manager to show the path's parent and select the path. When
 * that service is missing, the parent directory is opened instead.
 */
export async function revealLocalItem(targetPath) {
    try {
        await launchCommand("gdbus", fileManagerShowItemsArgs(targetPath), 1_000);
        return;
    }
    catch {
        // FileManager1 is optional. The parent directory is the remaining way to land on the file.
    }
    await openLocalItem(dirname(targetPath));
}
//# sourceMappingURL=system-open.js.map