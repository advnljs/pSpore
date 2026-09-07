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
export declare const FULL_MESSAGE_SLICE_CHARS = 65536;
/**
 * Reassembles one message from slices, so a client can read text the publishing
 * ceiling had to cut without raising that ceiling for every message.
 *
 * Returns `undefined` when the slices do not line up — a message edited or
 * renumbered mid-read would otherwise be spliced together from two different
 * versions of itself. The caller decides what to tell the reader.
 */
export declare function readFullMessage(fetchSlice: (offset: number, limit: number) => Promise<unknown>): Promise<string | undefined>;
export declare function isMessageSlice(value: unknown): value is MessageSlice;
//# sourceMappingURL=full-message.d.ts.map