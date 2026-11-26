import { useEffect, useState } from "react";
import type Lenis from "lenis";
import { STORY_CHAPTERS } from "@/viz/pipelineModel";
import type { StoryData } from "@/components/algorithm/useStoryData";

/**
 * Fixed chapter rail. Tracks the scene crossing the viewport center, doubles
 * as mission control during a live run (stage dots light as real stages
 * complete), and jumps chapters via lenis.
 */
export function ProgressRail({
  scroller,
  lenis,
  data,
}: {
  scroller: HTMLElement | null;
  lenis: Lenis | null;
  data: StoryData;
}) {
  const [active, setActive] = useState("hero");

  useEffect(() => {
    const sections = STORY_CHAPTERS.map((c) =>
      document.getElementById(`algo-${c.id}`),
    ).filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActive(entry.target.id.replace("algo-", ""));
          }
        }
      },
      { root: scroller ?? undefined, rootMargin: "-45% 0px -45% 0px", threshold: 0 },
    );
    sections.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [scroller]);

  const chapterState = (chapter: (typeof STORY_CHAPTERS)[number]): string => {
    if (!data.isRunning || chapter.stages.length === 0) return "";
    const infos = chapter.stages.map((key) => data.liveStages[key]).filter(Boolean);
    if (infos.length === 0) return "";
    if (infos.every((i) => i!.status === "done")) return " rail-dot--done";
    if (infos.some((i) => i!.status === "running")) return " rail-dot--running";
    return "";
  };

  return (
    <nav className="algo-rail" aria-label="Story chapters">
      {data.isRunning ? (
        <span className="algo-rail__live algo-live-pill">
          <span className="algo-live-pill__dot" />
          LIVE
        </span>
      ) : null}
      {STORY_CHAPTERS.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`rail-dot${active === c.id ? " rail-dot--active" : ""}${chapterState(c)}`}
          onClick={() => {
            const el = document.getElementById(`algo-${c.id}`);
            if (el && lenis) lenis.scrollTo(el, { offset: 0, duration: 1.1 });
            else el?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          <span className="rail-dot__marker" />
          <span className="rail-dot__label">{c.title}</span>
        </button>
      ))}
    </nav>
  );
}
