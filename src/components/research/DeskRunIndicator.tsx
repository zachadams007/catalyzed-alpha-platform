import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useResearchDeskStore } from "@/store/useResearchDeskStore";
import { IconSparkle } from "@/components/icons";
import "@/styles/desk-run-indicator.css";

/** mm:ss from ms. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A small floating pill that shows a Research Desk run is STILL RUNNING while you're on another
 * tab - with a live timer counting from the run's real start (so it never resets). Click it to
 * jump back to the desk. Hidden on the desk itself (the desk shows its own progress) and when
 * nothing is in flight.
 */
export function DeskRunIndicator() {
  const entries = useResearchDeskStore((s) => s.entries);
  const location = useLocation();
  const navigate = useNavigate();
  const [, tick] = useState(0);

  // Re-render every second to advance the timer.
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, []);

  // The oldest in-flight run (there's usually just one).
  const running = Object.values(entries)
    .filter((e) => e.state === "loading")
    .sort((a, b) => a.startedAt - b.startedAt)[0];

  // Don't show on the desk route (it renders its own progress).
  const onDesk = location.pathname.startsWith("/research");
  if (!running || onDesk) return null;

  const elapsed = Date.now() - running.startedAt;

  return (
    <button
      type="button"
      className="desk-run-indicator"
      onClick={() => navigate(`/research?ticker=${encodeURIComponent(running.ticker)}`)}
      title={`Research still running for ${running.ticker} — click to return to the desk`}
      aria-label={`Research running for ${running.ticker}, ${fmtElapsed(elapsed)} elapsed. Return to the desk.`}
    >
      <span className="desk-run-indicator__glyph" aria-hidden="true">
        <span className="desk-run-indicator__pulse" />
        <IconSparkle size={13} />
      </span>
      <span className="desk-run-indicator__body">
        <span className="desk-run-indicator__label">
          Researching <span className="mono">{running.ticker}</span>
        </span>
        <span className="desk-run-indicator__timer mono">{fmtElapsed(elapsed)}</span>
      </span>
    </button>
  );
}
