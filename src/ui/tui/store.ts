import type { KernelState } from "../../kernel/state.js";
import type { EventEnvelope, ServerHelloFrame } from "../../protocol/schema.js";
import {
  applyProtocolEvent,
  initialProtocolUiState,
  replaceProtocolSnapshot,
  selectProtocolSession,
  type ProtocolUiState,
} from "../shared/protocol-state.js";

export interface TuiStoreSnapshot {
  connected: boolean;
  instanceId?: string;
  selectedSessionId: string;
  kernel: KernelState;
  cursors: Readonly<Record<string, number>>;
  gap?: { streamId: string; expected: number; received: number };
  streamingText: Readonly<Record<string, string>>;
  notice: string;
  panel?: { title: string; lines: readonly string[] };
}

export class TuiStore {
  #state: TuiStoreSnapshot = {
    connected: false,
    ...initialProtocolUiState(),
    notice: "Connecting to daemon…",
  };

  snapshot(): TuiStoreSnapshot {
    return structuredClone(this.#state);
  }

  applyHello(hello: ServerHelloFrame): void {
    const cursors = { ...this.#state.cursors, [hello.streamId]: hello.latestSeq };
    this.#state = {
      ...this.#state,
      ...replaceProtocolSnapshot(protocolState(this.#state), hello.snapshot, cursors),
      connected: true,
      instanceId: hello.instanceId,
      notice: "Connected",
    };
    delete this.#state.gap;
  }

  disconnected(message: string): void {
    this.#state = { ...this.#state, connected: false, notice: message };
  }

  setNotice(notice: string): void {
    this.#state = { ...this.#state, notice };
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
    this.#state = {
      ...this.#state,
      ...result.state,
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
    selectedSessionId: state.selectedSessionId,
    ...(state.gap ? { gap: state.gap } : {}),
  };
}
