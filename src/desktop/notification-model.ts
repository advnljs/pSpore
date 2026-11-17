import type { KernelState } from "../kernel/state.js";
import type { NotificationRecord } from "../notifications/notification-service.js";

/** The destination is resolved from authoritative state, never from popup IPC. */
export function notificationSession(record: NotificationRecord, state: KernelState): string | undefined {
  const id = record.target.kind === "session" ? record.target.sessionId
    : record.source.kind === "agent" ? record.source.sessionId : `run:${record.source.runId}`;
  return Object.hasOwn(state.sessions, id) ? id : undefined;
}

/** First connection is a baseline; subsequent snapshots recover missed notifications. */
export class NotificationFeed {
  readonly #seen = new Set<string>();
  #initialized = false;

  accept(records: readonly NotificationRecord[]): NotificationRecord[] {
    const fresh = records.filter((record) => !this.#seen.has(record.id));
    for (const record of records) this.#seen.add(record.id);
    // The daemon retains 200 records. Keep a wider bounded replay guard.
    while (this.#seen.size > 2_000) this.#seen.delete(this.#seen.values().next().value!);
    if (!this.#initialized) { this.#initialized = true; return []; }
    return fresh;
  }
}

export function notificationBounds(area: { x: number; y: number; width: number; height: number }): {
  x: number; y: number; width: number; height: number;
} {
  const margin = 16;
  const width = Math.min(432, area.width - margin * 2);
  const height = Math.min(292, area.height - margin * 2);
  return { x: area.x + area.width - width - margin, y: area.y + area.height - height - margin, width, height };
}
