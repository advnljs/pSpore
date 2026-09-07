import type { ModelRef } from "../../domain/runtime.js";
import type { KernelState } from "../../kernel/state.js";
import type { EventEnvelope, ServerHelloFrame } from "../../protocol/schema.js";
import { applyCoworkActivityEvent, type CoworkActivity } from "../shared/activity.js";
import {
  applyProtocolEvent,
  initialProtocolUiState,
  replaceProtocolSnapshot,
  selectProtocolSession,
  type ProtocolUiState,
} from "../shared/protocol-state.js";

/** Matches the desktop settle window so both shells report outages alike. */
export const TUI_CONNECTION_SETTLE_MS = 2_000;

export interface TuiStoreSnapshot {
  /** Presented connection state: a reconnect inside the settle window stays true. */
  connected: boolean;
  /** True while a short reconnect is in flight but still presented as connected. */
  reconnecting: boolean;
  instanceId?: string;
  selectedSessionId: string;
  kernel: KernelState;
  cursors: Readonly<Record<string, number>>;
  gap?: { streamId: string; expected: number; received: number };
  streamingText: Readonly<Record<string, string>>;
  streamingThinking: Readonly<Record<string, string>>;
  activities: readonly CoworkActivity[];
  configuredModel?: ModelRef;
  notice: string;
  panel?: { title: string; lines: readonly string[] };
}

export class TuiStore {
  readonly #now: () => number;
  #unsettledSince: number | undefined;
  #everConnected = false;
  #state: TuiStoreSnapshot = {
    connected: false,
    reconnecting: false,
    ...initialProtocolUiState(),
    activities: [],
    notice: "Connecting to daemon…",
  };

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /**
   * Re-checks the settle window from a timer so a real outage still surfaces
   * once the masking window expires. Returns true when the view changed.
   */
  settleConnection(): boolean {
    if (!this.#state.reconnecting) return false;
    if (this.#unsettledSince !== undefined && this.#now() - this.#unsettledSince < TUI_CONNECTION_SETTLE_MS) return false;
    this.#state = { ...this.#state, connected: false, reconnecting: false };
    return true;
  }

  snapshot(): TuiStoreSnapshot {
    // Protocol reducers replace state immutably and clone IPC payloads at the
    // boundary. Avoid copying every historical message on each terminal frame.
    return this.#state;
  }

  applyHello(hello: ServerHelloFrame): void {
    const cursors = { ...this.#state.cursors, [hello.streamId]: hello.latestSeq };
    const activities = this.#state.instanceId && this.#state.instanceId !== hello.instanceId ? [] : this.#state.activities;
    this.#state = {
      ...this.#state,
      ...replaceProtocolSnapshot(protocolState(this.#state), hello.snapshot, cursors),
      activities,
      connected: true,
      reconnecting: false,
      instanceId: hello.instanceId,
      notice: "Connected",
    };
    delete this.#state.gap;
    this.#everConnected = true;
    this.#unsettledSince = undefined;
  }

  disconnected(message: string): void {
    if (this.#unsettledSince === undefined) this.#unsettledSince = this.#now();
    // Long runs briefly drop and re-establish the socket. Masking that for the
    // settle window keeps the status line steady instead of flapping.
    const masked = this.#everConnected && this.#now() - this.#unsettledSince < TUI_CONNECTION_SETTLE_MS;
    this.#state = {
      ...this.#state,
      connected: masked,
      reconnecting: masked,
      ...(masked ? {} : { notice: message }),
    };
  }

  setNotice(notice: string): void {
    this.#state = { ...this.#state, notice };
  }

  setConfiguredModel(model: ModelRef | undefined): void {
    if (model) this.#state = { ...this.#state, configuredModel: { ...model } };
    else {
      const next = { ...this.#state };
      delete next.configuredModel;
      this.#state = next;
    }
  }

  setPanel(title: string, lines: readonly string[]): void {
    this.#state = { ...this.#state, panel: { title, lines: [...lines] }, notice: `${title} opened; use /back or Esc to return` };
  }

  clearPanel(): void {
    if (!this.#state.panel) return;
    const next = { ...this.#state };
    delete next.panel;
    this.#state = { ...next, notice: "Conversation view" };
  }

  selectSession(id: string): string {
    const protocol = selectProtocolSession(protocolState(this.#state), id);
    this.#state = { ...this.#state, ...protocol, notice: `Selected ${id}` };
    return protocol.selectedSessionId;
  }

  applyEvent(event: EventEnvelope): void {
    const result = applyProtocolEvent(protocolState(this.#state), event);
    const activities = result.applied
      ? applyCoworkActivityEvent(this.#state.activities, event)
      : this.#state.activities;
    this.#state = {
      ...this.#state,
      ...result.state,
      activities,
      ...(result.notificationNotice ? { notice: result.notificationNotice } : {}),
      ...(result.state.gap ? { notice: `Event gap detected on ${result.state.gap.streamId}; reconnecting for a snapshot` } : {}),
    };
  }
}

function protocolState(state: TuiStoreSnapshot): ProtocolUiState {
  return {
    kernel: state.kernel,
    cursors: state.cursors,
    streamingText: state.streamingText,
    streamingThinking: state.streamingThinking,
    selectedSessionId: state.selectedSessionId,
    ...(state.gap ? { gap: state.gap } : {}),
  };
}
