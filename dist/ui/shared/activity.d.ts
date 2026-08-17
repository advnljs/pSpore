import type { EventEnvelope } from "../../protocol/schema.js";
export type CoworkActivityStatus = "running" | "succeeded" | "failed";
/**
 * A client-neutral view of agent work. TUI and desktop render this same model with
 * different widgets, so tool semantics never drift between the two clients.
 */
export interface CoworkActivity {
    id: string;
    type: string;
    sessionId?: string;
    toolName?: string;
    status: CoworkActivityStatus;
    label: string;
    summary: string;
    ts: string;
    completedAt?: string;
    durationMs?: number;
    resultSummary?: string;
    detail?: string;
}
export declare function applyCoworkActivityEvent(current: readonly CoworkActivity[], event: EventEnvelope, maximum?: number): readonly CoworkActivity[];
export declare function toolLabel(toolName: string, status: CoworkActivityStatus): string;
export declare function activityDetailLines(activity: CoworkActivity): string[];
export declare function formatDuration(durationMs: number): string;
//# sourceMappingURL=activity.d.ts.map