/**
 * NotebookOverlay — opens when Flux's desk notebook is clicked.
 *
 * Diegetic styling: cream page background (#E8D5B7) with horizontal ruled
 * lines, dark serif body text, gold accents for chapter dividers. Closes
 * on Escape (handled in Room.tsx) or click on the dim backdrop outside
 * the page.
 *
 * Renders the most recent 50 completed runs from localStorage. Newest
 * at top.
 */

import { useRoomStore } from "../store/roomStore";
import { formatDuration } from "../log/activityLog";
import { palette } from "./palette";

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${dateStr} · ${time}`;
}

export default function NotebookOverlay() {
  const open = useRoomStore((s) => s.notebookOpen);
  const close = useRoomStore((s) => s.closeNotebook);
  const entries = useRoomStore((s) => s.logEntries);

  if (!open) return null;

  return (
    <div
      data-testid="notebook-overlay"
      onClick={close}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        animation: "anchor-fade-in 180ms ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: palette.textChrome,
          color: "#3D2314",
          width: "min(700px, 92vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: "32px 40px",
          borderRadius: 4,
          fontFamily: "Georgia, 'Times New Roman', serif",
          // Diegetic page lines — horizontal ruled paper feel, ~26px gutters.
          backgroundImage: `repeating-linear-gradient(
            to bottom,
            transparent 0,
            transparent 25px,
            rgba(139, 105, 20, 0.18) 25px,
            rgba(139, 105, 20, 0.18) 26px
          )`,
          boxShadow: "0 30px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(139, 105, 20, 0.4)",
        }}
      >
        <header
          style={{
            borderBottom: `2px solid ${palette.accent}`,
            paddingBottom: 12,
            marginBottom: 20,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "0.02em" }}>
              Anchor Log
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, opacity: 0.7, fontStyle: "italic" }}>
              {entries.length === 0
                ? "No completed runs yet."
                : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · newest first`}
            </p>
          </div>
          <button
            onClick={close}
            style={{
              background: "transparent",
              border: `1px solid ${palette.accent}`,
              color: palette.accent,
              fontFamily: "inherit",
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 3,
              cursor: "pointer",
            }}
          >
            close · esc
          </button>
        </header>

        {entries.length === 0 ? (
          <p style={{ fontStyle: "italic", opacity: 0.6, marginTop: 32 }}>
            The notebook will fill in as agents complete their runs.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {entries.map((e) => (
              <li
                key={e.id}
                style={{
                  padding: "12px 0",
                  borderBottom: "1px dashed rgba(61, 35, 20, 0.18)",
                }}
                data-testid="notebook-entry"
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: 12,
                    marginBottom: 4,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 9,
                        height: 9,
                        borderRadius: "50%",
                        background: e.agentColor,
                        marginRight: 4,
                      }}
                    />
                    <strong style={{ fontSize: 15, letterSpacing: "0.01em" }}>{e.agent}</strong>
                    <span style={{ fontSize: 12, opacity: 0.7 }}>
                      {e.tools.length > 0 ? e.tools.join(" · ") : "—"}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" }}>
                    {formatDuration(e.durationMs)} · {formatTimestamp(e.endedAt)}
                  </div>
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    lineHeight: 1.45,
                    fontStyle: "italic",
                    color: "#3D2314",
                  }}
                >
                  {e.summary}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <style>{`@keyframes anchor-fade-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
    </div>
  );
}
