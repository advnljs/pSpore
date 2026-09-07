export type SessionId = string;

export interface ModelRef {
  provider: string;
  model: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PinnedContextFile {
  path: string;
  content: string;
}

export interface AgentSessionSpec {
  sessionId: SessionId;
  workspaceId: string;
  cwd: string;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  systemPrompt?: string;
  contextFiles?: readonly PinnedContextFile[];
  enabledTools?: readonly string[];
  authorization?: {
    agentPath: readonly string[];
    runId?: string;
    jobId?: string;
    allowedApprovalScopes: readonly ("once" | "session" | "job")[];
    deniedCapabilities?: readonly string[];
  };
}

export interface ResumeSessionSpec extends AgentSessionSpec {
  sessionFile: string;
}

export interface AgentHandle {
  sessionId: SessionId;
  upstreamSessionId: string;
  sessionFile?: string;
}

export interface Accepted {
  accepted: true;
  commandId: string;
  acceptedAt: string;
}

export interface RuntimeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number;
}

export interface RuntimeMessage {
  id?: string;
  role: string;
  text: string;
}

export interface RuntimeQueueSnapshot {
  steering: readonly string[];
  followUp: readonly string[];
}

export interface RootSessionMetadata {
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Everything about a session except its transcript. Clients need this for every
 * session they know about, so it must not grow with the length of a
 * conversation — a snapshot that carries every session's full history is the
 * one frame a reconnect cannot avoid.
 */
export interface SessionMetadata {
  sessionId: SessionId;
  upstreamSessionId: string;
  sessionFile?: string;
  cwd: string;
  status: "idle" | "running" | "failed";
  model?: ModelRef;
  thinking: ThinkingLevel;
  /** Total transcript messages the daemon holds, independent of what is sent. */
  messageCount: number;
  /** First user text, so a session can be titled without its transcript. */
  firstUserText?: string;
  queue: RuntimeQueueSnapshot;
  usage: RuntimeUsage;
  rootSession?: RootSessionMetadata;
  lastError?: string;
}

/**
 * What the daemon broadcasts: session metadata plus a bounded tail of the
 * transcript, enough for a client to render immediately. Older history is
 * fetched on demand with the `session.transcript` command.
 */
export interface SessionView extends SessionMetadata {
  /** Index of `messages[0]` within the full transcript. */
  messageOffset: number;
  messages: readonly RuntimeMessage[];
}

/** One requested slice of a session's persisted transcript. */
export interface TranscriptPage {
  /** Index of `messages[0]` within the full transcript. */
  from: number;
  /** Total transcript messages available. */
  count: number;
  messages: readonly RuntimeMessage[];
}

/**
 * One message's text, sliced. A message can be far longer than the daemon will
 * publish in a single string, so reading one in full is a paged request rather
 * than one oversized frame.
 */
export interface TranscriptMessageSlice {
  /** Persisted branch entry id, when the message has one. */
  id?: string;
  /** Index of the message within the full transcript. */
  index: number;
  role: string;
  /** Character offset of `text` within the whole message. */
  offset: number;
  /** Total characters the message holds. */
  length: number;
  text: string;
}

/**
 * One addressable entry of a conversation. Streaming updates name the item they
 * belong to, so a delta never has to be described by re-sending the transcript
 * around it. Pi's own client/server protocol, Codex and OpenClaw all address
 * conversation state this way.
 */
export interface TranscriptItem {
  id: string;
  role: string;
  text: string;
  /** Hidden reasoning, shown only while the item is still streaming. */
  thinking?: string;
  status: "streaming" | "complete" | "error" | "aborted";
  ts: string;
}

export type TranscriptDeltaKind = "text" | "thinking";

export type RuntimeEventType =
  | "session.replaced"
  | "run.started"
  | "run.settled"
  | "transcript.item.started"
  | "transcript.delta"
  | "transcript.item.finished"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "queue.updated"
  | "compaction.started"
  | "compaction.completed"
  | "retry.started"
  | "retry.completed"
  | "runtime.error";

export interface RuntimeEvent {
  id: string;
  sessionId: SessionId;
  upstreamSessionId: string;
  type: RuntimeEventType;
  ts: string;
  transient: boolean;
  payload: Readonly<Record<string, unknown>>;
}

export interface ToolAuthorizationRequest {
  sessionId: SessionId;
  toolCallId: string;
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  agentPath?: readonly string[];
  runId?: string;
  jobId?: string;
  allowedApprovalScopes?: readonly ("once" | "session" | "job")[];
  deniedCapabilities?: readonly string[];
}

export type ToolAuthorizationResult =
  | { decision: "allow" }
  | { decision: "deny"; reason: string; terminate?: boolean };

export interface ToolGate {
  authorize(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult>;
}

export interface AgentRuntimePort {
  create(spec: AgentSessionSpec): Promise<AgentHandle>;
  resume(spec: ResumeSessionSpec): Promise<AgentHandle>;
  prompt(sessionId: SessionId, input: string): Promise<Accepted>;
  steer(sessionId: SessionId, input: string): Promise<Accepted>;
  followUp(sessionId: SessionId, input: string): Promise<Accepted>;
  promoteFollowUp(sessionId: SessionId, index: number): Promise<Accepted>;
  abort(sessionId: SessionId, reason: string): Promise<void>;
  compact(sessionId: SessionId, instructions?: string): Promise<void>;
  /** Session state without its transcript: never grows with the conversation. */
  snapshot(sessionId: SessionId): SessionMetadata;
  /**
   * A slice of the persisted transcript, newest-first by default. Reading from
   * the persisted branch rather than the model's context means history stays
   * visible after a compaction rewrites what the model sees.
   */
  transcript(sessionId: SessionId, options: { from?: number; limit: number }): TranscriptPage;
  /**
   * One transcript message's untruncated text, in slices. Addressed by branch
   * entry id when the caller has one, because an index shifts as a run appends
   * to the transcript underneath it.
   */
  transcriptMessage(
    sessionId: SessionId,
    options: { id?: string; index?: number; offset?: number; limit: number },
  ): TranscriptMessageSlice;
  subscribe(sessionId: SessionId, sink: (event: RuntimeEvent) => void): () => void;
  waitForIdle(sessionId: SessionId): Promise<void>;
  dispose(sessionId: SessionId): Promise<void>;
}
