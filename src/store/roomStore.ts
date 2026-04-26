/**
 * Room store — single source of truth for the AnchorSpace UI.
 *
 * Wires the GatewayClient → AgentStateParser → React via Zustand.
 *
 * Phase 3 additions:
 *   - Stable agent name registry: assigns "Sub-1", "Sub-2", ... in spawn
 *     order; "Flux" reserved for the anchor run.
 *   - End-of-run detection: when a run transitions from live → ended, an
 *     entry is appended to the persisted activity log.
 *   - Notebook overlay open/close state.
 *   - Test seed entry point so the screenshot harness can stage history.
 */

import { create } from "zustand";
import { GatewayClient } from "../lib/GatewayClient";
import { AgentStateParser, type AgentRuns, type AgentRunState, type ProxyStatus } from "../lib/AgentStateParser";
import type { GatewayEnvelope } from "../lib/types";
import { installTestInjector } from "./testInjector";
import {
  appendEntry,
  loadEntries,
  summaryFromText,
  type LogEntry,
} from "../log/activityLog";
import { palette, subagentColor } from "../room/palette";

interface RoomState {
  // Connection state.
  socketStatus: "idle" | "connecting" | "open" | "closed";
  proxy: ProxyStatus;

  // Parsed agent state.
  runs: AgentRuns;

  // Diagnostics.
  eventCount: number;
  lastEvent?: GatewayEnvelope;

  // T-15 notebook.
  logEntries: LogEntry[];
  notebookOpen: boolean;
  openNotebook: () => void;
  closeNotebook: () => void;

  // T-18 stable names.
  /** Composite key (`runId::sessionKey`) → display name. */
  agentNames: Map<string, string>;

  // Lifecycle.
  start: () => void;
  stop: () => void;
}

let client: GatewayClient | null = null;
let parser: AgentStateParser | null = null;
let unsubParser: (() => void) | null = null;
let unsubClient: (() => void) | null = null;

let prevSnapshotRuns: Map<string, AgentRunState> | null = null;
let subagentSpawnCounter = 0;
const nameRegistry = new Map<string, string>();
/** Track which key maps to "Flux" so we don't double-assign. */
let fluxKey: string | null = null;

function assignName(run: AgentRunState): string {
  const cached = nameRegistry.get(run.key);
  if (cached) return cached;
  // Flux = first run we ever see whose sessionKey ends with `:main` (the
  // OpenClaw main session). All others are sub-agents in spawn order.
  const isMainSession = /:main$/.test(run.sessionKey);
  if (isMainSession && fluxKey === null) {
    fluxKey = run.key;
    nameRegistry.set(run.key, "Flux");
    return "Flux";
  }
  subagentSpawnCounter += 1;
  const name = `Sub-${subagentSpawnCounter}`;
  nameRegistry.set(run.key, name);
  return name;
}

function colorFor(run: AgentRunState, name: string, names: Map<string, string>): string {
  if (name === "Flux") return palette.flux;
  // Sub-agent index = position among non-Flux entries in the registry.
  const subagentKeys = [...names.entries()]
    .filter(([, n]) => n !== "Flux")
    .map(([k]) => k);
  const idx = Math.max(0, subagentKeys.indexOf(run.key));
  return subagentColor(idx);
}

function buildEntry(run: AgentRunState, name: string, color: string): LogEntry {
  const tools: string[] = [];
  for (const t of run.openTools) {
    if (!tools.includes(t.name)) tools.push(t.name);
  }
  // The parser drops openTools on phase=end, so by the time we observe the
  // ended run the array may be empty. Best-effort: keep the assistantText
  // and lastOutput fields, which survive.
  return {
    id: run.key,
    agent: name,
    agentColor: color,
    tools,
    durationMs: Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt),
    endedAt: run.endedAt ?? Date.now(),
    summary: summaryFromText(run.assistantText, run.lastOutput),
  };
}

export const useRoomStore = create<RoomState>((set, get) => ({
  socketStatus: "idle",
  proxy: { connected: false, changedAt: Date.now() },
  runs: new Map(),
  eventCount: 0,

  logEntries: typeof window !== "undefined" ? loadEntries() : [],
  notebookOpen: false,
  openNotebook: () => set({ notebookOpen: true }),
  closeNotebook: () => set({ notebookOpen: false }),

  agentNames: new Map(),

  start() {
    if (client) return;

    // Isolation flag: when present, skip the real WS so screenshots are
    // deterministic and don't pick up the host's actual agent activity.
    const isolated = typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("mock") === "isolated";

    parser = new AgentStateParser();
    prevSnapshotRuns = null;
    subagentSpawnCounter = 0;
    fluxKey = null;
    nameRegistry.clear();

    unsubParser = parser.on((snap) => {
      const runs = snap.runs;
      const newNames = new Map(get().agentNames);
      // Assign names for any newly-seen runs.
      for (const run of runs.values()) {
        if (!newNames.has(run.key)) {
          newNames.set(run.key, assignName(run));
        }
      }

      // Detect transitions live → ended; build log entries for each.
      let nextLog: LogEntry[] | null = null;
      if (prevSnapshotRuns) {
        for (const run of runs.values()) {
          if (run.endedAt === undefined) continue;
          const prev = prevSnapshotRuns.get(run.key);
          // Entry created if (a) we'd never seen this run as ended, or
          // (b) prev had no endedAt. Captures both first-end and re-emit.
          if (prev && prev.endedAt !== undefined) continue;
          const name = newNames.get(run.key) ?? "Unknown";
          const color = colorFor(run, name, newNames);
          nextLog = appendEntry(buildEntry(run, name, color));
        }
      }
      prevSnapshotRuns = new Map(runs);

      set({
        runs,
        proxy: snap.proxy,
        agentNames: newNames,
        ...(nextLog ? { logEntries: nextLog } : {}),
      });
    });

    if (!isolated) {
      client = new GatewayClient({
        onStatus: (s) => set({ socketStatus: s }),
      });
      unsubClient = client.on((env) => {
        set((state) => ({ eventCount: state.eventCount + 1, lastEvent: env }));
        parser?.ingest(env);
      });
      client.connect();
    } else {
      // Isolated mode: skip the real WS. Use a no-op stub so the start/stop
      // guards still work (close, on => unsub).
      const stub: GatewayClient = {
        connect: () => {},
        close: () => {},
        on: () => () => {},
      } as unknown as GatewayClient;
      client = stub;
      unsubClient = () => {};
    }

    if (typeof window !== "undefined") {
      installTestInjector(parser, () => set({ logEntries: loadEntries() }));
    }
  },

  stop() {
    unsubClient?.();
    unsubParser?.();
    client?.close();
    client = null;
    parser = null;
    unsubClient = null;
    unsubParser = null;
    prevSnapshotRuns = null;
    set({ socketStatus: "idle" });
  },
}));

// Re-export for use in components.
export type { AgentRuns, ProxyStatus };
