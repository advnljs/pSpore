import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Accepted, AgentHandle, AgentRuntimePort, AgentSessionSpec, ModelRef, ResumeSessionSpec, RuntimeEvent, RuntimeMessage, SessionId, SessionMetadata, ToolGate, TranscriptMessageSlice, TranscriptPage } from "../domain/runtime.js";
import type { AutoCompactionConfig } from "../config/config.js";
import type { SessionSkill } from "../plugins/types.js";
type Clock = () => Date;
type IdFactory = () => string;
export interface PiRuntimeAdapterOptions {
    agentDir: string;
    sessionRoot: string;
    modelRuntime?: ModelRuntime;
    resolveModel?: (ref: ModelRef | undefined, runtime: ModelRuntime) => Model<string> | undefined;
    createTools?: (sessionId: SessionId) => readonly ToolDefinition[];
    createSkillPaths?: (sessionId: SessionId) => readonly string[] | Promise<readonly string[]>;
    /**
     * Skills already resolved outside Pi — the user's own workspace skills, which
     * Pi's strict loader would drop for loose frontmatter. They join the path-based
     * skills, which win any name collision.
     */
    createSkills?: (sessionId: SessionId) => readonly SessionSkill[] | Promise<readonly SessionSkill[]>;
    toolGate?: ToolGate;
    clock?: Clock;
    idFactory?: IdFactory;
    autoCompaction?: AutoCompactionConfig;
}
export declare class PiRuntimeAdapter implements AgentRuntimePort {
    #private;
    private constructor();
    static create(options: PiRuntimeAdapterOptions): Promise<PiRuntimeAdapter>;
    create(spec: AgentSessionSpec): Promise<AgentHandle>;
    resume(spec: ResumeSessionSpec): Promise<AgentHandle>;
    prompt(sessionId: SessionId, input: string): Promise<Accepted>;
    steer(sessionId: SessionId, input: string): Promise<Accepted>;
    followUp(sessionId: SessionId, input: string): Promise<Accepted>;
    promoteFollowUp(sessionId: SessionId, index: number): Promise<Accepted>;
    abort(sessionId: SessionId, _reason: string): Promise<void>;
    compact(sessionId: SessionId, instructions?: string): Promise<void>;
    snapshot(sessionId: SessionId): SessionMetadata;
    subscribe(sessionId: SessionId, sink: (event: RuntimeEvent) => void): () => void;
    waitForIdle(sessionId: SessionId): Promise<void>;
    newSession(sessionId: SessionId): Promise<AgentHandle>;
    switchSession(sessionId: SessionId, sessionFile: string): Promise<AgentHandle>;
    /**
     * A slice of the persisted branch, which keeps entries a compaction has
     * already dropped from the model's context. Only the requested slice is
     * rendered to text: doing that for the whole branch is what made every
     * streamed token cost as much as the conversation was long.
     */
    transcript(sessionId: SessionId, options: {
        from?: number;
        limit: number;
    }): TranscriptPage;
    /**
     * One message's full text, sliced. The transcript on the wire is bounded per
     * string, so a message longer than that ceiling arrives cut; this is how a
     * client asks for the rest of it without widening the ceiling for everything.
     */
    transcriptMessage(sessionId: SessionId, options: {
        id?: string;
        index?: number;
        offset?: number;
        limit: number;
    }): TranscriptMessageSlice;
    /** The persisted branch's message entries, unrendered. */
    branch(sessionId: SessionId): readonly RuntimeMessage[];
    fork(sessionId: SessionId, entryId: string, position?: "before" | "at"): Promise<AgentHandle>;
    dispose(sessionId: SessionId): Promise<void>;
    disposeAll(): Promise<void>;
}
export {};
//# sourceMappingURL=pi-runtime-adapter.d.ts.map