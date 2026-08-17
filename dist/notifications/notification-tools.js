import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { NotificationService } from "./notification-service.js";
const parameters = Type.Object({
    title: Type.String({ minLength: 1, maxLength: 120 }),
    body: Type.String({ minLength: 1, maxLength: 4_000 }),
    level: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("success"), Type.Literal("warning"), Type.Literal("error")])),
}, { additionalProperties: false });
export function createNotificationTools(sessionId, notifications) {
    return [
        defineTool({
            name: "notify",
            label: "Notify",
            description: "Send a short durable local notification to the user.",
            parameters,
            executionMode: "sequential",
            execute: async (_toolCallId, params, signal) => {
                if (signal?.aborted)
                    throw signal.reason instanceof Error ? signal.reason : new Error("Notification aborted");
                const record = await notifications.notify({
                    level: params.level ?? "info",
                    title: params.title,
                    body: params.body,
                    source: { kind: "agent", sessionId },
                });
                return { content: [{ type: "text", text: `Notification delivered (${record.id})` }], details: record };
            },
        }),
    ];
}
//# sourceMappingURL=notification-tools.js.map