import type { RuntimeMessage, RuntimeToolCall, SessionMetadata, SessionView } from "../../domain/runtime.js";
import { initialKernelState, type KernelState } from "../../kernel/state.js";
import type { EventEnvelope } from "../../protocol/schema.js";

export interface ProtocolUiState {
  kernel: KernelState;
  cursors: Readonly<Record<string, number>>;
  streamingText: Readonly<Record<string, string>>;
  streamingThinking: Readonly<Record<string, string>>;
  /** Transcript item each session is currently streaming, so a delta for a
   * superseded item cannot append to the one on screen. */
  streamingItems: Readonly<Record<string, string>>;
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
    streamingItems: {},
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
    streamingItems: {},
    selectedSessionId: selectAvailable(current.selectedSessionId, kernel),
  };
}

/**
 * Merges an older page of history in front of what a client already holds.
 * Only prepending is supported: the newest messages arrive with events, and a
 * page that would leave a hole is refused rather than silently reordered.
 */
export function applyTranscriptPage(
  current: ProtocolUiState,
  page: { sessionId: string; from: number; count: number; messages: readonly RuntimeMessage[] },
): ProtocolUiState {
  const session = current.kernel.sessions[page.sessionId];
  if (!session || page.from >= session.messageOffset) return current;
  if (page.from + page.messages.length < session.messageOffset) return current;
  const older = page.messages.slice(0, session.messageOffset - page.from);
  if (older.length === 0) return current;
  return {
    ...current,
    kernel: {
      ...current.kernel,
      sessions: {
        ...current.kernel.sessions,
        [page.sessionId]: {
          ...session,
          messageOffset: page.from,
          messages: [...structuredClone(older), ...session.messages],
        },
      },
    },
  };
}

/**
 * Keeps history a client has already paged in when an authoritative tail
 * arrives. The tail is bounded, so without this every settled run would throw
 * away the scrollback the reader just asked for. Older messages are kept only
 * while they still join onto the new tail and still belong to the same upstream
 * session: a replaced session renumbers the transcript, so its old prefix can
 * no longer be trusted.
 */
function mergeScrollback(existing: SessionView | undefined, incoming: SessionView): SessionView {
  if (!existing || existing.upstreamSessionId !== incoming.upstreamSessionId) return incoming;
  if (existing.messageOffset >= incoming.messageOffset) return incoming;
  const kept = incoming.messageOffset - existing.messageOffset;
  if (existing.messages.length < kept) return incoming;
  return {
    ...incoming,
    messageOffset: existing.messageOffset,
    messages: [...existing.messages.slice(0, kept), ...incoming.messages],
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
    itemId: string;
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
  // Deltas name their item, so a run belonging to a superseded item starts a
  // fresh buffer rather than appending to the message already on screen.
  const active = current.streamingItems[delta.sessionId];
  const replaced = active !== undefined && active !== delta.itemId;
  const field = delta.channel === "thinking" ? "streamingThinking" : "streamingText";
  const other = delta.channel === "thinking" ? "streamingText" : "streamingThinking";
  const existing = replaced ? "" : current[field][delta.sessionId] ?? "";
  return {
    state: {
      ...current,
      cursors: { ...current.cursors, [delta.streamId]: delta.seq },
      streamingItems: { ...current.streamingItems, [delta.sessionId]: delta.itemId },
      [field]: { ...current[field], [delta.sessionId]: `${existing}${delta.text}` },
      ...(replaced ? { [other]: { ...current[other], [delta.sessionId]: "" } } : {}),
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
  let streamingItems = current.streamingItems;
  if (event.type === "daemon.state") {
    const daemon = payload["daemon"];
    if (isRecord(daemon) && typeof daemon["phase"] === "string" && typeof payload["revision"] === "number") {
      kernel = { ...kernel, daemon: daemon as unknown as KernelState["daemon"], revision: payload["revision"] };
    }
  }
  if (event.type === "indexing.status" && isRecord(payload["status"])) {
    kernel = {
      ...kernel,
      revision: numericRevision(payload, kernel.revision),
      indexing: structuredClone(payload["status"]) as unknown as KernelState["indexing"],
    };
  }
  const session = payload["session"];
  if (isSessionMetadata(session)) {
    // A payload without a transcript updates status, usage and queue only; the
    // messages a client already holds stay in place. One that carries the tail
    // re-establishes the transcript, which is what makes it authoritative.
    const existing = kernel.sessions[session.sessionId];
    const next: SessionView = isSessionView(session)
      ? mergeScrollback(existing, structuredClone(session))
      : {
        ...structuredClone(session),
        messages: existing?.messages ?? [],
        messageOffset: existing?.messageOffset ?? 0,
      };
    kernel = {
      ...kernel,
      revision: numericRevision(payload, kernel.revision),
      sessions: { ...kernel.sessions, [session.sessionId]: next },
    };
  }
  if (event.type === "session.closed" && typeof payload["sessionId"] === "string") {
    const sessions = { ...kernel.sessions };
    delete sessions[payload["sessionId"]];
    streamingText = withoutSession(streamingText, payload["sessionId"]);
    streamingThinking = withoutSession(streamingThinking, payload["sessionId"]);
    streamingItems = withoutSession(streamingItems, payload["sessionId"]);
    kernel = { ...kernel, revision: numericRevision(payload, kernel.revision), sessions };
  }
  const streamSessionId = typeof payload["sessionId"] === "string" ? payload["sessionId"] : undefined;
  if (event.type === "transcript.item.started" && streamSessionId) {
    const item = asRecord(payload["item"]);
    if (typeof item["id"] === "string") {
      streamingItems = { ...streamingItems, [streamSessionId]: item["id"] };
      streamingText = withoutSession(streamingText, streamSessionId);
      streamingThinking = withoutSession(streamingThinking, streamSessionId);
    }
  }
  if (event.type === "transcript.delta" && streamSessionId && typeof payload["delta"] === "string") {
    const itemId = typeof payload["itemId"] === "string" ? payload["itemId"] : undefined;
    // A delta names its item, so one belonging to a superseded item starts a
    // fresh buffer instead of appending to whatever is on screen.
    const current = streamingItems[streamSessionId];
    const replaced = itemId !== undefined && current !== undefined && current !== itemId;
    if (itemId !== undefined && current !== itemId) streamingItems = { ...streamingItems, [streamSessionId]: itemId };
    const field = payload["kind"] === "thinking" ? "thinking" : "text";
    const text = replaced ? "" : streamingText[streamSessionId] ?? "";
    const think = replaced ? "" : streamingThinking[streamSessionId] ?? "";
    if (field === "thinking") {
      streamingThinking = { ...streamingThinking, [streamSessionId]: `${think}${payload["delta"]}` };
      if (replaced) streamingText = { ...streamingText, [streamSessionId]: "" };
    } else {
      streamingText = { ...streamingText, [streamSessionId]: `${text}${payload["delta"]}` };
      if (replaced) streamingThinking = { ...streamingThinking, [streamSessionId]: "" };
    }
  }
  if (event.type === "transcript.item.finished" && streamSessionId && !isSessionView(session)) {
    // The event carries the finished item in full, so the transcript grows by
    // appending it rather than by re-sending the messages around it. `run.settled`
    // still ships the authoritative tail, which reconciles any drift.
    const item = asRecord(payload["item"]);
    const existing = kernel.sessions[streamSessionId];
    if (existing && typeof item["role"] === "string" && typeof item["text"] === "string") {
      kernel = {
        ...kernel,
        sessions: {
          ...kernel.sessions,
          [streamSessionId]: {
            ...existing,
            messages: [...existing.messages, {
              role: item["role"], text: item["text"],
              ...(typeof item["thinking"] === "string" ? { thinking: item["thinking"] } : {}),
              ...(Array.isArray(item["toolCalls"]) ? { toolCalls: item["toolCalls"].filter(isRuntimeToolCall) } : {}),
              ...(typeof item["toolCallId"] === "string" ? { toolCallId: item["toolCallId"] } : {}),
              ...(typeof item["toolName"] === "string" ? { toolName: item["toolName"] } : {}),
              ...(typeof item["isError"] === "boolean" ? { isError: item["isError"] } : {}),
            }],
            messageCount: existing.messageCount + 1,
          },
        },
      };
    }
  }
  const finishesStreaming = event.type === "transcript.item.finished"
    || event.type === "run.settled"
    || event.type === "runtime.error"
    || event.type === "session.replaced";
  if (streamSessionId && finishesStreaming) {
    streamingText = withoutSession(streamingText, streamSessionId);
    streamingThinking = withoutSession(streamingThinking, streamSessionId);
    streamingItems = withoutSession(streamingItems, streamSessionId);
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
      streamingItems,
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

function isRuntimeToolCall(value: unknown): value is RuntimeToolCall {
  return isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string" && typeof value["input"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  return (
    isRecord(value)
    && typeof value["sessionId"] === "string"
    && typeof value["upstreamSessionId"] === "string"
    && typeof value["cwd"] === "string"
    && (value["status"] === "idle" || value["status"] === "running" || value["status"] === "failed")
    && typeof value["messageCount"] === "number"
  );
}

function isSessionView(value: unknown): value is SessionView {
  return isSessionMetadata(value) && Array.isArray((value as SessionView).messages)
    && typeof (value as SessionView).messageOffset === "number";
}
