import type { OutcomeEntry } from "@/engine/outcomeLedger";

/**
 * "The model's calls" view for the Track Record - the missing piece that made the
 * tab read empty for the first week. The outcome ledger records EVERY published
 * signal daily, but the performance staircase only appears once forward returns
 * settle (7-30d). This surfaces the top picks per recent day with their LIVE
 * progress NOW (current price vs price-at-publish), so the tab populates immediately
 * and you can watch picks before they settle.
 *
 * Pure + testable: the component supplies a `priceOf` resolver (live price, else the
 * loaded board) and `nowMs`. Return basis is honest: live when we have a current
 * price, else the latest SETTLED forward return, else "tracking".
 */

export type CallBasis = "live" | "settled" | "tracking";

export interface RecentCall {
  ticker: string;
  name: string;
  score: number;
  priceAtPublish: number;
  currentPrice: number | null;
  /** Return as a ratio (0.12 = +12%), or null while tracking. */
  ret: number | null;
  basis: CallBasis;
  heldDays: number;
  /** Engine version that made the call; absent for pre-tagging history. */
  liveVariant?: OutcomeEntry["liveVariant"];
}

export interface RecentCallDay {
  day: string; // YYYY-MM-DD
  calls: RecentCall[];
}

const DAY_MS = 86_400_000;

export function buildRecentCalls(
  entries: readonly OutcomeEntry[],
  priceOf: (ticker: string) => number | undefined,
  nowMs: number,
  opts: { perDay?: number; maxDays?: number } = {},
): RecentCallDay[] {
  const perDay = opts.perDay ?? 8;
  const maxDays = opts.maxDays ?? 6;

  const byDay = new Map<string, OutcomeEntry[]>();
  for (const e of entries) {
    const day = e.publishedAtISO.slice(0, 10);
    const arr = byDay.get(day);
    if (arr) arr.push(e);
    else byDay.set(day, [e]);
  }

  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a)).slice(0, maxDays);

  return days
    .map((day) => {
      const calls = (byDay.get(day) ?? [])
        .slice()
        .sort((a, b) => b.opportunityScore - a.opportunityScore)
        .slice(0, perDay)
        .map((e): RecentCall => {
          const cur = priceOf(e.ticker);
          let ret: number | null = null;
          let basis: CallBasis = "tracking";
          if (cur != null && cur > 0 && e.priceAtPublish > 0) {
            ret = (cur - e.priceAtPublish) / e.priceAtPublish;
            basis = "live";
          } else {
            const fr = e.forwardReturns;
            const settled = fr.d252 ?? fr.d90 ?? fr.d30 ?? fr.d20 ?? fr.d7;
            if (settled != null) {
              ret = settled;
              basis = "settled";
            }
          }
          return {
            ticker: e.ticker,
            name: e.name,
            score: e.opportunityScore,
            priceAtPublish: e.priceAtPublish,
            ...(e.liveVariant ? { liveVariant: e.liveVariant } : {}),
            currentPrice: cur != null && cur > 0 ? cur : null,
            ret,
            basis,
            heldDays: Math.max(0, Math.round((nowMs - Date.parse(e.publishedAtISO)) / DAY_MS)),
          };
        });
      return { day, calls };
    })
    .filter((d) => d.calls.length > 0);
}
