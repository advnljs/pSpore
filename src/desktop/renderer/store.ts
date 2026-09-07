import type { RuntimeMessage } from "../../domain/runtime.js";
import type { KernelState } from "../../kernel/state.js";
import type { EventEnvelope } from "../../protocol/schema.js";
import {
  applyProtocolDelta,
  applyProtocolEvent,
  applyTranscriptPage as mergeTranscriptPage,
  initialProtocolUiState,
  replaceProtocolSnapshot,
  selectProtocolSession,
  type ProtocolUiState,
} from "../../ui/shared/protocol-state.js";
import {
  applyCoworkActivityEvent,
  type CoworkActivity,
} from "../../ui/shared/activity.js";
import type { DesktopBootstrap, DesktopConnectionState, DesktopFrame } from "../ipc-contract.js";

export type DesktopActivity = CoworkActivity;

/**
 * A reconnect that resolves inside this window is invisible to the user. Long
 * runs briefly drop and re-establish the socket; showing every one of those made
 * the header badge, banner and every connection-gated button flicker.
 */
export const CONNECTION_SETTLE_MS = 2_000;

export interface DesktopStoreSnapshot {
  /** Raw bridge state; use `stableConnection` for anything the user sees. */
  connection: DesktopConnectionState;
  /**
   * Connection state after the settle window: it keeps reporting `connected`
   * through a short reconnect and only degrades once the outage outlasts
   * `CONNECTION_SETTLE_MS`.
   */
  stableConnection: DesktopConnectionState;
  /** True while a reconnect is in flight but still being presented as connected. */
  reconnecting: boolean;
  kernel: KernelState;
  cursors: Readonly<Record<string, number>>;
  streamingText: Readonly<Record<string, string>>;
  streamingThinking: Readonly<Record<string, string>>;
  /** Transcript item each session is streaming, keyed by session id. */
  streamingItems: Readonly<Record<string, string>>;
  selectedSessionId: string;
  activities: readonly DesktopActivity[];
  notice: string;
  gap?: { streamId: string; expected: number; received: number };
}

export class DesktopStore {
  readonly #now: () => number;
  /** Timestamp the current non-connected phase began, or undefined while connected. */
  #unsettledSince: number | undefined;
  #lastConnected: DesktopConnectionState | undefined;
  #state: DesktopStoreSnapshot = {
    connection: { phase: "disconnected", attempt: 0, message: "Desktop is starting" },
    stableConnection: { phase: "disconnected", attempt: 0, message: "Desktop is starting" },
    reconnecting: false,
    ...initialProtocolUiState(),
    activities: [],
    notice: "正在启动 pSpore…",
  };

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /**
   * Re-evaluates the settle window. The renderer calls this on a timer so a
   * genuine outage still surfaces even when no further frames arrive.
   * Returns true when the presented state changed.
   */
  settleConnection(): boolean {
    const stable = this.#stableConnection(this.#state.connection);
    const reconnecting = this.#isReconnecting(this.#state.connection);
    if (stable.phase === this.#state.stableConnection.phase
      && stable.message === this.#state.stableConnection.message
      && stable.instanceId === this.#state.stableConnection.instanceId
      && reconnecting === this.#state.reconnecting) {
      return false;
    }
    this.#state = { ...this.#state, stableConnection: stable, reconnecting };
    if (stable.phase !== "connected") this.#state = { ...this.#state, notice: connectionNotice(stable) };
    return true;
  }

  snapshot(): DesktopStoreSnapshot {
    // Reducers replace state immutably and already clone untrusted IPC payloads.
    // Returning the current read model avoids cloning the complete transcript on
    // every streaming delta; renderer code treats this value as read-only.
    return this.#state;
  }

  applyBootstrap(bootstrap: DesktopBootstrap): void {
    const protocol = bootstrap.snapshot
      ? replaceProtocolSnapshot(protocolState(this.#state), bootstrap.snapshot, bootstrap.cursors)
      : { ...protocolState(this.#state), cursors: { ...bootstrap.cursors } };
    this.#state = { ...this.#state, ...protocol };
    delete this.#state.gap;
    this.#setConnection(bootstrap.connection);
  }

  applyFrame(frame: DesktopFrame): void {
    if (frame.kind === "connection") {
      this.#setConnection(frame.connection);
      return;
    }
    if (frame.kind === "snapshot") {
      this.#state = {
        ...this.#state,
        ...replaceProtocolSnapshot(protocolState(this.#state), frame.snapshot, frame.cursors),
        notice: "已加载守护进程权威快照",
      };
      delete this.#state.gap;
      return;
    }
    if (frame.kind === "delta") {
      const result = applyProtocolDelta(protocolState(this.#state), frame);
      this.#state = { ...this.#state, ...result.state, ...(result.state.gap ? { notice: gapNotice(result.state.gap) } : {}) };
      return;
    }
    this.#applyEvent(frame.event);
  }

  /** Merges an older page of history fetched by the transcript backfill. */
  applyTranscriptPage(page: { sessionId: string; from: number; count: number; messages: readonly RuntimeMessage[] }): boolean {
    const next = mergeTranscriptPage(protocolState(this.#state), page);
    if (next === protocolState(this.#state)) return false;
    this.#state = { ...this.#state, ...next };
    return true;
  }

  selectSession(id: string): void {
    this.#state = { ...this.#state, ...selectProtocolSession(protocolState(this.#state), id), notice: `已切换到 ${id}` };
  }

  setNotice(notice: string): void {
    this.#state = { ...this.#state, notice };
  }

  #setConnection(connection: DesktopConnectionState): void {
    const next = structuredClone(connection);
    if (next.phase === "connected") {
      this.#unsettledSince = undefined;
      this.#lastConnected = next;
    } else if (this.#unsettledSince === undefined) {
      this.#unsettledSince = this.#now();
    }
    const stable = this.#stableConnection(next);
    const reconnecting = this.#isReconnecting(next);
    this.#state = {
      ...this.#state,
      connection: next,
      stableConnection: stable,
      reconnecting,
      // A blip inside the settle window keeps the previous notice, so the status
      // line does not flash "disconnected" and back during a long run.
      ...(reconnecting ? {} : { notice: connectionNotice(stable) }),
    };
  }

  #stableConnection(connection: DesktopConnectionState): DesktopConnectionState {
    if (!this.#isReconnecting(connection)) return connection;
    return structuredClone(this.#lastConnected as DesktopConnectionState);
  }

  /** True while a short outage is still being presented as a live connection. */
  #isReconnecting(connection: DesktopConnectionState): boolean {
    if (connection.phase === "connected") return false;
    if (!this.#lastConnected || this.#unsettledSince === undefined) return false;
    return this.#now() - this.#unsettledSince < CONNECTION_SETTLE_MS;
  }

  #applyEvent(event: EventEnvelope): void {
    const result = applyProtocolEvent(protocolState(this.#state), event);
    if (!result.applied) {
      this.#state = { ...this.#state, ...result.state, ...(result.state.gap ? { notice: gapNotice(result.state.gap) } : {}) };
      return;
    }
    const activities = applyCoworkActivityEvent(this.#state.activities, event);
    this.#state = {
      ...this.#state,
      ...result.state,
      activities,
      ...(result.notificationNotice ? { notice: result.notificationNotice } : {}),
    };
  }
}

function protocolState(state: DesktopStoreSnapshot): ProtocolUiState {
  return {
    kernel: state.kernel,
    cursors: state.cursors,
    streamingText: state.streamingText,
    streamingThinking: state.streamingThinking,
    streamingItems: state.streamingItems,
    selectedSessionId: state.selectedSessionId,
    ...(state.gap ? { gap: state.gap } : {}),
  };
}

function gapNotice(gap: NonNullable<ProtocolUiState["gap"]>): string {
  return `事件流 ${gap.streamId} 出现缺口：期望 ${gap.expected}，收到 ${gap.received}；正在等待新的权威快照`;
}

function connectionNotice(connection: DesktopConnectionState): string {
  if (connection.phase === "connected") return "已连接本地守护进程";
  return connection.message ?? (connection.phase === "connecting" ? "正在连接守护进程…" : "守护进程已断开");
}
