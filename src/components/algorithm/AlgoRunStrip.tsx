import { useEffect, useState } from "react";
import { STAGE_KEYS } from "@/viz/pipelineModel";
import type { StoryData } from "@/components/algorithm/useStoryData";

/**
 * The live scanning strip - pinned across the top of the Algorithm story while a
 * research run is in flight. It mirrors the REAL pipeline (`currentRun` stages +
 * their live detail), so the instant you press "Run it live" you can see the
 * discovery/research actually happening, and it stays put as the guided tour
 * glides through the chapters below. Auto-hides shortly after the run lands.
 *
 * On /core this replaces the in-flow ResearchNarrator (which would scroll away
 * and reflow the pinned scenes); every number still comes straight from the
 * store - no invented copy.
 */

/** Fallback ETA before we have a measured run, mirrors ResearchNarrator. */
const DEFAULT_RUN_MS = 9_000;

function useElapsedMs(active: boolean, startedAt?: string): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) {
      setMs(0);
      return;
    }
    const start = Date.parse(startedAt);
    const tick = () => setMs(Math.max(0, Date.now() - start));
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  return ms;
}

export function AlgoRunStrip({ data }: { data: StoryData }) {
  const running = data.isRunning;
  const errored = data.researchStatus === "error";
  const run = data.currentRun;

  // Keep the strip mounted briefly after the run settles so the closing beat
  // reads; an error lingers a little longer so the recovery hint is catchable.
  const [visible, setVisible] = useState(running);
  useEffect(() => {
    if (running) {
      setVisible(true);
      return;
    }
    if (!visible) return;
    const t = window.setTimeout(() => setVisible(false), errored ? 3600 : 1800);
    return () => window.clearTimeout(t);
  }, [running, errored, visible]);

  const elapsed = useElapsedMs(running, run?.startedAt);

  if (!visible || !run) return null;

  const stages = run.stages ?? [];
  const total = stages.length || STAGE_KEYS.length;
  const doneCount = stages.filter((s) => s.status === "done").length;
  const active = stages.find((s) => s.status === "running");

  // Bar blends stage completion with a soft time estimate so it always moves;
  // on error it freezes at whatever the pipeline reached.
  const stageFraction = doneCount / total;
  const timeFraction = running ? Math.min(0.95, elapsed / DEFAULT_RUN_MS) : 1;
  const progress = errored
    ? Math.max(0.06, stageFraction)
    : running
      ? Math.max(0.06, Math.max(stageFraction, timeFraction * 0.9))
      : 1;

  const tone = running ? "is-running" : errored ? "is-error" : "is-done";
  const label = running
    ? active?.label ?? "Scanning the market"
    : errored
      ? "Research paused"
      : `Research complete — ${run.signalsGenerated} signals scored`;
  const detail = running
    ? active?.detail ??
      (run.universeSize > 0
        ? `${run.universeSize} candidates in the universe`
        : "spinning up the research agent…")
    : errored
      ? "couldn’t reach the data source — check your API key, then run again"
      : "ranked into the live leaderboard below";

  return (
    <div className={`algo-runstrip ${tone}`} role="status" aria-live="polite">
      <span className="algo-runstrip__live">
        <span className="algo-runstrip__dot" />
        {running ? "LIVE" : errored ? "RETRY" : "DONE"}
      </span>

      <div className="algo-runstrip__main">
        <div className="algo-runstrip__head">
          <span className="algo-runstrip__label">{label}</span>
          <span className="algo-runstrip__detail mono">{detail}</span>
        </div>
        <div className="algo-runstrip__track">
          <span
            className="algo-runstrip__fill"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
          {running ? <span className="algo-runstrip__scan" aria-hidden="true" /> : null}
        </div>
      </div>

      <div className="algo-runstrip__pips" aria-hidden="true">
        {stages.map((s) => (
          <span
            key={s.key}
            className={`algo-runstrip__pip algo-runstrip__pip--${s.status}`}
            title={s.label}
          />
        ))}
        <span className="algo-runstrip__count mono">
          {Math.min(doneCount + (active ? 1 : 0), total)}/{total}
        </span>
      </div>
    </div>
  );
}
