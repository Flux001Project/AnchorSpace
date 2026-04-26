/**
 * Verified gateway event protocol (probed 2026-04-26 against OpenClaw 2026.4.15).
 * See README.md → "Verified gateway event protocol".
 */

export type GatewayEventName =
  | "agent"
  | "chat"
  | "health"
  | "tick"
  // Synthetic events emitted by the local proxy (vite-plugins/gatewayProxy.ts):
  | "proxy:disconnected"
  | "proxy:reconnected"
  | "proxy:starting";

export type AgentStreamKind =
  | "lifecycle"
  | "item"
  | "command_output"
  | "assistant";

export interface GatewayEnvelope<P = Record<string, unknown>> {
  type: "event";
  event: GatewayEventName;
  payload: P;
  seq?: number;
  runId?: string;
  sessionKey?: string;
  ts?: number;
}

// ── Stream-specific payload shapes ───────────────────────────────────────────

export interface AgentLifecyclePayload {
  stream: "lifecycle";
  phase: "start" | "end";
  runId: string;
  sessionKey: string;
  startedAt?: number;
  endedAt?: number;
}

export interface AgentItemPayload {
  stream: "item";
  data: {
    itemId: string;
    phase: "start" | "update" | "end";
    kind: "tool" | "command";
    /** Tool name, e.g. "exec", "read", "process", "write". */
    name: string;
    title?: string;
    meta?: string;
    status?: "running" | "completed" | "failed";
    toolCallId?: string;
    progressText?: string;
    startedAt?: number;
    endedAt?: number;
    summary?: string;
  };
  runId: string;
  sessionKey: string;
  seq?: number;
  ts?: number;
}

export interface AgentCommandOutputPayload {
  stream: "command_output";
  data: {
    itemId: string;
    phase: "delta" | "end";
    title?: string;
    toolCallId?: string;
    name?: string;
    output: string;
    status?: "running" | "completed" | "failed";
    exitCode?: number;
    durationMs?: number;
    cwd?: string;
    summary?: string;
  };
  runId: string;
  sessionKey: string;
  seq?: number;
  ts?: number;
}

export interface AgentAssistantPayload {
  stream: "assistant";
  data: {
    text: string;
    delta: string;
  };
  runId: string;
  sessionKey: string;
  seq?: number;
  ts?: number;
}

export type AgentEventPayload =
  | AgentLifecyclePayload
  | AgentItemPayload
  | AgentCommandOutputPayload
  | AgentAssistantPayload;

// ── Synthetic proxy event payloads ───────────────────────────────────────────

export interface ProxyDisconnectedPayload {
  reason: string;
  greeting?: boolean;
}

export interface ProxyReconnectedPayload {
  ts: number;
  greeting?: boolean;
}
