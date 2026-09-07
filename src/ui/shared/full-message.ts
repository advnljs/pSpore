import { MAX_PUBLISHED_STRING_CHARS } from "../../protocol/limits.js";

/** One `session.message` response: a window onto a single message's text. */
export interface MessageSlice {
  offset: number;
  length: number;
  text: string;
}

/**
 * Characters one slice asks for. It matches the daemon's per-string publishing
 * ceiling, so a slice is never cut a second time on its way back.
 */
export const FULL_MESSAGE_SLICE_CHARS = MAX_PUBLISHED_STRING_CHARS;

/** Guards against paging forever if a peer keeps returning empty slices. */
const MAX_SLICE_REQUESTS = 64;

/**
 * Reassembles one message from slices, so a client can read text the publishing
 * ceiling had to cut without raising that ceiling for every message.
 *
 * Returns `undefined` when the slices do not line up — a message edited or
 * renumbered mid-read would otherwise be spliced together from two different
 * versions of itself. The caller decides what to tell the reader.
 */
export async function readFullMessage(
  fetchSlice: (offset: number, limit: number) => Promise<unknown>,
): Promise<string | undefined> {
  let restored = "";
  for (let request = 0; request < MAX_SLICE_REQUESTS; request += 1) {
    const slice = await fetchSlice(restored.length, FULL_MESSAGE_SLICE_CHARS);
    if (!isMessageSlice(slice) || slice.offset !== restored.length) return undefined;
    restored += slice.text;
    if (restored.length >= slice.length) return restored;
    // No progress and still short of the total: the rest is unreachable.
    if (slice.text.length === 0) return undefined;
  }
  return undefined;
}

export function isMessageSlice(value: unknown): value is MessageSlice {
  if (typeof value !== "object" || value === null) return false;
  const slice = value as Record<string, unknown>;
  return typeof slice["offset"] === "number"
    && typeof slice["length"] === "number"
    && typeof slice["text"] === "string";
}
