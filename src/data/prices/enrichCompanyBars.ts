import type { CompanyData } from "@/types";
import {
  applyAlpacaBarsToCompany,
  fetchAlpacaBarsForSymbols,
  type BarsFetchOptions,
} from "@/data/alpaca/bars";

export interface BarsEnrichProgress {
  done: number;
  total: number;
}

/**
 * Batch-enrich the broad-universe scan with REAL daily bars from Alpaca IEX.
 *
 * This replaces {@link enrichUniverseWithLiveHistory} (Yahoo) for the scan
 * because Yahoo's chart API is network-blocked from this Node environment.
 * Alpaca already works for snapshots, so we use the same auth path.
 *
 * Strategy:
 *   1. Pre-fetch SPY bars to get the actual 3-month market return
 *      (used for relativeStrength3M instead of a fixed 4% proxy).
 *   2. Batch-fetch all ticker bars - 50 symbols per HTTP call, paced at 150ms.
 *   3. Apply momentum math synchronously per company (no per-ticker I/O).
 *
 * Degrades gracefully:
 *   - A dead batch is skipped; those companies keep their modeled momentum.
 *   - Companies with < 20 closes keep their synthetic values.
 *   - If SPY can't be fetched, relativeStrength3M falls back to ticker3M − 4%.
 */
export async function enrichUniverseWithAlpacaBars(
  companies: CompanyData[],
  onProgress?: (p: BarsEnrichProgress) => void,
  opts?: Pick<BarsFetchOptions, "concurrency" | "timeoutMs">,
): Promise<CompanyData[]> {
  if (companies.length === 0) return companies;

  // Step 1: real SPY 3M return as market benchmark.
  const spyMap = await fetchAlpacaBarsForSymbols(["SPY"], {
    concurrency: 1,
    timeoutMs: opts?.timeoutMs,
  }).catch((): Record<string, import("@/data/alpaca/bars").DailyBars> => ({}));
  const spyCloses = spyMap["SPY"]?.closes ?? [];
  const marketReturn3M =
    spyCloses.length > 63
      ? (() => {
          const now = spyCloses[spyCloses.length - 1]!;
          const then = spyCloses[spyCloses.length - 1 - 63]!;
          return then > 0 ? (now - then) / then : 0.04;
        })()
      : 0.04; // fallback: ~4% broad-market proxy

  // Step 2: fetch all tickers (pooled, 3 in-flight).
  const tickers = companies.map((c) => c.ticker);
  const total = tickers.length;
  const barsMap = await fetchAlpacaBarsForSymbols(tickers, {
    concurrency: opts?.concurrency ?? 3,
    timeoutMs: opts?.timeoutMs,
    onProgress: (done) => onProgress?.({ done, total }),
  });

  // Step 3: apply (pure, synchronous).
  return companies.map((company) =>
    applyAlpacaBarsToCompany(company, barsMap[company.ticker], marketReturn3M, spyCloses),
  );
}
