import { useEffect } from "react";
import { useRoomStore } from "./store/roomStore";

/**
 * Phase 1 smoke surface. The real lo-fi room renders in Phase 2; for now
 * we expose enough state to confirm the proxy → client → parser pipeline
 * is alive: socket status, proxy LED, event count, parsed run cards.
 */
export default function App() {
  const start = useRoomStore((s) => s.start);
  const stop = useRoomStore((s) => s.stop);
  const socketStatus = useRoomStore((s) => s.socketStatus);
  const proxy = useRoomStore((s) => s.proxy);
  const runs = useRoomStore((s) => s.runs);
  const eventCount = useRoomStore((s) => s.eventCount);

  useEffect(() => {
    start();
    return () => stop();
  }, [start, stop]);

  const ledColor = proxy.connected
    ? "bg-emerald-400 shadow-emerald-400/60"
    : "bg-room-amber shadow-room-amber/60";

  return (
    <div className="min-h-screen p-8 max-w-6xl mx-auto">
      <header className="flex items-center gap-4 mb-8">
        <span
          className={`inline-block w-3 h-3 rounded-full ${ledColor} shadow-[0_0_12px_currentColor]`}
          title={proxy.connected ? "upstream gateway connected" : (proxy.lastReason ?? "disconnected")}
        />
        <h1 className="text-xl font-medium tracking-wide">AnchorSpace</h1>
        <span className="text-xs opacity-50 ml-auto font-mono">
          phase 1 · socket={socketStatus} · proxy={proxy.connected ? "up" : "down"} · events={eventCount}
        </span>
      </header>

      {!proxy.connected && (
        <div className="border border-room-amber/40 bg-room-amber/5 text-room-warm p-4 rounded mb-6 text-sm font-mono">
          upstream gateway disconnected
          {proxy.lastReason && <> · reason: {proxy.lastReason}</>}
        </div>
      )}

      <section>
        <h2 className="text-sm uppercase tracking-widest opacity-60 mb-3">
          Active runs ({runs.size})
        </h2>
        {runs.size === 0 ? (
          <p className="text-sm opacity-50 font-mono">
            No agent runs observed yet. Trigger one with{" "}
            <code className="bg-white/5 px-1.5 py-0.5 rounded">openclaw agent -m "list /tmp"</code>.
          </p>
        ) : (
          <ul className="space-y-3">
            {[...runs.values()].map((r) => (
              <li
                key={r.key}
                className="border border-white/10 rounded p-4 bg-white/[0.02] font-mono text-sm"
              >
                <div className="flex justify-between items-baseline mb-2">
                  <span className="opacity-60">{r.sessionKey}</span>
                  <span className="text-room-warm uppercase text-xs tracking-wider">
                    {r.activity}
                    {r.endedAt ? " · done" : ""}
                  </span>
                </div>
                {r.openTools.length > 0 && (
                  <div className="opacity-70 mb-1 text-xs">
                    tools: {r.openTools.map((t) => t.name).join(" · ")}
                  </div>
                )}
                {r.lastOutput && (
                  <pre className="text-xs opacity-50 truncate">› {r.lastOutput}</pre>
                )}
                {r.assistantText && (
                  <div className="text-xs opacity-70 mt-2 line-clamp-3 whitespace-pre-wrap">
                    {r.assistantText.slice(0, 240)}
                    {r.assistantText.length > 240 ? "…" : ""}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
