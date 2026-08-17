import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
const parameters = Type.Object({
    action: Type.Union([Type.Literal("list"), Type.Literal("put")]),
    job: Type.Optional(Type.Unknown()),
    expectedSha256: Type.Optional(Type.Union([Type.Null(), Type.String({ minLength: 64, maxLength: 64 })])),
}, { additionalProperties: false });
export function createAutomationTools(control) {
    return [
        defineTool({
            name: "schedule",
            label: "Schedule",
            description: "List cron jobs or atomically create/update one using its source SHA-256. List first; use null only for a new job.",
            parameters,
            executionMode: "sequential",
            execute: async (_toolCallId, params, signal) => {
                if (signal?.aborted)
                    throw signal.reason instanceof Error ? signal.reason : new Error("Schedule operation aborted");
                if (params.action === "list") {
                    if (params.job !== undefined || params.expectedSha256 !== undefined) {
                        throw new Error("schedule list does not accept job or expectedSha256");
                    }
                    const jobs = control().listJobs();
                    return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }], details: { jobs } };
                }
                if (params.job === undefined || params.expectedSha256 === undefined) {
                    throw new Error("schedule put requires job and expectedSha256 (null for create)");
                }
                const job = await control().putJob(params.job, params.expectedSha256);
                return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }], details: { job } };
            },
        }),
    ];
}
//# sourceMappingURL=automation-tools.js.map