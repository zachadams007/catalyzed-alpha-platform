import { useState } from "react";
import type { Portfolio, PortfolioDiscovery, TradeHorizon } from "@/types";
import { ScreenCriteriaForm } from "@/components/screen/ScreenCriteriaForm";
import { useAppStore } from "@/store/useAppStore";
import { defaultGrowthScreenCriteria } from "@/engine/screen";
import { IconForge, IconRefresh } from "@/components/icons";

interface PortfolioDiscoveryPanelProps {
  portfolio: Portfolio;
}

export function PortfolioDiscoveryPanel({ portfolio }: PortfolioDiscoveryPanelProps) {
  const setPortfolioDiscovery = useAppStore((s) => s.setPortfolioDiscovery);
  const runPortfolioDiscovery = useAppStore((s) => s.runPortfolioDiscovery);
  const preferences = useAppStore((s) => s.preferences);

  const initial = portfolio.discovery ?? {
    horizon: (preferences.tradeHorizon ?? "position_trading") as TradeHorizon,
    criteria: { ...defaultGrowthScreenCriteria(), maxResults: 10 },
    description: portfolio.description || "",
    targetCount: 10,
  };

  const [horizons, setHorizons] = useState<TradeHorizon[]>(
    initial.horizons?.length ? initial.horizons : [initial.horizon],
  );
  const [criteria, setCriteria] = useState(initial.criteria);
  const [description, setDescription] = useState(initial.description);
  const [targetCount, setTargetCount] = useState(initial.targetCount);
  const [running, setRunning] = useState(false);

  const save = () => {
    const discovery: PortfolioDiscovery = {
      horizon: horizons[0] ?? "position_trading",
      horizons,
      criteria: { ...criteria, maxResults: targetCount },
      description,
      targetCount,
      lastRunAt: portfolio.discovery?.lastRunAt,
    };
    setPortfolioDiscovery(portfolio.id, discovery);
  };

  const run = () => {
    save();
    setRunning(true);
    void Promise.resolve().then(() => {
      runPortfolioDiscovery(portfolio.id, Math.min(3, Math.max(1, targetCount - portfolio.holdings.length)));
      setRunning(false);
    });
  };

  return (
    <section className="pf-panel portfolio-discovery">
      <div className="portfolio-discovery__head">
        <div>
          <div className="section-title">Portfolio discovery</div>
          <p className="portfolio-discovery__lede text-muted">
            Same screening engine as Blueprint. Save your thesis and filters, then run again later to
            surface new names (adds up to a few per run — not hundreds).
          </p>
        </div>
        {portfolio.discovery?.lastRunAt && (
          <span className="portfolio-discovery__meta text-faint">
            Last run {new Date(portfolio.discovery.lastRunAt).toLocaleDateString()}
          </span>
        )}
      </div>

      <ScreenCriteriaForm
        horizons={horizons}
        onHorizonsChange={setHorizons}
        criteria={criteria}
        onCriteriaChange={setCriteria}
        description={description}
        onDescriptionChange={setDescription}
      />

      <div className="field portfolio-discovery__target">
        <label htmlFor="pf-discovery-target">Target holdings (about {targetCount})</label>
        <input
          id="pf-discovery-target"
          type="range"
          min={3}
          max={15}
          value={targetCount}
          onChange={(e) => setTargetCount(Number(e.target.value))}
        />
      </div>

      <div className="portfolio-discovery__actions">
        <button type="button" className="btn btn--primary" onClick={run} disabled={running}>
          {running ? <span className="spinner" /> : <IconForge size={16} />}
          {running ? "Running…" : "Run discovery"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={save}>
          Save settings
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setCriteria(defaultGrowthScreenCriteria());
            setHorizons(["position_trading", "swing_trading"]);
            setTargetCount(10);
          }}
        >
          <IconRefresh size={16} /> Growth preset
        </button>
      </div>
    </section>
  );
}
