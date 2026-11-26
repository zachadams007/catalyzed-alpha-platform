import type { CatalystType, MarketCapBucket, RiskLevel, Sector, StockSignal } from "@/types";
import { TRADE_HORIZON_SHORT } from "@/types";
import { likelyHorizon } from "@/lib/tradeHorizon";

export function SectorPill({ sector }: { sector: Sector }) {
  return <span className="pill pill--sector">{sector}</span>;
}

export function CapPill({ bucket }: { bucket: MarketCapBucket }) {
  return (
    <span className="pill pill--cap">
      {bucket} Cap
    </span>
  );
}

export function CatalystPill({ type }: { type: CatalystType }) {
  // Never surface an empty "None" chip - if there's no catalyst, show nothing
  // (a "none" tag is noise on the feed). The catalyst story still appears in the
  // hype/news blocks when one actually exists.
  if (type === "None") return null;
  return (
    <span className="pill pill--catalyst">
      <span className="pill__dot" />
      {type}
    </span>
  );
}

export function RiskPill({ level }: { level: RiskLevel }) {
  // Framed as VOLATILITY, never "risk" - "low risk" wrongly implies you can't
  // lose money. Volatility honestly describes how much the name can swing. The
  // colour coding (pill--risk-{level}) is unchanged.
  return (
    <span
      className={`pill pill--risk-${level}`}
      title="Volatility profile — how much this name tends to swing. Not a safety rating; any stock can lose value."
    >
      <span className="pill__dot" />
      {level} volatility
    </span>
  );
}

export function ConfidencePill({
  confidence,
  explanation,
}: {
  confidence: number;
  explanation?: string;
}) {
  return (
    <span className="pill pill--confidence" title={explanation}>
      {confidence}% confidence
    </span>
  );
}

/** Derived "most likely time scale" for this signal - see likelyHorizon(). */
export function HorizonPill({ signal }: { signal: StockSignal }) {
  const { horizon, why } = likelyHorizon(signal);
  return (
    <span className="pill pill--horizon" title={`Likely time scale — ${why}`}>
      <span className="pill__dot" />
      {TRADE_HORIZON_SHORT[horizon]}
    </span>
  );
}
