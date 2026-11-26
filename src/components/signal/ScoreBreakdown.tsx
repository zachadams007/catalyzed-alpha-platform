import type { ScoreBreakdown as Breakdown } from "@/types";
import { scoreColors } from "@/lib/ui";

/** Per-category bars + risk/confidence rows. The "why it scored this way" view. */
export function ScoreBreakdown({ breakdown }: { breakdown: Breakdown }) {
  return (
    <div className="breakdown">
      {breakdown.categories.map((cat) => {
        const { a, b, solid } = scoreColors(cat.score);
        return (
          <div key={cat.key}>
            <div className="score-bar__head">
              <div>
                <span className="score-bar__label">{cat.label}</span>
                <span className="score-bar__weight">{Math.round(cat.weight * 100)}% weight</span>
              </div>
              <span className="score-bar__value mono" style={{ color: solid }}>
                {cat.score}
              </span>
            </div>
            <div className="score-bar__track">
              <div
                className="score-bar__fill"
                style={{ width: `${cat.score}%`, background: `linear-gradient(90deg, ${a}, ${b})` }}
              />
            </div>
            <div className="score-bar__explain">{cat.explanation}</div>
          </div>
        );
      })}

      <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />

      <div>
        <div className="score-bar__head">
          <span className="score-bar__label" style={{ color: "var(--bear)" }}>
            Risk Penalty
          </span>
          <span className="score-bar__value mono" style={{ color: "var(--bear)" }}>
            -{breakdown.riskPenalty}
          </span>
        </div>
        <div className="score-bar__explain">{breakdown.riskExplanation}</div>
      </div>

      <div>
        <div className="score-bar__head">
          <span className="score-bar__label" style={{ color: "var(--accent-3)" }}>
            Confidence
          </span>
          <span className="score-bar__value mono" style={{ color: "var(--accent-3)" }}>
            {breakdown.confidence}%
          </span>
        </div>
        <div className="score-bar__track">
          <div
            className="score-bar__fill"
            style={{ width: `${breakdown.confidence}%`, background: "var(--accent-3)" }}
          />
        </div>
        <div className="score-bar__explain">
          {breakdown.confidenceExplanation ||
            "How much we trust these inputs (data coverage + internal agreement) - not the size of the opportunity."}
        </div>
      </div>
    </div>
  );
}
