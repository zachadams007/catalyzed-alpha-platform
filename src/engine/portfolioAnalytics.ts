import type { Portfolio, PortfolioQuote, PortfolioSplitAdjustment, Sector, StockSignal } from "@/types";

/**
 * Pure portfolio analytics. Turns a portfolio's holdings (ticker + optional
 * shares/cost) plus the current signal universe into allocation, value and P/L
 * numbers for the Portfolio detail view. No React, no store - fully testable and
 * reusable server-side later.
 */

export interface AllocationSegment {
  label: string;
  /** Absolute magnitude (USD market value, or equal-weight units in fallback). */
  value: number;
  /** Share of the whole, 0..1. */
  pct: number;
  color: string;
}

/** One holding placed inside its sector, for the concentric allocation rings. */
export interface AllocationHolding extends AllocationSegment {
  ticker: string;
  sector: string;
  /** Index of the parent sector in the sector ring (drives the outer-ring hue). */
  sectorIndex: number;
  /** Rank within the sector (0 = largest) - drives the within-sector tint step. */
  sectorRank: number;
}

/**
 * A sector and the holdings nested beneath it - the source for the concentric
 * "sector wraps holding" rings. Sectors and their holdings share the SAME angular
 * order, so a sector's outer arc sits directly above its holdings' inner arcs.
 */
export interface AllocationSectorGroup {
  label: string;
  /** Same as {@link label}; kept explicit for call-site clarity. */
  sector: string;
  value: number;
  /** Sector share of the whole, 0..1. */
  pct: number;
  color: string;
  sectorIndex: number;
  holdings: AllocationHolding[];
}

export interface HoldingRow {
  ticker: string;
  name?: string;
  sector?: Sector;
  shares?: number;
  costBasis?: number;
  /** Imported/snapshot value (USD) - present when no live price drives value. */
  importedValue?: number;
  price?: number;
  dayChange?: number;
  marketValue?: number;
  costValue?: number;
  pl?: number;
  plPct?: number;
  /** Share of portfolio value, 0..1 (value-based when tracked, else equal). */
  weight: number;
  hasSignal: boolean;
  opportunityScore?: number;
  note?: string;
  /** Present when a real detected stock split has rescaled this holding's shares/costBasis. */
  splitAdjustment?: PortfolioSplitAdjustment;
}

export interface PortfolioAnalytics {
  rows: HoldingRow[];
  totalValue: number;
  totalCost: number;
  totalPL: number;
  totalPLPct: number;
  dayChangeValue: number;
  dayChangePct: number;
  /** True when at least one holding has a share count. */
  tracked: boolean;
  /** Holdings that produced a market value. */
  valuedCount: number;
  sectorAllocation: AllocationSegment[];
  holdingAllocation: AllocationSegment[];
  /** Holdings nested inside their sector - for the concentric allocation rings. */
  sectorGroups: AllocationSectorGroup[];
  avgOpportunity: number | null;
  avgConfidence: number | null;
}

/**
 * Calm, distinct palette for allocation slices. Values are design tokens
 * (defined in tokens.css as --pf-slice-*) so the donut stays on-brand and
 * tokenized - they resolve when applied via an inline `style` stroke/background.
 */
const PALETTE_SIZE = 10;

export function sliceColor(index: number): string {
  return `var(--pf-slice-${(index % PALETTE_SIZE) + 1})`;
}

/** A single derived headline number for the vitals strip. */
export interface PortfolioVital {
  /** Stable key so the UI can pick an icon / tone. */
  key:
    | "best"
    | "worst"
    | "concentration"
    | "sector"
    | "mover"
    | "diversification";
  label: string;
  ticker?: string;
  /** Primary display value (already formatted by the caller via row data). */
  value: number;
  /** Optional secondary ratio (0..1) - pct move, weight share, etc. */
  ratio?: number;
  /** Sentiment for tinting; "neutral" when not directional. */
  tone: "positive" | "negative" | "neutral";
  detail: string;
}

export type PortfolioWarningKind = "concentration" | "sector" | "single-name" | "thin-coverage";

export interface PortfolioWarning {
  kind: PortfolioWarningKind;
  severity: "info" | "watch" | "risk";
  title: string;
  detail: string;
}

export interface PortfolioVitals {
  best?: PortfolioVital;
  worst?: PortfolioVital;
  /** Largest single-holding weight, 0..1. */
  concentration: number;
  concentrationTicker?: string;
  /** Largest sector weight, 0..1. */
  topSectorWeight: number;
  topSector?: string;
  /** Count of distinct sectors represented. */
  sectorCount: number;
  /** Biggest absolute day move among valued holdings. */
  mover?: PortfolioVital;
  /** Effective number of holdings (1 / sum of weight²) - diversification proxy. */
  effectiveHoldings: number;
  warnings: PortfolioWarning[];
}

/** Concentration thresholds - research guidance, never advice. */
const SINGLE_NAME_RISK = 0.35;
const SINGLE_NAME_WATCH = 0.25;
const SECTOR_RISK = 0.55;
const SECTOR_WATCH = 0.4;

/**
 * Derive the "vitals" headline numbers + concentration/sector warnings from an
 * already-computed analytics object. Pure and deterministic - best/worst by P/L
 * when tracked, concentration + sector tilt from weights, biggest day mover from
 * live day-change. Honest: returns undefined fields rather than fabricating.
 */
export function computePortfolioVitals(analytics: PortfolioAnalytics): PortfolioVitals {
  const { rows, sectorAllocation, holdingAllocation } = analytics;

  // Best / worst by realized-on-paper P/L percent (needs cost basis + value).
  const withPL = rows.filter((r) => r.plPct != null && Number.isFinite(r.plPct));
  const sortedPL = [...withPL].sort((a, b) => (b.plPct ?? 0) - (a.plPct ?? 0));
  const bestRow = sortedPL[0];
  const worstRow = sortedPL[sortedPL.length - 1];
  const best: PortfolioVital | undefined =
    bestRow && (bestRow.plPct ?? 0) > 0
      ? {
          key: "best",
          label: "Best performer",
          ticker: bestRow.ticker,
          value: bestRow.pl ?? 0,
          ratio: bestRow.plPct,
          tone: "positive",
          detail: `${bestRow.ticker} leads on return since cost`,
        }
      : undefined;
  const worst: PortfolioVital | undefined =
    worstRow && worstRow !== bestRow && (worstRow.plPct ?? 0) < 0
      ? {
          key: "worst",
          label: "Biggest drag",
          ticker: worstRow.ticker,
          value: worstRow.pl ?? 0,
          ratio: worstRow.plPct,
          tone: "negative",
          detail: `${worstRow.ticker} is furthest below cost`,
        }
      : undefined;

  // Concentration: the single largest holding weight.
  const topHolding = holdingAllocation[0];
  const concentration = topHolding?.pct ?? 0;
  const topSeg = sectorAllocation[0];
  const topSectorWeight = topSeg?.pct ?? 0;
  const sectorCount = sectorAllocation.length;

  // Biggest absolute day mover among valued holdings.
  const valuedMovers = rows.filter(
    (r) => r.dayChange != null && Number.isFinite(r.dayChange) && (r.marketValue ?? 0) > 0,
  );
  const moverRow = [...valuedMovers].sort(
    (a, b) => Math.abs(b.dayChange ?? 0) - Math.abs(a.dayChange ?? 0),
  )[0];
  const mover: PortfolioVital | undefined =
    moverRow && (moverRow.dayChange ?? 0) !== 0
      ? {
          key: "mover",
          label: "Day's biggest move",
          ticker: moverRow.ticker,
          value: (moverRow.marketValue ?? 0) * (moverRow.dayChange ?? 0),
          ratio: moverRow.dayChange,
          tone: (moverRow.dayChange ?? 0) > 0 ? "positive" : "negative",
          detail: `${moverRow.ticker} is the most active name today`,
        }
      : undefined;

  // Effective number of holdings (inverse Herfindahl) - a diversification proxy.
  const sumSq = holdingAllocation.reduce((a, s) => a + s.pct * s.pct, 0);
  const effectiveHoldings = sumSq > 0 ? 1 / sumSq : 0;

  // Warnings - concentration / sector tilt / thin live coverage.
  const warnings: PortfolioWarning[] = [];
  if (topHolding && concentration >= SINGLE_NAME_RISK) {
    warnings.push({
      kind: "single-name",
      severity: "risk",
      title: `${topHolding.label} is ${Math.round(concentration * 100)}% of the book`,
      detail:
        "A single name driving more than a third of the portfolio concentrates outcome on one story. Worth reviewing for balance.",
    });
  } else if (topHolding && concentration >= SINGLE_NAME_WATCH) {
    warnings.push({
      kind: "concentration",
      severity: "watch",
      title: `${topHolding.label} carries ${Math.round(concentration * 100)}% weight`,
      detail: "The top position is sizeable. Keep an eye on single-name risk as it grows.",
    });
  }
  if (topSeg && topSectorWeight >= SECTOR_RISK) {
    warnings.push({
      kind: "sector",
      severity: "risk",
      title: `${Math.round(topSectorWeight * 100)}% concentrated in ${topSeg.label}`,
      detail:
        "The book is heavily tilted to one sector, so it moves with that sector's cycle. Diversifying spreads the bet.",
    });
  } else if (topSeg && topSectorWeight >= SECTOR_WATCH) {
    warnings.push({
      kind: "sector",
      severity: "watch",
      title: `${topSeg.label} is the dominant sector at ${Math.round(topSectorWeight * 100)}%`,
      detail: "A meaningful sector tilt — fine if intentional, worth noting if not.",
    });
  }

  return {
    best,
    worst,
    concentration,
    concentrationTicker: topHolding?.label,
    topSectorWeight,
    topSector: topSeg?.label,
    sectorCount,
    mover,
    effectiveHoldings,
    warnings,
  };
}

type SignalLookup = (ticker: string) => StockSignal | undefined;
type QuoteLookup = (ticker: string) => PortfolioQuote | undefined;

function pct(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

export function computePortfolioAnalytics(
  portfolio: Portfolio,
  lookup: SignalLookup,
  quoteLookup?: QuoteLookup,
): PortfolioAnalytics {
  const tracked = portfolio.holdings.some(
    (h) => (h.shares ?? 0) > 0 || (h.value ?? 0) > 0,
  );

  const rows: HoldingRow[] = portfolio.holdings.map((h) => {
    const signal = lookup(h.ticker);
    const quote = quoteLookup?.(h.ticker);
    const price = quote?.price ?? signal?.price;
    const shares = h.shares;
    // Prefer a live valuation (shares × current price); otherwise fall back to
    // the imported/snapshot dollar value so allocation is still value-weighted.
    const liveValue = shares != null && price != null ? shares * price : undefined;
    const marketValue = liveValue ?? (h.value != null && h.value > 0 ? h.value : undefined);
    const costValue =
      shares != null && h.costBasis != null ? shares * h.costBasis : undefined;
    const pl =
      marketValue != null && costValue != null ? marketValue - costValue : undefined;
    const plPct = pl != null && costValue ? pl / costValue : undefined;

    return {
      ticker: h.ticker,
      name: signal?.name,
      sector: signal?.sector,
      shares,
      costBasis: h.costBasis,
      importedValue: liveValue == null && h.value != null && h.value > 0 ? h.value : undefined,
      price,
      dayChange: quote?.dayChange ?? signal?.dayChange,
      marketValue,
      costValue,
      pl,
      plPct,
      weight: 0, // filled below
      hasSignal: Boolean(signal),
      opportunityScore: signal?.score.opportunityScore,
      note: h.note,
      splitAdjustment: h.splitAdjustment,
    };
  });

  const valued = rows.filter((r) => r.marketValue != null);
  const totalValue = valued.reduce((a, r) => a + (r.marketValue ?? 0), 0);
  const totalCost = rows.reduce((a, r) => a + (r.costValue ?? 0), 0);
  const totalPL = rows.reduce((a, r) => a + (r.pl ?? 0), 0);
  const dayChangeValue = valued.reduce(
    (a, r) => a + (r.marketValue ?? 0) * (r.dayChange ?? 0),
    0,
  );

  // Weights: value-based when we have market values, else equal weight so the
  // donut still renders for watch-only portfolios.
  if (totalValue > 0) {
    for (const r of rows) r.weight = pct(r.marketValue ?? 0, totalValue);
  } else if (rows.length > 0) {
    for (const r of rows) r.weight = 1 / rows.length;
  }

  // Holding allocation (largest first).
  const holdingAllocation: AllocationSegment[] = rows
    .filter((r) => r.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((r, i) => ({
      label: r.ticker,
      value: totalValue > 0 ? (r.marketValue ?? 0) : r.weight,
      pct: r.weight,
      color: sliceColor(i),
    }));

  // Sector allocation.
  const bySector = new Map<string, number>();
  for (const r of rows) {
    if (r.weight <= 0) continue;
    const key = r.sector ?? "Unclassified";
    const add = totalValue > 0 ? (r.marketValue ?? 0) : r.weight;
    bySector.set(key, (bySector.get(key) ?? 0) + add);
  }
  const sectorTotal = [...bySector.values()].reduce((a, b) => a + b, 0);
  const sectorAllocation: AllocationSegment[] = [...bySector.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], i) => ({
      label,
      value,
      pct: pct(value, sectorTotal),
      color: sliceColor(i),
    }));

  // Concentric model: sectors (outer ring) each wrapping their holdings (inner
  // ring), in the SAME angular order so a sector's arc sits over its holdings.
  // Holdings are tinted by their parent sector's hue (color + sectorRank), so the
  // structure reads as colour "families" at a glance.
  const rowsBySector = new Map<string, HoldingRow[]>();
  for (const r of rows) {
    if (r.weight <= 0) continue;
    const key = r.sector ?? "Unclassified";
    const list = rowsBySector.get(key);
    if (list) list.push(r);
    else rowsBySector.set(key, [r]);
  }
  const sectorGroups: AllocationSectorGroup[] = sectorAllocation.map((sector, sectorIndex) => {
    const members = (rowsBySector.get(sector.label) ?? [])
      .slice()
      .sort((a, b) => b.weight - a.weight);
    return {
      label: sector.label,
      sector: sector.label,
      value: sector.value,
      pct: sector.pct,
      color: sliceColor(sectorIndex),
      sectorIndex,
      holdings: members.map((r, sectorRank) => ({
        label: r.ticker,
        ticker: r.ticker,
        sector: sector.label,
        sectorIndex,
        sectorRank,
        value: totalValue > 0 ? (r.marketValue ?? 0) : r.weight,
        pct: r.weight,
        color: sliceColor(sectorIndex),
      })),
    };
  });

  const scored = rows.filter((r) => r.opportunityScore != null);
  const avgOpportunity = scored.length
    ? Math.round(
        scored.reduce((a, r) => a + (r.opportunityScore ?? 0), 0) / scored.length,
      )
    : null;
  const withConfidence = portfolio.holdings
    .map((h) => lookup(h.ticker))
    .filter((s): s is StockSignal => Boolean(s));
  const avgConfidence = withConfidence.length
    ? Math.round(
        withConfidence.reduce((a, s) => a + s.confidence, 0) / withConfidence.length,
      )
    : null;

  return {
    rows,
    totalValue,
    totalCost,
    totalPL,
    totalPLPct: totalCost > 0 ? totalPL / totalCost : 0,
    dayChangeValue,
    dayChangePct: pct(dayChangeValue, totalValue),
    tracked,
    valuedCount: valued.length,
    sectorAllocation,
    holdingAllocation,
    sectorGroups,
    avgOpportunity,
    avgConfidence,
  };
}
