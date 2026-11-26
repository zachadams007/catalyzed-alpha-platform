import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useReducedMotion } from "motion/react";
import { isResearchRunAllowed } from "@/data/providers";
import { useStoryScroll } from "@/viz/useStoryScroll";
import "@/styles/algorithm.css";
import { useStoryData } from "@/components/algorithm/useStoryData";
import { useLiveTour } from "@/components/algorithm/useLiveTour";
import { AmbientCursor } from "@/components/algorithm/AmbientCursor";
import { AlgoRunStrip } from "@/components/algorithm/AlgoRunStrip";
import { ProgressRail } from "@/components/algorithm/ProgressRail";
import { SceneHero } from "@/components/algorithm/scenes/SceneHero";
import { SceneDiscovery } from "@/components/algorithm/scenes/SceneDiscovery";
import { SceneEnrichment } from "@/components/algorithm/scenes/SceneEnrichment";
import { SceneScoring } from "@/components/algorithm/scenes/SceneScoring";
import { SceneRanking } from "@/components/algorithm/scenes/SceneRanking";
import { SceneDivergence } from "@/components/algorithm/scenes/SceneDivergence";
import { SceneResearchDesk } from "@/components/algorithm/scenes/SceneResearchDesk";
import { FinePrint } from "@/components/algorithm/FinePrint";

/**
 * The Algorithm tab - a scroll-driven story of the real pipeline.
 *
 * Converge: every data pathway flows into the catalyst-spark engine.
 * Travel:   discovery → enrichment → scoring → ranking, scene by scene.
 * Diverge:  pathways fan out to every destination tab, explorable in place.
 *
 * On narrow viewports (≤1100px) scenes stack and the scroll engine is
 * disabled - every scene renders its finished state as a static, fully
 * readable page. On wider viewports the scrub always runs regardless of the
 * OS reduced-motion setting (cursor parallax is still silenced).
 */
/** Below this width the scene grids stack - pinning would trap content. */
function useNarrowViewport(maxWidth = 1100): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(`(max-width: ${maxWidth}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [maxWidth]);
  return narrow;
}

export function AlgorithmStory() {
  const reduced = useReducedMotion() ?? false;
  const narrow = useNarrowViewport();
  // Only viewport width gates the scroll engine - narrow viewports stack scenes
  // and can't pin. Reduced-motion OS setting alone no longer disables the scrub
  // so the experience works regardless of Windows animation preferences.
  const isStatic = narrow;
  const { scroller, lenis } = useStoryScroll(!isStatic);
  const data = useStoryData();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tour = useLiveTour(lenis, scroller, data);

  // Canonical cross-tab entry: /core?run=live kicks a research run and
  // auto-tours the story alongside it (Blueprint, For You, etc. deep-link
  // here instead of running bespoke flows). If a run is already in flight the
  // store no-ops the kick and the tour simply attaches to the live run.
  const [searchParams, setSearchParams] = useSearchParams();
  const consumedRunParam = useRef(false);
  const wantsLive = searchParams.get("run") === "live";
  useEffect(() => {
    if (!wantsLive || consumedRunParam.current) return;
    // The tour needs the smooth-scroll host; wait for it unless we're static.
    if (!isStatic && !lenis) return;
    consumedRunParam.current = true;
    if (isResearchRunAllowed() || data.isRunning) {
      void data.runResearchNow("manual");
      if (!isStatic) tour.start();
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsLive, lenis, isStatic]);

  return (
    <div ref={rootRef} className={`algo-story${isStatic ? " algo-story--static" : ""}`}>
      <div className="algo-ambient" aria-hidden="true" />
      {!isStatic && !reduced ? <AmbientCursor rootRef={rootRef} /> : null}
      <AlgoRunStrip data={data} />
      {tour.engaged ? (
        <div className="algo-tour-pill mono" role="status">
          auto-touring the live run — scroll to take over
        </div>
      ) : null}
      <ProgressRail scroller={scroller} lenis={lenis} data={data} />
      <SceneHero scroller={scroller} data={data} onRunLive={isStatic ? undefined : tour.start} />
      <SceneDiscovery scroller={scroller} data={data} />
      <SceneEnrichment scroller={scroller} data={data} />
      <SceneScoring scroller={scroller} data={data} />
      <SceneRanking scroller={scroller} data={data} />
      <SceneDivergence data={data} />
      <SceneResearchDesk />
      <FinePrint />
    </div>
  );
}
