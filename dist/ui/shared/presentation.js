export function presentSessions(kernel, selectedSessionId) {
    const main = kernel.sessions["main"];
    const result = [{
            id: "main",
            sessionId: "main",
            title: "Main session",
            status: main?.status ?? "idle",
            depth: 0,
            selected: selectedSessionId === "main",
            active: Boolean(main) || selectedSessionId === "main",
            kind: "main",
        }];
    for (const agent of Object.values(kernel.agents).sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
        const session = kernel.sessions[agent.sessionId];
        result.push({
            id: agent.id,
            sessionId: agent.sessionId,
            title: agent.objective || agent.id,
            status: session?.status ?? agent.status,
            depth: Math.min(agent.depth, 5),
            selected: selectedSessionId === agent.sessionId,
            active: Boolean(session),
            kind: "agent",
        });
    }
    return result;
}
export function kernelMetrics(kernel) {
    const sessions = Object.values(kernel.sessions);
    const runs = Object.values(kernel.runs);
    const mcpServers = Object.values(kernel.mcpServers);
    const resources = Object.values(kernel.resources);
    return {
        sessions: sessions.length,
        runningSessions: sessions.filter((session) => session.status === "running").length,
        pendingApprovals: Object.keys(kernel.approvals).length,
        runs: runs.length,
        activeRuns: runs.filter((run) => run.status === "queued" || run.status === "running").length,
        readyMcpServers: mcpServers.filter((server) => server.status === "ready").length,
        mcpServers: mcpServers.length,
        activeResources: resources.filter((resource) => resource.status === "active" || resource.status === "ready").length,
        resources: resources.length,
    };
}
export function selectedAgent(kernel, selectedSessionId) {
    return Object.values(kernel.agents).find((agent) => agent.sessionId === selectedSessionId);
}
export function conversationIntent(kernel, selectedSessionId, text, mode) {
    const agent = selectedAgent(kernel, selectedSessionId);
    if (agent) {
        return {
            target: "agent",
            agentId: agent.id,
            sessionId: agent.sessionId,
            text,
            mode: mode === "prompt" ? "next" : mode,
        };
    }
    return { target: "main", sessionId: "main", text, mode };
}
export function terminalAgentStatus(value) {
    return value === "succeeded" || value === "failed" || value === "cancelled" || value === "budget_exhausted";
}
export function shortId(value) {
    return value.length > 15 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}
export function formatTokens(value) {
    return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}
export function formatBytes(value) {
    if (value >= 1_048_576)
        return `${(value / 1_048_576).toFixed(1)} MB`;
    if (value >= 1_024)
        return `${(value / 1_024).toFixed(1)} KB`;
    return `${value} B`;
}
export function clockTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value.slice(0, 8) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
//# sourceMappingURL=presentation.js.map