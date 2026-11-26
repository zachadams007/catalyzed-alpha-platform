import { IconSparkle } from "@/components/icons";
import type { PortfolioInsight } from "@/engine/portfolioInsights";

const TONE_LABEL: Record<PortfolioInsight["tone"], string> = {
  opportunity: "Opportunity",
  watch: "Watch",
  risk: "Risk",
  info: "Note",
};

export function PortfolioInsightsPanel({ insights }: { insights: PortfolioInsight[] }) {
  return (
    <section className="pf-panel pf-insights" aria-label="Portfolio insights">
      <div className="pf-panel__head">
        <IconSparkle size={17} />
        <span className="pf-panel__title">Insights on your holdings</span>
        <span className="pf-panel__hint text-faint">Research prompts - not advice</span>
      </div>
      {insights.length > 0 ? (
        <ul className="pf-insights__list">
          {insights.map((insight) => (
            <li key={insight.id} className={`pf-insight pf-insight--${insight.tone}`}>
              <span className={`pf-insight__tag pf-insight__tag--${insight.tone}`}>
                {TONE_LABEL[insight.tone]}
              </span>
              <div className="pf-insight__body">
                <div className="pf-insight__title">{insight.title}</div>
                <p className="pf-insight__detail">{insight.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="pf-insights__empty">
          Add live research coverage or more holdings to surface concentration and catalyst prompts.
        </div>
      )}
    </section>
  );
}
