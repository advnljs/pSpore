import type { KernelState } from "../kernel/state.js";
import type { EventEnvelope } from "../protocol/schema.js";
import {
  decodeLlmSettingsUpdate,
  type LlmSettings,
  type LlmSettingsUpdate,
  type ModelApi,
  type ThinkingLevel,
} from "../settings/llm-settings.js";

export const DESKTOP_BOOTSTRAP_CHANNEL = "pspore:desktop:bootstrap";
export const DESKTOP_DISPATCH_CHANNEL = "pspore:desktop:dispatch";
export const DESKTOP_FRAME_CHANNEL = "pspore:desktop:frame";
export const DESKTOP_SETTINGS_GET_CHANNEL = "pspore:desktop:settings:get";
export const DESKTOP_SETTINGS_SAVE_CHANNEL = "pspore:desktop:settings:save";

export type DesktopConnectionPhase = "connecting" | "connected" | "disconnected";

export interface DesktopConnectionState {
  phase: DesktopConnectionPhase;
  attempt: number;
  message?: string;
  instanceId?: string;
}

export interface DesktopVersions {
  pspore: string;
  pi: string;
  electron: string;
  node: string;
}

export interface DesktopBootstrap {
  version: 1;
  connection: DesktopConnectionState;
  snapshot: KernelState | null;
  cursors: Record<string, number>;
  versions: DesktopVersions;
}

export type DesktopFrame =
  | { version: 1; kind: "connection"; connection: DesktopConnectionState }
  | { version: 1; kind: "snapshot"; snapshot: KernelState; cursors: Record<string, number> }
  | { version: 1; kind: "event"; event: EventEnvelope }
  | { version: 1; kind: "delta"; streamId: string; fromSeq: number; seq: number; sessionId: string; text: string };

export type DesktopCommand =
  | { action: "prompt"; text: string; sessionId: string }
  | { action: "steer"; text: string; sessionId: string }
  | { action: "follow_up"; text: string; sessionId: string }
  | { action: "abort"; sessionId: string }
  | { action: "compact"; sessionId: string }
  | { action: "session.create"; title?: string }
  | { action: "queue.send-now"; sessionId: string; index: number }
  | { action: "approval.resolve"; approvalId: string; approved: boolean; scope: "once" | "session" | "job" }
  | { action: "jobs.list" }
  | { action: "runs.list" }
  | { action: "notifications.list" }
  | { action: "job.run"; jobId: string }
  | { action: "run.cancel"; runId: string }
  | { action: "agents.list" }
  | { action: "agent.spawn"; objective: string; parentId: string }
  | { action: "agent.send"; agentId: string; message: string; mode: "steer" | "follow_up" | "next" }
  | { action: "agent.join"; agentIds: string[] }
  | { action: "agent.cancel"; agentId: string }
  | { action: "mcp.servers" }
  | { action: "mcp.tools" }
  | { action: "mcp.discover"; serverId: string }
  | { action: "mcp.ping"; serverId: string }
  | { action: "resources.list" }
  | { action: "skills.list" }
  | { action: "plugins.list" }
  | { action: "resources.inspect"; stagingName: string }
  | { action: "resources.install"; stagingName: string; expectedDigest: string }
  | { action: "resources.disable"; kind: "skill" | "host-plugin"; name: string; expectedDigest: string };

export interface DesktopProtocolInvocation {
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
}

export interface DesktopApi {
  bootstrap(): Promise<DesktopBootstrap>;
  dispatch(command: DesktopCommand): Promise<unknown>;
  getSettings(): Promise<DesktopLlmSettings>;
  saveSettings(settings: DesktopLlmSettingsUpdate): Promise<DesktopSettingsSaveResult>;
  subscribe(listener: (frame: DesktopFrame) => void): () => void;
}

export type DesktopModelApi = ModelApi;
export type DesktopThinkingLevel = ThinkingLevel;
export type DesktopLlmSettings = LlmSettings;
export type DesktopLlmSettingsUpdate = LlmSettingsUpdate;

export interface DesktopSettingsSaveResult {
  settings: DesktopLlmSettings;
  applied: boolean;
  restartRequired: boolean;
  message: string;
}

export function decodeDesktopLlmSettingsUpdate(value: unknown): DesktopLlmSettingsUpdate {
  return decodeLlmSettingsUpdate(value, "desktop LLM settings");
}

export function decodeDesktopCommand(value: unknown): DesktopCommand {
  const input = object(value, "desktop command");
  const action = boundedString(input["action"], "desktop command.action", 64);
  switch (action) {
    case "prompt":
    case "steer":
    case "follow_up":
      exactKeys(input, ["action", "text", "sessionId"], action);
      return {
        action,
        text: boundedString(input["text"], `${action}.text`, 65_536),
        sessionId: identifier(input["sessionId"], `${action}.sessionId`),
      };
    case "abort":
    case "compact":
      exactKeys(input, ["action", "sessionId"], action);
      return { action, sessionId: identifier(input["sessionId"], `${action}.sessionId`) };
    case "session.create": {
      exactKeys(input, ["action", "title"], action, ["title"]);
      const title = input["title"];
      return {
        action,
        ...(title === undefined ? {} : { title: boundedString(title, "session.create.title", 120) }),
      };
    }
    case "queue.send-now":
      exactKeys(input, ["action", "sessionId", "index"], action);
      return {
        action,
        sessionId: identifier(input["sessionId"], "queue.send-now.sessionId"),
        index: nonNegativeInteger(input["index"], "queue.send-now.index", 10_000),
      };
    case "jobs.list":
    case "runs.list":
    case "notifications.list":
    case "agents.list":
    case "mcp.servers":
    case "mcp.tools":
    case "resources.list":
    case "skills.list":
    case "plugins.list":
      exactKeys(input, ["action"], action);
      return { action };
    case "approval.resolve": {
      exactKeys(input, ["action", "approvalId", "approved", "scope"], action);
      const approved = input["approved"];
      if (typeof approved !== "boolean") throw new Error("approval.resolve.approved must be boolean");
      return {
        action,
        approvalId: identifier(input["approvalId"], "approval.resolve.approvalId"),
        approved,
        scope: enumeration(input["scope"], ["once", "session", "job"], "approval.resolve.scope"),
      };
    }
    case "job.run":
      exactKeys(input, ["action", "jobId"], action);
      return { action, jobId: identifier(input["jobId"], "job.run.jobId") };
    case "run.cancel":
      exactKeys(input, ["action", "runId"], action);
      return { action, runId: identifier(input["runId"], "run.cancel.runId") };
    case "agent.spawn":
      exactKeys(input, ["action", "objective", "parentId"], action);
      return {
        action,
        objective: boundedString(input["objective"], "agent.spawn.objective", 16_384),
        parentId: identifier(input["parentId"], "agent.spawn.parentId"),
      };
    case "agent.send":
      exactKeys(input, ["action", "agentId", "message", "mode"], action);
      return {
        action,
        agentId: identifier(input["agentId"], "agent.send.agentId"),
        message: boundedString(input["message"], "agent.send.message", 65_536),
        mode: enumeration(input["mode"], ["steer", "follow_up", "next"], "agent.send.mode"),
      };
    case "agent.join":
      exactKeys(input, ["action", "agentIds"], action);
      return { action, agentIds: identifierArray(input["agentIds"], "agent.join.agentIds", 32) };
    case "agent.cancel":
      exactKeys(input, ["action", "agentId"], action);
      return { action, agentId: identifier(input["agentId"], "agent.cancel.agentId") };
    case "mcp.discover":
    case "mcp.ping":
      exactKeys(input, ["action", "serverId"], action);
      return { action, serverId: identifier(input["serverId"], `${action}.serverId`) };
    case "resources.inspect":
      exactKeys(input, ["action", "stagingName"], action);
      return { action, stagingName: resourceName(input["stagingName"], "resources.inspect.stagingName") };
    case "resources.install":
      exactKeys(input, ["action", "stagingName", "expectedDigest"], action);
      return {
        action,
        stagingName: resourceName(input["stagingName"], "resources.install.stagingName"),
        expectedDigest: digest(input["expectedDigest"], "resources.install.expectedDigest"),
      };
    case "resources.disable":
      exactKeys(input, ["action", "kind", "name", "expectedDigest"], action);
      return {
        action,
        kind: enumeration(input["kind"], ["skill", "host-plugin"], "resources.disable.kind"),
        name: identifier(input["name"], "resources.disable.name"),
        expectedDigest: digest(input["expectedDigest"], "resources.disable.expectedDigest"),
      };
    default:
      throw new Error(`Desktop action is not allowlisted: ${action}`);
  }
}

export function toProtocolInvocation(
  command: DesktopCommand,
  paths: { stagingPath(name: string): string },
): DesktopProtocolInvocation {
  switch (command.action) {
    case "prompt":
      return { type: "session.prompt", payload: { text: command.text, mode: "auto" }, sessionId: command.sessionId };
    case "steer":
      return { type: "session.prompt", payload: { text: command.text, mode: "steer" }, sessionId: command.sessionId };
    case "follow_up":
      return { type: "session.prompt", payload: { text: command.text, mode: "follow_up" }, sessionId: command.sessionId };
    case "abort":
      return { type: "session.abort", payload: { reason: "Electron user requested abort" }, sessionId: command.sessionId };
    case "compact":
      return { type: "session.compact", payload: {}, sessionId: command.sessionId };
    case "session.create":
      return { type: "session.create", payload: command.title === undefined ? {} : { title: command.title } };
    case "queue.send-now":
      return { type: "session.queue.send-now", payload: { index: command.index }, sessionId: command.sessionId };
    case "approval.resolve":
      return {
        type: "approval.resolve",
        payload: { approvalId: command.approvalId, approved: command.approved, scope: command.scope },
      };
    case "jobs.list":
    case "runs.list":
    case "notifications.list":
    case "agents.list":
    case "mcp.servers":
    case "mcp.tools":
    case "resources.list":
    case "skills.list":
    case "plugins.list":
      return { type: command.action, payload: {} };
    case "job.run":
      return { type: "job.run", payload: { jobId: command.jobId } };
    case "run.cancel":
      return { type: "run.cancel", payload: { runId: command.runId, reason: "cancelled from Electron" } };
    case "agent.spawn":
      return {
        type: "agent.spawn",
        payload: {
          parentId: command.parentId,
          objective: command.objective,
          workspaceMode: "shared-read",
          budget: {
            maxTurns: 8,
            maxToolCalls: 24,
            maxInputTokens: 50_000,
            maxOutputTokens: 8_000,
            maxChildren: 0,
          },
        },
      };
    case "agent.send":
      return {
        type: "agent.send",
        payload: { agentId: command.agentId, message: command.message, mode: command.mode },
      };
    case "agent.join":
      return { type: "agent.join", payload: { agentIds: command.agentIds, timeoutMs: 300_000 } };
    case "agent.cancel":
      return { type: "agent.cancel", payload: { agentId: command.agentId, reason: "cancelled from Electron" } };
    case "mcp.discover":
      return { type: "mcp.discover", payload: { serverId: command.serverId } };
    case "mcp.ping":
      return { type: "mcp.ping", payload: { serverId: command.serverId } };
    case "resources.inspect":
      return { type: "resources.inspect", payload: { stagingPath: paths.stagingPath(command.stagingName) } };
    case "resources.install":
      return {
        type: "resources.install",
        payload: { stagingPath: paths.stagingPath(command.stagingName), expectedDigest: command.expectedDigest },
      };
    case "resources.disable":
      return {
        type: "resources.disable",
        payload: { kind: command.kind, name: command.name, expectedDigest: command.expectedDigest },
      };
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, optional: readonly string[] = []): void {
  const expected = new Set(keys);
  const optionalKeys = new Set(optional);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}`);
  for (const key of keys) if (!optionalKeys.has(key) && !(key in value)) throw new Error(`${path}.${key} is required`);
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000]/.test(value)) {
    throw new Error(`${path} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const text = boundedString(value, path, 128);
  if (/[\u0000-\u001f]/.test(text)) throw new Error(`${path} contains control characters`);
  return text;
}

function identifierArray(value: unknown, path: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`${path} must contain 1-${maximum} identifiers`);
  }
  const result = value.map((item, index) => identifier(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${path} must not contain duplicates`);
  return result;
}

function nonNegativeInteger(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`${path} must be an integer between 0 and ${maximum}`);
  }
  return Number(value);
}

function resourceName(value: unknown, path: string): string {
  const text = boundedString(value, path, 128);
  if (text === "." || text === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw new Error(`${path} must be one top-level staging resource name`);
  }
  return text;
}

function digest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${path} must be a lowercase SHA-256`);
  return value;
}

function enumeration<const T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  return value as T;
}
