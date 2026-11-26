import type {
  ForYouFilterId,
  ScoreCategoryKey,
  StockSignal,
  UserPreferences,
} from "@/types";
import { personalize, type RankedSignal } from "@/feed/feedAlgorithm";
import { emergingThemeHits } from "@/feed/emergingThemes";

/**
 * For-You filter toggles - the social-media-style personalization layer.
 *
 * These are HARD filters, not gentle boosts: while any filter is active, every
 * name that matches it outranks every name that doesn't (the non-matching rest
 * of the board renders behind a labelled divider). Within the matched pool the
 * ordering stays quality-first: base rank score + the user's learned
 * personalization boosts, so a filter always surfaces the BEST names of its
 * type, not just any match.
 *
 * Everything is pure and works on the in-memory universe - toggling a filter
 * re-composes instantly with NO market rescan.
 *
 * Evidence honesty: every `why` string is derived from real signal fields
 * (score categories, raw catalyst timing, SEC/congress disclosures, theme
 * keyword hits) - never fabricated.
 */
export interface FilterHit {
  id: ForYouFilterId;
  /** Honest one-liner shown as the card's lead "why" reason. */
  why: string;
}

export interface ForYouFilterDef {
  id: ForYouFilterId;
  label: string;
  /** Plain-English tooltip: what the toggle does, no jargon. */
  hint: string;
  evaluate(signal: StockSignal, prefs: UserPreferences): FilterHit | null;
}

function cat(signal: StockSignal, key: ScoreCategoryKey): number {
  return signal.score.categories.find((c) => c.key === key)?.score ?? 50;
}

const EARLY_CAPS = new Set(["Nano", "Micro", "Small"]);

export const FOR_YOU_FILTERS: ForYouFilterDef[] = [
  {
    id: "early_catalyst",
    label: "Early + catalyst",
    hint: "Small companies with a live catalyst that haven't already run — catching the move before it's obvious.",
    evaluate(signal) {
      if (!EARLY_CAPS.has(signal.marketCapBucket)) return null;
      // "Early" means the entry isn't already stretched to highs.
      if (cat(signal, "valuation") < 42) return null;
      // Early-move evidence from ANY live source, strongest first. Calibrated
      // against the real board (2026-07-01): the catalyst category is 0 for
      // 75%+ of small caps (few dated catalysts attach outside earnings
      // season), so catalyst-only evidence surfaced 1 name in 470 - news heat,
      // fundamental inflection, and sentiment turns are the honest
      // catalyst-adjacent "early" signals the scan actually carries.
      const raw = signal.catalyst;
      const dated =
        raw != null && raw.daysAway >= -7 && raw.daysAway <= 60 && raw.magnitude >= 0.25;
      const tagged = signal.whyInteresting?.some(
        (t) => t.kind === "fresh_catalyst" || t.kind === "reaccelerating",
      );
      let evidence: string | null = null;
      if (dated && raw) {
        evidence =
          raw.daysAway >= 0
            ? `catalyst in ${raw.daysAway}d`
            : `fresh catalyst ${-raw.daysAway}d ago`;
      } else if (tagged || cat(signal, "catalyst") >= 52) {
        evidence = "live catalyst heat";
      } else if (cat(signal, "inflection") >= 62) {
        evidence = "fundamentals inflecting early";
      } else if (cat(signal, "news") >= 60) {
        evidence = "news heat building";
      } else if ((signal.hype?.score ?? 0) >= 55) {
        evidence = "attention building";
      } else if (cat(signal, "sentimentShift") >= 60) {
        evidence = "sentiment turning";
      }
      if (evidence == null) return null;
      return {
        id: "early_catalyst",
        why: `Early ${signal.marketCapBucket.toLowerCase()}-cap · ${evidence}`,
      };
    },
  },
  {
    id: "emerging_themes",
    label: "Emerging themes",
    hint: "Names in today's highest-growth-potential themes — quantum, cybersecurity, post-quantum security, AI infrastructure, nuclear, space.",
    evaluate(signal, prefs) {
      const hits = emergingThemeHits(signal, prefs.forYouThemes);
      if (hits.length === 0) return null;
      const lead = hits[0];
      return { id: "emerging_themes", why: `${lead.theme.label} — ${lead.evidence}` };
    },
  },
  {
    id: "reversal_setups",
    label: "Reversal setups",
    hint: "Discounted names showing a real turn signal — below a moving average is welcome here; that's where reversals start.",
    evaluate(signal) {
      if (cat(signal, "valuation") < 56) return null; // must be a discounted entry
      if (cat(signal, "momentum") > 55) return null; // already moving = not a reversal SETUP
      // Require a reason for the turn - never surface reason-less falling knives.
      const turnEvidence = Math.max(
        cat(signal, "inflection"),
        cat(signal, "fundamentals"),
        cat(signal, "growth"),
        cat(signal, "catalyst"),
      );
      if (turnEvidence < 55) return null;
      const belowTrend = signal.momentum ? !signal.momentum.aboveSMA50 : false;
      return {
        id: "reversal_setups",
        why: belowTrend
          ? "Reversal setup — discounted, turn signals firming, still under the 50-day"
          : "Reversal setup — discounted entry with turn signals firming",
      };
    },
  },
  {
    id: "breakout_watch",
    label: "Breakout watch",
    hint: "Confirmed strength plus building attention — momentum names setting up, excluding parabolic already-went moves.",
    evaluate(signal) {
      const momentum = cat(signal, "momentum");
      if (momentum < 64) return null;
      // A breakout WATCH needs trend structure forming - below the 50-day is
      // reversal territory, the other chip's job. (null = structure unknown, allowed.)
      if (signal.momentum && !signal.momentum.aboveSMA50) return null;
      const attention = Math.max(
        cat(signal, "news"),
        cat(signal, "social"),
        signal.hype?.score ?? 0,
      );
      if (attention < 58) return null;
      const rsi = signal.momentum?.rsi;
      if (rsi != null && rsi > 80) return null; // parabolic - chase risk, not a setup
      const structure =
        signal.momentum?.aboveSMA50 && signal.momentum?.aboveSMA200
          ? "trend confirmed"
          : "strength building";
      return { id: "breakout_watch", why: `Breakout watch — ${structure}, attention rising` };
    },
  },
  {
    id: "smart_money",
    label: "Smart money",
    hint: "Disclosed insider buying, congressional trading, or activist stakes — people with information committing real dollars.",
    evaluate(signal) {
      const tagged = signal.whyInteresting?.find(
        (t) => t.kind === "insider_buying" || t.kind === "smart_money",
      );
      if (tagged) {
        return { id: "smart_money", why: tagged.detail ?? tagged.label ?? "Smart-money activity" };
      }
      const buys = signal.secActivity?.form4BuyCount90d ?? 0;
      if (buys > 0) {
        return {
          id: "smart_money",
          why: `${buys} open-market insider buy${buys > 1 ? "s" : ""} (90d)`,
        };
      }
      if ((signal.secActivity?.form4NetBuyValue90d ?? 0) > 0) {
        return { id: "smart_money", why: "Net insider buying (90d)" };
      }
      const congress = signal.congressTrades?.length ?? 0;
      if (congress > 0) {
        return {
          id: "smart_money",
          why: `${congress} congressional trade${congress > 1 ? "s" : ""} disclosed`,
        };
      }
      if ((signal.secActivity?.thirteenDCount90d ?? 0) > 0) {
        return { id: "smart_money", why: "Activist / strategic 13D stake disclosed" };
      }
      if (signal.catalystType === "Insider") {
        return { id: "smart_money", why: "Insider-activity catalyst" };
      }
      return null;
    },
  },
  {
    id: "discounted_quality",
    label: "Discounted quality",
    hint: "Large caps with solid fundamentals trading at a discounted entry — the MSFT-shaped setup.",
    evaluate(signal) {
      if (signal.marketCapBucket !== "Large" && signal.marketCapBucket !== "Mega") return null;
      if (cat(signal, "valuation") < 55) return null;
      if (Math.max(cat(signal, "fundamentals"), cat(signal, "growth")) < 56) return null;
      return { id: "discounted_quality", why: "Large-cap quality at a discounted entry" };
    },
  },
];

export function forYouFilterById(id: ForYouFilterId): ForYouFilterDef | undefined {
  return FOR_YOU_FILTERS.find((f) => f.id === id);
}

export interface ForYouComposition {
  /** The feed to render: matched names when filters are active, else the whole ranked board. */
  ranked: RankedSignal[];
  /** Non-matching remainder (rendered behind a divider) while filters are active. */
  backfill: RankedSignal[];
  /** Per-filter match counts across the board (for chip badges). */
  counts: Partial<Record<ForYouFilterId, number>>;
  /** The validated active filter set actually applied. */
  activeFilters: ForYouFilterId[];
}

/** Names matching several active filters float above single-filter matches. */
const MULTI_FILTER_BONUS = 6;

/**
 * Compose the For-You feed: personalize (base rank + learned boosts + risk
 * dial) then partition by the active filter toggles. Pure; recomputes in
 * memory on every preference change.
 */
export function composeForYou(
  signals: StockSignal[],
  prefs: UserPreferences,
): ForYouComposition {
  const active = (prefs.forYouFilters ?? []).filter(
    (id): id is ForYouFilterId => forYouFilterById(id) != null,
  );
  const base = personalize(signals, prefs);
  if (active.length === 0) {
    return { ranked: base, backfill: [], counts: {}, activeFilters: [] };
  }

  const defs = active.map((id) => forYouFilterById(id)!) ;
  const counts: Partial<Record<ForYouFilterId, number>> = {};
  const matched: RankedSignal[] = [];
  const backfill: RankedSignal[] = [];

  for (const entry of base) {
    // "Less like this" stays meaningful under filters: muted names never jump
    // the divider just because they match a toggle.
    if (prefs.mutedTickers.includes(entry.signal.ticker)) {
      backfill.push(entry);
      continue;
    }
    const hits: FilterHit[] = [];
    for (const def of defs) {
      const hit = def.evaluate(entry.signal, prefs);
      if (hit) hits.push(hit);
    }
    if (hits.length === 0) {
      backfill.push(entry);
      continue;
    }
    for (const hit of hits) counts[hit.id] = (counts[hit.id] ?? 0) + 1;
    matched.push({
      signal: entry.signal,
      matchScore: Math.min(
        100,
        Math.round(entry.matchScore + (hits.length - 1) * MULTI_FILTER_BONUS),
      ),
      reasons: [...hits.map((h) => h.why), ...entry.reasons].slice(0, 3),
    });
  }

  matched.sort((a, b) => b.matchScore - a.matchScore);
  return { ranked: matched, backfill, counts, activeFilters: active };
}
