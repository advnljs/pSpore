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
    };
}
//# sourceMappingURL=state.js.map