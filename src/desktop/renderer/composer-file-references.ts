export const MAX_COMPOSER_FILE_REFERENCES = 32;
export const MAX_COMPOSER_MESSAGE_LENGTH = 65_536;

const MAX_REFERENCE_PATH_LENGTH = 4_096;
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type ComposerFileReferenceKind = "file" | "directory";

export interface ComposerFileReference {
  path: string;
  kind: ComposerFileReferenceKind;
}

export interface MergeComposerFileReferencesResult {
  references: ComposerFileReference[];
  added: number;
  skipped: number;
}

/**
 * Electron returns an absolute path for an operating-system-backed File. Keep
 * only bounded Linux paths so a dropped browser-created File cannot become an
 * ambiguous prompt reference.
 */
export function composerFileReference(
  path: string,
  kind: ComposerFileReferenceKind,
): ComposerFileReference | undefined {
  if (!path.startsWith("/") || path.length > MAX_REFERENCE_PATH_LENGTH || UNSAFE_PATH_CHARACTERS.test(path)) {
    return undefined;
  }
  return { path, kind };
}

export function mergeComposerFileReferences(
  current: readonly ComposerFileReference[],
  incoming: readonly ComposerFileReference[],
  maximum = MAX_COMPOSER_FILE_REFERENCES,
): MergeComposerFileReferencesResult {
  const references = current.slice(0, maximum);
  const seen = new Set(references.map((reference) => reference.path));
  let added = 0;
  let skipped = Math.max(0, current.length - references.length);

  for (const reference of incoming) {
    if (seen.has(reference.path) || references.length >= maximum) {
      skipped += 1;
      continue;
    }
    references.push(reference);
    seen.add(reference.path);
    added += 1;
  }
  return { references, added, skipped };
}

export function composerFileReferenceToken(reference: ComposerFileReference): string {
  // JSON quoting keeps whitespace, quotes and backslashes unambiguous while
  // retaining Pi's familiar @path reference marker. No file content is read.
  return `@${JSON.stringify(reference.path)}`;
}

export function composeMessageWithFileReferences(
  text: string,
  references: readonly ComposerFileReference[],
  maximumLength = MAX_COMPOSER_MESSAGE_LENGTH,
): string {
  const body = text.trim();
  const referenceBlock = references.map(composerFileReferenceToken).join("\n");
  const message = body && referenceBlock ? `${body}\n\n${referenceBlock}` : body || referenceBlock;
  if (message.length > maximumLength) {
    throw new Error(`消息与文件引用合计不能超过 ${maximumLength} 个字符`);
  }
  return message;
}

export function composerFileReferenceName(path: string): string {
  const withoutTrailingSlash = path.length > 1 ? path.replace(/\/+$/u, "") : path;
  const separator = withoutTrailingSlash.lastIndexOf("/");
  return withoutTrailingSlash.slice(separator + 1) || withoutTrailingSlash;
}
