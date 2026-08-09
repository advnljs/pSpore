import type { AgentSnapshot } from "../../domain/runtime.js";
import { initialKernelState, type KernelState } from "../../kernel/state.js";
import type { EventEnvelope } from "../../protocol/schema.js";
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
    kernel: initialKernelState(),
    cursors: {},
    streamingText: {},
    selectedSessionId: "main",
    activities: [],
    notice: "Starting pSpore…",
  };

  snapshot(): DesktopStoreSnapshot {
    return structuredClone(this.#state);
  }

  applyBootstrap(bootstrap: DesktopBootstrap): void {
    this.#state = {
      ...this.#state,
      connection: structuredClone(bootstrap.connection),
      kernel: bootstrap.snapshot ? structuredClone(bootstrap.snapshot) : this.#state.kernel,
      cursors: { ...bootstrap.cursors },
      selectedSessionId: selectAvailable(this.#state.selectedSessionId, bootstrap.snapshot ?? this.#state.kernel),
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
        kernel: structuredClone(frame.snapshot),
        cursors: { ...frame.cursors },
        streamingText: {},
        selectedSessionId: selectAvailable(this.#state.selectedSessionId, frame.snapshot),
        notice: "Authoritative daemon snapshot loaded",
      };
      delete this.#state.gap;
      return;
    }
    if (frame.kind === "delta") {
      const previous = this.#state.cursors[frame.streamId] ?? 0;
      if (frame.seq <= previous) return;
      if (frame.fromSeq !== previous + 1 || frame.seq < frame.fromSeq) {
        this.#recordGap(frame.streamId, previous + 1, frame.fromSeq);
        return;
      }
      this.#state = {
        ...this.#state,
        cursors: { ...this.#state.cursors, [frame.streamId]: frame.seq },
        streamingText: {
          ...this.#state.streamingText,
          [frame.sessionId]: `${this.#state.streamingText[frame.sessionId] ?? ""}${frame.text}`,
        },
      };
      return;
    }
    this.#applyEvent(frame.event);
  }

  selectSession(id: string): void {
    const sessionId = this.#state.kernel.sessions[id] ? id : this.#state.kernel.agents[id]?.sessionId;
    if (!sessionId || !this.#state.kernel.sessions[sessionId]) throw new Error(`Session is not active: ${id}`);
    this.#state = { ...this.#state, selectedSessionId: sessionId, notice: `Selected ${id}` };
  }

  setNotice(notice: string): void {
    this.#state = { ...this.#state, notice };
  }

  #applyEvent(event: EventEnvelope): void {
    const previous = this.#state.cursors[event.streamId] ?? 0;
    if (event.seq <= previous) return;
    if (event.seq !== previous + 1) {
      this.#recordGap(event.streamId, previous + 1, event.seq);
      return;
    }

    const cursors = { ...this.#state.cursors, [event.streamId]: event.seq };
    let kernel = this.#state.kernel;
    let streamingText = this.#state.streamingText;
    const payload = asRecord(event.payload);
    if (event.type === "daemon.state") {
      const daemon = payload["daemon"];
      const revision = payload["revision"];
      if (isRecord(daemon) && typeof daemon["phase"] === "string" && typeof revision === "number") {
        kernel = { ...kernel, daemon: daemon as unknown as KernelState["daemon"], revision };
      }
    }
    const session = payload["session"];
    if (isAgentSnapshot(session)) {
      kernel = {
        ...kernel,
        revision: numericRevision(payload, kernel.revision),
        sessions: { ...kernel.sessions, [session.sessionId]: structuredClone(session) },
      };
      if (event.type === "message.completed" || event.type === "run.settled") {
        const next = { ...streamingText };
        delete next[session.sessionId];
        streamingText = next;
      }
    }
    if (event.type === "session.closed" && typeof payload["sessionId"] === "string") {
      const sessions = { ...kernel.sessions };
      delete sessions[payload["sessionId"]];
      const nextStreaming = { ...streamingText };
      delete nextStreaming[payload["sessionId"]];
      kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), sessions };
      streamingText = nextStreaming;
    }
    if (event.type === "approval.requested" && isRecord(payload["request"]) && typeof payload["request"]["id"] === "string") {
      const request = payload["request"] as unknown as KernelState["approvals"][string];
      kernel = {
        ...kernel,
        revision: numericRevision(payload, kernel.revision),
        approvals: { ...kernel.approvals, [request.id]: structuredClone(request) },
      };
    }
    if (event.type === "approval.resolved" && typeof payload["approvalId"] === "string") {
      const approvals = { ...kernel.approvals };
      delete approvals[payload["approvalId"]];
      kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), approvals };
    }
    if (event.type === "automation.run" && isRecord(payload["run"]) && typeof payload["run"]["id"] === "string") {
      const run = payload["run"] as unknown as KernelState["runs"][string];
      kernel = {
        ...kernel,
        revision: numericRevision(payload, kernel.revision),
        runs: { ...kernel.runs, [run.id]: structuredClone(run) },
      };
    }
    if (event.type === "notification.created" && isRecord(payload["notification"]) && typeof payload["notification"]["id"] === "string") {
      const notification = payload["notification"] as unknown as KernelState["notifications"][number];
      kernel = {
        ...kernel,
        revision: numericRevision(payload, kernel.revision),
        notifications: [...kernel.notifications, structuredClone(notification)].slice(-200),
      };
    }
    if (event.type === "agent.updated" && isRecord(payload["agent"]) && typeof payload["agent"]["id"] === "string") {
      const agent = payload["agent"] as unknown as KernelState["agents"][string];
      kernel = {
        ...kernel,
        revision: numericRevision(payload, kernel.revision),
        agents: { ...kernel.agents, [agent.id]: structuredClone(agent) },
      };
    }
    if (event.type === "agent.message" && isRecord(payload["message"]) && typeof payload["message"]["id"] === "string") {
      const message = payload["message"] as unknown as KernelState["agentMessages"][number];
      kernel = {
        ...kernel,
        revision: numericRevision(payload, kernel.revision),
        agentMessages: [...kernel.agentMessages, structuredClone(message)].slice(-500),
      };
    }
    if (event.type === "mcp.health" && isRecord(payload["health"]) && typeof payload["health"]["serverId"] === "string") {
      const health = payload["health"] as unknown as KernelState["mcpServers"][string];
      kernel = {
        ...kernel,
        revision: numericRevision(payload, kernel.revision),
        mcpServers: { ...kernel.mcpServers, [health.serverId]: structuredClone(health) },
      };
    }
    if (event.type === "resource.health" && isRecord(payload["health"]) && typeof payload["health"]["key"] === "string") {
      const health = payload["health"] as unknown as KernelState["resources"][string];
      kernel = {
        ...kernel,
        revision: numericRevision(payload, kernel.revision),
        resources: { ...kernel.resources, [health.key]: structuredClone(health) },
      };
    }

    const activity = activityFrom(event);
    this.#state = {
      ...this.#state,
      kernel,
      cursors,
      streamingText,
      selectedSessionId: selectAvailable(this.#state.selectedSessionId, kernel),
      activities: activity ? [...this.#state.activities, activity].slice(-100) : this.#state.activities,
      ...(event.type === "notification.created" ? { notice: notificationNotice(payload) } : {}),
    };
  }

  #recordGap(streamId: string, expected: number, received: number): void {
    this.#state = {
      ...this.#state,
      gap: { streamId, expected, received },
      notice: `Event gap detected on ${streamId}; waiting for a fresh snapshot`,
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

function notificationNotice(payload: Record<string, unknown>): string {
  const notification = payload["notification"];
  if (!isRecord(notification)) return "New notification";
  return `${String(notification["title"] ?? "Notification")}: ${String(notification["body"] ?? "")}`;
}

function numericRevision(payload: Record<string, unknown>, fallback: number): number {
  return typeof payload["revision"] === "number" ? payload["revision"] : fallback;
}

function selectAvailable(selected: string, kernel: KernelState): string {
  if (kernel.sessions[selected]) return selected;
  return kernel.sessions["main"] ? "main" : (Object.keys(kernel.sessions)[0] ?? "main");
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

function isAgentSnapshot(value: unknown): value is AgentSnapshot {
  return (
    isRecord(value) &&
    typeof value["sessionId"] === "string" &&
    typeof value["upstreamSessionId"] === "string" &&
    typeof value["cwd"] === "string" &&
    (value["status"] === "idle" || value["status"] === "running" || value["status"] === "failed") &&
    Array.isArray(value["messages"])
  );
}
