/**
 * Shared ceilings for everything the daemon puts on the wire.
 *
 * Clients validate incoming frames strictly and drop the connection when a
 * frame violates a limit. A daemon that publishes an oversized-but-honest
 * payload therefore locks the client out permanently: the offending value is
 * part of the authoritative snapshot, so every reconnect replays the same
 * rejection. The daemon bounds its own output well below the client ceilings
 * so that can never happen, and clients keep the ceilings as a guard against a
 * genuinely broken peer.
 */
/** Client-side ceiling for a single string in a protocol value. */
export declare const MAX_PROTOCOL_STRING_CHARS = 262144;
/** Client-side ceiling for the entry count of a single array or object. */
export declare const MAX_PROTOCOL_COLLECTION_ENTRIES = 10000;
/** Client-side ceiling for JSON nesting depth. */
export declare const MAX_PROTOCOL_DEPTH = 32;
/** Client-side ceiling for the total node count of one protocol value. */
export declare const MAX_PROTOCOL_NODES = 2000000;
/** Daemon-side ceiling for a single published string. */
export declare const MAX_PUBLISHED_STRING_CHARS = 65536;
/** Daemon-side ceiling for a published array or object entry count. */
export declare const MAX_PUBLISHED_COLLECTION_ENTRIES = 2000;
/** Daemon-side ceiling for published JSON nesting depth. */
export declare const MAX_PUBLISHED_DEPTH = 24;
/**
 * Daemon-side ceiling for one whole published value. Per-string and per-array
 * limits alone still multiply out past what a frame can carry once a home holds
 * many long sessions, and the snapshot that cannot be encoded is the snapshot
 * every reconnect asks for again.
 */
export declare const MAX_PUBLISHED_VALUE_CHARS = 8388608;
export interface PublishedValueBounds {
    maxStringChars: number;
    maxCollectionEntries: number;
    maxDepth: number;
    maxTotalChars: number;
}
export declare const PUBLISHED_VALUE_BOUNDS: PublishedValueBounds;
/**
 * Returns `value` bounded to `bounds`, sharing structure with the input when
 * nothing had to be trimmed. Oversized strings keep their head and announce the
 * cut; arrays keep their newest entries and spend the shared budget on those
 * first, because every unbounded collection on this protocol is an append-only
 * transcript whose tail is the part a client is looking at.
 */
export declare function boundPublishedValue<T>(value: T, bounds?: PublishedValueBounds): T;
/**
 * Bounds `value` and reports roughly how many characters it will occupy on the
 * wire, so callers that retain published frames can budget their own memory
 * without re-serialising every one of them.
 */
export declare function measurePublishedValue<T>(value: T, bounds?: PublishedValueBounds): {
    value: T;
    cost: number;
};
/** Bounds a single string the same way `boundPublishedValue` bounds nested ones. */
export declare function boundPublishedText(value: string, maxChars?: number): string;
//# sourceMappingURL=limits.d.ts.map