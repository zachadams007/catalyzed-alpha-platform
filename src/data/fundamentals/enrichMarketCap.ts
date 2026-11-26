import type { CompanyData } from "@/types";
import { fmpProfile } from "@/data/fmp/fmpClient";
import { isFmpQueryable } from "@/data/http";
import { bucketForMarketCap, isPlausibleMarketCap } from "@/lib/format";
import type { MarketCapBucket } from "@/types";

/**
 * Backfill a USD market cap for names the primary feed couldn't size.
 *
 * WHY THIS EXISTS. Finnhub reports `marketCapitalization` in millions of the
 * LISTING currency. For a foreign listing or ADR that is not USD - SK Hynix
 * (SKHY) reports KRW - the number cannot be compared against USD cap thresholds,
 * so `liveCompany.ts` now discards it rather than converting without an FX rate.
 * That leaves `marketCap: 0`, which buckets as "Unknown".
 *
 * "Unknown" is deliberately NOT buried by the screen's cap gate (see
 * `screen.ts`: a data gap shouldn't throw away an otherwise-good name). The
 * side effect was that unsized names IGNORED the user's market-cap filter
 * entirely - filtering out small caps still surfaced a $1.26T Korean chipmaker
 * on the Blueprint board.
 *
 * FMP's `/stable/profile` reports the US-listed line in USD ($1.256T for SKHY),
 * which buckets correctly as "Mega". So: for the handful of names still at zero,
 * ask FMP once each. Typically ~2 of 460 names, and `LIMIT` bounds the worst
 * case, so this costs a rounding error against the daily budget.
 *
 * Never fabricates: a name FMP can't size is left at 0 and still reads "Unknown".
 */

/** Hard ceiling on backfill calls per run, so a bad feed day can't burn budget. */
const LIMIT = 40;

/**
 * Look up caps for `tickers` with bounded concurrency and return a map of the
 * ones FMP could size. Both callers in this module previously ran a plain
 * `for…await` - one round trip per ticker, serialized - which sat directly on
 * the board's render path (the cache-read repair) and on the scan. Batches of
 * 8 keep the burst well under FMP's per-minute limit while collapsing N
 * sequential waits into ~N/8.
 *
 * Never fabricates and never throws: a ticker FMP can't size is simply absent
 * from the result, so callers leave it "Unknown".
 */
async function resolveCapsInBatches(tickers: string[]): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  const batchSize = 8;
  for (let index = 0; index < tickers.length; index += batchSize) {
    const batch = tickers.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map((t) => fmpProfile(t)));
    settled.forEach((result, i) => {
      if (result.status !== "fulfilled") return; // leave unsized - honest
      const profile = result.value;
      // `/stable/profile` → `marketCap`; legacy alias `mktCap` for a
      // grandfathered key. Only accept a sane USD figure.
      const cap = profile?.marketCap ?? profile?.mktCap;
      if (cap != null && isPlausibleMarketCap(cap)) resolved.set(batch[i]!, cap);
    });
  }
  return resolved;
}

export async function enrichUniverseWithMarketCap(
  companies: CompanyData[],
): Promise<CompanyData[]> {
  if (!isFmpQueryable()) return companies;

  const needsCap = companies.filter((c) => !isPlausibleMarketCap(c.marketCap));
  if (needsCap.length === 0) return companies;

  const resolved = await resolveCapsInBatches(needsCap.slice(0, LIMIT).map((c) => c.ticker));

  if (resolved.size === 0) return companies;
  return companies.map((c) => {
    const cap = resolved.get(c.ticker);
    return cap == null ? c : { ...c, marketCap: cap };
  });
}

/**
 * Repair unsized caps on signals read back from the shared daily cache.
 *
 * The scan-side backfill above only helps boards produced AFTER it ships. Boards
 * already sitting in `daily_signals` still carry the bad zero, so without this a
 * user keeps seeing a $1.26T name rendered as "cap - " - and slipping through
 * their market-cap filter - until the next scheduled scan lands.
 *
 * Cheap by construction: only the handful of unsized names are looked up
 * (typically 2 of ~460), and `LIMIT` bounds the worst case. Recomputes the
 * bucket so the screen gate sees a real size, not "Unknown".
 */
export async function repairSignalMarketCaps<
  T extends { ticker: string; marketCap?: number; marketCapBucket?: MarketCapBucket },
>(signals: T[]): Promise<T[]> {
  if (!isFmpQueryable()) return signals;

  const unsized = signals.filter((s) => !isPlausibleMarketCap(s.marketCap ?? 0));
  if (unsized.length === 0) return signals;

  const resolved = await resolveCapsInBatches(unsized.slice(0, LIMIT).map((s) => s.ticker));

  if (resolved.size === 0) return signals;
  return signals.map((s) => {
    const cap = resolved.get(s.ticker);
    return cap == null ? s : { ...s, marketCap: cap, marketCapBucket: bucketForMarketCap(cap) };
  });
}
