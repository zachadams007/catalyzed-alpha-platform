import { describe, expect, it } from "vitest";

import {
  isNewsRelevantToTicker,
  selectRelevantLiveNews,
  type LiveNewsCandidate,
} from "@/data/news/newsSelection";

const base = {
  publishedAt: "2026-06-18T12:00:00.000Z",
  sentiment: 0,
};

function item(overrides: Partial<LiveNewsCandidate>): LiveNewsCandidate {
  return {
    ...base,
    headline: "RBNH headline",
    source: "Benzinga",
    sourceId: "benzinga",
    url: `https://example.test/${Math.random()}`,
    symbols: ["RBNH"],
    ...overrides,
  };
}

describe("newsSelection ticker relevance", () => {
  it("uses vendor symbol lists as the authority when present", () => {
    expect(
      isNewsRelevantToTicker(
        item({
          headline: "Robinhood expands crypto tools",
          symbols: ["HOOD"],
        }),
        "RBNH",
      ),
    ).toBe(false);

    expect(
      isNewsRelevantToTicker(
        item({
          headline: "A supplier also mentions RBNH in passing",
          symbols: ["HOOD"],
        }),
        "RBNH",
      ),
    ).toBe(false);
  });

  it("falls back to strong ticker mentions when vendors omit symbols", () => {
    expect(
      isNewsRelevantToTicker(
        item({
          headline: "$RBNH posts phase 2 update after the close",
          symbols: [],
        }),
        "RBNH",
      ),
    ).toBe(true);

    expect(
      isNewsRelevantToTicker(
        item({
          headline: "Biotech sector rallies after a quiet session",
          symbols: [],
        }),
        "RBNH",
      ),
    ).toBe(false);
  });
});

describe("selectRelevantLiveNews", () => {
  it("returns only on-ticker, deduped, multi-source results from mixed fixtures", () => {
    const selected = selectRelevantLiveNews("RBNH", [
      item({
        headline: "RBNH wins FDA clearance for home diagnostics platform",
        source: "Benzinga",
        sourceId: "benzinga",
        url: "https://benzinga.example/rbnh-fda",
        symbols: ["RBNH"],
        publishedAt: "2026-06-18T12:00:00.000Z",
      }),
      item({
        headline: "RBNH wins FDA clearance for home diagnostics platform",
        source: "FMP / MarketWatch",
        sourceId: "fmp",
        url: "https://fmp.example/rbnh-fda?utm=copy",
        symbols: ["RBNH"],
        publishedAt: "2026-06-18T11:59:00.000Z",
      }),
      item({
        headline: "RBNH signs national distribution agreement",
        source: "FMP / PR Newswire",
        sourceId: "fmp",
        url: "https://fmp.example/rbnh-distribution",
        symbols: ["RBNH"],
        publishedAt: "2026-06-18T11:00:00.000Z",
      }),
      item({
        headline: "Finnhub: RBNH reports revenue above preliminary view",
        source: "Finnhub",
        sourceId: "finnhub",
        url: "https://finnhub.example/rbnh-revenue",
        symbols: ["RBNH"],
        publishedAt: "2026-06-18T10:00:00.000Z",
      }),
      item({
        headline: "$RBNH volume running hot after diagnostics update",
        source: "StockTwits",
        sourceId: "stocktwits",
        url: "https://stocktwits.com/user/message/1",
        symbols: ["RBNH"],
        publishedAt: "2026-06-18T09:00:00.000Z",
      }),
      item({
        headline: "HOOD launches prediction-market hub",
        source: "Benzinga",
        sourceId: "benzinga",
        url: "https://benzinga.example/hood",
        symbols: ["HOOD"],
        publishedAt: "2026-06-18T13:00:00.000Z",
      }),
      item({
        headline: "Small-cap health tech roundup",
        source: "Yahoo Finance",
        sourceId: "yahoo",
        url: "https://yahoo.example/roundup",
        symbols: [],
        publishedAt: "2026-06-18T08:00:00.000Z",
      }),
    ]);

    expect(selected.map((n) => n.headline)).toEqual([
      "RBNH wins FDA clearance for home diagnostics platform",
      "RBNH signs national distribution agreement",
      "Finnhub: RBNH reports revenue above preliminary view",
      "$RBNH volume running hot after diagnostics update",
    ]);
    expect(selected.every((n) => !n.headline.includes("HOOD"))).toBe(true);
    expect(new Set(selected.map((n) => n.source))).toEqual(
      new Set(["Benzinga", "FMP / PR Newswire", "Finnhub", "StockTwits"]),
    );
  });

  it("caps a dominant source when other sources have qualifying stories", () => {
    const topics = [
      "capacity expansion",
      "margin guide",
      "new contract",
      "trial enrollment",
      "board change",
      "patent award",
      "debt refinance",
      "launch timing",
    ];
    const benzingaFlood = Array.from({ length: 8 }, (_, i) =>
      item({
        headline: `RBNH Benzinga ${topics[i]}`,
        source: "Benzinga",
        sourceId: "benzinga",
        url: `https://benzinga.example/rbnh-${i}`,
        publishedAt: `2026-06-18T0${i}:00:00.000Z`,
      }),
    );

    const selected = selectRelevantLiveNews(
      "RBNH",
      [
        ...benzingaFlood,
        item({
          headline: "RBNH FMP update",
          source: "FMP",
          sourceId: "fmp",
          url: "https://fmp.example/rbnh",
        }),
        item({
          headline: "RBNH Finnhub update",
          source: "Finnhub",
          sourceId: "finnhub",
          url: "https://finnhub.example/rbnh",
        }),
      ],
      { limit: 6 },
    );

    const benzingaCount = selected.filter((n) => n.source === "Benzinga").length;
    expect(selected).toHaveLength(5);
    expect(benzingaCount).toBeLessThanOrEqual(3);
    expect(selected.map((n) => n.source)).toEqual(
      expect.arrayContaining(["FMP", "Finnhub"]),
    );
  });
});
