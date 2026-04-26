/**
 * AnchorSpace ↔ OpenClaw Gateway proxy (Vite plugin).
 *
 * Architecture (Path 1):
 *   Browser ──no-auth ws──▶ this proxy ──authenticated ws──▶ OpenClaw Gateway
 *                          (127.0.0.1:4242)                    (127.0.0.1:18789)
 *
 * The browser never sees the gateway token. The proxy:
 *   1. Reads the token from ~/.openclaw/openclaw.json at startup.
 *   2. Opens an authenticated upstream WS to the gateway, performing the
 *      challenge/response handshake (connect.challenge → connect req with
 *      caps: ["tool-events"]).
 *   3. Exposes a no-auth downstream WS server on 127.0.0.1:4242 at /events.
 *   4. Forwards every gateway event verbatim to all downstream clients.
 *   5. On token-file-not-found, upstream auth failure, or upstream disconnect:
 *      keep the downstream open and emit a synthetic event so the UI can
 *      render an amber-LED state instead of crashing.
 *      Synthetic events:
 *        { type: "event", event: "proxy:disconnected", payload: { reason } }
 *        { type: "event", event: "proxy:reconnected",  payload: { ts } }
 *
 * Reconnect strategy: exponential backoff (1s → 2s → 4s → 8s → 15s cap),
 * jittered ±20%, until upstream is healthy again.
 */

import type { Plugin, ViteDevServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import JSON5 from "json5";

// ── Types ────────────────────────────────────────────────────────────────────

interface ProxyOptions {
  /** Downstream port for the browser. */
  downstreamPort?: number;
  /** Upstream gateway URL. */
  upstreamUrl?: string;
  /** Path to openclaw.json holding the token. */
  configPath?: string;
}

interface SyntheticEnvelope {
  type: "event";
  event: "proxy:disconnected" | "proxy:reconnected" | "proxy:starting";
  payload: Record<string, unknown>;
  ts: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readGatewayToken(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf8");
    // openclaw.json is JSON5 (line/block comments, trailing commas).
    const cfg = JSON5.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const tok = cfg?.gateway?.auth?.token;
    return typeof tok === "string" && tok.trim().length > 0 ? tok.trim() : null;
  } catch (err) {
    console.error("[gateway-proxy] failed to parse openclaw.json:", err);
    return null;
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)); // 1,2,4,8,15...
  const jitter = 0.8 + Math.random() * 0.4; // ±20%
  return Math.round(base * jitter);
}

function log(...args: unknown[]) {
  console.log("[gateway-proxy]", ...args);
}
function warn(...args: unknown[]) {
  console.warn("[gateway-proxy]", ...args);
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function gatewayProxy(opts: ProxyOptions = {}): Plugin {
  const downstreamPort = opts.downstreamPort ?? 4242;
  const upstreamUrl = opts.upstreamUrl ?? "ws://127.0.0.1:18789";
  const configPath = opts.configPath ?? join(homedir(), ".openclaw", "openclaw.json");

  // Mutable runtime state — scoped to this plugin instance.
  const state = {
    wss: null as WebSocketServer | null,
    upstream: null as WebSocket | null,
    upstreamReady: false,
    reconnectAttempt: 0,
    reconnectTimer: null as NodeJS.Timeout | null,
    closed: false,
    pendingId: null as string | null,
  };

  /** Broadcast a frame (string or object) to all connected browser clients. */
  function broadcast(frame: string | object) {
    if (!state.wss) return;
    const payload = typeof frame === "string" ? frame : JSON.stringify(frame);
    for (const client of state.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (err) {
          warn("downstream send failed:", err);
        }
      }
    }
  }

  function broadcastSynthetic(
    event: SyntheticEnvelope["event"],
    payload: Record<string, unknown> = {}
  ) {
    const env: SyntheticEnvelope = {
      type: "event",
      event,
      payload,
      ts: Date.now(),
    };
    broadcast(env);
  }

  function scheduleReconnect(reason: string) {
    if (state.closed) return;
    state.upstreamReady = false;
    broadcastSynthetic("proxy:disconnected", { reason });
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    const delay = backoffMs(state.reconnectAttempt);
    state.reconnectAttempt += 1;
    log(`reconnect in ${delay}ms (attempt ${state.reconnectAttempt}, reason=${reason})`);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      void connectUpstream();
    }, delay);
  }

  async function connectUpstream() {
    if (state.closed) return;

    const token = readGatewayToken(configPath);
    if (!token) {
      warn(`token not found in ${configPath} — staying in disconnected state`);
      scheduleReconnect("token-file-not-found");
      return;
    }

    log(`connecting upstream → ${upstreamUrl}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(upstreamUrl);
    } catch (err) {
      scheduleReconnect(`upstream-connect-throw: ${(err as Error).message}`);
      return;
    }

    state.upstream = ws;
    state.upstreamReady = false;
    state.pendingId = null;

    let helloDone = false;
    let connectSent = false;

    ws.on("open", () => log("upstream OPEN"));

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return; // skip non-JSON
      }

      const msg = parsed as {
        type?: string;
        event?: string;
        payload?: { nonce?: string };
        id?: string;
        ok?: boolean;
        error?: { code?: string; message?: string };
      };

      // Pre-handshake: handle challenge/response, suppress from downstream.
      if (msg.type === "event" && msg.event === "connect.challenge") {
        const nonce = msg.payload?.nonce;
        if (!nonce) {
          warn("challenge missing nonce");
          ws.close();
          return;
        }
        if (connectSent) return;
        connectSent = true;
        const id = randomUUID();
        state.pendingId = id;
        const connectReq = {
          type: "req",
          id,
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "openclaw-probe",
              version: "anchorspace-proxy-0.1",
              platform: "node",
              mode: "probe",
              instanceId: randomUUID(),
            },
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            caps: ["tool-events"],
            auth: { token },
            userAgent: "anchorspace-gateway-proxy/0.1",
            locale: "en-US",
          },
        };
        ws.send(JSON.stringify(connectReq));
        return;
      }

      // Handshake response.
      if (msg.type === "res" && msg.id === state.pendingId) {
        if (msg.ok) {
          helloDone = true;
          state.upstreamReady = true;
          if (state.reconnectAttempt > 0) {
            log("upstream RECONNECTED");
            broadcastSynthetic("proxy:reconnected", { ts: Date.now() });
          } else {
            log("upstream HELLO ok — ready");
          }
          state.reconnectAttempt = 0;
        } else {
          const reason = `auth-failed: ${msg.error?.code ?? "unknown"} ${msg.error?.message ?? ""}`.trim();
          warn(reason);
          ws.close();
          // scheduleReconnect fires from "close" handler.
        }
        return;
      }

      // Post-handshake: forward everything to browser clients.
      if (helloDone) {
        broadcast(raw.toString());
      }
    });

    ws.on("close", (code, reason) => {
      log(`upstream CLOSE code=${code} reason=${reason?.toString() ?? ""}`);
      state.upstream = null;
      if (!state.closed) scheduleReconnect(`upstream-closed-${code}`);
    });

    ws.on("error", (err) => {
      warn("upstream ERROR:", err.message);
      // close handler will schedule the reconnect.
    });
  }

  function startDownstream() {
    if (state.wss) return;
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: downstreamPort,
      path: "/events",
    });
    state.wss = wss;

    wss.on("listening", () => {
      log(`downstream listening on ws://127.0.0.1:${downstreamPort}/events`);
    });

    wss.on("connection", (sock, req) => {
      const ip = req.socket.remoteAddress ?? "?";
      log(`downstream client connected from ${ip} (${wss.clients.size} total)`);

      // Greet the new client with current proxy state so the UI doesn't sit
      // blank waiting for the next live event.
      const greeting: SyntheticEnvelope = {
        type: "event",
        event: state.upstreamReady ? "proxy:reconnected" : "proxy:disconnected",
        payload: state.upstreamReady
          ? { ts: Date.now(), greeting: true }
          : { reason: "upstream-not-ready", greeting: true },
        ts: Date.now(),
      };
      try {
        sock.send(JSON.stringify(greeting));
      } catch {
        /* ignore */
      }

      sock.on("close", () => {
        log(`downstream client disconnected (${wss.clients.size - 1} remaining)`);
      });
    });

    wss.on("error", (err) => warn("downstream WSS error:", err));
  }

  function shutdown() {
    state.closed = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.upstream) {
      try {
        state.upstream.close();
      } catch {
        /* ignore */
      }
      state.upstream = null;
    }
    if (state.wss) {
      state.wss.close();
      state.wss = null;
    }
  }

  return {
    name: "anchorspace:gateway-proxy",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      log(`starting (downstream=${downstreamPort}, upstream=${upstreamUrl})`);
      startDownstream();
      void connectUpstream();
      server.httpServer?.once("close", shutdown);
    },
  };
}

export default gatewayProxy;
