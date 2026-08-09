import type { KernelEvent, KernelState, PublicKernelEvent, Reduction } from "./state.js";

export function reduceKernel(state: KernelState, event: KernelEvent): Reduction {
  switch (event.type) {
    case "daemon.transition": {
      const next = changed(state, { ...state, daemon: structuredClone(event.daemon) });
      return broadcast(next, event, "daemon.state", { daemon: next.daemon, revision: next.revision }, true);
    }
    case "session.snapshot": {
      const snapshot = structuredClone(event.snapshot);
      const next = changed(state, {
        ...state,
        sessions: { ...state.sessions, [snapshot.sessionId]: snapshot },
      });
      return broadcast(
        next,
        event,
        "session.snapshot",
        { session: snapshot, revision: next.revision },
        true,
      );
    }
    case "session.closed": {
      const sessions = { ...state.sessions };
      delete sessions[event.sessionId];
      const next = changed(state, { ...state, sessions });
      return broadcast(next, event, "session.closed", { sessionId: event.sessionId, revision: next.revision }, true);
    }
    case "runtime.received": {
      const snapshot = event.snapshot ? structuredClone(event.snapshot) : undefined;
      const next = snapshot
        ? changed(state, { ...state, sessions: { ...state.sessions, [snapshot.sessionId]: snapshot } })
        : state;
      return broadcast(
        next,
        event,
        event.event.type,
        {
          sessionId: event.event.sessionId,
          upstreamSessionId: event.event.upstreamSessionId,
          ...event.event.payload,
          ...(snapshot ? { revision: next.revision } : {}),
          ...(snapshot && !event.event.transient ? { session: snapshot } : {}),
        },
        !event.event.transient,
      );
    }
    case "approval.requested": {
      const request = structuredClone(event.request);
      const next = changed(state, {
        ...state,
        approvals: { ...state.approvals, [request.id]: request },
      });
      return broadcast(
        next,
        event,
        "approval.requested",
        { request, revision: next.revision },
        true,
      );
    }
    case "automation.run": {
      const run = structuredClone(event.run);
      const next = changed(state, { ...state, runs: { ...state.runs, [run.id]: run } });
      return broadcast(next, event, "automation.run", { run, revision: next.revision }, true);
    }
    case "notification.created": {
      const notification = structuredClone(event.notification);
      const next = changed(state, {
        ...state,
        notifications: [...state.notifications, notification].slice(-200),
      });
      return broadcast(next, event, "notification.created", { notification, revision: next.revision }, true);
    }
    case "agent.updated": {
      const agent = structuredClone(event.agent);
      const next = changed(state, { ...state, agents: { ...state.agents, [agent.id]: agent } });
      return broadcast(next, event, "agent.updated", { agent, revision: next.revision }, true);
    }
    case "agent.message": {
      const message = structuredClone(event.message);
      const next = changed(state, { ...state, agentMessages: [...state.agentMessages, message].slice(-500) });
      return broadcast(next, event, "agent.message", { message, revision: next.revision }, true);
    }
    case "approval.resolved": {
      const approvals = { ...state.approvals };
      delete approvals[event.request.id];
      const next = changed(state, { ...state, approvals });
      return broadcast(
        next,
        event,
        "approval.resolved",
        {
          approvalId: event.request.id,
          resolution: structuredClone(event.resolution),
          revision: next.revision,
        },
        true,
      );
    }
  }
}

function changed(previous: KernelState, next: KernelState): KernelState {
  return { ...next, revision: previous.revision + 1 };
}

function broadcast(
  state: KernelState,
  metadata: Pick<KernelEvent, "id" | "ts" | "correlationId" | "causationId">,
  type: string,
  payload: Readonly<Record<string, unknown>>,
  durable: boolean,
): Reduction {
  const publicEvent: PublicKernelEvent = {
    id: metadata.id,
    ts: metadata.ts,
    durable,
    type,
    payload,
    ...(metadata.correlationId === undefined ? {} : { correlationId: metadata.correlationId }),
    ...(metadata.causationId === undefined ? {} : { causationId: metadata.causationId }),
  };
  return { state, effects: [{ type: "client.broadcast", event: publicEvent }] };
}
