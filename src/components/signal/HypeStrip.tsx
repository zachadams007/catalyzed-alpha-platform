import type { ExecutiveSignalSummary, HypeTier, StockSignal } from "@/types";
import { executiveSignalsForTicker } from "@/data/terminal/executiveTrades";
import { InfoTip } from "@/components/common/Tooltip";

interface HypeStripProps {
  signal: StockSignal;
}

const TIER_CLASS: Record<HypeTier, string> = {
  "On fire": "on-fire",
  "Heating up": "heating",
  Warming: "warming",
  Cooling: "cooling",
};

/** Stable kebab key for a hype tier - drives the card-level heat skin. */
export function hypeTierKey(tier: HypeTier): string {
  return TIER_CLASS[tier];
}

const TIER_ICON: Record<HypeTier, string> = {
  "On fire": "🔥",
  "Heating up": "📈",
  Warming: "✨",
  Cooling: "🌙",
};

/**
 * What the tier badge actually measures - ATTENTION + smart-money HEAT (momentum,
 * news/social buzz, congressional and insider buying), never a dated catalyst
 * event. Shown in a tooltip so "Warming" next to a Catalyst score of 0 reads as
 * two different, both-honest measures instead of a contradiction.
 */
const TIER_TIP: Record<HypeTier, string> = {
  "On fire":
    "\"On fire\" measures attention & smart-money HEAT right now — momentum, news/social buzz, and congressional or insider buying. It's separate from the Catalyst score, which only counts dated events (earnings, M&A, FDA, contracts).",
  "Heating up":
    "\"Heating up\" measures attention & smart-money HEAT right now — momentum, news/social buzz, and congressional or insider buying. It's separate from the Catalyst score, which only counts dated events (earnings, M&A, FDA, contracts).",
  Warming:
    "\"Warming\" measures attention & smart-money HEAT — momentum, news/social buzz, and congressional or insider buying. It's separate from the Catalyst score, which only counts dated events (earnings, M&A, FDA, contracts), so this can run warm even when Catalyst reads 0.",
  Cooling:
    "\"Cooling\" measures attention & smart-money HEAT — momentum, news/social buzz, and congressional or insider buying. It's separate from the Catalyst score, which only counts dated events (earnings, M&A, FDA, contracts).",
};

interface KeyEvent {
  key: string;
  icon?: string;
  label: string;
  tone: "bull" | "bear";
}

/** A compact, prioritized "what's actually happening" label from the President signal. */
function execEvent(summary: ExecutiveSignalSummary): KeyEvent | null {
  const item = summary.favorable ?? summary.adverse;
  if (!item) return null;
  const bull = Boolean(summary.favorable);
  const label =
    item.kind === "buy"
      ? "President buy"
      : item.kind === "sell"
        ? "President sale"
        : item.kind === "favorable_callout"
          ? "Spotlighted by President"
          : "President policy risk";
  return { key: "exec", icon: "🏛️", label, tone: bull ? "bull" : "bear" };
}

/**
 * The most decision-relevant happenings for this name, PRIORITIZED: a Presidential
 * callout first, then insider/congress buying or selling. Momentum, news counts and
 * social chatter are intentionally NOT here - those live on the full stock page. The
 * row is capped so the catalyst tile stays condensed (one line on a phone).
 */
function buildKeyEvents(signal: StockSignal): KeyEvent[] {
  const events: KeyEvent[] = [];

  const exec = executiveSignalsForTicker(signal.ticker);
  if (exec) {
    const e = execEvent(exec);
    if (e) events.push(e);
  }

  const trades = signal.congressTrades ?? [];
  const cBuys = trades.filter((t) => t.transaction === "buy").length;
  const cSells = trades.filter((t) => t.transaction === "sell").length;
  if (cBuys > 0 && cBuys >= cSells) {
    events.push({ key: "congress", label: `Congress ${cBuys} buy${cBuys === 1 ? "" : "s"}`, tone: "bull" });
  } else if (cSells > 0) {
    events.push({ key: "congress", label: `Congress ${cSells} sell${cSells === 1 ? "" : "s"}`, tone: "bear" });
  }

  const sec = signal.secActivity;
  if (sec?.form4BuyCount90d && sec.form4BuyCount90d > 0) {
    events.push({ key: "insider", label: "Insider buying", tone: "bull" });
  } else if (sec?.form4NetBuyValue90d != null && sec.form4NetBuyValue90d < 0) {
    events.push({ key: "insider", label: "Insider selling", tone: "bear" });
  }

  return events.slice(0, 3);
}

/**
 * The single CATALYST TILE on the feed card: a heat badge (tier + 0–100 catalyst-
 * drive score), one short punchline, the drive meter, and a prioritized row of the
 * MOST IMPORTANT happenings (President callout, insider/congress buys-sells). The
 * President spotlight is folded in here as a top-priority badge - NOT a second
 * tile. Everything finer-grained (momentum, news, social, full sourcing) lives on
 * the stock page. Purely presentational; the tldr/score come from `computeHype`.
 */
export function HypeStrip({ signal }: HypeStripProps) {
  const { hype } = signal;
  const tierClass = TIER_CLASS[hype.tier];
  const events = buildKeyEvents(signal);

  return (
    <section
      className={`hype-strip hype-strip--${tierClass}`}
      aria-label={`Catalyst drive ${hype.score} of 100, ${hype.tier}`}
    >
      <div className="hype-strip__head">
        <span className="hype-badge">
          <span className="hype-badge__icon" aria-hidden>
            {TIER_ICON[hype.tier]}
          </span>
          <span className="hype-badge__tier">{hype.tier}</span>
          <span className="hype-badge__score mono">{hype.score}</span>
          <InfoTip label={`About the ${hype.tier} heat score`} content={TIER_TIP[hype.tier]} />
        </span>
        <p className="hype-strip__tldr">{hype.tldr}</p>
      </div>

      {/* Catalyst-drive meter - the 0–100 score as a glowing, tier-colored fill. */}
      <div className="hype-meter" aria-hidden>
        <span className="hype-meter__fill" style={{ width: `${hype.score}%` }} />
      </div>

      {events.length > 0 && (
        <div className="hype-strip__events">
          {events.map((e) => (
            <span key={e.key} className={`hype-event hype-event--${e.tone}`}>
              {e.icon ? (
                <span className="hype-event__icon" aria-hidden>
                  {e.icon}
                </span>
              ) : null}
              {e.label}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
