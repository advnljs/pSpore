import type { RunBudget } from "../automation/types.js";
import type { RuntimeUsage } from "../domain/runtime.js";

export type AgentStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "budget_exhausted";
export type AgentWorkspaceMode = "shared-read" | "shared-write";
export type AgentMessageMode = "steer" | "follow_up" | "next";

export interface AgentResult {
  status: Extract<AgentStatus, "succeeded" | "failed" | "cancelled" | "budget_exhausted">;
  summary: string;
  evidenceRefs: string[];
  changedFiles: string[];
  openQuestions: string[];
  usage: RuntimeUsage;
}

export interface AgentRecord {
  version: 1;
  id: string;
  sessionId: string;
  parentId: string;
  rootId: string;
  objective: string;
  cwd: string;
  depth: number;
  workspaceMode: AgentWorkspaceMode;
  budget: RunBudget;
  status: AgentStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: AgentResult;
  error?: string;
}

export interface AgentMessage {
  version: 1;
  id: string;
  senderId: string;
  recipientId: string;
  sequence: number;
  correlationId: string;
  priority: "normal" | "high";
  mode: AgentMessageMode;
  text: string;
  tokenEstimate: number;
  ts: string;
}

export interface AgentSpawnRequest {
  parentId: string;
  objective: string;
  cwd: string;
  workspaceMode: AgentWorkspaceMode;
  budget: RunBudget;
}
