// Gateway WS tap. Replicates AnchorSpace's vite gateway-proxy handshake
// (challenge → connect req with auth token), subscribes to tool-events,
// and dumps every envelope plus a per-run summary on close.
//
// Use this to diagnose phantom-run questions: connect, observe what comes
// through during a quiet window, then check which envelopes arrive without
// a lifecycle:start or any tool item.
//
//   node scripts/anchor-tap.mjs                 # default 60s window
//   TAP_DURATION_MS=300000 node scripts/anchor-tap.mjs   # 5 min
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import json5 from "json5";

const cfg = json5.parse(readFileSync(process.env.HOME + "/.openclaw/openclaw.json", "utf8"));
const token = cfg.gateway.auth.token;
const port = cfg.gateway.port ?? 18789;
const url = `ws://127.0.0.1:${port}/`;

const DURATION_MS = Number(process.env.TAP_DURATION_MS ?? 60000);

const ws = new WebSocket(url);
const seen = new Map(); // key → { rid, sk, count, streams, firstEvent, sawLifecycleStart, sawTool }
let pendingId = null;
let helloDone = false;

ws.on("open", () => {
  process.stderr.write(`[tap] connected to ${url}\n`);
});

function summarize(payload) {
  const stream = payload?.stream ?? "(no-stream)";
  if (stream === "item") {
    const phase = payload?.data?.phase ?? "?";
    const kind = payload?.data?.kind ?? "?";
    const name = payload?.data?.name ?? "";
    return `item.${phase}/${kind}/${name}`;
  }
  if (stream === "lifecycle") return `lifecycle.${payload?.phase ?? "?"}`;
  if (stream === "assistant") return `assistant(text=${(payload?.data?.text ?? "").length}b)`;
  if (stream === "command_output") return "cmd_out";
  return stream;
}

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); }
  catch { return; }

  // Handshake.
  if (msg.type === "event" && msg.event === "connect.challenge") {
    pendingId = randomUUID();
    ws.send(JSON.stringify({
      type: "req",
      id: pendingId,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "openclaw-probe",
          version: "anchor-tap-0.1",
          platform: "node",
          mode: "probe",
          instanceId: randomUUID(),
        },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        caps: ["tool-events"],
        auth: { token },
        userAgent: "anchor-tap/0.1",
        locale: "en-US",
      },
    }));
    return;
  }

  if (msg.type === "res" && msg.id === pendingId) {
    if (msg.ok) {
      helloDone = true;
      process.stderr.write("[tap] handshake OK — listening\n");
    } else {
      process.stderr.write(`[tap] handshake FAIL: ${JSON.stringify(msg.error)}\n`);
      ws.close();
    }
    return;
  }

  if (!helloDone) return;

  if (msg.type === "event") {
    const rid = msg.runId ?? msg.payload?.runId ?? null;
    const sk = msg.sessionKey ?? msg.payload?.sessionKey ?? null;
    const ev = msg.event;
    const summary = summarize(msg.payload);

    // Track only `agent`-stream events for the run map (those create runs in parser).
    if (ev === "agent" && rid && sk) {
      const key = `${rid}::${sk}`;
      const rec = seen.get(key) ?? {
        rid, sk, count: 0, streams: new Set(),
        firstEvent: `${ev}/${summary}`,
        firstTs: Date.now(),
        sawLifecycleStart: false,
        sawTool: false,
      };
      rec.count += 1;
      rec.streams.add(summary);
      if (msg.payload?.stream === "lifecycle" && msg.payload?.phase === "start") rec.sawLifecycleStart = true;
      if (msg.payload?.stream === "item" && msg.payload?.data?.kind === "tool") rec.sawTool = true;
      seen.set(key, rec);
    }

    console.log(`[ev] ${ev}/${summary} rid=${rid?.slice?.(0,8) ?? rid} sk=${sk}`);
  }
});

ws.on("error", (err) => {
  process.stderr.write(`[tap] error: ${err.message}\n`);
});

ws.on("close", () => {
  process.stderr.write("[tap] closed\n");
  process.stderr.write("\n=== AGENT-STREAM RUN SUMMARY ===\n");
  for (const [, rec] of seen) {
    const phantom = !rec.sawLifecycleStart || !rec.sawTool;
    process.stderr.write(`${phantom ? "⚠️  PHANTOM" : "✓"} run ${rec.rid?.slice?.(0,8) ?? rec.rid} session=${rec.sk}\n`);
    process.stderr.write(`   events=${rec.count} firstEvent=${rec.firstEvent}\n`);
    process.stderr.write(`   sawLifecycleStart=${rec.sawLifecycleStart} sawTool=${rec.sawTool}\n`);
    process.stderr.write(`   streams=${[...rec.streams].join(", ")}\n`);
  }
  process.exit(0);
});

setTimeout(() => ws.close(), DURATION_MS);
