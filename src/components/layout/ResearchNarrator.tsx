import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";

/**
 * The loading narrator. While a research run is in flight, this overlays an
 * attractive, concise status strip above whatever skeletons a page is showing,
 * narrating the REAL pipeline (stages + live detail from `currentRun`) plus a
 * grounded ETA derived from the previous run's duration. No fake copy - every
 * number comes from the store. It auto-hides shortly after a run completes.
 */

const DEFAULT_RUN_MS = 9_000; // fallback ETA before we have a measured run

function useElapsed(active: boolean, startedAt?: string): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) {
      setElapsed(0);
      return;
    }
    const start = Date.parse(startedAt);
    const tick = () => setElapsed(Math.max(0, Date.now() - start));
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  return elapsed;
}

export function ResearchNarrator() {
  const status = useAppStore((s) => s.researchStatus);
  const currentRun = useAppStore((s) => s.currentRun);
  const lastRun = useAppStore((s) => s.lastRun);
  // The Algorithm story (/core) pins its own fixed scanning strip (AlgoRunStrip);
  // the in-flow narrator would scroll away and reflow the pinned scenes.
  const onCore = useLocation().pathname.startsWith("/core");

  const running = status === "running";
  const errored = status === "error";
  // Keep the strip mounted briefly after completion so the closing beat reads.
  const [visible, setVisible] = useState(running);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    if (running) {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      setVisible(true);
    } else if (visible) {
      hideTimer.current = window.setTimeout(() => setVisible(false), errored ? 3200 : 1800);
    }
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const run = running ? currentRun : currentRun ?? lastRun;
  const elapsed = useElapsed(running, run?.startedAt);

  if (onCore || !visible || !run) return null;

  const stages = run.stages ?? [];
  const doneCount = stages.filter((s) => s.status === "done").length;
  const active = stages.find((s) => s.status === "running");
  const total = stages.length || 1;

  // Progress: blend stage completion with a soft within-stage estimate so the
  // bar always moves. ETA anchors on the last measured run when we have one.
  const typicalMs = lastRun?.durationMs && lastRun.durationMs > 0 ? lastRun.durationMs : DEFAULT_RUN_MS;
  const stageFraction = doneCount / total;
  const timeFraction = running ? Math.min(0.97, elapsed / typicalMs) : 1;
  const progress = running ? Math.min(0.97, Math.max(stageFraction, timeFraction * 0.92)) : 1;
  const remainingMs = running ? Math.max(0, typicalMs - elapsed) : 0;
  const etaLabel = errored
    ? "retry"
    : !running || progress >= 0.96
      ? "wrapping up…"
      : remainingMs > 1500
        ? `~${Math.ceil(remainingMs / 1000)}s left`
        : "a few seconds left";

  const headline = running
    ? active?.label ?? "Researching the market"
    : errored
      ? "Research paused"
      : "Research complete";
  const detail = running
    ? active?.detail ??
      (run.universeSize > 0 ? `${run.universeSize} candidates in the universe` : "Spinning up agents…")
    : errored
      ? "Couldn't reach the data source — check your API key, then run again."
      : `${run.signalsGenerated} signals scored${
          run.durationMs ? ` in ${(run.durationMs / 1000).toFixed(1)}s` : ""
        }`;
  const tone = running ? "is-running" : errored ? "is-error" : "is-complete";

  return (
    <div
      className={`research-narrator ${tone}`}
      role="status"
      aria-live="polite"
    >
      <div className="research-narrator__glyph" aria-hidden="true">
        <span className="research-narrator__pulse" />
      </div>

      <div className="research-narrator__body">
        <div className="research-narrator__head">
          <span className="research-narrator__title">{headline}</span>
          <span className="research-narrator__eta mono">{etaLabel}</span>
        </div>
        <div className="research-narrator__detail">{detail}</div>

        <div className="research-narrator__track">
          <span
            className="research-narrator__fill"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>

        <div className="research-narrator__stages" aria-hidden="true">
          {stages.map((s) => (
            <span
              key={s.key}
              className={`research-narrator__step research-narrator__step--${s.status}`}
              title={s.label}
            />
          ))}
          <span className="research-narrator__count mono">
            {Math.min(doneCount + (active ? 1 : 0), total)}/{total}
          </span>
        </div>
      </div>
    </div>
  );
}
