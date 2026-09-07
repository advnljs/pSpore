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
export const MAX_PROTOCOL_STRING_CHARS = 262_144;
/** Client-side ceiling for the entry count of a single array or object. */
export const MAX_PROTOCOL_COLLECTION_ENTRIES = 10_000;
/** Client-side ceiling for JSON nesting depth. */
export const MAX_PROTOCOL_DEPTH = 32;
/** Client-side ceiling for the total node count of one protocol value. */
export const MAX_PROTOCOL_NODES = 2_000_000;
/** Daemon-side ceiling for a single published string. */
export const MAX_PUBLISHED_STRING_CHARS = 65_536;
/** Daemon-side ceiling for a published array or object entry count. */
export const MAX_PUBLISHED_COLLECTION_ENTRIES = 2_000;
/** Daemon-side ceiling for published JSON nesting depth. */
export const MAX_PUBLISHED_DEPTH = 24;
/**
 * Daemon-side ceiling for one whole published value. Per-string and per-array
 * limits alone still multiply out past what a frame can carry once a home holds
 * many long sessions, and the snapshot that cannot be encoded is the snapshot
 * every reconnect asks for again.
 */
export const MAX_PUBLISHED_VALUE_CHARS = 8_388_608;
const NESTED_PLACEHOLDER = "[truncated: value nested too deeply]";
/** Rough per-entry overhead of JSON delimiters, so the budget tracks the wire. */
const ENTRY_OVERHEAD = 2;
/** Rough cost of a scalar that carries no length of its own. */
const SCALAR_COST = 8;
export const PUBLISHED_VALUE_BOUNDS = {
    maxStringChars: MAX_PUBLISHED_STRING_CHARS,
    maxCollectionEntries: MAX_PUBLISHED_COLLECTION_ENTRIES,
    maxDepth: MAX_PUBLISHED_DEPTH,
    maxTotalChars: MAX_PUBLISHED_VALUE_CHARS,
};
/**
 * Returns `value` bounded to `bounds`, sharing structure with the input when
 * nothing had to be trimmed. Oversized strings keep their head and announce the
 * cut; arrays keep their newest entries and spend the shared budget on those
 * first, because every unbounded collection on this protocol is an append-only
 * transcript whose tail is the part a client is looking at.
 */
export function boundPublishedValue(value, bounds = PUBLISHED_VALUE_BOUNDS) {
    return measurePublishedValue(value, bounds).value;
}
/**
 * Bounds `value` and reports roughly how many characters it will occupy on the
 * wire, so callers that retain published frames can budget their own memory
 * without re-serialising every one of them.
 */
export function measurePublishedValue(value, bounds = PUBLISHED_VALUE_BOUNDS) {
    const bounded = bound(value, bounds, 0, { remaining: bounds.maxTotalChars });
    return { value: bounded.value, cost: bounded.cost };
}
/** Bounds a single string the same way `boundPublishedValue` bounds nested ones. */
export function boundPublishedText(value, maxChars = MAX_PUBLISHED_STRING_CHARS) {
    if (value.length <= maxChars)
        return value;
    // The marker is part of the budget, and its own length depends only on values
    // the caller already knows, so the result is exactly `maxChars` characters.
    const marker = `…[truncated to ${maxChars} of ${value.length} characters]`;
    return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}
function bound(value, bounds, depth, budget) {
    if (typeof value === "string") {
        const bounded = boundPublishedText(value, bounds.maxStringChars);
        budget.remaining -= bounded.length;
        return { value: bounded, cost: bounded.length };
    }
    if (value === null || typeof value !== "object") {
        budget.remaining -= SCALAR_COST;
        return { value, cost: SCALAR_COST };
    }
    if (depth >= bounds.maxDepth) {
        budget.remaining -= NESTED_PLACEHOLDER.length;
        return { value: NESTED_PLACEHOLDER, cost: NESTED_PLACEHOLDER.length };
    }
    if (Array.isArray(value))
        return boundArray(value, bounds, depth, budget);
    return boundObject(value, bounds, depth, budget);
}
function boundArray(value, bounds, depth, budget) {
    const start = Math.max(0, value.length - bounds.maxCollectionEntries);
    let changed = start > 0;
    let cost = ENTRY_OVERHEAD;
    // Newest first: an exhausted budget drops the oldest entries rather than
    // starving the tail a client actually renders.
    const reversed = [];
    for (let index = value.length - 1; index >= start; index -= 1) {
        if (budget.remaining <= 0) {
            changed = true;
            break;
        }
        const item = value[index];
        const bounded = bound(item, bounds, depth + 1, budget);
        if (bounded.value !== item)
            changed = true;
        budget.remaining -= ENTRY_OVERHEAD;
        cost += bounded.cost + ENTRY_OVERHEAD;
        reversed.push(bounded.value);
    }
    if (!changed)
        return { value, cost };
    return { value: reversed.reverse(), cost };
}
function boundObject(value, bounds, depth, budget) {
    const entries = Object.entries(value);
    const trimmed = entries.length > bounds.maxCollectionEntries
        ? entries.slice(-bounds.maxCollectionEntries)
        : entries;
    let changed = trimmed.length !== entries.length;
    let cost = ENTRY_OVERHEAD;
    const next = {};
    for (const [key, item] of trimmed) {
        // Object keys are structure, not payload: dropping them would break the
        // shape a client validates against, so they are always kept.
        const bounded = bound(item, bounds, depth + 1, budget);
        if (bounded.value !== item)
            changed = true;
        budget.remaining -= key.length + ENTRY_OVERHEAD;
        cost += bounded.cost + key.length + ENTRY_OVERHEAD;
        next[key] = bounded.value;
    }
    return changed ? { value: next, cost } : { value, cost };
}
//# sourceMappingURL=limits.js.map