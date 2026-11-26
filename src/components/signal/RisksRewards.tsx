import type { ReactNode } from "react";
import type { ScoreCategoryKey, StockSignal } from "@/types";
import { formatPct, formatPctPlain } from "@/lib/format";
import { looksUnprofitable } from "@/engine/profitability";
import {
  IconArrowUp,
  IconAlertTriangle,
  IconShield,
  IconScale,
  IconInfo,
} from "@/components/icons";
import "./company-report.css";

type Tone = "positive" | "neutral" | "warn" | "negative";

interface ReportItem {
  id: string;
  text: string;
  tone: Tone;
  detail?: string;
}

/** Find a category score by key (0 when the engine didn't emit it). */
function catScore(signal: StockSignal, key: ScoreCategoryKey): number {
  return signal.score.categories.find((c) => c.key === key)?.score ?? 0;
}
function catExplain(signal: StockSignal, key: ScoreCategoryKey): string | undefined {
  return signal.score.categories.find((c) => c.key === key)?.explanation;
}

/**
 * The price/valuation read, derived from the engine's "Entry / Value Timing"
 * sub-score. Returns null only when that dimension is absent (the engine always
 * emits it, so in practice it's always present).
 */
export function valuationSignal(
  signal: StockSignal,
): { score: number; label: string; tone: Tone; hint?: string } | null {
  const cat = signal.score.categories.find((c) => c.key === "valuation");
  if (!cat) return null;
  const s = cat.score;
  // Thin/modeled price history → the engine returns a neutral read and says so;
  // surface that honestly instead of a fabricated price judgment ("chasing highs"
  // on a name that's actually near its lows - the BMNR case).
  if (cat.explanation.startsWith("Limited price history")) {
    return { score: s, label: "Limited history", tone: "neutral", hint: cat.explanation };
  }
  let label: string;
  let tone: Tone;
  if (s >= 68) {
    label = "Discounted entry";
    tone = "positive";
  } else if (s >= 52) {
    label = "Fair entry";
    tone = "neutral";
  } else if (s >= 40) {
    label = "Full price";
    tone = "warn";
  } else {
    label = "Chasing highs";
    tone = "negative";
  }
  return { score: s, label, tone, hint: cat.explanation };
}

/** Compact "good price / valuation" chip for the card + detail hero. */
export function ValuationChip({
  signal,
  className,
}: {
  signal: StockSignal;
  className?: string;
}) {
  const v = valuationSignal(signal);
  if (!v) return null;
  return (
    <span className={`val-chip val-chip--${v.tone} ${className ?? ""}`} title={v.hint}>
      <IconScale size={13} className="val-chip__icon" />
      <span className="val-chip__label">{v.label}</span>
      <span className="val-chip__score mono">{v.score}</span>
    </span>
  );
}

/**
 * Compose plain-English rewards + honest watch-outs from a signal's existing,
 * already-computed fields. Each rule fires only on a real, observable condition
 * - watch-outs are NEVER fabricated, and missing fundamentals (N/A) are skipped.
 */
function buildReport(signal: StockSignal): { rewards: ReportItem[]; watchOuts: ReportItem[] } {
  const f = signal.fundamentals;
  const av = signal.fundamentalsAvailability;
  const has = (k: keyof typeof f) => !av || av[k] !== false;
  const m = signal.momentum;
  const rewards: ReportItem[] = [];
  const watchOuts: ReportItem[] = [];

  // ---- Rewards (positive, in priority order) ----
  const cat = signal.catalyst;
  if (cat && cat.magnitude >= 0.5 && signal.catalystLive !== false) {
    const when =
      cat.daysAway > 0 ? `in ${cat.daysAway}d` : cat.daysAway === 0 ? "today" : `${-cat.daysAway}d ago`;
    rewards.push({
      id: "catalyst",
      tone: "positive",
      text: `${cat.type} catalyst ${when}`,
      detail: cat.description,
    });
  }
  if (catScore(signal, "valuation") >= 62) {
    rewards.push({
      id: "value",
      tone: "positive",
      text: "Attractive entry vs its recent range",
      detail: catExplain(signal, "valuation"),
    });
  }
  if (has("revenueGrowthYoY") && f.revenueGrowthYoY >= 0.15) {
    rewards.push({
      id: "rev",
      tone: "positive",
      text: `Revenue growing ${formatPct(f.revenueGrowthYoY)} YoY`,
    });
  }
  if (has("epsGrowthYoY") && f.epsGrowthYoY >= 0.15) {
    rewards.push({ id: "eps", tone: "positive", text: `Earnings up ${formatPct(f.epsGrowthYoY)} YoY` });
  }
  if (has("netMargin") && f.netMargin >= 0.1) {
    rewards.push({
      id: "margin",
      tone: "positive",
      text: `Solidly profitable — ${formatPctPlain(f.netMargin)} net margin`,
    });
  }
  if (m.aboveSMA200 && m.return3M > 0.05) {
    rewards.push({
      id: "trend",
      tone: "positive",
      text: `Uptrend — above its 200-day, ${formatPct(m.return3M)} 3M`,
    });
  }
  if (signal.news.sentiment >= 0.2 && signal.news.count7d > 0) {
    rewards.push({
      id: "news",
      tone: "positive",
      text: `Positive news flow — ${signal.news.count7d} stories this week`,
    });
  }
  const mean = signal.analyst?.consensus?.mean;
  if (mean && signal.price > 0) {
    const up = (mean - signal.price) / signal.price;
    if (up >= 0.15) {
      rewards.push({ id: "pt", tone: "positive", text: `Street target ${formatPct(up)} above spot` });
    }
  }

  // ---- Watch-outs (honest; only when the real field crosses a threshold) ----
  if (signal.riskLevel === "High" || signal.riskLevel === "Extreme") {
    watchOuts.push({
      id: "risk",
      tone: "negative",
      text: signal.score.riskExplanation || `${signal.riskLevel} volatility — expect bigger swings`,
    });
  }
  if (has("epsGrowthYoY") && f.epsGrowthYoY < 0) {
    watchOuts.push({
      id: "eps-",
      tone: "warn",
      text: `Earnings shrinking — EPS ${formatPct(f.epsGrowthYoY)} YoY`,
    });
  }
  if (has("revenueGrowthYoY") && f.revenueGrowthYoY < 0) {
    watchOuts.push({
      id: "rev-",
      tone: "warn",
      text: `Revenue declining — ${formatPct(f.revenueGrowthYoY)} YoY`,
    });
  }
  if (looksUnprofitable(has("netMargin") ? f.netMargin : null, has("peRatio") ? f.peRatio : null)) {
    watchOuts.push({
      id: "np",
      tone: "warn",
      text: `Unprofitable — ${formatPctPlain(f.netMargin)} net margin`,
    });
  }
  if (has("fcfMargin") && f.fcfMargin < 0 && signal.risk.cashRunwayQuarters < 6) {
    watchOuts.push({
      id: "cash",
      tone: "negative",
      text: `Burning cash — ~${Math.max(0, Math.round(signal.risk.cashRunwayQuarters))} quarters runway`,
    });
  }
  if (signal.risk.dilutionRisk >= 0.5) {
    watchOuts.push({ id: "dil", tone: "warn", text: "Dilution / financing overhang risk" });
  }
  if (signal.risk.shortInterestPct >= 0.15) {
    watchOuts.push({
      id: "si",
      tone: "warn",
      text: `Crowded short — ${formatPctPlain(signal.risk.shortInterestPct)} of float`,
    });
  }
  if (signal.risk.governanceFlag >= 0.4) {
    watchOuts.push({ id: "gov", tone: "negative", text: "Governance / accounting red flag" });
  }
  if (!m.aboveSMA200) {
    watchOuts.push({ id: "sma", tone: "warn", text: "Trading below its 200-day average" });
  }
  if (signal.news.sentiment <= -0.2 && signal.news.count7d > 0) {
    watchOuts.push({ id: "news-", tone: "warn", text: "Negative news tone lately" });
  }
  const rec = signal.analyst?.recommendations;
  if (rec) {
    const buys = rec.strongBuy + rec.buy;
    const sells = rec.sell + rec.strongSell;
    if (sells > buys && sells > 0) {
      watchOuts.push({ id: "downgrade", tone: "warn", text: "More analyst sells than buys" });
    }
  }
  if (catScore(signal, "valuation") <= 38) {
    watchOuts.push({ id: "val-", tone: "warn", text: "Price looks stretched vs its range" });
  }

  return { rewards, watchOuts };
}

const TONE_ICON: Record<Tone, ReactNode> = {
  positive: <IconArrowUp size={13} />,
  neutral: <IconInfo size={13} />,
  warn: <IconAlertTriangle size={13} />,
  negative: <IconAlertTriangle size={13} />,
};

function ItemList({ items }: { items: ReportItem[] }) {
  return (
    <ul className="rr__list">
      {items.map((it) => (
        <li key={it.id} className={`rr__item rr__item--${it.tone}`} title={it.detail}>
          <span className="rr__bullet" aria-hidden>
            {TONE_ICON[it.tone]}
          </span>
          <span className="rr__text">{it.text}</span>
        </li>
      ))}
    </ul>
  );
}

interface RisksRewardsProps {
  signal: StockSignal;
  /** "card" = 2 items per column; "detail" = up to 4. */
  variant?: "card" | "detail";
  className?: string;
}

/**
 * Plain-English Rewards & Watch-outs. Watch-outs are honest - when the data
 * shows no red flags it says so rather than inventing one.
 */
export function RisksRewards({ signal, variant = "detail", className }: RisksRewardsProps) {
  const { rewards, watchOuts } = buildReport(signal);
  const cap = variant === "card" ? 2 : 4;

  const rw: ReportItem[] =
    rewards.length > 0
      ? rewards.slice(0, cap)
      : [{ id: "none", tone: "neutral", text: "No standout upside drivers in our data right now." }];

  const wo: ReportItem[] =
    watchOuts.length > 0
      ? watchOuts.slice(0, cap)
      : [{ id: "clean", tone: "positive", text: "No major red flags in our data." }];

  return (
    <div className={`rr rr--${variant} ${className ?? ""}`}>
      <div className="rr__col rr__col--rewards">
        <div className="rr__head">
          <IconArrowUp size={13} className="rr__head-icon" />
          Rewards
        </div>
        <ItemList items={rw} />
      </div>
      <div className="rr__col rr__col--risks">
        <div className="rr__head">
          {watchOuts.length > 0 ? (
            <IconAlertTriangle size={13} className="rr__head-icon" />
          ) : (
            <IconShield size={13} className="rr__head-icon" />
          )}
          Watch-outs
        </div>
        <ItemList items={wo} />
      </div>
    </div>
  );
}
