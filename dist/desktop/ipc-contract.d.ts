import type { KernelState } from "../kernel/state.js";
import type { EventEnvelope } from "../protocol/schema.js";
import { type IndexingSettings, type IndexingSettingsUpdate } from "../settings/indexing-settings.js";
import { type LlmSettings, type LlmSettingsUpdate, type ModelApi, type ThinkingLevel } from "../settings/llm-settings.js";
export declare const DESKTOP_BOOTSTRAP_CHANNEL = "pspore:desktop:bootstrap";
export declare const DESKTOP_DISPATCH_CHANNEL = "pspore:desktop:dispatch";
export declare const DESKTOP_FRAME_CHANNEL = "pspore:desktop:frame";
export declare const DESKTOP_SETTINGS_GET_CHANNEL = "pspore:desktop:settings:get";
export declare const DESKTOP_SETTINGS_SAVE_CHANNEL = "pspore:desktop:settings:save";
export declare const DESKTOP_INDEXING_GET_CHANNEL = "pspore:desktop:indexing:get";
export declare const DESKTOP_INDEXING_SAVE_CHANNEL = "pspore:desktop:indexing:save";
export declare const DESKTOP_INDEXING_PICK_CHANNEL = "pspore:desktop:indexing:pick";
/**
 * Thrown before a command is written to the socket, so a caller may safely retry
 * it once the bridge reconnects. Never used for a command that was already sent.
 */
export declare const DAEMON_NOT_CONNECTED_MESSAGE = "pSpore daemon is not connected";
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
export type DesktopFrame = {
    version: 1;
    kind: "connection";
    connection: DesktopConnectionState;
} | {
    version: 1;
    kind: "snapshot";
    snapshot: KernelState;
    cursors: Record<string, number>;
} | {
    version: 1;
    kind: "event";
    event: EventEnvelope;
} | {
    version: 1;
    kind: "delta";
    streamId: string;
    fromSeq: number;
    seq: number;
    /** Transient events the daemon shed for this client just before `fromSeq`. */
    skipped?: number;
    sessionId: string;
    /** Transcript item this coalesced run of deltas belongs to. */
    itemId: string;
    channel: "text" | "thinking";
    text: string;
};
export type DesktopCommand = {
    action: "prompt";
    text: string;
    sessionId: string;
} | {
    action: "steer";
    text: string;
    sessionId: string;
} | {
    action: "follow_up";
    text: string;
    sessionId: string;
} | {
    action: "abort";
    sessionId: string;
} | {
    action: "compact";
    sessionId: string;
} | {
    action: "session.create";
    title?: string;
} | {
    action: "session.delete";
    sessionId: string;
} | {
    action: "session.transcript";
    sessionId: string;
    from?: number;
    limit?: number;
} | {
    action: "session.message";
    sessionId: string;
    id?: string;
    index?: number;
    offset?: number;
    limit?: number;
} | {
    action: "queue.send-now";
    sessionId: string;
    index: number;
} | {
    action: "approval.resolve";
    approvalId: string;
    approved: boolean;
    scope: "once" | "session" | "job";
} | {
    action: "jobs.list";
} | {
    action: "runs.list";
} | {
    action: "notifications.list";
} | {
    action: "job.run";
    jobId: string;
} | {
    action: "run.cancel";
    runId: string;
} | {
    action: "agents.list";
} | {
    action: "agent.spawn";
    objective: string;
    parentId: string;
} | {
    action: "agent.send";
    agentId: string;
    message: string;
    mode: "steer" | "follow_up" | "next";
} | {
    action: "agent.join";
    agentIds: string[];
} | {
    action: "agent.cancel";
    agentId: string;
} | {
    action: "mcp.servers";
} | {
    action: "mcp.tools";
} | {
    action: "tools.list";
} | {
    action: "mcp.discover";
    serverId: string;
} | {
    action: "mcp.ping";
    serverId: string;
} | {
    action: "resources.list";
} | {
    action: "skills.list";
} | {
    action: "plugins.list";
} | {
    action: "resources.inspect";
    stagingName: string;
} | {
    action: "resources.install";
    stagingName: string;
    expectedDigest: string;
} | {
    action: "resources.disable";
    kind: "skill" | "host-plugin";
    name: string;
    expectedDigest: string;
};
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
    getIndexing(): Promise<DesktopIndexingSettings>;
    saveIndexing(settings: DesktopIndexingSettingsUpdate): Promise<DesktopIndexingSaveResult>;
    /** Opens a native directory chooser; resolves to undefined when cancelled. */
    pickIndexDirectory(): Promise<string | undefined>;
    /** Resolve only an operating-system-backed File supplied by a user drag. */
    getPathForFile(file: unknown): string;
    subscribe(listener: (frame: DesktopFrame) => void): () => void;
}
export type DesktopModelApi = ModelApi;
export type DesktopThinkingLevel = ThinkingLevel;
export type DesktopIndexingSettings = IndexingSettings;
export type DesktopIndexingSettingsUpdate = IndexingSettingsUpdate;
export interface DesktopIndexingSaveResult {
    settings: DesktopIndexingSettings;
    applied: boolean;
    message: string;
}
export declare function decodeDesktopIndexingSettingsUpdate(value: unknown): DesktopIndexingSettingsUpdate;
export type DesktopLlmSettings = LlmSettings;
export type DesktopLlmSettingsUpdate = LlmSettingsUpdate;
export interface DesktopSettingsSaveResult {
    settings: DesktopLlmSettings;
    applied: boolean;
    restartRequired: boolean;
    message: string;
}
export declare function decodeDesktopLlmSettingsUpdate(value: unknown): DesktopLlmSettingsUpdate;
export declare function decodeDesktopCommand(value: unknown): DesktopCommand;
export declare function toProtocolInvocation(command: DesktopCommand, paths: {
    stagingPath(name: string): string;
}): DesktopProtocolInvocation;
//# sourceMappingURL=ipc-contract.d.ts.map