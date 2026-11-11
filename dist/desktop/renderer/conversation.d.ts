import type { RuntimeMessage, RuntimeToolCall } from "../../domain/runtime.js";
export interface ConversationEntry {
    message: RuntimeMessage;
    index: number;
}
export type ConversationRow = {
    kind: "message";
    key: string;
    entry: ConversationEntry;
} | {
    kind: "process";
    key: string;
    entries: ConversationEntry[];
    active: boolean;
};
export declare function isToolMessage(message: RuntimeMessage): boolean;
/** Group only consecutive work; user messages and final answers are boundaries. */
export declare function conversationRows(messages: readonly RuntimeMessage[], offset: number, running: boolean): ConversationRow[];
/** The same source strings the renderer makes searchable, in display order. */
export declare function conversationRowText(row: ConversationRow): string;
/** Prefer the action's target over generic byte counts; preserve full input below. */
export declare function toolCallSummary(call: RuntimeToolCall): string;
//# sourceMappingURL=conversation.d.ts.map