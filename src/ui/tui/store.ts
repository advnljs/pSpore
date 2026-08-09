import type { AgentSnapshot } from "../../domain/runtime.js";
import { initialKernelState, type KernelState } from "../../kernel/state.js";
import type { EventEnvelope, ServerHelloFrame } from "../../protocol/schema.js";

export interface TuiStoreSnapshot {
  connected: boolean;
  instanceId?: string;
  kernel: KernelState;
  cursors: Readonly<Record<string, number>>;
  gap?: { streamId: string; expected: number; received: number };
  streamingText: Readonly<Record<string, string>>;
  notice: string;
}

export class TuiStore {
  #state: TuiStoreSnapshot = {
    connected: false,
    kernel: initialKernelState(),
    cursors: {},
    streamingText: {},
    notice: "Connecting to daemon…",
  };

  snapshot(): TuiStoreSnapshot {
    return structuredClone(this.#state);
  }

  applyHello(hello: ServerHelloFrame): void {
    this.#state = {
      ...this.#state,
      connected: true,
      instanceId: hello.instanceId,
      kernel: structuredClone(hello.snapshot),
      cursors: { ...this.#state.cursors, [hello.streamId]: hello.latestSeq },
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

  applyEvent(event: EventEnvelope): void {
    const previous = this.#state.cursors[event.streamId] ?? 0;
    if (event.seq <= previous) return;
    if (event.seq !== previous + 1) {
      this.#state = {
        ...this.#state,
        gap: { streamId: event.streamId, expected: previous + 1, received: event.seq },
        notice: `Event gap detected on ${event.streamId}; reconnecting for a snapshot`,
      };
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
        revision: typeof payload["revision"] === "number" ? payload["revision"] : kernel.revision,
        sessions: { ...kernel.sessions, [session.sessionId]: structuredClone(session) },
      };
      if (event.type === "message.completed" || event.type === "run.settled") {
        const next = { ...streamingText };
        delete next[session.sessionId];
        streamingText = next;
      }
    }
    if (event.type === "session.snapshot" && isAgentSnapshot(payload["session"])) {
      const nextSession = payload["session"];
      kernel = {
        ...kernel,
        revision: typeof payload["revision"] === "number" ? payload["revision"] : kernel.revision,
        sessions: { ...kernel.sessions, [nextSession.sessionId]: structuredClone(nextSession) },
      };
    }
    if (event.type === "session.closed" && typeof payload["sessionId"] === "string") {
      const sessions = { ...kernel.sessions };
      delete sessions[payload["sessionId"]];
      const nextStreaming = { ...streamingText };
      delete nextStreaming[payload["sessionId"]];
      kernel = {
        ...kernel,
        revision: typeof payload["revision"] === "number" ? payload["revision"] : kernel.revision,
        sessions,
      };
      streamingText = nextStreaming;
    }
    if (event.type === "message.delta" && typeof payload["sessionId"] === "string" && typeof payload["delta"] === "string") {
      streamingText = {
        ...streamingText,
        [payload["sessionId"]]: `${streamingText[payload["sessionId"]] ?? ""}${payload["delta"]}`,
      };
    }
    if (event.type === "approval.requested" && isRecord(payload["request"]) && typeof payload["request"]["id"] === "string") {
      const request = payload["request"] as unknown as KernelState["approvals"][string];
      kernel = {
        ...kernel,
        revision: typeof payload["revision"] === "number" ? payload["revision"] : kernel.revision,
        approvals: { ...kernel.approvals, [request.id]: structuredClone(request) },
      };
    }
    if (event.type === "approval.resolved" && typeof payload["approvalId"] === "string") {
      const approvals = { ...kernel.approvals };
      delete approvals[payload["approvalId"]];
      kernel = {
        ...kernel,
        revision: typeof payload["revision"] === "number" ? payload["revision"] : kernel.revision,
        approvals,
      };
    }
    if (event.type === "automation.run" && isRecord(payload["run"]) && typeof payload["run"]["id"] === "string") {
      const run = payload["run"] as unknown as KernelState["runs"][string];
      kernel = {
        ...kernel,
        revision: typeof payload["revision"] === "number" ? payload["revision"] : kernel.revision,
        runs: { ...kernel.runs, [run.id]: structuredClone(run) },
      };
    }
    this.#state = { ...this.#state, kernel, cursors, streamingText };
  }
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
