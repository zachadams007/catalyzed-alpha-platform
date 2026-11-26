/**
 * Heatmap data model - pure transforms from scored signals into the treemap's
 * input. No React, no store access: the page reads `signals` (and an optional
 * live-price overlay) and hands them here.
 */

import type { Sector, StockSignal } from "@/types";
import { formatMarketCap, formatPct, isPlausibleMarketCap } from "@/lib/format";
import { MARKET_MAJORS, MARKET_MAJOR_SECTOR } from "@/data/symbols/majors.generated";
import type { HeatMode, HypeDomain } from "@/components/heatmap/colorScale";
import type { TreemapGroup } from "@/components/heatmap/treemap";

/**
 * Trusted-cap supplements that aren't yet in the auto-generated majors roster.
 * SpaceX (SPCX) IPO'd on NASDAQ on 2026-06-12 and is now a real public mega-cap
 * (~$2.44T, ~$185/sh - a top US name alongside NVDA/AAPL/MSFT). The weekly majors
 * snapshot predates the listing, so we seed a trusted fallback cap here until the
 * roster regenerates. The LIVE provider cap is always preferred when present and
 * plausible (≤ $5T); this dated value is only the trusted floor/fallback so the
 * "drop un-rostered megacap" gate never throws SPCX away.
 * Source: SpaceX (SPCX) NASDAQ debut, 2026-06-12; ~$2.44T cap (verified 2026-06-19).
 */
const SUPPLEMENTAL_TRUSTED_CAP: ReadonlyArray<readonly [string, number]> = [
  ["SPCX", 2.44e12],
];

/**
 * Trusted real caps for the genuine top US companies (auto-generated weekly from
 * a real provider), plus a few supplements ({@link SUPPLEMENTAL_TRUSTED_CAP}) for
 * newly-listed mega-caps the snapshot hasn't picked up yet. Two jobs on the map:
 *   1. CORRECT - if a roster name's cached cap is garbage (e.g. "B" Barrick at
 *      $11T), we render the roster's REAL cap instead, so the tile is sized
 *      truthfully.
 *   2. GATE - a name claiming a megacap-tier cap that is NOT in this roster is
 *      almost certainly a fabricated/units-bug value (the "LCID $2.65T",
 *      "NNE $24.95T" class). Such names are excluded so a single lie can't paint
 *      a giant tile. Real small/mid names (below the megacap floor) are untouched.
 */
const TRUSTED_CAP = new Map<string, number>([
  ...MARKET_MAJORS.map((m) => [m.ticker.toUpperCase(), m.marketCap] as const),
  ...SUPPLEMENTAL_TRUSTED_CAP.map(([t, c]) => [t.toUpperCase(), c] as const),
]);

/**
 * Megacap floor, in USD, safely below the smallest genuine top-200 company
 * (~$70B). A name claiming a cap at or above this that is absent from the
 * trusted roster is treated as bad data and dropped from the map.
 */
const MEGACAP_TRUST_FLOOR = 50e9;

/**
 * Resolve the cap to RENDER for a name. For a TRUSTED roster name we prefer the
 * LIVE provider cap when it's plausible (≤ {@link MAX_PLAUSIBLE_MARKET_CAP}) so a
 * real mega-cap tracks the market, and fall back to the trusted cap when the
 * provider value is garbage (the "B" Barrick $11T cached-lie class). For a name
 * NOT on the roster we take the provider cap only if it's plausible and not an
 * un-rostered megacap claim. Returns null when the name should be dropped (no
 * sane cap to size on).
 */
export function resolveMarketCap(ticker: string, providerCap: number): number | null {
  const sym = ticker.trim().toUpperCase();
  const trusted = TRUSTED_CAP.get(sym);
  if (trusted != null) {
    // Prefer the live provider cap ONLY when it's a believable DRIFT from the
    // trusted (weekly-refreshed) value - a real cap doesn't move more than ~50% in
    // a week. A provider cap wildly off the trusted one is a synthetic-seed lie
    // that's still under the $5T plausibility ceiling (e.g. NFLX seeded at $4.3T vs
    // a real $0.32T, AMZN at $3.3T): those must NOT size the tile. Fall back to the
    // trusted cap. This is the sub-$5T analogue of the megacap garbage guard below.
    if (isPlausibleMarketCap(providerCap) && providerCap >= trusted * 0.5 && providerCap <= trusted * 1.6) {
      return providerCap;
    }
    return trusted;
  }
  if (!isPlausibleMarketCap(providerCap)) return null; // 0 / NaN / >$5T garbage
  if (providerCap >= MEGACAP_TRUST_FLOOR) return null; // un-rostered "megacap" = a lie
  return providerCap; // a real small/mid name the roster doesn't cover
}

/**
 * Resolve the sector to GROUP a name under. The daily scan's per-name sector
 * comes from Finnhub's coarse `finnhubIndustry`, and when that profile call is
 * throttled the name falls to a SYNTHETIC seed whose sector is hashed from the
 * ticker - so big names land in absurd buckets (TSLA→Real Estate, NVDA→Materials,
 * JPM→Utilities). For any name on the trusted majors roster we therefore prefer
 * its real, curated sector over the signal's; off-roster small/mid names keep the
 * signal sector (best available). This is the sector analogue of resolveMarketCap.
 */
export function resolveSector(ticker: string, signalSector: Sector): Sector {
  return MARKET_MAJOR_SECTOR[ticker.trim().toUpperCase()] ?? signalSector;
}

/** The flat per-company datum a tile renders from. */
export interface HeatTile {
  ticker: string;
  name: string;
  sector: Sector;
  marketCap: number;
  /** Last price (USD); live overlay preferred over the daily-scan price. 0 = unknown. */
  price: number;
  /** OUR blended opportunity score, 0..100. */
  opportunity: number;
  /** Intraday change as a ratio (0.034 = +3.4%); live overlay preferred. */
  dayChange: number;
  /** Composite "about to move" score, 0..100. */
  hype: number;
  /** Hype tier label ("On fire", …). */
  hypeTier: string;
}

export interface HeatModeMeta {
  mode: HeatMode;
  label: string;
  /** One-line description shown under the controls. */
  blurb: string;
  /** Short metric label for the tile + tooltip ("Score", "Day", "Hype"). */
  metricLabel: string;
}

export const HEAT_MODES: HeatModeMeta[] = [
  {
    mode: "opportunity",
    label: "Opportunity",
    blurb: "Our blended 0–100 opportunity score — azure runs hot, coral runs cold.",
    metricLabel: "Score",
  },
  {
    mode: "day",
    label: "Day move",
    blurb: "Today's price move — green for gainers, red for decliners, by magnitude.",
    metricLabel: "Day",
  },
  {
    mode: "hype",
    label: "Hype",
    blurb: "Attention & catalyst heat — cool slate warming to ember as a name lights up.",
    metricLabel: "Hype",
  },
];

/** Build the flat tile set, preferring live day-change + price overlays when present. */
export function buildHeatTiles(
  signals: StockSignal[],
  liveDayChange?: Record<string, number>,
  livePrice?: Record<string, number>,
): HeatTile[] {
  const tiles: HeatTile[] = [];
  for (const s of signals) {
    // Resolve the cap to RENDER: the trusted roster cap for a real megacap
    // (preferring its live cap, correcting a cached lie like "B" $11T), the
    // provider cap for a sane small/mid name, or null to DROP it - an absurd
    // ($24.95T) value or an un-rostered megacap claim ($2.65T for a small-cap).
    // A dropped garbage tile beats a giant fake.
    const marketCap = resolveMarketCap(s.ticker, s.marketCap);
    if (marketCap == null) continue;

    const live = liveDayChange?.[s.ticker];
    // Coerce any non-finite metric to a safe value - NaN would slip through
    // `??`, paint a broken/misleading tile, and print "NaN" on the label.
    const opportunity = Number.isFinite(s.score?.opportunityScore) ? s.score.opportunityScore : 0;
    const dayChange = Number.isFinite(live)
      ? (live as number)
      : Number.isFinite(s.dayChange)
        ? s.dayChange
        : 0;
    const hype = Number.isFinite(s.hype?.score) ? (s.hype!.score as number) : 0;
    const liveP = livePrice?.[s.ticker];
    const price = Number.isFinite(liveP)
      ? (liveP as number)
      : Number.isFinite(s.price)
        ? s.price
        : 0;
    tiles.push({
      ticker: s.ticker.trim().toUpperCase(),
      name: s.name,
      sector: resolveSector(s.ticker, s.sector),
      marketCap,
      price,
      opportunity,
      dayChange,
      hype,
      hypeTier: s.hype?.tier ?? "—",
    });
  }
  return tiles;
}

/** Group tiles by sector, ordered by total market cap (largest sector first). */
export function groupBySector(tiles: HeatTile[]): TreemapGroup<HeatTile>[] {
  const bySector = new Map<Sector, HeatTile[]>();
  for (const tile of tiles) {
    const list = bySector.get(tile.sector);
    if (list) list.push(tile);
    else bySector.set(tile.sector, [tile]);
  }
  return [...bySector.entries()]
    .map(([sector, items]) => ({
      key: sector,
      label: sector,
      items: items.sort((a, b) => b.marketCap - a.marketCap),
      total: items.reduce((sum, t) => sum + t.marketCap, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .map(({ key, label, items }) => ({ key, label, items }));
}

/** The raw metric value a mode reads from a tile. */
export function metricValue(mode: HeatMode, tile: HeatTile): number {
  if (mode === "day") return tile.dayChange;
  if (mode === "hype") return tile.hype;
  return tile.opportunity;
}

/** The metric value formatted for display in the active mode. */
export function metricText(mode: HeatMode, tile: HeatTile): string {
  if (mode === "day") return formatPct(tile.dayChange);
  if (mode === "hype") return String(Math.round(tile.hype));
  return String(Math.round(tile.opportunity));
}

export interface HeatStats {
  companies: number;
  sectors: number;
  totalCap: number;
  totalCapLabel: string;
  /** Names up on the day. */
  advancers: number;
  /** Names down on the day. */
  decliners: number;
  /** Names flat (no measurable move). */
  unchanged: number;
  /** Advancers as a share of the names that moved at all, 0..1. */
  advancersShare: number;
  /** Cap-weighted day move (ratio) - the "index" move of the whole map. */
  capWeightedMove: number;
  /** Signed change in total market cap today, in USD. */
  capChangeAbs: number;
  /** Signed compact label for {@link capChangeAbs} (e.g. "+$312.0B"). */
  capChangeLabel: string;
  /** Equal-weighted average day move (ratio). */
  avgMove: number;
  /** The single biggest absolute mover, or null when the map is empty. */
  biggestMover: { ticker: string; name: string; dayChange: number } | null;
  /** Sector with the strongest cap-weighted day move, or null when empty. */
  hottestSector: { sector: Sector; move: number } | null;
}

/** Signed compact market-cap label, e.g. "+$312.0B" / "−$1.20T" / "flat". */
function signedCapLabel(delta: number): string {
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e6) return "flat";
  return `${delta > 0 ? "+" : "−"}${formatMarketCap(Math.abs(delta))}`;
}

export function heatStats(tiles: HeatTile[]): HeatStats {
  const totalCap = tiles.reduce((sum, t) => sum + t.marketCap, 0);

  let up = 0;
  let down = 0;
  let flat = 0;
  let moveSum = 0;
  let capWeighted = 0; // Σ cap×day
  let capChangeAbs = 0; // Σ (cap − prevCap)
  let biggest: HeatStats["biggestMover"] = null;
  const sectorCapMove = new Map<Sector, { weighted: number; cap: number }>();
  const sectorSet = new Set<Sector>();

  for (const t of tiles) {
    const day = t.dayChange;
    if (day > 0) up++;
    else if (day < 0) down++;
    else flat++;

    moveSum += day;
    capWeighted += t.marketCap * day;
    // prevCap from today's cap and move; guard the degenerate (1+day) ≤ 0.
    const prevCap = 1 + day > 0 ? t.marketCap / (1 + day) : t.marketCap;
    capChangeAbs += t.marketCap - prevCap;

    if (!biggest || Math.abs(day) > Math.abs(biggest.dayChange)) {
      biggest = { ticker: t.ticker, name: t.name, dayChange: day };
    }

    sectorSet.add(t.sector);
    const agg = sectorCapMove.get(t.sector) ?? { weighted: 0, cap: 0 };
    agg.weighted += t.marketCap * day;
    agg.cap += t.marketCap;
    sectorCapMove.set(t.sector, agg);
  }

  let hottestSector: HeatStats["hottestSector"] = null;
  for (const [sector, agg] of sectorCapMove) {
    if (agg.cap <= 0) continue;
    const move = agg.weighted / agg.cap;
    if (!hottestSector || move > hottestSector.move) hottestSector = { sector, move };
  }

  const moved = up + down;
  return {
    companies: tiles.length,
    sectors: sectorSet.size,
    totalCap,
    totalCapLabel: formatMarketCap(totalCap),
    advancers: up,
    decliners: down,
    unchanged: flat,
    advancersShare: moved ? up / moved : 0,
    capWeightedMove: totalCap > 0 ? capWeighted / totalCap : 0,
    capChangeAbs,
    capChangeLabel: signedCapLabel(capChangeAbs),
    avgMove: tiles.length ? moveSum / tiles.length : 0,
    biggestMover: biggest,
    hottestSector,
  };
}

/**
 * The contrast-stretch window for the hype ramp - robust p6..p96 of the observed
 * hype scores, widened to a minimum spread so a near-flat field doesn't explode
 * tiny differences across the whole ramp. See {@link normalizeHype}.
 */
export function hypeDomain(tiles: HeatTile[]): HypeDomain {
  const scores = tiles
    .map((t) => t.hype)
    .filter((s) => Number.isFinite(s))
    .sort((a, b) => a - b);
  if (scores.length === 0) return { lo: 0, hi: 100 };

  const at = (q: number): number => {
    const idx = Math.min(scores.length - 1, Math.max(0, Math.round((scores.length - 1) * q)));
    return scores[idx]!;
  };

  let lo = at(0.06);
  let hi = at(0.96);
  const MIN_SPREAD = 16;
  if (hi - lo < MIN_SPREAD) {
    const mid = (hi + lo) / 2;
    lo = mid - MIN_SPREAD / 2;
    hi = mid + MIN_SPREAD / 2;
  }
  return { lo, hi };
}
