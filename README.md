# AnchorSpace

A warm lo-fi streamer-bedroom web app where Flux and sub-agents are visible
animated characters. Reads from the OpenClaw Gateway over WebSocket and
renders agent activity as ambient room state — chat built in.

> Status: **v0.1 — Phase 0 scaffold (initial commit).**
> Stack: Vite + React + TypeScript + Canvas 2D.
> Inspired by the [pixel-agents](https://github.com/pablodelucca/pixel-agents)
> concept; built clean from scratch for the browser.

---

## Architecture (Path 1: Vite-embedded gateway proxy)

```
Browser  ──ws──▶  Vite-embedded proxy  ──authenticated ws──▶  OpenClaw Gateway
(no auth)        (loopback only)                              ws://127.0.0.1:18789
```

- **Browser** opens `ws://localhost:4242/events`. No auth, no challenge handshake.
- **Vite plugin (`vite-plugins/gatewayProxy.ts`)** reads the gateway token from
  `~/.openclaw/openclaw.json` (`gateway.auth.token`), holds the authenticated
  upstream WS to the gateway, and exposes a no-auth downstream WS to the browser.
  Loopback-bind only (`host: '127.0.0.1'`), no external exposure.
- **Token never reaches the browser.** This is the whole reason for the proxy.
- On token-file-not-found or upstream auth failure: log clearly, keep the
  downstream WS open, emit a synthetic `{event: "proxy:disconnected"}` so the
  room renders an amber-LED state instead of crashing.

`npm run dev` starts both the web server and the proxy in one process.

---

## Verified gateway event protocol (probed 2026-04-26)

The proxy connects to the gateway on `ws://127.0.0.1:18789` (loopback only)
and performs the challenge/response handshake:

1. Open WS → server immediately sends `connect.challenge` event with a `nonce`.
2. Client sends a `req` with method `connect`, including:
   - `auth.token` (from `~/.openclaw/openclaw.json` → `gateway.auth.token`)
   - `client.{ id, version, platform, mode, instanceId }`
   - `role: "operator"`
   - `scopes: ["operator.admin", "operator.read", "operator.write"]`
   - `caps: ["tool-events"]`  ← required to receive agent tool stream
   - `minProtocol: 3, maxProtocol: 3`
3. Server replies with `hello-ok` (incl. `connId`, available methods).

Subscription is implicit — connecting with `caps: ["tool-events"]` IS the
subscription. No separate `events.subscribe` RPC needed.

### Wire envelope

```ts
interface GatewayEnvelope {
  type: "event";
  event: "agent" | "chat" | "health" | "tick";
  payload: {
    stream?: "lifecycle" | "item" | "command_output" | "assistant";
    // ...stream-specific fields below
  };
  seq: number;
  runId?: string;
  sessionKey?: string;
}
```

### Streams observed during a real agent run

| `event` | `payload.stream` | When | Useful fields |
|---|---|---|---|
| `agent` | `lifecycle` | run start / end | `phase: "start"\|"end"`, `runId`, `sessionKey`, timestamps |
| `agent` | `item` (kind=`tool`) | tool call boundary | `itemId`, `name` (e.g. `exec`, `read`, `process`), `toolCallId`, `title`, `meta`, `status`, `phase: "start"\|"update"\|"end"` |
| `agent` | `item` (kind=`command`) | shell command boundary | same as tool, plus `progressText` on update |
| `agent` | `command_output` | streaming stdout/stderr | `output` (delta or full), `phase: "delta"\|"end"`, on end: `exitCode`, `durationMs`, `cwd`, `summary` |
| `agent` | `assistant` | LLM token deltas | `text` (cumulative), `delta` (just-added) |
| `chat` | — | message-state mirror | `state: "delta"\|"final"`, `message.role`, `message.content[]` |
| `health` | — | periodic snapshot | full health dump |
| `tick` | — | keepalive | just `ts` |

For character animation, the relevant streams are **`agent.item`**
(`kind` + `name` → animation state) and **`agent.command_output`** (live
progress text). Group by `runId` + `sessionKey` so concurrent runs animate
on separate characters.

---

## Roadmap

- [x] **Phase 0** — workspace scaffold, repo creation, initial commit (this commit)
- [ ] **Phase 1** — Vite gateway-proxy plugin + browser GatewayClient + AgentStateParser
- [ ] **Phase 2** — Canvas 2D room renderer; Flux character; ambient state
- [ ] **Phase 3** — Sub-agent characters; concurrent-run animation
- [ ] **Phase 4** — Embedded chat panel
- [ ] **Phase 5** — Polish, sounds, lo-fi vibe pass

Phase boundaries are reviewed and greenlit individually — no phase-jumping.

---

## Local dev

```bash
npm install
npm run dev      # starts Vite + embedded gateway proxy (Phase 1)
```

OpenClaw gateway must be running locally on `ws://127.0.0.1:18789`
(default for local installs).

## Repo

`Flux001Project/AnchorSpace` · MIT
