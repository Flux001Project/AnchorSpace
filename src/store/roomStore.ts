/**
 * Room store — single source of truth for the AnchorSpace UI.
 *
 * Wires the GatewayClient → AgentStateParser → React via Zustand.
 *
 * Phase 1 only: connection lifecycle + parsed run state + last raw event
 * count for diagnostics. Phase 2 will hook the renderer to `runs` and
 * `proxyConnected`.
 */

import { create } from "zustand";
import { GatewayClient } from "../lib/GatewayClient";
import { AgentStateParser, type AgentRuns, type ProxyStatus } from "../lib/AgentStateParser";
import type { GatewayEnvelope } from "../lib/types";
import { installTestInjector } from "./testInjector";

interface RoomState {
  // Connection state.
  socketStatus: "idle" | "connecting" | "open" | "closed";
  proxy: ProxyStatus;

  // Parsed agent state.
  runs: AgentRuns;

  // Diagnostics (handy for the corner LED / phase-1 smoke test).
  eventCount: number;
  lastEvent?: GatewayEnvelope;

  // Lifecycle.
  start: () => void;
  stop: () => void;
}

let client: GatewayClient | null = null;
let parser: AgentStateParser | null = null;
let unsubParser: (() => void) | null = null;
let unsubClient: (() => void) | null = null;

export const useRoomStore = create<RoomState>((set) => ({
  socketStatus: "idle",
  proxy: { connected: false, changedAt: Date.now() },
  runs: new Map(),
  eventCount: 0,

  start() {
    if (client) return;

    parser = new AgentStateParser();
    unsubParser = parser.on((snap) => {
      set({ runs: snap.runs, proxy: snap.proxy });
    });

    client = new GatewayClient({
      onStatus: (s) => set({ socketStatus: s }),
    });
    unsubClient = client.on((env) => {
      set((state) => ({ eventCount: state.eventCount + 1, lastEvent: env }));
      parser?.ingest(env);
    });
    client.connect();

    // Test-only deterministic injector for the screenshot harness. Only
    // installs when ?mock=1 is in the URL so production builds are clean.
    if (typeof window !== "undefined") {
      installTestInjector(parser);
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
    set({ socketStatus: "idle" });
  },
}));

// Re-export for use in App.tsx.
export type { AgentRuns, ProxyStatus };
