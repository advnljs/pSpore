import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Accepted, AgentHandle, AgentRuntimePort, AgentSessionSpec, AgentSnapshot, ModelRef, ResumeSessionSpec, RuntimeEvent, SessionId, ToolGate } from "../domain/runtime.js";
type Clock = () => Date;
type IdFactory = () => string;
export interface PiRuntimeAdapterOptions {
    agentDir: string;
    sessionRoot: string;
    modelRuntime?: ModelRuntime;
    resolveModel?: (ref: ModelRef | undefined, runtime: ModelRuntime) => Model<string> | undefined;
    createTools?: (sessionId: SessionId) => readonly ToolDefinition[];
    createSkillPaths?: (sessionId: SessionId) => readonly string[] | Promise<readonly string[]>;
    toolGate?: ToolGate;
    clock?: Clock;
    idFactory?: IdFactory;
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
    abort(sessionId: SessionId, _reason: string): Promise<void>;
    compact(sessionId: SessionId, instructions?: string): Promise<void>;
    snapshot(sessionId: SessionId): AgentSnapshot;
    subscribe(sessionId: SessionId, sink: (event: RuntimeEvent) => void): () => void;
    waitForIdle(sessionId: SessionId): Promise<void>;
    newSession(sessionId: SessionId): Promise<AgentHandle>;
    switchSession(sessionId: SessionId, sessionFile: string): Promise<AgentHandle>;
    fork(sessionId: SessionId, entryId: string, position?: "before" | "at"): Promise<AgentHandle>;
    dispose(sessionId: SessionId): Promise<void>;
    disposeAll(): Promise<void>;
}
export {};
//# sourceMappingURL=pi-runtime-adapter.d.ts.map