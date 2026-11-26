import type { RankingMode, ScreenCriteria } from "@/types";
import { RANKING_MODE_LABELS } from "@/types";
import { Tooltip } from "@/components/common/Tooltip";
import { isAiMode } from "@/components/screen/researchFlow";

/**
 * Ranking-mode controls for the Blueprint board. FE-only: they set
 * `criteria.rankingMode`, which the engine's modeFitScore() already consumes
 * (src/engine/screen.ts) - no blend math lives here. Descriptions are
 * grounded in the actual fit lanes so the UI can never lie about the order.
 *
 * The control is split into two pieces that share one piece of state
 * (`criteria.rankingMode`):
 *  - <RankingModePills> - the pill picker. Lives INSIDE the Advanced dropdown.
 *  - <RankingModeInstructions> - the dynamic copy + Blended flow. Lives OUTSIDE
 *    the dropdown, beside the Run button, so picking a pill updates the
 *    instructions and the Run dock live.
 *
 * Modes split into two lanes the run dock mirrors:
 *  - LOCAL (Fundamentals only): pure local math, instant, no AI ever.
 *  - AI (Blended, AI only): "Run Blueprint" fires the hosted niche search
 *    alongside local scoring and merges one board.
 *
 * Collapsed from 5 modes to 3 (owner request 2026-06-20). Theme-led and
 * description-led ranking still exist as fit LANES inside `blended` - they
 * just aren't standalone pills anymore. See {@link RankingMode}.
 */

const MODE_ORDER: RankingMode[] = ["fundamentals", "blended", "ai"];

const MODE_MEANINGS: Record<RankingMode, string> = {
  fundamentals:
    "Ranks purely on business quality — growth, valuation, margins, and liquidity. Runs instantly on-device. Your narrative and theme tags are ignored in the sort order.",
  blended:
    "The default. Combines quality fundamentals, theme match, and your written description into one ranked board. Hit Run Blueprint to also search the web for niche names.",
  ai: "Orders the board by how relevant the AI thinks each stock is to your niche. Hit Run Blueprint to do a live web search; before that, it estimates relevance from your description and tags.",
};

/** Short, hoverable teaching line per pill (full meaning renders below). */
const MODE_TIPS: Record<RankingMode, { lane: string; tip: string }> = {
  fundamentals: {
    lane: "On-device · instant",
    tip: "Quality only — ignores hype, theme, and AI entirely.",
  },
  blended: {
    lane: "AI on Run",
    tip: "Quality + theme + description. The default all-rounder.",
  },
  ai: {
    lane: "AI on Run",
    tip: "AI relevance score leads. Run Blueprint does a live web search.",
  },
};

const BLENDED_FLOW = [
  "Describe what you're looking for in the narrative",
  "Tune filters — the board re-ranks live as you change them",
  "Hit Run Blueprint — filters score the board instantly while the AI searches the web for niche names",
  "AI-found names go through the same filters and merge into the same ranked board",
];

/**
 * The pill picker. Compact, fits the Advanced dropdown column. Each pill carries
 * its lane (Local / AI) so the choice is legible without the description below.
 */
export function RankingModePills({
  criteria,
  onCriteriaChange,
}: {
  criteria: ScreenCriteria;
  onCriteriaChange: (c: ScreenCriteria) => void;
}) {
  const mode = criteria.rankingMode ?? "blended";

  return (
    <div className="rank-pick" role="radiogroup" aria-label="Ranking mode">
      {MODE_ORDER.map((m) => (
        <Tooltip
          key={m}
          placement="top"
          content={
            <>
              <strong className="tip__range">{MODE_TIPS[m].lane}</strong>
              <span className="tip__hint">{MODE_TIPS[m].tip}</span>
            </>
          }
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={`rank-pick__pill${mode === m ? " rank-pick__pill--on" : ""}${
              isAiMode(m) ? " rank-pick__pill--ai" : ""
            }`}
            onClick={() => onCriteriaChange({ ...criteria, rankingMode: m })}
          >
            <span className="rank-pick__label">{RANKING_MODE_LABELS[m]}</span>
            <span className="rank-pick__lane">{isAiMode(m) ? "AI" : "Local"}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * The dynamic instructions - the copy that changes with the selected mode, plus
 * the Blended step flow. Rendered OUTSIDE the Advanced dropdown (in the Run
 * dock) so the page's primary action always carries its own explanation, even
 * though the mode is now chosen inside the dropdown.
 */
export function RankingModeInstructions({ criteria }: { criteria: ScreenCriteria }) {
  const mode = criteria.rankingMode ?? "blended";

  return (
    <div className="rank-mode">
      <div className="rank-mode__active">
        <span className="rank-mode__active-label">Ranking by</span>
        <span className={`rank-mode__active-mode${isAiMode(mode) ? " rank-mode__active-mode--ai" : ""}`}>
          {RANKING_MODE_LABELS[mode]}
        </span>
      </div>
      <p className="rank-mode__meaning">{MODE_MEANINGS[mode]}</p>
      {mode === "blended" ? (
        <ol className="rank-mode__flow" aria-label="How the Blended mode builds the board">
          {BLENDED_FLOW.map((step, i) => (
            <li key={step} className="rank-mode__step">
              <span className="rank-mode__step-num mono">{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
