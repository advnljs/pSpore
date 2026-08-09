import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function atomicWriteFile(path: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((cleanupError: unknown) => {
      if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function atomicWriteJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export async function appendJsonLine(path: string, value: unknown, mode = 0o600): Promise<void> {
  const file = await open(path, "a", mode);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
