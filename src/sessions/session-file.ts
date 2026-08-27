import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ResolveSessionFileOptions {
  root?: string;
  allowMissing?: boolean;
}

/**
 * Canonicalize a Pi JSONL session path without requiring the leaf file to
 * exist. Pi intentionally defers creating a new file until persistence starts,
 * so callers may validate the existing canonical parent first and materialize
 * the leaf afterwards.
 */
export async function resolveSessionFile(
  path: string,
  options: ResolveSessionFileOptions = {},
): Promise<string> {
  const requested = resolve(path);
  if (!requested.endsWith(".jsonl")) throw invalidSessionFile(path);
  const root = options.root === undefined ? undefined : await realpath(options.root);
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch (error) {
    if (!options.allowMissing || !isNodeError(error) || error.code !== "ENOENT") throw error;
    const parent = await realpath(dirname(requested));
    assertInsideRoot(parent, root, path);
    canonical = join(parent, basename(requested));
    return canonical;
  }
  assertInsideRoot(canonical, root, path);
  if (!canonical.endsWith(".jsonl")) throw invalidSessionFile(path);
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error(`Session file is not a regular file: ${path}`);
  return canonical;
}

function assertInsideRoot(path: string, root: string | undefined, input: string): void {
  if (root === undefined) return;
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw invalidSessionFile(input);
}

function invalidSessionFile(path: string): Error {
  return new Error(`Session file must be a JSONL file inside the session root: ${path}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
