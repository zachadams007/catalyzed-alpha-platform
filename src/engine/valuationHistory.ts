import { clamp } from "@/lib/math";

/**
 * OWN-HISTORY VALUATION - is this name cheap relative to ITSELF, and has the
 * business outgrown the stock?
 *
 * WHY THIS EXISTS
 * Every valuation read in the engine was RELATIVE TO THE UNIVERSE (a
 * cross-sectional z) or relative to the name's own PRICE high. Neither answers
 * the question that actually decides these setups: is the market paying less for
 * a dollar of this company's sales than it used to?
 *
 * Independently, our own 2026-07-21 case research
 * (`docs/research/catalyzed-learning-loop-evidence-2026-07-21.md`) concluded that an
 * "own-history valuation percentile" was a required feature in ALL THREE named cases - Oracle,
 * SoFi and Microsoft. `CompanyData.valuation.peVsOwn5yrPctile` was built for exactly this and
 * `scoreValuation` already weights it at 0.25 - but nothing ever populated it, so it was
 * disclosed for 0% of the live board.
 *
 * THE TWO READINGS
 *   percentile - where today's valuation sits inside this company's own
 *                 multi-year range, on sales AND (where a real profitable history
 *                 exists) on earnings. 0 = cheapest it has been, 1 = the most
 *                 expensive. Amazon reads 0.20, Palantir 1.00.
 *   divergence - revenue CAGR minus price CAGR over the same window. Positive
 *                 means the business compounded faster than the stock, i.e. the
 *                 multiple COMPRESSED and the market is paying less for the same
 *                 sales. Negative means the stock ran ahead of the business.
 *
 * HONEST LIMITATION (stated, not hidden): this uses PRICE per dollar of revenue,
 * not strictly market-cap per dollar of revenue, because point-in-time share
 * counts are not fetched. For a heavy repurchaser (Oracle, Microsoft) the share
 * count shrinks, so price-per-revenue overstates today's multiple and the name
 * reads slightly MORE expensive than it truly is - a conservative error. For a
 * diluter the bias runs the other way, which is why {@link MIN_YEARS} requires a
 * real multi-year series before any of this is emitted at all.
 */

/** Fewer than this many disclosed annual revenue points ⇒ emit nothing. */
export const MIN_YEARS = 3;
/**
 * Profitable historical years required before the EARNINGS percentile is trusted.
 * Three, because a recently-profitable name has a short and flattering P/E past.
 */
export const MIN_EARNINGS_YEARS = 3;

export interface RevenueYear {
  /** SEC calendar frame id, e.g. "CY2024". */
  period: string;
  revenue: number;
}

export interface OwnHistoryValuation {
  /** 0 = cheapest in its own range, 1 = most expensive. Mean of the sales and
   *  earnings readings when both are trustworthy, else whichever exists. */
  percentile: number;
  /** The price/sales reading on its own. */
  salesPercentile: number;
  /** The price/earnings reading, when the company was profitable enough to have one. */
  earningsPercentile: number | null;
  /** Revenue CAGR minus price CAGR over the covered window, as a ratio. */
  divergence: number;
  /** Compound annual revenue growth over the window. */
  revenueCagr: number;
  /** Compound annual price growth over the window. */
  priceCagr: number;
  /** Today's price per dollar of annual revenue. */
  currentRatio: number;
  /** How many years the reading is built from. */
  years: number;
}

/** Calendar year an annual frame id refers to ("CY2024" → 2024). */
function frameYear(period: string): number | null {
  const m = /^CY(\d{4})$/.exec(period);
  return m ? Number(m[1]) : null;
}

/**
 * Close price at (or just before) the end of `year`, from a daily close series
 * whose LAST element is `asOf`. Returns null when the series does not reach back
 * that far - we never extrapolate a price we do not have.
 */
function closeAtYearEnd(
  closes: number[],
  asOf: Date,
  year: number,
  tradingDaysPerYear = 252,
): number | null {
  // How far back the END of `year` (31 Dec) sits from `asOf`, in years.
  //
  // This arithmetic was wrong once and it silently corrupted every reading: the
  // first version used `(asOf.year - year) + monthFraction`, which is a full year
  // too far back - in July 2026 it paired fiscal 2024 with a mid-2023 price rather
  // than a Dec-2024 one. Amazon then read as mid-range against its own earnings
  // history when it was in fact near the cheap end. Written explicitly as
  // "decimal now minus decimal year-end" so it stays checkable.
  const monthFraction = (asOf.getUTCMonth() + 1) / 12;
  const nowDecimal = asOf.getUTCFullYear() + monthFraction;
  const yearEndDecimal = year + 1;
  const yearsBack = nowDecimal - yearEndDecimal;
  if (yearsBack < 0) return null;
  const offsetDays = Math.round(yearsBack * tradingDaysPerYear);
  const idx = closes.length - 1 - offsetDays;
  if (idx < 0 || idx >= closes.length) return null;
  const value = closes[idx];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function cagr(from: number, to: number, years: number): number {
  if (from <= 0 || to <= 0 || years <= 0) return 0;
  return Math.pow(to / from, 1 / years) - 1;
}

/**
 * Compute the own-history valuation reading. Returns null when there is not
 * enough DISCLOSED history to say anything honest.
 *
 * @param revenueByYear disclosed annual revenue, newest first
 * @param closes        daily closes, oldest→newest, ending at `asOf`
 * @param currentPrice  latest price
 * @param asOf          the date `closes` ends on
 */
export function computeOwnHistoryValuation(
  revenueByYear: RevenueYear[] | undefined,
  closes: number[] | undefined,
  currentPrice: number,
  asOf: Date,
  /**
   * Disclosed annual NET INCOME, newest first. Optional but important: a
   * price/SALES percentile misreads any company whose MARGINS re-rated. Amazon's
   * net margin went ~2% → ~11%, so it sits mid-range on sales while trading at the
   * cheap end of its own EARNINGS history. The two readings are AVERAGED - see the
   * note at the blend site for why taking the cheaper one was exploitable.
   */
  netIncomeByYear?: Array<{ period: string; netIncome: number }>,
): OwnHistoryValuation | null {
  if (!revenueByYear || revenueByYear.length < MIN_YEARS) return null;
  if (!closes || closes.length < 400) return null; // need real multi-year price
  if (!(currentPrice > 0)) return null;

  const newest = revenueByYear[0]!;
  if (!(newest.revenue > 0)) return null;
  const currentRatio = currentPrice / newest.revenue;

  // Historical price-per-revenue-dollar, one point per disclosed year we can also
  // price. The newest year is excluded - it IS the current reading.
  const history: number[] = [];
  let oldest: { year: number; revenue: number; price: number } | null = null;
  for (const row of revenueByYear.slice(1)) {
    const year = frameYear(row.period);
    if (year == null || !(row.revenue > 0)) continue;
    const price = closeAtYearEnd(closes, asOf, year);
    if (price == null) continue;
    history.push(price / row.revenue);
    oldest = { year, revenue: row.revenue, price };
  }
  if (history.length < MIN_YEARS - 1) return null;

  // Percentile of today's ratio within its own history (inclusive of itself, so a
  // new extreme reads as 0 or 1 rather than undefined).
  const all = [...history, currentRatio].sort((a, b) => a - b);
  const rank = all.findIndex((v) => v >= currentRatio);
  const percentile = clamp(rank / Math.max(1, all.length - 1), 0, 1);

  const years = oldest ? asOf.getUTCFullYear() - oldest.year : history.length;
  const revenueCagr = oldest ? cagr(oldest.revenue, newest.revenue, years) : 0;
  const priceCagr = oldest ? cagr(oldest.price, currentPrice, years) : 0;

  // EARNINGS percentile, when the company was profitable across enough of the
  // window for the comparison to be meaningful. Loss years are skipped rather
  // than signed - a negative P/E is not "cheap", it is undefined.
  let earningsPercentile: number | null = null;
  if (netIncomeByYear && netIncomeByYear.length >= MIN_YEARS) {
    const newestNi = netIncomeByYear[0];
    if (newestNi && newestNi.netIncome > 0) {
      const currentPe = currentPrice / newestNi.netIncome;
      const peHistory: number[] = [];
      for (const row of netIncomeByYear.slice(1)) {
        const year = frameYear(row.period);
        if (year == null || !(row.netIncome > 0)) continue;
        const price = closeAtYearEnd(closes, asOf, year);
        if (price == null) continue;
        peHistory.push(price / row.netIncome);
      }
      // Require a REAL earnings history, not two lucky years. Palantir exposed
      // this: it turned profitable recently, so its P/E history is short and every
      // earlier reading was even more extreme - which made a P/E of 130 score as
      // "the cheapest it has ever been". A multiple can only be ranked against a
      // past that actually exists.
      if (peHistory.length >= MIN_EARNINGS_YEARS) {
        const allPe = [...peHistory, currentPe].sort((a, b) => a - b);
        const peRank = allPe.findIndex((v) => v >= currentPe);
        earningsPercentile = clamp(peRank / Math.max(1, allPe.length - 1), 0, 1);
      }
    }
  }

  // AVERAGE the two readings rather than taking the cheaper one.
  //
  // `Math.min` was the first attempt and it is exploitable: a name that is the
  // most expensive it has EVER been on sales (1.00) while showing a short, cheap
  // earnings history (0.00) collected a maximum-cheap score. That is precisely how
  // Palantir reached #1 on a P/E of 130. Each leg captures something real - sales
  // for a business whose margins have not settled, earnings for one whose margins
  // re-rated durably - so the honest summary is the middle, and a genuine
  // re-rating shows up in both legs eventually.
  const blended =
    earningsPercentile == null ? percentile : (percentile + earningsPercentile) / 2;

  return {
    percentile: blended,
    salesPercentile: percentile,
    earningsPercentile,
    divergence: revenueCagr - priceCagr,
    revenueCagr,
    priceCagr,
    currentRatio,
    years: Math.max(1, years),
  };
}
