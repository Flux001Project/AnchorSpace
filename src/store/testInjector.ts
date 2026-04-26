/**
 * Test-only deterministic injector for the screenshot harness.
 *
 * Only installs when `?mock=1` is in the URL. Exposes
 * `window.__anchorspaceTestInject(kind, opts?)` so puppeteer scripts can
 * drive the room into a known state without flying a real agent run.
 *
 * Phase 3 actions:
 *   - "long-typing"   start a Flux run that has been running for 16 minutes
 *                     (forces the timer into the warning-amber color)
 *   - "seed-log"      stage 6 historical entries into localStorage and
 *                     refresh the store's logEntries snapshot
 *   - "notebook-open" toggles the notebook overlay open
 *
 * This is a screenshot/debug aid. It does NOT replace the real event stream;
 * synthetic envelopes are pushed straight into the parser alongside live ones.
 */

import type { AgentStateParser } from "../lib/AgentStateParser";
import type { GatewayEnvelope } from "../lib/types";
import { useRoomStore } from "./roomStore";
import { _seedForTests, type LogEntry } from "../log/activityLog";
import { palette, subagentColor } from "../room/palette";

let currentParser: AgentStateParser | null = null;
let installed = false;

export function installTestInjector(
  parser: AgentStateParser,
  onLogReseed?: () => void
) {
  currentParser = parser;
  const mock = new URLSearchParams(window.location.search).get("mock");
  // Accept any truthy value of `mock` (typically `1` or `isolated`).
  if (mock === null) return;

  // Always seed the freshly-installed parser with `proxy:reconnected` so the
  // LED is green in mock mode. Without this, React StrictMode's double-invoke
  // (or any re-mount) leaves the new parser stuck at `connected: false` —
  // the previous-parser proxy state in the store gets clobbered as soon as
  // the new parser emits anything else.
  parser.ingest({
    type: "event",
    event: "proxy:reconnected",
    payload: { ts: Date.now() } as unknown as Record<string, unknown>,
  });

  if (installed) return;
  installed = true;

  (window as unknown as { __anchorspaceStore: typeof useRoomStore }).__anchorspaceStore = useRoomStore;

  const baseRun = {
    runId: "mock-flux-run",
    sessionKey: "agent:main:main",
  };

  const synth = (env: Partial<GatewayEnvelope> & { event: GatewayEnvelope["event"] }): GatewayEnvelope => ({
    type: "event",
    payload: {} as Record<string, unknown>,
    ...env,
  });

  const ingest = (env: GatewayEnvelope) => {
    currentParser?.ingest(env);
  };

  function start(runId: string, sessionKey: string, startedAt: number = Date.now()) {
    ingest(
      synth({
        event: "agent",
        runId,
        sessionKey,
        payload: {
          stream: "lifecycle",
          phase: "start",
          runId,
          sessionKey,
          startedAt,
        } as unknown as Record<string, unknown>,
      })
    );
  }

  function toolStart(runId: string, sessionKey: string, name: string, title?: string, itemId?: string, startedAt: number = Date.now()) {
    const id = itemId ?? `mock-${Math.random().toString(36).slice(2, 8)}`;
    ingest(
      synth({
        event: "agent",
        runId,
        sessionKey,
        payload: {
          stream: "item",
          runId,
          sessionKey,
          data: {
            itemId: id,
            phase: "start",
            kind: "tool",
            name,
            title,
            status: "running",
            startedAt,
          },
        } as unknown as Record<string, unknown>,
      })
    );
    return id;
  }

  function lifecycleEnd(runId: string, sessionKey: string) {
    ingest(
      synth({
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
      })
    );
  }

  // Note: `proxy:reconnected` is now seeded above, before the install-once
  // guard, so a fresh parser is always marked connected even on remount.

  type Kind =
    | "typing"
    | "reading"
    | "subagent"
    | "long-typing"
    | "seed-log"
    | "notebook-open"
    | "clear";

  const subagentRuns: Array<{ runId: string; sessionKey: string }> = [];

  function seedHistoricalLog() {
    const now = Date.now();
    // 6 entries spanning short → long durations across Flux + sub-agents.
    const entries: LogEntry[] = [
      {
        id: "seed-1",
        agent: "Flux",
        agentColor: palette.flux,
        tools: ["exec", "read"],
        durationMs: 47 * 1000,
        endedAt: now - 90 * 1000,
        summary: "Counted entries in /tmp and reported READY.",
      },
      {
        id: "seed-2",
        agent: "Sub-1",
        agentColor: subagentColor(0),
        tools: ["web_search"],
        durationMs: 2 * 60 * 1000 + 12 * 1000,
        endedAt: now - 5 * 60 * 1000,
        summary: "Pulled OpenClaw gateway docs from web search; summarized 3 sections.",
      },
      {
        id: "seed-3",
        agent: "Flux",
        agentColor: palette.flux,
        tools: ["read", "write", "edit"],
        durationMs: 6 * 60 * 1000,
        endedAt: now - 18 * 60 * 1000,
        summary: "Refactored Character.ts to expose explicit state-machine transitions.",
      },
      {
        id: "seed-4",
        agent: "Sub-2",
        agentColor: subagentColor(1),
        tools: ["memory_search", "memory_get"],
        durationMs: 31 * 1000,
        endedAt: now - 32 * 60 * 1000,
        summary: "Recalled Phase-1 architecture decisions from MEMORY.md.",
      },
      {
        id: "seed-5",
        agent: "Flux",
        agentColor: palette.flux,
        tools: ["exec"],
        durationMs: 4 * 1000,
        endedAt: now - 47 * 60 * 1000,
        summary: "Ran git status — clean.",
      },
      {
        id: "seed-6",
        agent: "Sub-3",
        agentColor: subagentColor(2),
        tools: ["image"],
        durationMs: 18 * 1000,
        endedAt: now - 60 * 60 * 1000,
        summary: "Generated 4 procedural sprite previews for Phase 2 review.",
      },
    ];
    _seedForTests(entries);
    onLogReseed?.();
  }

  (window as unknown as { __anchorspaceTestInject: (k: Kind) => void }).__anchorspaceTestInject = (kind) => {
    switch (kind) {
      case "typing":
        start(baseRun.runId, baseRun.sessionKey);
        toolStart(baseRun.runId, baseRun.sessionKey, "exec", "ls -la /Users/invokeautomation/.openclaw");
        break;
      case "reading":
        start(baseRun.runId, baseRun.sessionKey);
        toolStart(baseRun.runId, baseRun.sessionKey, "read", "/Users/invokeautomation/.openclaw/context/CONTEXT.md");
        break;
      case "subagent": {
        const sub = {
          runId: `mock-sub-${subagentRuns.length}`,
          sessionKey: `agent:main:explicit:probe-${subagentRuns.length}`,
        };
        subagentRuns.push(sub);
        start(sub.runId, sub.sessionKey);
        toolStart(sub.runId, sub.sessionKey, "web_search", "OpenClaw gateway documentation");
        break;
      }
      case "long-typing": {
        // Start a Flux run that has been running for 16 minutes.
        const longAgo = Date.now() - 16 * 60 * 1000;
        start(baseRun.runId, baseRun.sessionKey, longAgo);
        toolStart(
          baseRun.runId,
          baseRun.sessionKey,
          "exec",
          "long-running build pipeline",
          undefined,
          longAgo + 2000
        );
        break;
      }
      case "seed-log":
        seedHistoricalLog();
        break;
      case "notebook-open":
        useRoomStore.getState().openNotebook();
        break;
      case "clear":
        lifecycleEnd(baseRun.runId, baseRun.sessionKey);
        for (const s of subagentRuns) lifecycleEnd(s.runId, s.sessionKey);
        subagentRuns.length = 0;
        break;
    }
  };
}
