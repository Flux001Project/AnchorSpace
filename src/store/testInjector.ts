/**
 * Test-only deterministic injector for the screenshot harness.
 *
 * Only installs when `?mock=1` is in the URL. Exposes
 * `window.__anchorspaceTestInject(kind)` so puppeteer scripts can drive the
 * room into a known state without flying a real agent run.
 *
 * This is a screenshot/debug aid. It does NOT replace the real event stream;
 * synthetic envelopes are pushed straight into the parser alongside live ones.
 */

import type { AgentStateParser } from "../lib/AgentStateParser";
import type { GatewayEnvelope } from "../lib/types";
import { useRoomStore } from "./roomStore";

/** Holds the latest parser pointer; refreshed every start() (StrictMode
 *  remounts call start/stop/start in dev, swapping the parser). */
let currentParser: AgentStateParser | null = null;
let installed = false;

export function installTestInjector(parser: AgentStateParser) {
  // Always update the parser pointer — StrictMode in dev calls start/stop/start.
  currentParser = parser;
  if (installed) return;
  if (!new URLSearchParams(window.location.search).has("mock")) return;
  installed = true;
  // Expose store getter so puppeteer can introspect.
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

  function start(runId: string, sessionKey: string) {
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
          startedAt: Date.now(),
        } as unknown as Record<string, unknown>,
      })
    );
  }

  function toolStart(runId: string, sessionKey: string, name: string, title?: string, itemId?: string) {
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
            startedAt: Date.now(),
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

  // Mark proxy as connected so the LED is green in screenshots.
  ingest(
    synth({
      event: "proxy:reconnected",
      payload: { ts: Date.now() } as unknown as Record<string, unknown>,
    })
  );

  type Kind = "typing" | "reading" | "subagent" | "clear";

  const subagentRuns: Array<{ runId: string; sessionKey: string }> = [];

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
        toolStart(sub.runId, sub.sessionKey, "web_search", "openclaw gateway documentation");
        break;
      }
      case "clear":
        lifecycleEnd(baseRun.runId, baseRun.sessionKey);
        for (const s of subagentRuns) lifecycleEnd(s.runId, s.sessionKey);
        subagentRuns.length = 0;
        break;
    }
  };
}
