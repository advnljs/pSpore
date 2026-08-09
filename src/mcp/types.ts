export type McpTrust = "trusted-local" | "sandboxed";

export interface McpStdioTransportConfig {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  envRefs: Readonly<Record<string, string>>;
}

export interface McpHttpHeaderRef {
  env: string;
  prefix?: string;
}

export interface McpHttpTransportConfig {
  type: "streamable-http";
  url: string;
  headerRefs: Readonly<Record<string, McpHttpHeaderRef>>;
}

export type McpTransportConfig = McpStdioTransportConfig | McpHttpTransportConfig;

export interface McpServerConfig {
  id: string;
  enabled: boolean;
  trust: McpTrust;
  transport: McpTransportConfig;
  allowedTools: string[];
  deniedTools: string[];
  idleTimeoutMs: number;
  requestTimeoutMs: number;
}

export type McpHealthStatus = "disabled" | "untrusted" | "idle" | "connecting" | "ready" | "backoff" | "stopped";

export interface McpHealthRecord {
  version: 1;
  serverId: string;
  status: McpHealthStatus;
  transport: McpTransportConfig["type"];
  toolCount: number;
  failureCount: number;
  updatedAt: string;
  connectedAt?: string;
  retryAt?: string;
  lastError?: string;
}

export interface McpToolDescriptor {
  version: 1;
  serverId: string;
  name: string;
  normalizedName: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown> & { type: "object" };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpCallDetails {
  serverId: string;
  toolName: string;
  normalizedName: string;
  isError: boolean;
  bytes: number;
  truncated: boolean;
  artifactPath?: string;
  artifactSha256?: string;
}

export interface McpCallOutput {
  text: string;
  details: McpCallDetails;
}
