import type { CompanyData } from "@/types";
import { isFmpConfigured } from "@/data/http";
import { fmpScreener, type FmpScreenerParams, type FmpScreenerRow } from "@/data/fmp/fmpClient";
import { companyFromScreenerRow } from "@/data/fmp/fmpUniverse";
import { fetchUsSymbolList } from "@/data/funnel/symbolList";
import {
  DEFAULT_PREFILTER_GATES,
  prefilterUniverse,
  type ScreenerCandidate,
} from "@/data/funnel/prefilter";
import { deriveFunnelSize, type FunnelBudget } from "@/data/funnel/budget";
import { blendDiscoveryModes } from "@/data/funnel/modes";
import { getCurrentRiskAppetite, riskAdjustGates } from "@/feed/riskTilt";
import type { DataProvider } from "./types";

/**
 * Full-Market Funnel - the challenger's universe source.
 *
 * Instead of a fixed ~75-name list or a 48-name AI-discovery cap, the funnel
 * sweeps the whole investable US market each run:
 *   Stage 0 - the cached list of US common stocks (one Finnhub call/day) for an
 *              honest "out of ~X listed" headline + an ETF/warrant strip.
 *   Stage 0b - a broad FMP screener sweep (a handful of calls) that returns
 *              price / cap / volume / beta for the liquid universe.
 *   Stage 1 - a PURE prefilter applies the liquidity / price / size floors and
 *              ranks survivors with a small/mid (anti-megacap) tilt, slicing the
 *              budget-derived top-N for full per-name hydration + scoring.
 *
 * Hydration reuses `companyFromScreenerRow` (no extra calls); the live enrichment
 * lanes in runResearch then layer real history / fundamentals / news / social
 * onto the top-N. LIVE only - the mock universe stays 326-name and ungated so
 * Blueprint's niche screens never come up empty.
 */

/**
 * Broad, full-market screener sweeps spanning the cap spectrum at the liquidity
 * floor. NOT niche-themed - the point is breadth. Counts as a handful of FMP
 * calls total (Stage 0b), negligible against the daily budget.
 */
const MARKET_SWEEPS: FmpScreenerParams[] = [
  { marketCapMoreThan: 50_000_000, marketCapLowerThan: 1_000_000_000, volumeMoreThan: 100_000, isActivelyTrading: true, limit: 600 },
  { marketCapMoreThan: 1_000_000_000, marketCapLowerThan: 10_000_000_000, volumeMoreThan: 150_000, isActivelyTrading: true, limit: 500 },
  { marketCapMoreThan: 10_000_000_000, marketCapLowerThan: 100_000_000_000, volumeMoreThan: 200_000, isActivelyTrading: true, limit: 300 },
  { marketCapMoreThan: 100_000_000_000, volumeMoreThan: 300_000, isActivelyTrading: true, limit: 200 },
];

/**
 * Reserve this many top-by-cap slots so the anti-megacap discovery tilt can't
 * slice the market's biggest companies (or a fresh mega-cap IPO) out of the
 * universe - the client parallel to the cloud scan's market-majors seed. Bounded
 * so the small/mid discovery thesis still fills the bulk of the budget.
 */
const GUARANTEE_TOP_CAP = 150;

export interface FunnelTelemetry {
  /** Listed US common stocks (Stage 0). 0 when the symbol list was unavailable. */
  listed: number;
  /** Distinct screener candidates considered. */
  screened: number;
  /** Candidates clearing every floor gate. */
  passed: number;
  /** Names actually hydrated + scored. */
  scored: number;
  /** Budget-derived target N for this run. */
  targetN: number;
  /** Vendor whose remaining budget capped N (if any). */
  binding: FunnelBudget["binding"];
}

export class FunnelDataProvider implements DataProvider {
  readonly id = "funnel";
  readonly name = "Full-Market Funnel";
  readonly isLive = true;

  private lastTelemetry: FunnelTelemetry | null = null;

  async fetchUniverse(): Promise<CompanyData[]> {
    if (!isFmpConfigured()) {
      throw new Error(
        "Full-Market Funnel needs VITE_FMP_API_KEY for the screener sweep that prices the universe.",
      );
    }

    // Stage 0: full list of US common stocks (one cached call/day).
    const list = await fetchUsSymbolList();
    const commonSet = new Set(list.symbols);

    // Stage 0b: broad screener sweep → metric-bearing rows across the cap spectrum.
    const rowBySymbol = new Map<string, FmpScreenerRow>();
    const candidates: ScreenerCandidate[] = [];
    for (const sweep of MARKET_SWEEPS) {
      const rows = await fmpScreener(sweep);
      for (const r of rows) {
        const sym = r.symbol?.trim().toUpperCase();
        if (!sym || r.price == null || r.price <= 0) continue;
        if (commonSet.size > 0 && !commonSet.has(sym)) continue; // strip ETFs / warrants / units
        if (rowBySymbol.has(sym)) continue;
        rowBySymbol.set(sym, r);
        candidates.push({
          symbol: sym,
          price: r.price,
          marketCap: r.marketCap ?? 0,
          dollarVolume: (r.volume ?? 0) * r.price,
          beta: r.beta,
          sector: r.sector,
        });
      }
    }

    // Stage 1: gate the pool (the risk dial widens/tightens the floors, knob #1),
    // then re-rank the survivors by the blended discovery modes (Mission 5) and
    // slice the budget-derived top-N.
    const budget = deriveFunnelSize();
    const gates = riskAdjustGates(DEFAULT_PREFILTER_GATES, getCurrentRiskAppetite());
    const result = prefilterUniverse(candidates, gates, candidates.length);
    const selected = blendDiscoveryModes(
      result.passed,
      budget.n,
      undefined,
      undefined,
      Math.min(GUARANTEE_TOP_CAP, budget.n),
    );

    const universe: CompanyData[] = [];
    for (const c of selected) {
      const row = rowBySymbol.get(c.symbol);
      const company = row ? companyFromScreenerRow(row) : null;
      if (company) universe.push(company);
    }

    this.lastTelemetry = {
      listed: list.total,
      screened: result.screenedCount,
      passed: result.passedCount,
      scored: universe.length,
      targetN: budget.n,
      binding: budget.binding,
    };

    if (universe.length === 0) {
      throw new Error(
        "Full-Market Funnel produced no candidates — check FMP screener access and daily budgets.",
      );
    }
    return universe;
  }

  /** Honest one-line summary of the last funnel run (shown on the run + tab). */
  telemetry(): string | undefined {
    const t = this.lastTelemetry;
    if (!t) return undefined;
    const fmt = (n: number) => n.toLocaleString("en-US");
    const listed = t.listed > 0 ? `${fmt(t.listed)} listed → ` : "";
    return `${listed}${fmt(t.screened)} screened → ${fmt(t.passed)} passed gates → scored top ${fmt(t.scored)}`;
  }

  /** Structured telemetry for surfaces that want the numbers, not the string. */
  funnelTelemetry(): FunnelTelemetry | null {
    return this.lastTelemetry;
  }
}
