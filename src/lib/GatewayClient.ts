/**
 * Browser-side client for the AnchorSpace gateway proxy.
 *
 * Connects to the Vite-embedded proxy on ws://localhost:4242/events.
 * No auth, no challenge handshake — the proxy already did all of that
 * upstream against the real OpenClaw gateway.
 *
 * Reconnects with exponential backoff. Forwards every parsed envelope
 * to subscribers. On parse failure, emits the raw frame so the parser
 * layer can decide what to do.
 */

import type { GatewayEnvelope } from "./types";

type Listener = (env: GatewayEnvelope) => void;

export interface GatewayClientOptions {
  /** Defaults to ws://localhost:4242/events. */
  url?: string;
  /** Cap on backoff in ms. Default 15000. */
  maxBackoffMs?: number;
  /** Hook for connection-state changes (for amber-LED UI etc). */
  onStatus?: (status: "connecting" | "open" | "closed") => void;
}

export class GatewayClient {
  private readonly url: string;
  private readonly maxBackoffMs: number;
  private readonly onStatus?: (s: "connecting" | "open" | "closed") => void;
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private closed = false;

  constructor(opts: GatewayClientOptions = {}) {
    this.url = opts.url ?? "ws://localhost:4242/events";
    this.maxBackoffMs = opts.maxBackoffMs ?? 15000;
    this.onStatus = opts.onStatus;
  }

  /** Open the connection. Idempotent: calling again is a no-op while open. */
  connect(): void {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.onStatus?.("connecting");

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.onStatus?.("open");
    };

    ws.onmessage = (e) => {
      const raw = typeof e.data === "string" ? e.data : "";
      if (!raw) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      // Cheap shape check — anything that is `{type:"event", event:string}`.
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { type?: unknown }).type === "event" &&
        typeof (parsed as { event?: unknown }).event === "string"
      ) {
        this.dispatch(parsed as GatewayEnvelope);
      }
    };

    ws.onclose = () => {
      this.ws = null;
      this.onStatus?.("closed");
      if (!this.closed) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Browser WS error events have no useful detail — let onclose handle it.
    };
  }

  /** Permanently close. Disconnects and stops reconnect attempts. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** Subscribe to envelopes. Returns an unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── internal ───────────────────────────────────────────────────────────────

  private dispatch(env: GatewayEnvelope) {
    for (const fn of this.listeners) {
      try {
        fn(env);
      } catch (err) {
        console.error("[GatewayClient] listener threw:", err);
      }
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer !== null) return;
    const base = Math.min(this.maxBackoffMs, 1000 * 2 ** Math.min(this.reconnectAttempt, 4));
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(base * jitter);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
