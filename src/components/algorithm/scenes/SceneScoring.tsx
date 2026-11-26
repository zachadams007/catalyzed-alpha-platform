import { useRef } from "react";
import { useScrubScene } from "@/viz/useStoryScroll";
import {
  CATEGORY_CONFIG,
  CONFIDENCE,
  DISCOVERY_MODE,
  RANK_TILT,
  RISK,
  RISK_COMPONENT_LABELS,
  SMART_MONEY,
  stageLabel,
} from "@/viz/pipelineModel";
import type { StoryData } from "@/components/algorithm/useStoryData";

/**
 * Chapter 4 - the engine room. The weighted categories blend to 0–100, the
 * risk model shaves points (capped), and confidence is scored as its own axis.
 * Weights, risk components, and confidence penalties are the REAL config
 * objects; the example numbers are the top live signal's when available.
 */

interface CatRow {
  key: string;
  label: string;
  weight: number;
  score: number;
}

// Representative sub-scores used only when no live signal exists (labeled).
const SAMPLE_SCORES: Record<string, number> = {
  inflection: 72, catalyst: 78, sentimentShift: 64, pipeline: 61,
  momentum: 66, valuation: 58, news: 74, social: 71,
  volatility: 69, growth: 55, fundamentals: 52, liquidity: 47,
};

export function SceneScoring({
  scroller,
  data,
}: {
  scroller: HTMLElement | null;
  data: StoryData;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const s = data.example.signal;

  const rows: CatRow[] = CATEGORY_CONFIG.map((c) => ({
    key: c.key,
    label: c.label,
    weight: c.weight,
    score: s
      ? s.score.categories.find((cat) => cat.key === c.key)?.score ?? 0
      : SAMPLE_SCORES[c.key] ?? 50,
  }));

  const opportunity = s ? s.score.opportunityScore : 62;
  const riskPenalty = s ? s.score.riskPenalty : 9;
  const blend = Math.min(100, opportunity + riskPenalty);
  const confidence = s ? s.confidence : 64;
  const maxWeight = Math.max(...CATEGORY_CONFIG.map((c) => c.weight));

  const liveDetail =
    data.liveStages.score?.status === "running" ? data.liveStages.score.detail : undefined;

  useScrubScene(
    scroller,
    ref,
    (tl, q) => {
      const dialEl = (q(".score-dial__value") as HTMLElement[])[0];
      const confEl = (q(".score-conf__value") as HTMLElement[])[0];
      const dial = { value: 0 };
      const conf = { value: 0 };
      // Resting DOM shows the FINAL numbers (reduced-motion correctness);
      // the scrub rewinds them to 0 and counts up.
      if (dialEl) dialEl.textContent = "0";
      if (confEl) confEl.textContent = "0";

      tl.from(q(".score-flow__node"), { opacity: 0, y: 12, stagger: 0.06, duration: 0.4 }, 0)
        .from(
          q(".score-flow__op"),
          { opacity: 0, scale: 0.55, stagger: 0.06, duration: 0.3 },
          0.15,
        )
        .from(q(".score-bars"), { opacity: 0, x: -30, duration: 0.4 }, 0)
        .from(
          q(".score-bar__fill"),
          { scaleX: 0, transformOrigin: "left center", stagger: 0.06, duration: 0.5 },
          0.2,
        )
        .from(q(".score-dial"), { opacity: 0, scale: 0.92, duration: 0.45 }, 0.5)
        .to(
          dial,
          {
            value: blend,
            duration: 0.7,
            ease: "power2.out",
            onUpdate: () => {
              if (dialEl) dialEl.textContent = String(Math.round(dial.value));
            },
          },
          0.7,
        )
        .from(q(".score-blend-note"), { opacity: 0, y: 8, duration: 0.3 }, 0.9)
        .from(q(".score-risk"), { opacity: 0, y: 22, duration: 0.45 }, 1.35)
        .from(
          q(".score-risk__item"),
          { opacity: 0, x: -10, stagger: 0.05, duration: 0.25 },
          1.5,
        )
        .to(
          dial,
          {
            value: opportunity,
            duration: 0.5,
            ease: "power2.inOut",
            onUpdate: () => {
              if (dialEl) dialEl.textContent = String(Math.round(dial.value));
            },
          },
          1.75,
        )
        .to(q(".score-dial"), { "--dial-risk": 1, duration: 0.4 } as gsap.TweenVars, 1.75)
        .from(q(".score-conf"), { opacity: 0, y: 24, duration: 0.45 }, 2.2)
        .to(
          conf,
          {
            value: confidence,
            duration: 0.55,
            ease: "power2.out",
            onUpdate: () => {
              if (confEl) confEl.textContent = String(Math.round(conf.value));
            },
          },
          2.35,
        )
        .from(q(".score-tilt"), { opacity: 0, y: 14, duration: 0.4 }, 2.75);
    },
    { end: "+=260%" },
    [data.example.ticker, opportunity, confidence],
  );

  return (
    <section ref={ref} className="algo-scene algo-scene--scoring" id="algo-scoring">
      <div className="algo-scene__stage">
        <header className="algo-scene__head">
          <p className="algo-eyebrow">Scoring · “{stageLabel("score")}”</p>
          <h2 className="algo-headline">Pure math. Real weights. No vibes.</h2>
          <p className="algo-dek">
            Pure arithmetic — {CATEGORY_CONFIG.length} weighted sub-scores, led
            by the early <em>inflection</em>, <em>pipeline</em>, and{" "}
            <em>sentiment-shift</em> signals that precede a move. A capped risk
            penalty subtracts for solvency, dilution, governance, an anti-lottery
            pump guard, and an already-ran extension guard (a name that’s already
            run 6× off its base has consumed its asymmetry). The live ranking
            weights small and large caps on different curves so a real small-cap
            setup isn’t judged like a mega-cap.
            {!s ? " Representative example shown — scan the market for a live one." : null}
          </p>
          {liveDetail ? (
            <p className="algo-live-line mono" role="status">▸ {liveDetail}</p>
          ) : null}
        </header>

        <div
          className="score-flow"
          role="img"
          aria-label={`${CATEGORY_CONFIG.length} weighted dimensions blend to a 0–100 score (${blend}), minus a risk penalty capped at ${RISK.cap} (−${riskPenalty}), equals the opportunity score (${opportunity}). Confidence (${confidence}) is a separate trust gauge.`}
        >
          <div className="score-flow__node">
            <span className="score-flow__mini" aria-hidden="true">
              <i style={{ width: "72%" }} />
              <i style={{ width: "54%" }} />
              <i style={{ width: "38%" }} />
            </span>
            <span className="score-flow__big mono">{CATEGORY_CONFIG.length}</span>
            <span className="score-flow__lbl">
              weighted
              <br />
              dimensions
            </span>
          </div>
          <span className="score-flow__op" aria-hidden="true">→</span>
          <div className="score-flow__node">
            <span className="score-flow__big mono">{blend}</span>
            <span className="score-flow__lbl">
              weighted blend
              <br />
              <em>Σ score × weight</em>
            </span>
          </div>
          <span className="score-flow__op score-flow__op--sub" aria-hidden="true">−</span>
          <div className="score-flow__node score-flow__node--risk">
            <span className="score-flow__big mono">{riskPenalty}</span>
            <span className="score-flow__lbl">
              risk penalty
              <br />≤ {RISK.cap}, only subtracts
            </span>
          </div>
          <span className="score-flow__op" aria-hidden="true">=</span>
          <div className="score-flow__node score-flow__node--out">
            <span className="score-flow__big mono">{opportunity}</span>
            <span className="score-flow__lbl">Opportunity</span>
          </div>
          <span className="score-flow__divider" aria-hidden="true" />
          <div className="score-flow__node score-flow__node--conf">
            <span className="score-flow__big mono">{confidence}</span>
            <span className="score-flow__lbl">
              Confidence — separate
              <br />
              trust of inputs, not the setup
            </span>
          </div>
        </div>

        <div className="score-grid">
          <div className="score-bars" aria-label="The weighted categories">
            <p className="score-bars__hint">
              Track width = weight in the blend · fill = this name’s 0–100 sub-score
            </p>
            {rows.map((row) => (
              <div key={row.key} className="score-bar">
                <span className="score-bar__label">{row.label}</span>
                <span className="score-bar__weight mono">
                  ×{Math.round(row.weight * 100)}%
                </span>
                <span
                  className="score-bar__track"
                  style={{ width: `${(row.weight / maxWeight) * 100}%` }}
                >
                  <span
                    className="score-bar__fill"
                    style={{ width: `${row.score}%` }}
                  />
                </span>
                <span className="score-bar__score mono">{Math.round(row.score)}</span>
              </div>
            ))}

            <div className="score-bars__sum">
              <span className="score-bars__sum-sigma mono" aria-hidden="true">Σ</span>
              <span className="score-bars__sum-text">
                each score × its weight, all added up
              </span>
              <span className="score-bars__sum-val mono">{blend}</span>
              <span className="score-bars__sum-cap">weighted blend</span>
            </div>

            <p className="score-bars__explain">
              <strong>That’s the “weighted blend.”</strong> Take{" "}
              {rows[0].label.split(" ")[0]}:{" "}
              <span className="mono">
                {Math.round(rows[0].score)} × {Math.round(rows[0].weight * 100)}% ≈{" "}
                {Math.round(rows[0].score * rows[0].weight)}
              </span>{" "}
              points. Do that for every dimension, sum to{" "}
              <span className="mono">{blend}</span>, subtract risk (capped{" "}
              {RISK.cap}) for Opportunity — Confidence is judged on its own.
            </p>

            <div className="score-callouts">
              <div className="score-callout score-callout--noai">
                <span className="score-callout__tag">No AI in the score</span>
                <p className="score-callout__text">
                  {DISCOVERY_MODE === "agent"
                    ? "The research agent only found the name — every number here is plain, repeatable math."
                    : "The pre-rank only found the name — every number here is plain, repeatable math."}
                </p>
              </div>
              <div className="score-callout score-callout--smartmoney">
                <span className="score-callout__tag">
                  Smart-money tilt{" "}
                  <span className="mono">+{SMART_MONEY.maxBoost} max</span>
                </span>
                <p className="score-callout__text">
                  Disclosed congressional buys + net open-market insider buys
                  (Form 4 “P”) lift the Catalyst sub-score. No buying, no boost —
                  it never subtracts, and never fetches per-filing XML.
                </p>
              </div>
            </div>
          </div>

          <div className="score-right">
            <div className="score-dial">
              <p className="score-dial__label">
                Opportunity
                <span className="score-dial__ticker mono">{data.example.ticker}</span>
              </p>
              <p className="score-dial__value mono">{opportunity}</p>
              <p className="score-blend-note">
                blend − risk · the result of the diagram above
              </p>
            </div>

            <div className="score-risk">
              <p className="score-risk__title">
                − Risk penalty <span className="mono">cap {RISK.cap}</span>
              </p>
              <ul className="score-risk__list">
                {(
                  Object.entries(RISK.components) as Array<
                    [keyof typeof RISK.components, { max: number }]
                  >
                ).map(([key, c]) => (
                  <li key={key} className="score-risk__item">
                    {RISK_COMPONENT_LABELS[key]}
                    <span className="mono">−{c.max} max</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="score-conf">
              <p className="score-conf__title">
                Confidence — a separate axis
                <span className="score-conf__value mono">{confidence}</span>
              </p>
              <p className="score-conf__sub">
                How much we trust the inputs, not how good the setup is.
                Evidence {Math.round(CONFIDENCE.evidenceWeight * 100)}% ·
                agreement {Math.round(CONFIDENCE.agreementWeight * 100)}% ·
                floor {CONFIDENCE.floor}
              </p>
              <ul className="score-conf__penalties">
                <li>thin news −{CONFIDENCE.thinNewsPenalty}</li>
                <li>signal conflict −{CONFIDENCE.signalConflictPenalty}</li>
                <li>illiquidity −{CONFIDENCE.illiquidityPenalty}</li>
                <li>weak catalyst −{CONFIDENCE.weakCatalystPenalty}</li>
                <li>modeled source −{CONFIDENCE.modeledSourcePenalty}</li>
              </ul>
            </div>
          </div>
        </div>

        <p className="score-tilt mono">{RANK_TILT.summary}</p>
      </div>
    </section>
  );
}
