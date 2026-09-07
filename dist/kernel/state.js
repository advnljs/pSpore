import { initialIndexingStatus } from "../indexing/index-service.js";
export function initialKernelState() {
    return {
        revision: 0,
        daemon: { phase: "starting" },
        sessions: {},
        approvals: {},
        runs: {},
        notifications: [],
        agents: {},
        agentMessages: [],
        mcpServers: {},
        resources: {},
        indexing: initialIndexingStatus(),
    };
}
//# sourceMappingURL=state.js.map