import type { AgentSnapshot } from "../../domain/runtime.js";
import { initialKernelState, type KernelState } from "../../kernel/state.js";
import type { EventEnvelope } from "../../protocol/schema.js";

export interface ProtocolUiState {
  kernel: KernelState;
  cursors: Readonly<Record<string, number>>;
  streamingText: Readonly<Record<string, string>>;
  streamingThinking: Readonly<Record<string, string>>;
  selectedSessionId: string;
  gap?: { streamId: string; expected: number; received: number };
}

export interface ProtocolApplyResult {
  state: ProtocolUiState;
  applied: boolean;
  notificationNotice?: string;
}

export function initialProtocolUiState(): ProtocolUiState {
  return {
    kernel: initialKernelState(),
    cursors: {},
    streamingText: {},
    streamingThinking: {},
    selectedSessionId: "main",
  };
}

export function replaceProtocolSnapshot(
  current: ProtocolUiState,
  kernel: KernelState,
  cursors: Readonly<Record<string, number>>,
): ProtocolUiState {
  return {
    kernel: structuredClone(kernel),
    cursors: { ...cursors },
    streamingText: {},
    streamingThinking: {},
    selectedSessionId: selectAvailable(current.selectedSessionId, kernel),
  };
}

export function selectProtocolSession(current: ProtocolUiState, id: string): ProtocolUiState {
  const sessionId = current.kernel.sessions[id] ? id : current.kernel.agents[id]?.sessionId;
  if (!sessionId || !current.kernel.sessions[sessionId]) throw new Error(`Session is not active: ${id}`);
  return { ...current, selectedSessionId: sessionId };
}

export function applyProtocolDelta(
  current: ProtocolUiState,
  delta: {
    streamId: string;
    fromSeq: number;
    seq: number;
    skipped?: number;
    sessionId: string;
    channel: "text" | "thinking";
    text: string;
  },
): ProtocolApplyResult {
  const previous = current.cursors[delta.streamId] ?? 0;
  if (delta.seq <= previous) return { state: current, applied: false };
  const expected = previous + 1 + (delta.skipped ?? 0);
  if (delta.fromSeq !== expected || delta.seq < delta.fromSeq) {
    return { state: withGap(current, delta.streamId, expected, delta.fromSeq), applied: false };
  }
  const field = delta.channel === "thinking" ? "streamingThinking" : "streamingText";
  const values = current[field];
  return {
    state: {
      ...current,
      cursors: { ...current.cursors, [delta.streamId]: delta.seq },
      [field]: {
        ...values,
        [delta.sessionId]: `${values[delta.sessionId] ?? ""}${delta.text}`,
      },
    },
    applied: true,
  };
}

export function applyProtocolEvent(current: ProtocolUiState, event: EventEnvelope): ProtocolApplyResult {
  const previous = current.cursors[event.streamId] ?? 0;
  if (event.seq <= previous) return { state: current, applied: false };
  // Transient events the daemon shed under backpressure are announced through
  // `skipped`, so the cursor jumps forward without being treated as data loss.
  const expected = previous + 1 + (event.skipped ?? 0);
  if (event.seq !== expected) {
    return { state: withGap(current, event.streamId, expected, event.seq), applied: false };
  }

  const payload = asRecord(event.payload);
  let kernel = current.kernel;
  let streamingText = current.streamingText;
  let streamingThinking = current.streamingThinking;
  if (event.type === "daemon.state") {
    const daemon = payload["daemon"];
    if (isRecord(daemon) && typeof daemon["phase"] === "string" && typeof payload["revision"] === "number") {
      kernel = { ...kernel, daemon: daemon as unknown as KernelState["daemon"], revision: payload["revision"] };
    }
  }
  const session = payload["session"];
  if (isAgentSnapshot(session)) {
    kernel = {
      ...kernel,
      revision: numericRevision(payload, kernel.revision),
      sessions: { ...kernel.sessions, [session.sessionId]: structuredClone(session) },
    };
  }
  if (event.type === "session.closed" && typeof payload["sessionId"] === "string") {
    const sessions = { ...kernel.sessions };
    delete sessions[payload["sessionId"]];
    streamingText = withoutSession(streamingText, payload["sessionId"]);
    streamingThinking = withoutSession(streamingThinking, payload["sessionId"]);
    kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), sessions };
  }
  if (event.type === "message.delta" && typeof payload["sessionId"] === "string" && typeof payload["delta"] === "string") {
    streamingText = {
      ...streamingText,
      [payload["sessionId"]]: `${streamingText[payload["sessionId"]] ?? ""}${payload["delta"]}`,
    };
  }
  if (event.type === "message.thinking.delta" && typeof payload["sessionId"] === "string" && typeof payload["delta"] === "string") {
    streamingThinking = {
      ...streamingThinking,
      [payload["sessionId"]]: `${streamingThinking[payload["sessionId"]] ?? ""}${payload["delta"]}`,
    };
  }
  const streamSessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : undefined;
  const startsAssistantMessage = event.type === "message.started" && payload["role"] === "assistant";
  const finishesStreaming = event.type === "message.completed"
    || event.type === "run.settled"
    || event.type === "runtime.error"
    || event.type === "session.replaced";
  if (streamSessionId && (startsAssistantMessage || finishesStreaming)) {
    streamingText = withoutSession(streamingText, streamSessionId);
    streamingThinking = withoutSession(streamingThinking, streamSessionId);
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
    kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), runs: { ...kernel.runs, [run.id]: structuredClone(run) } };
  }
  let notificationNotice: string | undefined;
  if (event.type === "notification.created" && isRecord(payload["notification"]) && typeof payload["notification"]["id"] === "string") {
    const notification = payload["notification"] as unknown as KernelState["notifications"][number];
    kernel = {
      ...kernel,
      revision: numericRevision(payload, kernel.revision),
      notifications: [...kernel.notifications, structuredClone(notification)].slice(-200),
    };
    notificationNotice = `${notification.title}: ${notification.body}`;
  }
  if (event.type === "agent.updated" && isRecord(payload["agent"]) && typeof payload["agent"]["id"] === "string") {
    const agent = payload["agent"] as unknown as KernelState["agents"][string];
    kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), agents: { ...kernel.agents, [agent.id]: structuredClone(agent) } };
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
    kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), mcpServers: { ...kernel.mcpServers, [health.serverId]: structuredClone(health) } };
  }
  if (event.type === "resource.health" && isRecord(payload["health"]) && typeof payload["health"]["key"] === "string") {
    const health = payload["health"] as unknown as KernelState["resources"][string];
    kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), resources: { ...kernel.resources, [health.key]: structuredClone(health) } };
  }

  return {
    state: {
      ...current,
      kernel,
      cursors: { ...current.cursors, [event.streamId]: event.seq },
      streamingText,
      streamingThinking,
      selectedSessionId: selectAvailable(current.selectedSessionId, kernel),
    },
    applied: true,
    ...(notificationNotice ? { notificationNotice } : {}),
  };
}

function withoutSession(values: Readonly<Record<string, string>>, sessionId: string): Readonly<Record<string, string>> {
  if (!(sessionId in values)) return values;
  const next = { ...values };
  delete next[sessionId];
  return next;
}

function withGap(current: ProtocolUiState, streamId: string, expected: number, received: number): ProtocolUiState {
  return { ...current, gap: { streamId, expected, received } };
}

function numericRevision(payload: Record<string, unknown>, fallback: number): number {
  return typeof payload["revision"] === "number" ? payload["revision"] : fallback;
}

function selectAvailable(selected: string, kernel: KernelState): string {
  if (kernel.sessions[selected]) return selected;
  return kernel.sessions["main"] ? "main" : (Object.keys(kernel.sessions)[0] ?? "main");
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentSnapshot(value: unknown): value is AgentSnapshot {
  return (
    isRecord(value)
    && typeof value["sessionId"] === "string"
    && typeof value["upstreamSessionId"] === "string"
    && typeof value["cwd"] === "string"
    && (value["status"] === "idle" || value["status"] === "running" || value["status"] === "failed")
    && Array.isArray(value["messages"])
  );
}
