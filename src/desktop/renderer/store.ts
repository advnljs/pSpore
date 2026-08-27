import type { KernelState } from "../../kernel/state.js";
import type { EventEnvelope } from "../../protocol/schema.js";
import {
  applyProtocolDelta,
  applyProtocolEvent,
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

export interface DesktopStoreSnapshot {
  connection: DesktopConnectionState;
  kernel: KernelState;
  cursors: Readonly<Record<string, number>>;
  streamingText: Readonly<Record<string, string>>;
  streamingThinking: Readonly<Record<string, string>>;
  selectedSessionId: string;
  activities: readonly DesktopActivity[];
  notice: string;
  gap?: { streamId: string; expected: number; received: number };
}

export class DesktopStore {
  #state: DesktopStoreSnapshot = {
    connection: { phase: "disconnected", attempt: 0, message: "Desktop is starting" },
    ...initialProtocolUiState(),
    activities: [],
    notice: "正在启动 pSpore…",
  };

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
    this.#state = {
      ...this.#state,
      ...protocol,
      connection: structuredClone(bootstrap.connection),
      notice: connectionNotice(bootstrap.connection),
    };
    delete this.#state.gap;
  }

  applyFrame(frame: DesktopFrame): void {
    if (frame.kind === "connection") {
      this.#state = {
        ...this.#state,
        connection: structuredClone(frame.connection),
        notice: connectionNotice(frame.connection),
      };
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

  selectSession(id: string): void {
    this.#state = { ...this.#state, ...selectProtocolSession(protocolState(this.#state), id), notice: `已切换到 ${id}` };
  }

  setNotice(notice: string): void {
    this.#state = { ...this.#state, notice };
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
