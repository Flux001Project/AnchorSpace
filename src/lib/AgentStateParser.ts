/**
 * Folds raw gateway envelopes into a per-agent animation state.
 *
 * Each concurrent run gets its own slot keyed by `runId + sessionKey` so
 * the room can render multiple characters acting at once. Tool names map
 * to a coarse "activity" label that the room renderer turns into an
 * animation (typing-on-laptop, reading-book, on-the-phone, etc.).
 *
 * Tool names are based on the actual probe of OpenClaw 2026.4.15:
 *   exec, read, write, edit, process, web_search, web_fetch, image,
 *   memory_search, memory_get, sessions_*, cron, image, ...
 * We map known names; unknown names fall through to the generic
 * "thinking" activity so we don't crash on stack growth.
 */

import type {
  AgentAssistantPayload,
  AgentCommandOutputPayload,
  AgentEventPayload,
  AgentItemPayload,
  AgentLifecyclePayload,
  GatewayEnvelope,
  ProxyDisconnectedPayload,
  ProxyReconnectedPayload,
} from "./types";

export type Activity =
  | "idle"
  | "thinking"
  | "typing"      // assistant token stream
  | "running"    // exec / command running
  | "reading"    // read / web_fetch / memory_get
  | "writing"    // write / edit
  | "searching"  // web_search / memory_search
  | "managing"   // process / cron / sessions_*
  | "imagining"; // image

export interface AgentRunState {
  /** Composite key: `${runId}::${sessionKey}`. */
  key: string;
  runId: string;
  sessionKey: string;
  /** Coarse current activity for the renderer. */
  activity: Activity;
  /** Last assistant text (may be partial). */
  assistantText: string;
  /** Stack of currently-open tool items (ordered by start). */
  openTools: Array<{
    itemId: string;
    name: string;
    activity: Activity;
    title?: string;
    progressText?: string;
    startedAt: number;
  }>;
  /** Most recent stdout/stderr line for the renderer's "screen" prop. */
  lastOutput?: string;
  /** Run started at (ms since epoch). */
  startedAt: number;
  /** Run ended at (ms since epoch). undefined while live. */
  endedAt?: number;
}

/** Map of composite key → run state. */
export type AgentRuns = ReadonlyMap<string, AgentRunState>;

export interface ProxyStatus {
  connected: boolean;
  /** Reason last given by proxy:disconnected, if any. */
  lastReason?: string;
  /** Last status change ts. */
  changedAt: number;
}

export interface ParsedSnapshot {
  runs: AgentRuns;
  proxy: ProxyStatus;
}

// ── Tool name → activity mapping ─────────────────────────────────────────────

const TOOL_TO_ACTIVITY: Readonly<Record<string, Activity>> = {
  exec: "running",
  process: "managing",
  read: "reading",
  write: "writing",
  edit: "writing",
  web_search: "searching",
  web_fetch: "reading",
  memory_search: "searching",
  memory_get: "reading",
  image: "imagining",
  cron: "managing",
  sessions_list: "managing",
  sessions_history: "managing",
  sessions_send: "managing",
  sessions_spawn: "managing",
  sessions_yield: "managing",
  subagents: "managing",
  session_status: "managing",
};

function toolToActivity(name: string | undefined): Activity {
  if (!name) return "thinking";
  return TOOL_TO_ACTIVITY[name] ?? "thinking";
}

function compositeKey(runId: string, sessionKey: string): string {
  return `${runId}::${sessionKey}`;
}

// ── Parser ───────────────────────────────────────────────────────────────────

export class AgentStateParser {
  private runs = new Map<string, AgentRunState>();
  private proxy: ProxyStatus = { connected: false, changedAt: Date.now() };
  private listeners = new Set<(snap: ParsedSnapshot) => void>();
  /** Cap on completed runs we keep in the map for tail-rendering. */
  private maxKeptCompleted = 16;

  snapshot(): ParsedSnapshot {
    return { runs: new Map(this.runs), proxy: { ...this.proxy } };
  }

  on(listener: (snap: ParsedSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Feed a raw envelope. Returns true if state changed. */
  ingest(env: GatewayEnvelope): boolean {
    let changed = false;

    switch (env.event) {
      case "proxy:disconnected": {
        const p = env.payload as unknown as ProxyDisconnectedPayload;
        this.proxy = { connected: false, lastReason: p?.reason, changedAt: Date.now() };
        changed = true;
        break;
      }
      case "proxy:reconnected":
      case "proxy:starting": {
        const p = env.payload as unknown as ProxyReconnectedPayload;
        this.proxy = { connected: true, changedAt: p?.ts ?? Date.now() };
        changed = true;
        break;
      }
      case "agent": {
        changed = this.ingestAgent(env) || changed;
        break;
      }
      case "tick":
      case "health":
      case "chat":
        // Phase 1: pass-through, no state change. (Chat panel attaches in Phase 4.)
        break;
    }

    if (changed) this.emit();
    return changed;
  }

  /** Listener tuple for prune sweeps. */
  private maybePrune() {
    if (this.runs.size <= this.maxKeptCompleted) return;
    // Drop oldest completed runs first.
    const completed = [...this.runs.values()]
      .filter((r) => r.endedAt !== undefined)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (this.runs.size > this.maxKeptCompleted && completed.length > 0) {
      const oldest = completed.shift();
      if (oldest) this.runs.delete(oldest.key);
    }
  }

  private emit() {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch (err) {
        console.error("[AgentStateParser] listener threw:", err);
      }
    }
  }

  private ingestAgent(env: GatewayEnvelope): boolean {
    const payload = env.payload as unknown as AgentEventPayload;
    if (!payload || typeof payload !== "object" || !("stream" in payload)) return false;

    const runId = (env.runId as string | undefined) ?? (payload as { runId?: string }).runId;
    const sessionKey =
      (env.sessionKey as string | undefined) ?? (payload as { sessionKey?: string }).sessionKey;
    if (!runId || !sessionKey) return false;

    const key = compositeKey(runId, sessionKey);
    const now = Date.now();
    let run = this.runs.get(key);
    if (!run) {
      run = {
        key,
        runId,
        sessionKey,
        activity: "thinking",
        assistantText: "",
        openTools: [],
        startedAt: now,
      };
      this.runs.set(key, run);
    }

    switch (payload.stream) {
      case "lifecycle":
        return this.applyLifecycle(run, payload);
      case "item":
        return this.applyItem(run, payload);
      case "command_output":
        return this.applyCommandOutput(run, payload);
      case "assistant":
        return this.applyAssistant(run, payload);
      default:
        return false;
    }
  }

  private applyLifecycle(run: AgentRunState, p: AgentLifecyclePayload): boolean {
    if (p.phase === "start") {
      run.startedAt = p.startedAt ?? Date.now();
      run.endedAt = undefined;
      run.activity = "thinking";
      run.openTools = [];
      run.assistantText = "";
      run.lastOutput = undefined;
      return true;
    }
    if (p.phase === "end") {
      run.endedAt = p.endedAt ?? Date.now();
      run.activity = "idle";
      run.openTools = [];
      this.maybePrune();
      return true;
    }
    return false;
  }

  private applyItem(run: AgentRunState, p: AgentItemPayload): boolean {
    const { itemId, phase, name, title, kind } = p.data;
    // Only react to "tool" items. "command" items are duplicates of the
    // exec call already covered by name="exec".
    if (kind !== "tool") return false;
    const activity = toolToActivity(name);

    if (phase === "start") {
      run.openTools.push({
        itemId,
        name,
        activity,
        title,
        startedAt: p.data.startedAt ?? Date.now(),
      });
      run.activity = activity;
      return true;
    }
    if (phase === "update") {
      const t = run.openTools.find((x) => x.itemId === itemId);
      if (t && p.data.progressText) t.progressText = p.data.progressText;
      return true;
    }
    if (phase === "end") {
      run.openTools = run.openTools.filter((x) => x.itemId !== itemId);
      run.activity = run.openTools.length > 0
        ? run.openTools[run.openTools.length - 1].activity
        : "thinking";
      return true;
    }
    return false;
  }

  private applyCommandOutput(run: AgentRunState, p: AgentCommandOutputPayload): boolean {
    if (typeof p.data.output !== "string") return false;
    // Take last non-empty line for the "screen" prop.
    const lines = p.data.output.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) run.lastOutput = lines[lines.length - 1].slice(0, 240);
    return true;
  }

  private applyAssistant(run: AgentRunState, p: AgentAssistantPayload): boolean {
    if (typeof p.data.text === "string") run.assistantText = p.data.text;
    // Only flip to "typing" if no tool is open — tool activity wins.
    if (run.openTools.length === 0) run.activity = "typing";
    return true;
  }
}
