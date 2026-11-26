import { httpJson } from "@/data/http";
import { secEndpoint } from "@/data/sec/secEndpoint";
import { loadCikIndex } from "@/data/sec/secFilings";

/**
 * SEC XBRL "frames" → the FORWARD PIPELINE inputs (RPO / backlog / deferred
 * revenue) the `pipeline` scoring dimension was designed around but never had.
 *
 * WHY THIS EXISTS
 * The engine already scores a forward-pipeline dimension (weight 0.10-0.18
 * depending on cohort) whose whole job is to catch CONTRACTED demand before it
 * shows up in recognized revenue. In production it was scoring a flat neutral 50
 * for 100% of the published board, because nothing ever populated
 * `CompanyData.pipeline` - so the dimension carried real weight and zero
 * information. The board audit that found this is `scripts/diag_coverage.mts`.
 *
 * The canonical example: Oracle's remaining performance obligation went
 * $137.8B (FY2025) → $638.0B (FY2026) - contracted demand up ~363% - while
 * RECOGNIZED revenue grew ~17%. That gap is the entire "the market is pricing
 * the spend, not the bookings" thesis, and it is a disclosed, primary-source
 * number sitting in every 10-Q/10-K as us-gaap:RevenueRemainingPerformanceObligation.
 *
 * WHY `frames` AND NOT `companyfacts`
 * `companyfacts` is one multi-megabyte document PER COMPANY. `frames` returns
 * ONE calendar period for EVERY filer in a single response (~650-750 companies
 * per RPO frame), so the whole universe costs ~20 requests instead of ~500
 * multi-MB ones. SEC fair-access friendly and fast enough for the daily scan.
 *
 * HONESTY RULES (non-negotiable, see docs/data-sources.md)
 *   • Every value is a DISCLOSED filing figure. Nothing is modeled or inferred.
 *   • A company that does not report RPO simply gets no pipeline block, and the
 *     dimension stays a cold-start neutral 50 - never a fabricated number and
 *     never a penalty.
 *   • Mis-scaled filings are REAL (a ~$700M-revenue dredging company tagging a
 *     $763B "backlog"), so implausible values are DROPPED rather than ranked -
 *     see {@link PLAUSIBILITY}.
 */

/** Instantaneous (point-in-time) balance-style tags, probed on `...QnI` frames. */
const RPO_TAG = "RevenueRemainingPerformanceObligation";
const CONTRACT_LIABILITY_TAG = "ContractWithCustomerLiability";
const DEFERRED_REVENUE_TAG = "DeferredRevenue";
/** Duration (flow) revenue tags, probed on annual `CYxxxx` frames, best first. */
const REVENUE_TAGS = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"] as const;
/**
 * BANK / LENDER revenue. The standard revenue tags capture only NON-interest
 * income for a lender, which understates the top line badly: SoFi's derived net
 * margin came out at 78% and its own-history valuation percentile could not be
 * computed at all. Total revenue for these filers is interest income plus
 * non-interest income, so both legs are summed when the standard tags are absent.
 */
const INTEREST_REVENUE_TAGS = [
  "InterestAndDividendIncomeOperating",
  "RevenuesNetOfInterestExpense",
] as const;
const NONINTEREST_REVENUE_TAGS = ["NoninterestIncome"] as const;
/** Duration cash-flow tags → real free cash flow (operating cash flow − capex). */
const OCF_TAG = "NetCashProvidedByUsedInOperatingActivities";
/** Bottom-line profit, for a primary-source net margin. */
const NET_INCOME_TAG = "NetIncomeLoss";
const CAPEX_TAGS = [
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "PaymentsToAcquireProductiveAssets",
] as const;

/**
 * Guards against mis-tagged / mis-scaled filings. These are not opinions about
 * what makes a good stock - they are "this number cannot be literally true"
 * bounds, applied so one bad filing can never out-rank real disclosures.
 */
const PLAUSIBILITY = {
  /** Backlog beyond this multiple of annual revenue reads as a filing error. */
  maxBacklogToRevenue: 60,
  /** Year-over-year backlog growth beyond this ratio reads as a units change. */
  maxBacklogYoY: 12,
  /** Ignore sub-$1M values - noise, and never material to a scored name. */
  minUsd: 1_000_000,
};

/** How many calendar quarters back to probe for the instantaneous tags. */
const QUARTERS_BACK = 9;
/** How many annual frames back to probe for revenue. */
/**
 * How many annual frames back to probe for revenue.
 */
const YEARS_BACK = 6;
const FETCH_TIMEOUT_MS = 20_000;

export interface XbrlPipelineFacts {
  /** Disclosed RPO / backlog ÷ latest disclosed annual revenue. */
  backlogToRevTTM?: number;
  /** RPO growth vs ~4 quarters earlier, as a ratio (3.63 = +363%). */
  backlogYoY?: number;
  /** Contract-liability (deferred revenue) growth YoY, as a ratio. */
  deferredRevYoY?: number;
  /** Latest disclosed annual revenue in USD (the ratio denominator). */
  revenueTTM?: number;
  /** Raw latest RPO in USD, for explainers that want the hard number. */
  backlogUsd?: number;
  /** Period end date of `backlogUsd`, so the card can cite "as of". */
  backlogAsOf?: string;
  /**
   * The full dated RPO / backlog series (oldest -> newest) the latest figure was
   * taken from. Carried so a point-in-time replay can step back to the last
   * point that was actually PUBLIC on a given day instead of losing the whole
   * order book when the newest quarter is censored. Not used by the live scan.
   */
  backlogSeries?: Array<{ end: string; val: number }>;
  /** Same, for contract liabilities (deferred revenue). */
  deferredSeries?: Array<{ end: string; val: number }>;

  /**
   * Free cash flow ÷ revenue, from DISCLOSED operating cash flow minus capex.
   *
   * WHY THIS MATTERS MORE THAN IT LOOKS: `fcfMargin` was disclosed for 0% of the
   * live board, which silently disabled the solvency risk penalty (it needs
   * "negative FCF and a short runway") for every single name. A micro-cap burning
   * several times its revenue was therefore rated "Low risk". It is also the other
   * half of the order-book story: a backlog that must be financed with debt-funded
   * capex before it converts is worth less than one that converts from existing
   * capacity - Oracle's FY26 was $32.0B of operating cash flow against $55.7B of
   * capex, i.e. FCF of about −$23.7B, which no dimension could see.
   */
  fcfMargin?: number;
  /** Disclosed free cash flow in USD (operating cash flow − capex). */
  freeCashFlowUsd?: number;
  /** Disclosed capex in USD, for the "what is the spend actually costing" read. */
  capexUsd?: number;

  /**
   * Net income ÷ revenue, both from the filer's own annual XBRL.
   *
   * WHY WE DO NOT TRUST THE VENDOR HERE: Finnhub reported SoFi at
   * `netProfitMarginTTM: -19.79` - while simultaneously reporting a POSITIVE
   * `peTTM` of 36.6, which is only possible with positive earnings. SoFi had in
   * fact just posted its tenth consecutive GAAP-profitable quarter. The same
   * response claimed `revenueGrowthTTMYoy: 205.5%` against an actual ~41%. A
   * vendor field that contradicts itself cannot be published as fact, so the
   * primary-source figure wins wherever it exists.
   */
  netMargin?: number;
  /** Revenue growth between the two most recent annual XBRL frames. */
  revenueGrowthYoY?: number;
  /**
   * Disclosed annual revenue by calendar-frame period, NEWEST FIRST. Feeds the
   * own-history valuation percentile: a multiple only means something against the
   * multiple this same company used to trade at.
   */
  revenueByYear?: Array<{ period: string; revenue: number }>;
  /**
   * Disclosed annual NET INCOME by period, newest first. Needed because a
   * price/sales percentile alone misreads any company whose MARGINS expanded:
   * Amazon's net margin went from ~2% to ~11%, so it looks mid-range on sales
   * while sitting near the cheap end of its own EARNINGS history. Ranking a name
   * against its own multiple has to allow for the multiple that actually re-rated.
   */
  netIncomeByYear?: Array<{ period: string; netIncome: number }>;
}

interface FrameRow {
  cik?: number;
  entityName?: string;
  end?: string;
  val?: number;
}
interface FrameResponse {
  data?: FrameRow[];
}

/** One point in a per-CIK time series built from the calendar frames. */
interface SeriesPoint {
  end: string;
  val: number;
}

function frameUrl(tag: string, period: string): string {
  return secEndpoint("data", `/api/xbrl/frames/us-gaap/${tag}/USD/${period}.json`);
}

/**
 * Calendar-quarter frame ids (newest first), e.g. `CY2026Q1I`. SEC buckets a
 * filer's fiscal period into the calendar quarter it falls in, so a May-year-end
 * company like Oracle still lands in the ordinary quarterly frames.
 */
function recentQuarterFrames(now: Date, count: number): string[] {
  const out: string[] = [];
  let year = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < count; i++) {
    out.push(`CY${year}Q${q}I`);
    q -= 1;
    if (q === 0) {
      q = 4;
      year -= 1;
    }
  }
  return out;
}

/**
 * Calendar-quarter DURATION frame ids (newest first), e.g. `CY2026Q2` - the
 * ~90-day facts a 10-Q files. The quarter in progress has no frame yet, so the
 * walk starts one quarter back.
 */
function recentDurationQuarterFrames(now: Date, count: number): string[] {
  const out: string[] = [];
  let year = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3); // previous quarter (1..4), 0 ⇒ Q4 of last year
  if (q === 0) {
    q = 4;
    year -= 1;
  }
  for (let i = 0; i < count; i++) {
    out.push(`CY${year}Q${q}`);
    q -= 1;
    if (q === 0) {
      q = 4;
      year -= 1;
    }
  }
  return out;
}

/** How many duration quarters to walk: eight for TTM vs prior TTM, plus slack. */
const DURATION_QUARTERS_BACK = 10;

/**
 * TRAILING-TWELVE-MONTH figures from discrete quarters (newest first slots).
 *
 * Fiscal-year growth is up to a year stale: on 2026-09-20 Amazon read "rev +12%"
 * (FY2025 over FY2024) while its last two quarters were +16.6% and +19.6% and
 * TTM was +15.8%. A filer's 10-K carries no discrete Q4, so the fourth quarter
 * is derived as FY − (Q1 + Q2 + Q3) when the annual frame and all three earlier
 * quarters exist, and only when the remainder is plausible against them
 * (0.5×–2× their mean) - an off-calendar filer whose quarters straddle two
 * fiscal years fails that test and falls back to the fiscal-year read. TTM is
 * the newest four CONSECUTIVE slots; growth needs the four before them too.
 */
interface TtmRead {
  ttm: number;
  prior?: number;
  /** Index of the newest slot the TTM starts at (0 = the newest frame walked). */
  at: number;
}

function ttmFromSlots(slots: Array<number | undefined>): TtmRead | undefined {
  for (let i = 0; i + 3 < slots.length; i++) {
    const w = slots.slice(i, i + 4);
    if (w.some((v) => v == null)) continue;
    const ttm = (w as number[]).reduce((a, b) => a + b, 0);
    const pw = slots.slice(i + 4, i + 8);
    const prior =
      pw.length === 4 && pw.every((v) => v != null) ? (pw as number[]).reduce((a, b) => a + b, 0) : undefined;
    return { ttm, prior, at: i };
  }
  return undefined;
}

/**
 * Fill each slot (newest first) from the discrete quarterly frames, deriving a
 * missing Q4 from the annual frame. `derivedOk` records which Q4 derivations
 * passed the plausibility test so a second series (net income, which can be
 * negative and has no ratio test) can reuse exactly the same structure.
 */
function quarterlySlots(
  frames: string[],
  byFrame: Map<string, number> | undefined,
  annualByYear: (year: number) => number | undefined,
  opts: { ratioTest: boolean; derivedOk?: Set<string>; recordOk?: Set<string> },
): Array<number | undefined> {
  return frames.map((frame) => {
    const direct = byFrame?.get(frame);
    if (direct != null) return direct;
    if (!frame.endsWith("Q4")) return undefined;
    const year = Number(frame.slice(2, 6));
    const fy = annualByYear(year);
    if (fy == null) return undefined;
    const q123 = [1, 2, 3].map((q) => byFrame?.get(`CY${year}Q${q}`));
    if (q123.some((v) => v == null)) return undefined;
    const sum = (q123 as number[]).reduce((a, b) => a + b, 0);
    const derived = fy - sum;
    if (opts.ratioTest) {
      const mean = sum / 3;
      if (!(mean > 0) || derived < mean * 0.5 || derived > mean * 2) return undefined;
      opts.recordOk?.add(frame);
      return derived;
    }
    // No ratio test possible (signed series): trust only a structure the
    // revenue side already validated for the same filer and year.
    return opts.derivedOk?.has(frame) ? derived : undefined;
  });
}

function recentAnnualFrames(now: Date, count: number): string[] {
  const out: string[] = [];
  // The current calendar year's annual frame does not exist until filings land,
  // so start one year back - a missing frame is skipped harmlessly anyway.
  for (let i = 1; i <= count; i++) out.push(`CY${now.getUTCFullYear() - i}`);
  return out;
}

async function fetchFrame(tag: string, period: string): Promise<FrameRow[]> {
  try {
    const json = await httpJson<FrameResponse>(frameUrl(tag, period), {
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    return Array.isArray(json?.data) ? json.data : [];
  } catch {
    // A missing frame (period not yet published) is normal, not an error.
    return [];
  }
}

/**
 * Build a per-CIK time series for one instantaneous tag by walking the recent
 * calendar frames. Later frames win for the same `end` date (restatements).
 */
async function buildSeries(
  tag: string,
  periods: string[],
  onProgress?: (msg: string) => void,
): Promise<Map<number, SeriesPoint[]>> {
  const byCik = new Map<number, Map<string, number>>();
  for (const period of periods) {
    const rows = await fetchFrame(tag, period);
    onProgress?.(`  ${tag} ${period}: ${rows.length} filers`);
    for (const row of rows) {
      const cik = row.cik;
      const val = row.val;
      const end = row.end;
      if (typeof cik !== "number" || typeof val !== "number" || !Number.isFinite(val)) continue;
      if (!end || val < PLAUSIBILITY.minUsd) continue;
      const series = byCik.get(cik) ?? new Map<string, number>();
      series.set(end, val);
      byCik.set(cik, series);
    }
  }
  const out = new Map<number, SeriesPoint[]>();
  for (const [cik, series] of byCik) {
    const points = [...series.entries()]
      .map(([end, val]) => ({ end, val }))
      .sort((a, b) => a.end.localeCompare(b.end));
    out.set(cik, points);
  }
  return out;
}

/** Latest point, and the point closest to one year before it. */
function latestAndYearAgo(points: SeriesPoint[]): { latest: SeriesPoint; yearAgo: SeriesPoint } | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1]!;
  const latestMs = Date.parse(latest.end);
  if (!Number.isFinite(latestMs)) return null;
  const targetMs = latestMs - 365 * 24 * 3600 * 1000;
  let best: SeriesPoint | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const p of points.slice(0, -1)) {
    const ms = Date.parse(p.end);
    if (!Number.isFinite(ms)) continue;
    const gap = Math.abs(ms - targetMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = p;
    }
  }
  // Only call it "year over year" when the comparison point is genuinely ~a year
  // back (±100 days). Otherwise we'd label a 2-quarter gap as YoY growth.
  if (!best || bestGap > 100 * 24 * 3600 * 1000) return null;
  return { latest, yearAgo: best };
}

function yoyRatio(pair: { latest: SeriesPoint; yearAgo: SeriesPoint } | null): number | undefined {
  if (!pair || pair.yearAgo.val <= 0) return undefined;
  const ratio = pair.latest.val / pair.yearAgo.val - 1;
  if (!Number.isFinite(ratio) || ratio > PLAUSIBILITY.maxBacklogYoY) return undefined;
  return ratio;
}

/**
 * Fetch the disclosed forward-pipeline facts for every filer that reports them,
 * keyed by UPPERCASE TICKER. Returns an empty map (never throws) when SEC is
 * unreachable, so the scan degrades to today's cold-start neutral behavior.
 */
export async function fetchXbrlPipelineByTicker(
  onProgress?: (msg: string) => void,
): Promise<Map<string, XbrlPipelineFacts>> {
  const out = new Map<string, XbrlPipelineFacts>();
  try {
    const now = new Date();
    const quarterFrames = recentQuarterFrames(now, QUARTERS_BACK);
    const annualFrames = recentAnnualFrames(now, YEARS_BACK);

    const [rpo, contractLiability, deferredRevenue] = [
      await buildSeries(RPO_TAG, quarterFrames, onProgress),
      await buildSeries(CONTRACT_LIABILITY_TAG, quarterFrames, onProgress),
      await buildSeries(DEFERRED_REVENUE_TAG, quarterFrames, onProgress),
    ];

    // Annual revenue per CIK, kept PER PERIOD so a year-over-year growth rate can
    // be computed from two primary-source figures rather than trusted from a
    // vendor field. Preferred tag first; a CIK already filled for a period is not
    // overwritten by the fallback tag.
    const revenueByPeriod = new Map<string, Map<number, number>>();
    for (const tag of REVENUE_TAGS) {
      for (const period of annualFrames) {
        const rows = await fetchFrame(tag, period);
        onProgress?.(`  ${tag} ${period}: ${rows.length} filers`);
        const bucket = revenueByPeriod.get(period) ?? new Map<number, number>();
        for (const row of rows) {
          if (typeof row.cik !== "number" || typeof row.val !== "number") continue;
          if (!Number.isFinite(row.val) || row.val < PLAUSIBILITY.minUsd) continue;
          if (!bucket.has(row.cik)) bucket.set(row.cik, row.val);
        }
        revenueByPeriod.set(period, bucket);
      }
    }
    // FINANCIALS: lenders report their top line under bank-taxonomy tags.
    //
    // Two cases, handled differently because they have different failure modes:
    //
    //   1. EXPLICIT TOTAL - `RevenuesNetOfInterestExpense` is the filer's own
    //      "total net revenue" line. A lender that ALSO tags
    //      `RevenueFromContractWithCustomerExcludingAssessedTax` is tagging only
    //      its fee income there, so the standard tag captures a FRACTION of the
    //      business. SoFi FY2025: $0.62B under the contract tag against $3.61B
    //      total net revenue - the standard-tag margin came out at 77%, tripped
    //      the >60% implausibility guard, and SoFi was published with NO margin
    //      at all (scored as if unprofitable, on a real ~13%). A disclosed total
    //      is a superset of its own component by definition, so where the total
    //      is present it OVERRIDES the standard figure whenever it is larger.
    //      To keep the year-over-year series comparable, the override applies to
    //      every period the total covers, and a period it does not cover is
    //      dropped for that filer rather than mixed with a partial figure.
    //   2. ADDITIVE FALLBACK - interest income (+ non-interest income) is only
    //      used for a filer the standard tags MISSED. Gross interest income is
    //      before interest expense, so this sum can overstate a bank's net
    //      revenue; it is a floor for coverage, never an override.
    const interestByPeriod = new Map<string, Map<number, number>>();
    const totalByPeriod = new Map<string, Map<number, number>>();
    for (const tag of [...INTEREST_REVENUE_TAGS, ...NONINTEREST_REVENUE_TAGS]) {
      for (const period of annualFrames) {
        const rows = await fetchFrame(tag, period);
        const bucket = interestByPeriod.get(period) ?? new Map<number, number>();
        const totals = totalByPeriod.get(period) ?? new Map<number, number>();
        for (const row of rows) {
          if (typeof row.cik !== "number" || typeof row.val !== "number") continue;
          if (!Number.isFinite(row.val) || row.val < PLAUSIBILITY.minUsd) continue;
          // `RevenuesNetOfInterestExpense` is already a total, so never add to it.
          const isTotal = tag === "RevenuesNetOfInterestExpense";
          const prior = bucket.get(row.cik) ?? 0;
          bucket.set(row.cik, isTotal ? Math.max(prior, row.val) : prior + row.val);
          if (isTotal) totals.set(row.cik, Math.max(totals.get(row.cik) ?? 0, row.val));
        }
        interestByPeriod.set(period, bucket);
        totalByPeriod.set(period, totals);
      }
    }
    const filersWithTotal = new Set<number>();
    for (const totals of totalByPeriod.values()) for (const cik of totals.keys()) filersWithTotal.add(cik);
    for (const period of annualFrames) {
      const standard = revenueByPeriod.get(period) ?? new Map<number, number>();
      const totals = totalByPeriod.get(period) ?? new Map<number, number>();
      for (const cik of filersWithTotal) {
        const total = totals.get(cik);
        const partial = standard.get(cik);
        if (total == null) {
          if (partial != null) standard.delete(cik);
        } else if (partial == null || total > partial) {
          standard.set(cik, total);
        }
      }
      for (const [cik, val] of interestByPeriod.get(period) ?? []) {
        if (!standard.has(cik)) standard.set(cik, val);
      }
      revenueByPeriod.set(period, standard);
    }
    // `annualFrames` is newest-first, so the first period a CIK appears in is its
    // most recent disclosed year. Built AFTER the lender pass so a filer whose
    // standard-tag figure was overridden reports the overridden number.
    const revenueByCik = new Map<number, number>();
    for (const period of annualFrames) {
      for (const [cik, val] of revenueByPeriod.get(period) ?? []) {
        if (!revenueByCik.has(cik)) revenueByCik.set(cik, val);
      }
    }

    // Bottom-line profit per CIK, newest annual frame first.
    const netIncomeByCik = new Map<number, number>();
    const netIncomeByPeriod = new Map<string, Map<number, number>>();
    for (const period of annualFrames) {
      const rows = await fetchFrame(NET_INCOME_TAG, period);
      onProgress?.(`  ${NET_INCOME_TAG} ${period}: ${rows.length} filers`);
      const bucket = netIncomeByPeriod.get(period) ?? new Map<number, number>();
      for (const row of rows) {
        if (typeof row.cik !== "number" || typeof row.val !== "number") continue;
        if (!Number.isFinite(row.val)) continue;
        bucket.set(row.cik, row.val);
        if (!netIncomeByCik.has(row.cik)) netIncomeByCik.set(row.cik, row.val);
      }
      netIncomeByPeriod.set(period, bucket);
    }

    // DISCRETE QUARTERS for trailing-twelve-month revenue, growth and margin.
    // Same tag precedence as the annual fold: the standard tags first, then a
    // lender's explicit total overrides its partial contract figure; the
    // additive interest fallback is not walked quarterly (its annual read
    // already covers the filers the standard tags miss).
    const durationFrames = recentDurationQuarterFrames(now, DURATION_QUARTERS_BACK);
    const quarterlyRevenue = new Map<number, Map<string, number>>();
    const quarterlyTotal = new Map<number, Map<string, number>>();
    for (const tag of REVENUE_TAGS) {
      for (const period of durationFrames) {
        const rows = await fetchFrame(tag, period);
        onProgress?.(`  ${tag} ${period}: ${rows.length} filers`);
        for (const row of rows) {
          if (typeof row.cik !== "number" || typeof row.val !== "number") continue;
          if (!Number.isFinite(row.val) || row.val < PLAUSIBILITY.minUsd / 4) continue;
          const m = quarterlyRevenue.get(row.cik) ?? new Map<string, number>();
          if (!m.has(period)) m.set(period, row.val);
          quarterlyRevenue.set(row.cik, m);
        }
      }
    }
    for (const period of durationFrames) {
      const rows = await fetchFrame("RevenuesNetOfInterestExpense", period);
      for (const row of rows) {
        if (typeof row.cik !== "number" || typeof row.val !== "number") continue;
        if (!Number.isFinite(row.val) || row.val < PLAUSIBILITY.minUsd / 4) continue;
        const m = quarterlyTotal.get(row.cik) ?? new Map<string, number>();
        m.set(period, Math.max(m.get(period) ?? 0, row.val));
        quarterlyTotal.set(row.cik, m);
      }
    }
    for (const cik of filersWithTotal) {
      const totals = quarterlyTotal.get(cik);
      const partial = quarterlyRevenue.get(cik) ?? new Map<string, number>();
      for (const period of durationFrames) {
        const total = totals?.get(period);
        const part = partial.get(period);
        if (total == null) {
          if (part != null) partial.delete(period);
        } else if (part == null || total > part) {
          partial.set(period, total);
        }
      }
      quarterlyRevenue.set(cik, partial);
    }
    const quarterlyNetIncome = new Map<number, Map<string, number>>();
    for (const period of durationFrames) {
      const rows = await fetchFrame(NET_INCOME_TAG, period);
      onProgress?.(`  ${NET_INCOME_TAG} ${period}: ${rows.length} filers`);
      for (const row of rows) {
        if (typeof row.cik !== "number" || typeof row.val !== "number") continue;
        if (!Number.isFinite(row.val)) continue;
        const m = quarterlyNetIncome.get(row.cik) ?? new Map<string, number>();
        if (!m.has(period)) m.set(period, row.val);
        quarterlyNetIncome.set(row.cik, m);
      }
    }

    // Annual operating cash flow and capex per CIK → real free cash flow.
    const ocfByCik = new Map<number, number>();
    for (const period of annualFrames) {
      const rows = await fetchFrame(OCF_TAG, period);
      onProgress?.(`  ${OCF_TAG} ${period}: ${rows.length} filers`);
      for (const row of rows) {
        if (typeof row.cik !== "number" || typeof row.val !== "number") continue;
        if (!Number.isFinite(row.val)) continue;
        if (!ocfByCik.has(row.cik)) ocfByCik.set(row.cik, row.val);
      }
    }
    const capexByCik = new Map<number, number>();
    for (const tag of CAPEX_TAGS) {
      for (const period of annualFrames) {
        const rows = await fetchFrame(tag, period);
        onProgress?.(`  ${tag} ${period}: ${rows.length} filers`);
        for (const row of rows) {
          if (typeof row.cik !== "number" || typeof row.val !== "number") continue;
          if (!Number.isFinite(row.val)) continue;
          if (!capexByCik.has(row.cik)) capexByCik.set(row.cik, row.val);
        }
      }
    }

    const tickerByCik = new Map<number, string>();
    const cikIndex = await loadCikIndex();
    for (const [ticker, cik10] of cikIndex) {
      const cik = Number(cik10);
      if (Number.isFinite(cik) && !tickerByCik.has(cik)) tickerByCik.set(cik, ticker);
    }

    // Every filer that disclosed ANY of the inputs. A filer with a bottom line and
    // a top line but no operating-cash-flow tag (some file the continuing-
    // operations variant) still has a real net margin to publish.
    const ciks = new Set<number>([
      ...rpo.keys(),
      ...contractLiability.keys(),
      ...deferredRevenue.keys(),
      ...ocfByCik.keys(),
      ...netIncomeByCik.keys(),
    ]);

    for (const cik of ciks) {
      const ticker = tickerByCik.get(cik);
      if (!ticker) continue;

      const rpoPoints = rpo.get(cik) ?? [];
      const rpoPair = latestAndYearAgo(rpoPoints);
      const latestRpo = rpoPoints[rpoPoints.length - 1];
      const revenue = revenueByCik.get(cik);

      // Trailing-twelve-month revenue / net income from discrete quarters (see
      // ttmFromSlots). Accepted only when it is the same order of magnitude as
      // the newest fiscal year - a units change or restatement fails here.
      const derivedOk = new Set<string>();
      const revSlots = quarterlySlots(
        durationFrames,
        quarterlyRevenue.get(cik),
        (y) => revenueByPeriod.get(`CY${y}`)?.get(cik),
        { ratioTest: true, recordOk: derivedOk },
      );
      const revTtm = ttmFromSlots(revSlots);
      const ttmPlausible =
        revTtm != null && revTtm.ttm > 0 && (revenue == null || (revTtm.ttm >= revenue * 0.5 && revTtm.ttm <= revenue * 2));
      const niSlots = quarterlySlots(
        durationFrames,
        quarterlyNetIncome.get(cik),
        (y) => netIncomeByPeriod.get(`CY${y}`)?.get(cik),
        { ratioTest: false, derivedOk },
      );
      const niTtm = ttmPlausible ? ttmFromSlots(niSlots) : undefined;
      // The two windows must be the SAME four quarters for a margin to mean anything.
      const niTtmAligned = niTtm != null && revTtm != null && niTtm.at === revTtm.at ? niTtm : undefined;

      // Contract liability is the modern (ASC 606) tag; DeferredRevenue is the
      // legacy one. Use whichever produced a genuine YoY pair.
      const deferredYoY =
        yoyRatio(latestAndYearAgo(contractLiability.get(cik) ?? [])) ??
        yoyRatio(latestAndYearAgo(deferredRevenue.get(cik) ?? []));

      const facts: XbrlPipelineFacts = {};

      // The order book is measured against the CURRENT twelve months of revenue
      // when the quarters resolve, else the newest fiscal year.
      const revenueDenominator = ttmPlausible && revTtm != null ? revTtm.ttm : revenue;
      if (latestRpo && revenueDenominator && revenueDenominator > 0) {
        const ratio = latestRpo.val / revenueDenominator;
        // Drop physically implausible ratios (mis-scaled filings) rather than
        // letting a filing error out-rank genuine disclosures.
        if (Number.isFinite(ratio) && ratio > 0 && ratio <= PLAUSIBILITY.maxBacklogToRevenue) {
          facts.backlogToRevTTM = ratio;
          facts.revenueTTM = revenueDenominator;
        }
      }
      if (latestRpo) {
        facts.backlogUsd = latestRpo.val;
        facts.backlogAsOf = latestRpo.end;
      }
      if (rpoPoints.length > 0) facts.backlogSeries = rpoPoints.map((p) => ({ end: p.end, val: p.val }));
      const clPoints = contractLiability.get(cik) ?? deferredRevenue.get(cik) ?? [];
      if (clPoints.length > 0) facts.deferredSeries = clPoints.map((p) => ({ end: p.end, val: p.val }));
      const backlogYoY = yoyRatio(rpoPair);
      if (backlogYoY != null) facts.backlogYoY = backlogYoY;
      if (deferredYoY != null) facts.deferredRevYoY = deferredYoY;

      // Real free cash flow. Capex is filed as a POSITIVE outflow, so it is
      // subtracted. A filer that reports operating cash flow but no capex line is
      // treated as zero capex only when it also reports revenue - otherwise we
      // would invent an FCF for a company that simply did not tag the field.
      const ocf = ocfByCik.get(cik);
      if (ocf != null && revenue && revenue > 0) {
        const capex = capexByCik.get(cik) ?? 0;
        const fcf = ocf - Math.abs(capex);
        const margin = fcf / revenue;
        // Bound against mis-scaled filings the same way the backlog ratio is.
        if (Number.isFinite(margin) && Math.abs(margin) <= 20) {
          facts.fcfMargin = margin;
          facts.freeCashFlowUsd = fcf;
          if (capexByCik.has(cik)) facts.capexUsd = Math.abs(capex);
          if (facts.revenueTTM == null) facts.revenueTTM = revenue;
        }
      }

      // Primary-source net margin: trailing twelve months over the SAME four
      // quarters when they resolve, else fiscal year over fiscal year.
      //
      // GUARD - an INCOMPLETE revenue line, not an amazing business. The standard
      // revenue tags capture contract/product revenue; for banks and lenders they
      // miss net interest income entirely, so the denominator can be a fraction of
      // the real top line. SoFi came out at a 78% "net margin" that way, against an
      // actual ~15%. The lender total-revenue override above now removes that
      // class at the source, so the ceiling sits at 75%: Nvidia's genuine 64%
      // trailing margin (Q1 FY27 ran 71%) passes, a 77% partial-line artifact
      // still does not. Publishing NOTHING remains the safer error above it.
      const MAX_PLAUSIBLE_MARGIN = 0.75;
      const netIncome = netIncomeByCik.get(cik);
      const marginCandidates: Array<[number | undefined, number | undefined]> = [
        [niTtmAligned?.ttm, niTtmAligned != null ? revTtm?.ttm : undefined],
        [netIncome, revenue],
      ];
      for (const [num, den] of marginCandidates) {
        if (num == null || !den || den <= 0) continue;
        const margin = num / den;
        if (Number.isFinite(margin) && margin <= MAX_PLAUSIBLE_MARGIN && margin >= -20) {
          facts.netMargin = margin;
          break;
        }
      }

      // Primary-source revenue growth. Trailing twelve months against the prior
      // twelve when eight consecutive quarters resolve - the CURRENT run-rate -
      // otherwise the two most recent annual frames the filer actually appears in
      // (they may not be consecutive calendar years for an off-calendar fiscal
      // year, which is why both are looked up explicitly).
      if (ttmPlausible && revTtm != null) {
        facts.revenueTTM = revTtm.ttm;
        if (revTtm.prior != null && revTtm.prior > 0) {
          const growth = revTtm.ttm / revTtm.prior - 1;
          if (Number.isFinite(growth) && growth > -1 && growth <= 10) facts.revenueGrowthYoY = growth;
        }
      }
      const periodsWithCik = annualFrames.filter((p) => revenueByPeriod.get(p)?.has(cik));
      if (facts.revenueGrowthYoY == null && periodsWithCik.length >= 2) {
        const newest = revenueByPeriod.get(periodsWithCik[0]!)!.get(cik)!;
        const prior = revenueByPeriod.get(periodsWithCik[1]!)!.get(cik)!;
        if (prior > 0) {
          const growth = newest / prior - 1;
          // A >10x jump is an acquisition or a restatement, not organic growth.
          if (Number.isFinite(growth) && growth > -1 && growth <= 10) {
            facts.revenueGrowthYoY = growth;
          }
        }
      }

      // Multi-year revenue series (newest first) for the own-history multiple.
      const series = annualFrames
        .map((period) => ({ period, revenue: revenueByPeriod.get(period)?.get(cik) }))
        .filter((r): r is { period: string; revenue: number } => r.revenue != null && r.revenue > 0);
      if (series.length >= 3) facts.revenueByYear = series;

      const niSeries = annualFrames
        .map((period) => ({ period, netIncome: netIncomeByPeriod.get(period)?.get(cik) }))
        .filter((r): r is { period: string; netIncome: number } => r.netIncome != null);
      if (niSeries.length >= 3) facts.netIncomeByYear = niSeries;

      // Only publish a block that carries at least one usable signal.
      if (
        facts.backlogToRevTTM != null ||
        facts.backlogYoY != null ||
        facts.deferredRevYoY != null ||
        facts.fcfMargin != null ||
        facts.netMargin != null ||
        facts.revenueGrowthYoY != null
      ) {
        out.set(ticker, facts);
      }
    }
  } catch {
    return out;
  }
  return out;
}
