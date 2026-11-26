import type { CatalystType, CompanyData, RawCatalyst } from "@/types";
import { clamp, round } from "@/lib/math";

/**
 * Structured, materiality-scored catalyst event - the COMMON shape every real
 * catalyst source (SEC 8-K item codes, insider buy CLUSTERS, material sells,
 * and future sources: activist 13D, FDA/PDUFA, newsletters) emits, so the engine
 * sees one contract regardless of provenance.
 *
 * WHY THIS EXISTS (the pipeline gap this lane closes)
 * ---------------------------------------------------
 * Today `CompanyData.catalyst` is set ONLY by keyword inference over news
 * headlines (`inferCatalystFromNews`). The Terminal already pulls 8-K / Form 4 /
 * congress as `TerminalEvent[]` for the FEED UI, but those structured filings
 * NEVER reach the scoring engine - so Lane D's `catalystStrength()` /
 * `materialSellSignal()`, which are built to weight real events by
 * materiality × magnitude × recency, are starved of structured input. These
 * events fold the real filing signal into `CompanyData.catalyst` / `.secActivity`
 * where the engine already reads it.
 *
 * This module is the PURE spine: the event type + deterministic helpers (recency,
 * strength, dedupe, index, fold). It adds INPUTS to the engine; it never touches
 * the scoring WEIGHTS (Lane D owns those). All clocks are injected so the daily
 * research cache stays deterministic, exactly like `catalystStrength.ts`.
 */
export interface CatalystEvent {
  /** Uppercase US exchange symbol. */
  ticker: string;
  /** Maps onto the engine's `RawCatalyst.type`. */
  catalystType: CatalystType;
  /** ISO date the catalyst fired (past) or fires (upcoming). */
  date: string;
  /** One-line, plain-English description for the card/feed. */
  summary: string;
  /** Direct link to the underlying filing/disclosure. */
  sourceUrl: string;
  /**
   * Pre-recency materiality × magnitude, 0..1. This is what folds into
   * `RawCatalyst.magnitude` - recency stays the ENGINE's job (it re-derives
   * earliness from `daysAway`), so recency is applied EXACTLY ONCE downstream
   * rather than double-discounted.
   */
  magnitude: number;
  /**
   * Signed composite signal STRENGTH, 0..1 = `magnitude × recency(date)`, used to
   * pick the single strongest event per ticker, rank for dedupe, and drive the
   * feed tile. NEGATIVE for a disclosed material SELL / negative filing
   * (bankruptcy, delisting, cluster insider selling) so the negative-catalyst
   * rule can read the sign.
   */
  strength: number;
  /** True = a disclosed SELL / negative filing (downgrades the read). */
  negative?: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Whole days from now to the catalyst, matching `RawCatalyst.daysAway`'s sign
 * convention: POSITIVE = upcoming (days until), NEGATIVE = already happened
 * (still potentially fresh). Pure - the clock is injected.
 */
export function daysAwayFrom(dateIso: string, now: number = Date.now()): number {
  const t = new Date(dateIso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.round((t - now) / DAY_MS);
}

/**
 * Recency 0..1 used only to PICK the strongest event and to rank for the feed:
 * peaks near "imminent / just-fired", decays for the far-future (>~60d out) or
 * the stale (>~30d past). Deliberately mirrors `catalystEarliness` in
 * `catalystStrength.ts` so picking and scoring agree on what "fresh" means.
 */
export function recencyFactor(daysAway: number): number {
  if (daysAway >= 0) return clamp(1 - daysAway / 60, 0, 1); // upcoming
  return clamp(1 - -daysAway / 30, 0, 1); // already happened
}

/**
 * Signed composite strength for ranking/dedupe/feed: `magnitude × recency`,
 * negated for negative events. `magnitude` is the pre-recency materiality.
 */
export function eventStrength(magnitude: number, daysAway: number, negative = false): number {
  const s = clamp(magnitude, 0, 1) * recencyFactor(daysAway);
  return round(negative ? -s : s, 3);
}

/** Stable dedupe key: the source filing URL when present, else ticker|type|date. */
export function eventKey(e: CatalystEvent): string {
  if (e.sourceUrl) return e.sourceUrl;
  return `${e.ticker.trim().toUpperCase()}|${e.catalystType}|${e.date.slice(0, 10)}`;
}

/** Drop duplicate events (same filing surfaced twice / across sources), order-preserving. */
export function dedupeEvents(events: readonly CatalystEvent[]): CatalystEvent[] {
  const seen = new Set<string>();
  const out: CatalystEvent[] = [];
  for (const e of events) {
    const k = eventKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** Group events by uppercase ticker (events with no ticker are dropped). */
export function indexEventsByTicker(events: readonly CatalystEvent[]): Map<string, CatalystEvent[]> {
  const map = new Map<string, CatalystEvent[]>();
  for (const e of events) {
    const t = e.ticker.trim().toUpperCase();
    if (!t) continue;
    const list = map.get(t) ?? [];
    list.push(e);
    map.set(t, list);
  }
  return map;
}

/** The strongest POSITIVE event (max `strength` > 0) for a ticker, or null. */
export function strongestPositiveEvent(events: readonly CatalystEvent[]): CatalystEvent | null {
  let best: CatalystEvent | null = null;
  for (const e of events) {
    if (e.strength <= 0) continue;
    if (!best || e.strength > best.strength) best = e;
  }
  return best;
}

export interface FoldOptions {
  /** Reference "now" (epoch ms) for the recency window. Injectable for tests. */
  now?: number;
  /** Extra magnitude margin a live catalyst must clear before being overridden. */
  minMargin?: number;
}

/**
 * Fold the strongest positive catalyst event into `CompanyData.catalyst`.
 *
 * A real, DATED filing beats a keyword-inferred catalyst of equal/lower
 * magnitude (it's higher-credibility), and beats a MODELED placeholder even at a
 * somewhat lower magnitude. When it wins it replaces `catalyst`, flips
 * `catalystLive` true, and prepends the source link. Returns the SAME company
 * reference when nothing qualifies, so callers can detect "did anything change?"
 * by identity and the vast majority of names are untouched. Pure - clock injected.
 */
export function foldCatalystEventIntoCompany(
  company: CompanyData,
  events: readonly CatalystEvent[] | undefined,
  opts: FoldOptions = {},
): CompanyData {
  if (!events || events.length === 0) return company;
  const best = strongestPositiveEvent(events);
  if (!best) return company;

  const now = opts.now ?? Date.now();
  const margin = opts.minMargin ?? 0;
  const existing = company.catalyst;
  const existingMag = existing ? clamp(existing.magnitude, 0, 1) : 0;
  // A real event clears 100%+margin of a LIVE catalyst's magnitude, but only
  // 60% of a MODELED one - real, dated evidence outranks a placeholder.
  const modeled = company.catalystLive === false;
  const bar = existingMag * (modeled ? 0.6 : 1) + margin;
  if (best.magnitude + 1e-9 < bar) return company;

  const next: RawCatalyst = {
    type: best.catalystType,
    description: best.summary,
    daysAway: daysAwayFrom(best.date, now),
    magnitude: round(clamp(best.magnitude, 0, 1), 3),
  };
  const hasSource = !best.sourceUrl || company.sources.some((s) => s.url === best.sourceUrl);
  return {
    ...company,
    catalyst: next,
    catalystLive: true,
    sources: hasSource
      ? company.sources
      : [{ label: `${best.catalystType} catalyst`, url: best.sourceUrl }, ...company.sources],
  };
}
