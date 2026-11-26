import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/data/http", () => ({
  httpJson: vi.fn(),
}));

import { httpJson } from "@/data/http";
import { fetchYahooChart } from "@/data/prices/yahooChart";

const mockedJson = vi.mocked(httpJson);

afterEach(() => vi.clearAllMocks());

function chartResponse(opts: {
  currency?: string;
  price?: number;
  ts?: number[];
  closes?: Array<number | null>;
}) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol: "GCU.TO",
            currency: opts.currency ?? "CAD",
            exchangeName: "TOR",
            fullExchangeName: "Toronto",
            instrumentType: "EQUITY",
            regularMarketPrice: opts.price ?? 0.43,
            chartPreviousClose: 0.41,
            regularMarketVolume: 591951,
            fiftyTwoWeekHigh: 0.7,
            fiftyTwoWeekLow: 0.22,
            longName: "Gunnison Copper Corp",
            shortName: "GUNNISON COPPER CORP",
          },
          timestamp: opts.ts ?? [1781271000, 1781530200, 1781616600],
          indicators: { quote: [{ close: opts.closes ?? [0.41, 0.42, 0.43] }] },
        },
      ],
    },
  };
}

describe("fetchYahooChart", () => {
  it("parses real CAD meta + series for a TSX listing", async () => {
    mockedJson.mockResolvedValueOnce(chartResponse({}));
    const chart = await fetchYahooChart("GCU.TO");
    expect(chart).not.toBeNull();
    expect(chart!.meta.currency).toBe("CAD");
    expect(chart!.meta.regularMarketPrice).toBe(0.43);
    expect(chart!.meta.fullExchangeName).toBe("Toronto");
    expect(chart!.meta.longName).toBe("Gunnison Copper Corp");
    expect(chart!.series).toHaveLength(3);
    expect(chart!.closes).toEqual([0.41, 0.42, 0.43]);
  });

  it("drops null closes from the series but keeps the dated points", async () => {
    mockedJson.mockResolvedValueOnce(
      chartResponse({ ts: [1, 2, 3], closes: [1.0, null, 1.2] }),
    );
    const chart = await fetchYahooChart("GCU.TO");
    expect(chart!.closes).toEqual([1.0, 1.2]);
  });

  it("returns null when there is neither a meta price nor a series", async () => {
    mockedJson.mockResolvedValueOnce({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{ close: [] }] } }] } });
    // both hosts attempted (node → single /__yahoo host), still null
    const chart = await fetchYahooChart("GCU.TO");
    expect(chart).toBeNull();
  });

  it("never throws — a network error degrades to null", async () => {
    mockedJson.mockRejectedValue(new Error("network"));
    await expect(fetchYahooChart("GCU.TO")).resolves.toBeNull();
  });

  it("returns null for an empty symbol without a request", async () => {
    expect(await fetchYahooChart("  ")).toBeNull();
    expect(mockedJson).not.toHaveBeenCalled();
  });
});
