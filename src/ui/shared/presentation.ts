import type { KernelState } from "../../kernel/state.js";
import type { AgentRecord } from "../../agents/types.js";

export interface SessionListItem {
  id: string;
  sessionId: string;
  title: string;
  status: string;
  depth: number;
  selected: boolean;
  active: boolean;
  kind: "main" | "agent";
}

export interface KernelMetrics {
  sessions: number;
  runningSessions: number;
  pendingApprovals: number;
  runs: number;
  activeRuns: number;
  readyMcpServers: number;
  mcpServers: number;
  activeResources: number;
  resources: number;
}

export type ComposerMode = "auto" | "prompt" | "steer" | "follow_up";
export type ConversationIntent =
  | { target: "main"; sessionId: string; text: string; mode: ComposerMode }
  | { target: "agent"; agentId: string; sessionId: string; text: string; mode: "next" | "steer" | "follow_up" };

export function presentSessions(kernel: KernelState, selectedSessionId: string): SessionListItem[] {
  const agents = Object.values(kernel.agents).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const agentSessionIds = new Set(agents.map((agent) => agent.sessionId));
  const roots: Array<[string, KernelState["sessions"][string] | undefined]> = Object.entries(kernel.sessions)
    .filter(([id, session]) => session.rootSession || (!agentSessionIds.has(id) && !id.startsWith("agent:") && !id.startsWith("run:")))
    .sort(([leftId, left], [rightId, right]) => {
      if (leftId === "main") return -1;
      if (rightId === "main") return 1;
      return (left.rootSession?.createdAt ?? "").localeCompare(right.rootSession?.createdAt ?? "") || leftId.localeCompare(rightId);
    });
  if (roots.length === 0) roots.push(["main", undefined]);

  const result: SessionListItem[] = [];
  const appendedAgents = new Set<string>();
  for (const [id, session] of roots) {
    result.push({
      id,
      sessionId: id,
      title: session?.rootSession?.title ?? sessionTitle(session?.messages, id),
      status: session?.status ?? "idle",
      depth: 0,
      selected: selectedSessionId === id,
      active: Boolean(session) || selectedSessionId === id,
      kind: "main",
    });
    for (const agent of agents.filter((candidate) => candidate.rootId === id)) {
      result.push(agentListItem(agent, kernel, selectedSessionId));
      appendedAgents.add(agent.id);
    }
  }
  for (const agent of agents) {
    if (appendedAgents.has(agent.id)) continue;
    result.push(agentListItem(agent, kernel, selectedSessionId));
  }
  return result;
}

function agentListItem(agent: AgentRecord, kernel: KernelState, selectedSessionId: string): SessionListItem {
    const session = kernel.sessions[agent.sessionId];
    return {
      id: agent.id,
      sessionId: agent.sessionId,
      title: agent.objective || agent.id,
      status: session?.status ?? agent.status,
      depth: Math.min(agent.depth, 5),
      selected: selectedSessionId === agent.sessionId,
      active: Boolean(session),
      kind: "agent",
    };
}

export function kernelMetrics(kernel: KernelState): KernelMetrics {
  const sessions = Object.values(kernel.sessions);
  const runs = Object.values(kernel.runs);
  const mcpServers = Object.values(kernel.mcpServers);
  const resources = Object.values(kernel.resources);
  return {
    sessions: sessions.length,
    runningSessions: sessions.filter((session) => session.status === "running").length,
    pendingApprovals: Object.keys(kernel.approvals).length,
    runs: runs.length,
    activeRuns: runs.filter((run) => run.status === "queued" || run.status === "running").length,
    readyMcpServers: mcpServers.filter((server) => server.status === "ready").length,
    mcpServers: mcpServers.length,
    activeResources: resources.filter((resource) => resource.status === "active" || resource.status === "ready").length,
    resources: resources.length,
  };
}

export function selectedAgent(kernel: KernelState, selectedSessionId: string): AgentRecord | undefined {
  return Object.values(kernel.agents).find((agent) => agent.sessionId === selectedSessionId);
}

export function conversationIntent(
  kernel: KernelState,
  selectedSessionId: string,
  text: string,
  mode: ComposerMode,
): ConversationIntent {
  const agent = selectedAgent(kernel, selectedSessionId);
  if (agent) {
    return {
      target: "agent",
      agentId: agent.id,
      sessionId: agent.sessionId,
      text,
      mode: mode === "auto" || mode === "prompt" ? "next" : mode,
    };
  }
  const sessionId = kernel.sessions[selectedSessionId] ? selectedSessionId : "main";
  return { target: "main", sessionId, text, mode };
}

function sessionTitle(messages: readonly { role: string; text: string }[] | undefined, id: string): string {
  const first = messages?.find((message) => message.role === "user" && message.text.trim())?.text.replace(/\s+/g, " ").trim();
  if (!first) return id === "main" ? "Main session" : "New session";
  const chars = [...first];
  return chars.length > 72 ? `${chars.slice(0, 71).join("")}…` : first;
}

export function terminalAgentStatus(value: string): boolean {
  return value === "succeeded" || value === "failed" || value === "cancelled" || value === "budget_exhausted";
}

export function shortId(value: string): string {
  return value.length > 15 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}

export function formatTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

export function formatBytes(value: number): string {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${value} B`;
}

export function clockTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value.slice(0, 8) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
