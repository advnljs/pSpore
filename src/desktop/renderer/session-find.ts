/** One occurrence of the current query inside a session transcript. */
export interface TextHit {
  /** Index into the searched text list. */
  index: number;
  /** Occurrence within that text, starting at 0. */
  occurrence: number;
}

export interface TextHitResult {
  hits: TextHit[];
  /** True when matching stopped at the cap so a huge transcript cannot stall the UI. */
  capped: boolean;
}

/** Enough to jump through a long conversation without scanning every later copy. */
const MAX_HITS = 500;

/**
 * Finds non-overlapping, case-insensitive matches in transcript texts.
 * The texts are the session's message bodies in order, plus the live draft.
 */
export function findTextHits(texts: readonly string[], query: string): TextHitResult {
  const needle = query.trim().toLowerCase();
  if (!needle) return { hits: [], capped: false };
  const hits: TextHit[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const folded = (texts[index] ?? "").toLowerCase();
    let from = 0;
    let occurrence = 0;
    while (from < folded.length) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      hits.push({ index, occurrence });
      if (hits.length >= MAX_HITS) return { hits, capped: true };
      occurrence += 1;
      from = at + needle.length;
    }
  }
  return { hits, capped: false };
}
