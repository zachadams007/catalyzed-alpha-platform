import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MarketCapBucket } from "@/types";

/**
 * The two cap-resolution loops in enrichMarketCap.ts used to be `for…await`:
 * one FMP round trip per unsized ticker, fully serialized, sitting directly on
 * the board's render path (the cache-read repair) and on the nightly scan.
 * These tests pin the batched shape by measuring OVERLAP, not just the result -
 * a refactor that quietly re-serializes the loop would pass a result-only test
 * and silently reintroduce the tail.
 */

const inFlight = { now: 0, peak: 0 };
const fmpProfile = vi.fn(async (ticker: string) => {
  inFlight.now += 1;
  inFlight.peak = Math.max(inFlight.peak, inFlight.now);
  await new Promise((r) => setTimeout(r, 20));
  inFlight.now -= 1;
  if (ticker === "NOPE") return null; // FMP can't size it
  if (ticker === "BOOM") throw new Error("HTTP 500"); // vendor blew up
  return { symbol: ticker, marketCap: 5_000_000_000 };
});

vi.mock("@/data/fmp/fmpClient", () => ({ fmpProfile: (t: string) => fmpProfile(t) }));
vi.mock("@/data/http", () => ({ isFmpQueryable: () => true }));

describe("enrichMarketCap — batched cap resolution", () => {
  beforeEach(() => {
    inFlight.now = 0;
    inFlight.peak = 0;
    fmpProfile.mockClear();
  });

  it("repairSignalMarketCaps resolves unsized tickers CONCURRENTLY, not one at a time", async () => {
    const { repairSignalMarketCaps } = await import("@/data/fundamentals/enrichMarketCap");
    const signals: Array<{ ticker: string; marketCap: number; marketCapBucket?: MarketCapBucket }> =
      Array.from({ length: 8 }, (_, i) => ({ ticker: `T${i}`, marketCap: 0 }));

    const t0 = performance.now();
    const out = await repairSignalMarketCaps(signals);
    const elapsed = performance.now() - t0;

    // 8 lookups × 20ms each: serialized would be ≥160ms; one batch of 8 is ~20ms.
    expect(inFlight.peak).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(120);
    expect(fmpProfile).toHaveBeenCalledTimes(8);
    expect(out.every((s) => s.marketCap === 5_000_000_000 && s.marketCapBucket === "Mid")).toBe(true);
  });

  it("leaves a ticker FMP can't size as Unknown and survives a thrown lookup", async () => {
    const { repairSignalMarketCaps } = await import("@/data/fundamentals/enrichMarketCap");
    const out = await repairSignalMarketCaps([
      { ticker: "OK", marketCap: 0 },
      { ticker: "NOPE", marketCap: 0 },
      { ticker: "BOOM", marketCap: 0 },
    ]);
    const byT = Object.fromEntries(out.map((s) => [s.ticker, s]));
    expect(byT.OK!.marketCap).toBe(5_000_000_000);
    expect(byT.NOPE!.marketCap).toBe(0); // honest "Unknown", never fabricated
    expect(byT.BOOM!.marketCap).toBe(0); // one vendor error never costs the others
  });

  it("does not touch tickers that already have a plausible cap", async () => {
    const { repairSignalMarketCaps } = await import("@/data/fundamentals/enrichMarketCap");
    const out = await repairSignalMarketCaps([{ ticker: "NVDA", marketCap: 5e12, marketCapBucket: "Mega" as const }]);
    expect(fmpProfile).not.toHaveBeenCalled();
    expect(out[0]!.marketCap).toBe(5e12);
  });

  it("enrichUniverseWithMarketCap uses the same batched path for the scan", async () => {
    const { enrichUniverseWithMarketCap } = await import("@/data/fundamentals/enrichMarketCap");
    const companies = Array.from({ length: 6 }, (_, i) => ({ ticker: `C${i}`, marketCap: 0 })) as never[];
    const t0 = performance.now();
    await enrichUniverseWithMarketCap(companies);
    expect(performance.now() - t0).toBeLessThan(100); // 6 × 20ms serialized would be ≥120ms
    expect(inFlight.peak).toBeGreaterThanOrEqual(2);
  });
});
