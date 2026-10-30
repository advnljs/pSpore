import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type LocalPathAction = "open" | "reveal";

export interface LocalPathRequest {
  path: string;
  action: LocalPathAction;
}

/** A string is the original click payload: open the path. */
export function decodeLocalPathRequest(value: unknown): LocalPathRequest {
  if (typeof value === "string") return { path: value, action: "open" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("无效的本地路径");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "path" && key !== "action") throw new Error("无效的本地路径");
  }
  if (record["action"] !== "open" && record["action"] !== "reveal") throw new Error("无效的打开方式");
  if (typeof record["path"] !== "string") throw new Error("无效的本地路径");
  return { path: record["path"], action: record["action"] };
}

/**
 * The renderer may request only a local, existing regular file or directory.
 * Opening an executable is refused — the system opener may run it — but
 * revealing it in the file manager does not.
 */
export async function resolveLocalPath(value: string, action: LocalPathAction): Promise<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("无效的本地路径");
  }
  let path = value;
  if (value.startsWith("file:")) {
    try {
      path = fileURLToPath(value);
    } catch {
      throw new Error("只支持本机 file:// 链接");
    }
  }
  if (!isAbsolute(path)) throw new Error("只支持绝对本地路径");
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new Error("文件或目录不存在，或无法访问");
  }
  if (!details.isFile() && !details.isDirectory()) throw new Error("只支持普通文件和目录");
  if (action === "open" && details.isFile() && ((details.mode & 0o111) !== 0 || path.toLowerCase().endsWith(".desktop"))) {
    throw new Error("可执行文件不能通过对话链接直接打开");
  }
  return path;
}

export async function decodeOpenLocalPath(value: unknown): Promise<string> {
  const request = decodeLocalPathRequest(value);
  return resolveLocalPath(request.path, request.action);
}
