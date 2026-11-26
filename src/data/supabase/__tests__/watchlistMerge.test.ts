import { describe, expect, it } from "vitest";

import {
  diffChangedTickers,
  mergeWatchlist,
  serializeWatchlist,
  type WatchlistState,
} from "@/data/supabase/watchlistMerge";
import type { CloudWatchItem } from "@/data/supabase/watchlists";

const alert = (price: number, direction: "above" | "below" = "above") => ({
  ticker: "X",
  price,
  direction,
  createdAt: "2026-06-20T00:00:00.000Z",
});

describe("mergeWatchlist", () => {
  it("restores a remote-only watchlist onto an empty local (the 'it deleted' recovery)", () => {
    const local: WatchlistState = { tickers: [], alerts: {} };
    const remote: CloudWatchItem[] = [
      { ticker: "AAPL", alert: null, updatedAt: "2026-06-20T00:00:00Z" },
      { ticker: "MSFT", alert: alert(400), updatedAt: "2026-06-20T00:00:00Z" },
    ];
    const merged = mergeWatchlist(local, remote, new Map());
    expect(merged.tickers.sort()).toEqual(["AAPL", "MSFT"]);
    expect(merged.alerts.MSFT.price).toBe(400);
  });

  it("never drops a locally-added ticker on a pull (union-biased)", () => {
    const local: WatchlistState = { tickers: ["TSLA"], alerts: {} };
    const remote: CloudWatchItem[] = [{ ticker: "AAPL", alert: null, updatedAt: "2026-06-20T00:00:00Z" }];
    const merged = mergeWatchlist(local, remote, new Map());
    expect(merged.tickers.sort()).toEqual(["AAPL", "TSLA"]);
  });

  it("adopts a strictly-newer remote alert (LWW) but keeps a local newer one", () => {
    const local: WatchlistState = { tickers: ["NVDA"], alerts: { NVDA: alert(100) } };
    const stamps = new Map([["NVDA", "2026-06-20T00:00:00Z"]]);
    // remote newer than the stamp → adopt
    const newer = mergeWatchlist(local, [{ ticker: "NVDA", alert: alert(150), updatedAt: "2026-06-21T00:00:00Z" }], stamps);
    expect(newer.alerts.NVDA.price).toBe(150);
    // remote older than the stamp → keep local
    const older = mergeWatchlist(local, [{ ticker: "NVDA", alert: alert(150), updatedAt: "2026-06-19T00:00:00Z" }], stamps);
    expect(older.alerts.NVDA.price).toBe(100);
  });

  it("serializes order-independently and diffs membership + alert changes", () => {
    const a: WatchlistState = { tickers: ["A", "B"], alerts: { A: alert(1) } };
    const b: WatchlistState = { tickers: ["B", "A"], alerts: { A: alert(1) } };
    expect(serializeWatchlist(a)).toBe(serializeWatchlist(b));

    expect(diffChangedTickers({ tickers: ["A", "C"], alerts: {} }, { tickers: ["A"], alerts: {} }).sort()).toEqual(["C"]);
    expect(
      diffChangedTickers({ tickers: ["A"], alerts: { A: alert(2) } }, { tickers: ["A"], alerts: { A: alert(1) } }),
    ).toEqual(["A"]);
  });
});
