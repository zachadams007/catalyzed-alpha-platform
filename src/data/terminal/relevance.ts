import type { TerminalEvent } from "@/types/terminal";
import { MARKET_MAJOR_TICKERS } from "@/data/symbols/majors.generated";

/**
 * Terminal "Relevance" ranking - the counterpart to "Latest" (pure date order).
 *
 * The owner's case: the president named two stocks on live TV yesterday - a top-tier
 * catalyst - but in date order it was buried behind minutes-old minor PR. Relevance
 * floats the IMPORTANT items (major stocks / market-moving policy / major insider &
 * politician trades / big size) up even if a day old, with only a GENTLE recency
 * decay so a yesterday-major still outranks a minutes-ago-minor without making the
 * wire go stale. Pure + transparent (no black box), like the severity heuristic.
 */

const MAJORS = new Set(MARKET_MAJOR_TICKERS.map((t) => t.toUpperCase()));

/** Market-moving headline signals - a president/policy/regulatory/M&A mention is a
 *  far bigger catalyst than a routine release of the same age. */
const HIGH_IMPACT_RE =
  /\b(president|trump|white house|executive order|tariff|sanction|f\.?d\.?a\.?|approval|approved|merger|acqui|buyout|takeover|antitrust|do\.?j|s\.?e\.?c\.? (charges|probe|investigat)|investigation|bankruptc|recall|guidance|raises? guidance|beats?|contract award|awarded|defense contract|government|halt|delist|short report|activist)\b/i;

const KIND_WEIGHT: Record<TerminalEvent["kind"], number> = {
  politician_trade: 28,
  insider_buy: 24,
  gov_contract: 22,
  filing_8k: 16,
  insider_sell: 14,
  catalyst_news: 12,
};

/** Relevance score for an event at `nowMs`. Higher = more important to surface. */
export function terminalRelevance(e: TerminalEvent, nowMs: number): number {
  let s = e.severity === "high" ? 60 : e.severity === "elevated" ? 35 : 18;
  s += KIND_WEIGHT[e.kind] ?? 10;

  // A major/megacap name moving is more market-relevant than an unknown micro.
  if (e.ticker && MAJORS.has(e.ticker.toUpperCase())) s += 24;

  // Disclosed trade size - a big buy/sell carries weight ($100k→~15, $10M→~21).
  const v = e.trade?.valueUsd ?? 0;
  if (v > 0) s += Math.min(22, Math.max(0, Math.log10(v) * 3));

  // Market-moving headline (president names a stock, policy, M&A, FDA, activist…).
  if (HIGH_IMPACT_RE.test(e.headline ?? "")) s += 30;

  // Notable actor - a named politician outranks a routine corporate insider.
  const role = (e.actor?.role ?? "").toLowerCase();
  if (/senator|representative|congress|president|secretary|governor|speaker/.test(role)) s += 18;
  else if (/chief|ceo|cfo|chair|director|officer/.test(role)) s += 10;

  // GENTLE recency decay: full weight today, ~40% floor by two weeks - so a
  // day-old major still beats a minutes-old minor, but the wire never goes stale.
  const ageDays = (nowMs - Date.parse(e.surfacedAt || "")) / 86_400_000;
  const decay = Number.isFinite(ageDays) ? Math.max(0.4, 1 - ageDays / 14) : 1;
  return s * decay;
}

/** Sort a copy of the events by the chosen mode. "latest" = surfacedAt desc. */
export function sortTerminalEvents(
  events: readonly TerminalEvent[],
  mode: "latest" | "relevance",
  nowMs: number,
): TerminalEvent[] {
  const out = [...events];
  if (mode === "relevance") {
    out.sort((a, b) => terminalRelevance(b, nowMs) - terminalRelevance(a, nowMs));
  } else {
    out.sort((a, b) => Date.parse(b.surfacedAt || "") - Date.parse(a.surfacedAt || ""));
  }
  return out;
}
