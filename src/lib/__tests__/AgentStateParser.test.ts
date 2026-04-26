import { describe, it, expect } from "vitest";
import { AgentStateParser } from "../AgentStateParser";
import type { GatewayEnvelope } from "../types";

// ── Envelope builders ────────────────────────────────────────────────────────

const lifecycleStart = (runId: string, sessionKey: string): GatewayEnvelope => ({
  type: "event",
  event: "agent",
  runId,
  sessionKey,
  payload: {
    stream: "lifecycle",
    phase: "start",
    runId,
    sessionKey,
    startedAt: Date.now(),
  } as unknown as Record<string, unknown>,
});

const toolItemStart = (
  runId: string,
  sessionKey: string,
  itemId: string,
  name: string
): GatewayEnvelope => ({
  type: "event",
  event: "agent",
  runId,
  sessionKey,
  payload: {
    stream: "item",
    runId,
    sessionKey,
    data: {
      itemId,
      phase: "start",
      kind: "tool",
      name,
      status: "running",
      startedAt: Date.now(),
    },
  } as unknown as Record<string, unknown>,
});

const bareAssistant = (runId: string, sessionKey: string, text: string): GatewayEnvelope => ({
  type: "event",
  event: "agent",
  runId,
  sessionKey,
  payload: {
    stream: "assistant",
    runId,
    sessionKey,
    data: { text },
  } as unknown as Record<string, unknown>,
});

const bareCommandOutput = (runId: string, sessionKey: string, output: string): GatewayEnvelope => ({
  type: "event",
  event: "agent",
  runId,
  sessionKey,
  payload: {
    stream: "command_output",
    runId,
    sessionKey,
    data: { output },
  } as unknown as Record<string, unknown>,
});

// "announce-style" runId on an assistant stream — the gateway emits these
// when dispatching sub-agent results to delivery targets. They carry a
// synthetic runId and a sub-agent sessionKey; if the parser admitted them
// the room would paint a phantom character at a sub-agent desk.
const announceStyleAssistant = (text: string): GatewayEnvelope => ({
  type: "event",
  event: "agent",
  runId: "announce:v1:agent:main:subagent:abc-123:dispatch-456",
  sessionKey: "agent:main:subagent:abc-123",
  payload: {
    stream: "assistant",
    runId: "announce:v1:agent:main:subagent:abc-123:dispatch-456",
    sessionKey: "agent:main:subagent:abc-123",
    data: { text },
  } as unknown as Record<string, unknown>,
});

const bareLifecycleEnd = (runId: string, sessionKey: string): GatewayEnvelope => ({
  type: "event",
  event: "agent",
  runId,
  sessionKey,
  payload: {
    stream: "lifecycle",
    phase: "end",
    runId,
    sessionKey,
    endedAt: Date.now(),
  } as unknown as Record<string, unknown>,
});

const bareToolItemEnd = (
  runId: string,
  sessionKey: string,
  itemId: string,
  name: string
): GatewayEnvelope => ({
  type: "event",
  event: "agent",
  runId,
  sessionKey,
  payload: {
    stream: "item",
    runId,
    sessionKey,
    data: {
      itemId,
      phase: "end",
      kind: "tool",
      name,
      status: "ok",
    },
  } as unknown as Record<string, unknown>,
});

const bareCommandItemStart = (
  runId: string,
  sessionKey: string,
  itemId: string
): GatewayEnvelope => ({
  type: "event",
  event: "agent",
  runId,
  sessionKey,
  payload: {
    stream: "item",
    runId,
    sessionKey,
    data: {
      itemId,
      phase: "start",
      kind: "command", // NOT a tool — the parser already filters these in applyItem
      name: "exec",
      status: "running",
      startedAt: Date.now(),
    },
  } as unknown as Record<string, unknown>,
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AgentStateParser — substrate honesty (Phase 4.0.1)", () => {
  it("(a) lifecycle.start CREATES a run", () => {
    const p = new AgentStateParser();
    p.ingest(lifecycleStart("r1", "agent:main:main"));
    const snap = p.snapshot();
    expect(snap.runs.size).toBe(1);
    expect(snap.runs.get("r1::agent:main:main")?.runId).toBe("r1");
  });

  it("(b) tool item.start CREATES a run", () => {
    const p = new AgentStateParser();
    p.ingest(toolItemStart("r2", "agent:main:main", "i1", "exec"));
    const snap = p.snapshot();
    expect(snap.runs.size).toBe(1);
    const run = snap.runs.get("r2::agent:main:main");
    expect(run?.openTools).toHaveLength(1);
    expect(run?.openTools[0].name).toBe("exec");
  });

  it("(c) bare assistant stream does NOT create a run", () => {
    const p = new AgentStateParser();
    p.ingest(bareAssistant("r3", "agent:main:main", "some text"));
    expect(p.snapshot().runs.size).toBe(0);
  });

  it("(d) bare command_output does NOT create a run", () => {
    const p = new AgentStateParser();
    p.ingest(bareCommandOutput("r4", "agent:main:main", "stdout line"));
    expect(p.snapshot().runs.size).toBe(0);
  });

  it("(e) announce-style runId on assistant stream does NOT create a run", () => {
    const p = new AgentStateParser();
    p.ingest(announceStyleAssistant("dispatched result"));
    expect(p.snapshot().runs.size).toBe(0);
  });

  it("bare lifecycle.end does NOT create a run (only lifecycle.start qualifies)", () => {
    const p = new AgentStateParser();
    p.ingest(bareLifecycleEnd("r5", "agent:main:main"));
    expect(p.snapshot().runs.size).toBe(0);
  });

  it("bare tool item.end does NOT create a run (only item.start qualifies)", () => {
    const p = new AgentStateParser();
    p.ingest(bareToolItemEnd("r6", "agent:main:main", "i1", "exec"));
    expect(p.snapshot().runs.size).toBe(0);
  });

  it("kind=command item.start does NOT create a run (only kind=tool qualifies)", () => {
    const p = new AgentStateParser();
    p.ingest(bareCommandItemStart("r7", "agent:main:main", "i1"));
    expect(p.snapshot().runs.size).toBe(0);
  });

  it("late assistant text on a real run is admitted (run already exists)", () => {
    const p = new AgentStateParser();
    p.ingest(lifecycleStart("r8", "agent:main:main"));
    p.ingest(bareAssistant("r8", "agent:main:main", "hello world"));
    const run = p.snapshot().runs.get("r8::agent:main:main");
    expect(run?.assistantText).toBe("hello world");
  });

  it("late tool item.start on a phantom run admits it (recovery path)", () => {
    // First, bare assistant alone → no run.
    const p = new AgentStateParser();
    p.ingest(bareAssistant("r9", "agent:main:main", "thinking..."));
    expect(p.snapshot().runs.size).toBe(0);
    // Then a tool item.start arrives → run is born cleanly at that point.
    p.ingest(toolItemStart("r9", "agent:main:main", "i1", "read"));
    expect(p.snapshot().runs.size).toBe(1);
    const run = p.snapshot().runs.get("r9::agent:main:main");
    expect(run?.openTools).toHaveLength(1);
  });
});
