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
import type { DesktopBootstrap, DesktopConnectionState, DesktopFrame } from "../ipc-contract.js";

export interface DesktopActivity {
  id: string;
  type: string;
  ts: string;
  sessionId?: string;
  summary: string;
  detail?: string;
}

export interface DesktopStoreSnapshot {
  connection: DesktopConnectionState;
  kernel: KernelState;
  cursors: Readonly<Record<string, number>>;
  streamingText: Readonly<Record<string, string>>;
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
    notice: "Starting pSpore…",
  };

  snapshot(): DesktopStoreSnapshot {
    return structuredClone(this.#state);
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
        notice: "Authoritative daemon snapshot loaded",
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
    this.#state = { ...this.#state, ...selectProtocolSession(protocolState(this.#state), id), notice: `Selected ${id}` };
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
    const activity = activityFrom(event);
    this.#state = {
      ...this.#state,
      ...result.state,
      activities: activity ? [...this.#state.activities, activity].slice(-100) : this.#state.activities,
      ...(result.notificationNotice ? { notice: result.notificationNotice } : {}),
    };
  }
}

function activityFrom(event: EventEnvelope): DesktopActivity | undefined {
  const visible = new Set([
    "run.started",
    "run.settled",
    "tool.started",
    "tool.updated",
    "tool.completed",
    "compaction.started",
    "compaction.completed",
    "retry.started",
    "retry.completed",
    "runtime.error",
    "automation.run",
    "agent.updated",
    "agent.message",
    "mcp.health",
    "resource.health",
  ]);
  if (!visible.has(event.type)) return undefined;
  const payload = asRecord(event.payload);
  const sessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : undefined;
  const summary = activitySummary(event.type, payload);
  const detail = compactDetail(payload);
  return {
    id: event.id,
    type: event.type,
    ts: event.ts,
    summary,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(detail ? { detail } : {}),
  };
}

function activitySummary(type: string, payload: Record<string, unknown>): string {
  const tool = typeof payload["toolName"] === "string" ? payload["toolName"] : typeof payload["name"] === "string" ? payload["name"] : undefined;
  if (tool) return `${type}: ${tool}`;
  const error = typeof payload["error"] === "string" ? payload["error"] : undefined;
  if (error) return `${type}: ${error}`;
  return type.replaceAll(".", " ");
}

function compactDetail(payload: Record<string, unknown>): string | undefined {
  try {
    const text = JSON.stringify(payload, null, 2);
    return text.length > 16_000 ? `${text.slice(0, 16_000)}\n… output folded at 16 KB` : text;
  } catch {
    return undefined;
  }
}

function protocolState(state: DesktopStoreSnapshot): ProtocolUiState {
  return {
    kernel: state.kernel,
    cursors: state.cursors,
    streamingText: state.streamingText,
    selectedSessionId: state.selectedSessionId,
    ...(state.gap ? { gap: state.gap } : {}),
  };
}

function gapNotice(gap: NonNullable<ProtocolUiState["gap"]>): string {
  return `Event gap detected on ${gap.streamId}; expected ${gap.expected}, received ${gap.received}; waiting for a fresh snapshot`;
}

function connectionNotice(connection: DesktopConnectionState): string {
  if (connection.phase === "connected") return "Connected to the local daemon";
  return connection.message ?? (connection.phase === "connecting" ? "Connecting to daemon…" : "Daemon disconnected");
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
