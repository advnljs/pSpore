/** Find local paths in ordinary assistant prose, outside Markdown code spans. */
export type LocalTextPart = { text: string; href?: string };

const LOCAL_TARGET = /(?:file:\/\/\/|\/)[^\s<>"'`，。；：！？]+/g;
const END_PUNCTUATION = /[.,;:!?，。；：！？)\]}）]+$/;

export function localTextParts(value: string): LocalTextPart[] {
  const parts: LocalTextPart[] = [];
  let cursor = 0;
  for (const match of value.matchAll(LOCAL_TARGET)) {
    const start = match.index;
    const previous = value[start - 1];
    if (previous && !/[\s([{（]/.test(previous)) continue;
    const candidate = match[0];
    const href = candidate.replace(END_PUNCTUATION, "");
    if (href.length < 2 || href === "file:///") continue;
    if (start > cursor) parts.push({ text: value.slice(cursor, start) });
    parts.push({ text: href, href });
    cursor = start + href.length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor) });
  return parts;
}
