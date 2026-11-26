import type { ReactNode } from "react";
import type { ScoreCategoryKey, StockSignal, WhyTag, WhyTagKind } from "@/types";
import { formatPct } from "@/lib/format";
import {
  IconSparkle,
  IconBeacon,
  IconUser,
  IconScale,
  IconSearch,
  IconCore,
  IconShield,
  IconAlertTriangle,
  IconArrowUp,
  IconLayers,
  IconPulse,
} from "@/components/icons";
import { materialSellSignal } from "@/engine/catalystStrength";
import { computeSentimentShift } from "@/engine/sentimentShift";
import "./company-report.css";

/** Default chip label per kind (the feed lane may override via WhyTag.label). */
const DEFAULT_LABEL: Record<WhyTagKind, string> = {
  insider_buying: "Heavy insider buying",
  fresh_catalyst: "Fresh catalyst",
  discounted_earnings: "Discounted + positive earnings",
  overlooked_small_cap: "Overlooked small-cap",
  on_fire: "On fire",
  smart_money: "Smart money buying",
  sell_watch: "Insider selling — watch-out",
  reaccelerating: "Revenue re-accelerating",
  backlog_building: "Backlog building",
  sentiment_turning: "Sentiment turning",
  high_conviction: "High conviction",
};

const TAG_ICON: Record<WhyTagKind, ReactNode> = {
  insider_buying: <IconUser size={12} />,
  fresh_catalyst: <IconBeacon size={12} />,
  discounted_earnings: <IconScale size={12} />,
  overlooked_small_cap: <IconSearch size={12} />,
  on_fire: <IconSparkle size={12} />,
  smart_money: <IconCore size={12} />,
  sell_watch: <IconAlertTriangle size={12} />,
  reaccelerating: <IconArrowUp size={12} />,
  backlog_building: <IconLayers size={12} />,
  sentiment_turning: <IconPulse size={12} />,
  high_conviction: <IconShield size={12} />,
};

/**
 * Derive an HONEST fallback set of "why this is interesting" tags from a
 * signal's already-computed fields. Used only when the feed lane hasn't
 * attached `whyInteresting`. Every rule fires on a real, observable condition -
 * nothing is fabricated. Priority order is the push order; callers cap the count.
 */
export function deriveWhyTags(signal: StockSignal): WhyTag[] {
  const out: WhyTag[] = [];
  const cats = signal.score.categories;
  const catScore = (k: ScoreCategoryKey) => cats.find((c) => c.key === k)?.score ?? 0;
  const f = signal.fundamentals;
  const av = signal.fundamentalsAvailability;
  const epsAvail = !av || av.epsGrowthYoY !== false;

  // On fire - top hype tier (attention spiking right now).
  if (signal.hype?.tier === "On fire") {
    out.push({ kind: "on_fire", detail: signal.hype.tldr });
  }

  // Fresh catalyst - live, high-magnitude, inside the near-term window.
  const cat = signal.catalyst;
  if (
    cat &&
    signal.catalystLive !== false &&
    cat.daysAway <= 21 &&
    cat.daysAway >= -10 &&
    cat.magnitude >= 0.45
  ) {
    out.push({ kind: "fresh_catalyst", detail: cat.description });
  }

  // Heavy insider buying - only when real open-market Form 4 buys are known.
  const sec = signal.secActivity;
  const buyCount = sec?.form4BuyCount90d ?? 0;
  const netBuy = sec?.form4NetBuyValue90d ?? 0;
  if (buyCount > 0 || netBuy > 0) {
    out.push({
      kind: "insider_buying",
      detail:
        buyCount > 0
          ? `${buyCount} open-market insider buy${buyCount === 1 ? "" : "s"} (90d)`
          : "Net insider buying (90d)",
    });
  }

  // Smart money - disclosed congressional buys.
  const congBuys = (signal.congressTrades ?? []).filter((t) => t.transaction === "buy").length;
  if (congBuys > 0) {
    out.push({
      kind: "smart_money",
      detail: `${congBuys} congressional buy disclosure${congBuys === 1 ? "" : "s"}`,
    });
  }

  // Sell watch-out - MATERIAL disclosed selling by significant insiders /
  // important people (honest downside). Uses the same materiality threshold the
  // engine scores by (catalystStrength.ts), so the tile and the score agree; a
  // small routine sale stays below the floor and shows nothing.
  const sell = materialSellSignal(signal);
  if (sell.intensity > 0) {
    out.push({ kind: "sell_watch", detail: sell.reason });
  }

  // (v2) Revenue / margin RE-acceleration - the early inflection. Fires only on
  // REAL computed inflection inputs (absent until the daily scan's financials fold
  // runs), gated by a strong inflection sub-score so it agrees with the ranking.
  const inf = signal.inflection;
  if (inf && catScore("inflection") >= 60) {
    const detail =
      inf.revAccelQoQ != null && inf.revAccelQoQ > 0.01
        ? `Revenue growth re-accelerating (QoQ 2nd-deriv +${formatPct(inf.revAccelQoQ)})`
        : inf.grossMarginDeltaYoY != null && inf.grossMarginDeltaYoY > 0.01
          ? `Gross margin +${formatPct(inf.grossMarginDeltaYoY)} YoY`
          : inf.opMarginNow != null && inf.opMarginPrevYearQ != null && inf.opMarginPrevYearQ < 0 && inf.opMarginNow >= 0
            ? "Operating margin turned positive"
            : "Off a depressed base";
    if (detail !== "Off a depressed base" || (inf.opMarginNow ?? -1) >= 0) {
      out.push({ kind: "reaccelerating", detail });
    }
  }

  // (v2) Forward pipeline - backlog / book-to-bill / a named contract leading rev.
  const pipe = signal.pipeline;
  if (pipe && catScore("pipeline") >= 60) {
    const detail =
      pipe.bookToBill != null && pipe.bookToBill > 1.1
        ? `Book-to-bill ${pipe.bookToBill.toFixed(2)} — orders outrunning revenue`
        : pipe.backlogToRevTTM != null && pipe.backlogToRevTTM >= 1
          ? `Backlog ${pipe.backlogToRevTTM.toFixed(1)}× revenue`
          : pipe.namedContractPctRev != null && pipe.namedContractPctRev >= 0.05
            ? `A contract worth ${formatPct(pipe.namedContractPctRev)} of revenue`
            : null;
    if (detail) out.push({ kind: "backlog_building", detail });
  }

  // (v2) Sentiment turning - a real positive shift vs the stock's OWN 20-day
  // baseline, WITH substance (not unconfirmed hype). Cold-start → no chip.
  const shift = computeSentimentShift(signal);
  if (!shift.coldStart && shift.rawSigma > 0.25 && !shift.unconfirmedHype && shift.lead) {
    out.push({ kind: "sentiment_turning", detail: shift.lead });
  }

  // Discounted + positive earnings - good entry AND growing EPS.
  if (catScore("valuation") >= 60 && epsAvail && f.epsGrowthYoY > 0) {
    out.push({
      kind: "discounted_earnings",
      detail: `Discounted entry, EPS ${formatPct(f.epsGrowthYoY)} YoY`,
    });
  }

  // Overlooked small-cap - small/micro/nano scoring well with thin coverage.
  const smallish =
    signal.marketCapBucket === "Small" ||
    signal.marketCapBucket === "Micro" ||
    signal.marketCapBucket === "Nano";
  const coverage = signal.news?.count7d ?? 0;
  if (smallish && signal.score.opportunityScore >= 60 && coverage <= 4) {
    out.push({
      kind: "overlooked_small_cap",
      detail: `${signal.marketCapBucket}-cap · ${coverage} stories/7d`,
    });
  }

  return out;
}

interface WhyTagsProps {
  signal: StockSignal;
  /** Max chips to render. */
  limit?: number;
  className?: string;
}

/**
 * Smart-list "why this is interesting" chips. Prefers the feed lane's
 * `whyInteresting`; falls back to an honest local derivation. Renders nothing
 * when there is genuinely nothing interesting to flag.
 */
export function WhyTags({ signal, limit = 5, className }: WhyTagsProps) {
  const source =
    signal.whyInteresting && signal.whyInteresting.length > 0
      ? signal.whyInteresting
      : deriveWhyTags(signal);
  const tags = source.slice(0, limit);
  if (tags.length === 0) return null;

  return (
    <div className={`why-tags ${className ?? ""}`} aria-label="Why this is interesting">
      {tags.map((t) => {
        const label = t.label ?? DEFAULT_LABEL[t.kind];
        return (
          <span
            key={t.kind}
            className={`why-tag why-tag--${t.kind}`}
            title={t.detail ?? label}
          >
            <span className="why-tag__icon" aria-hidden>
              {TAG_ICON[t.kind]}
            </span>
            <span className="why-tag__label">{label}</span>
          </span>
        );
      })}
    </div>
  );
}
