import { describe, expect, it } from "vitest";

import {
  type FeedItem,
  type RawParsedEvent,
  classifyCatalyst,
  deriveEventsFromItems,
  parseFeedItems,
  tickersFromItem,
  validateParsedEvents,
} from "@/data/catalysts/newsletterCatalysts";

/**
 * Unit tests for the newsletter/RSS pipeline's PURE halves: the runtime-agnostic
 * feed parser (RSS <item> + Atom <entry>, CDATA, entities) and the universe-
 * anchored validator (drops hallucinated tickers, unknown types, sub-floor
 * strengths; infers negativity). The network + Gemini-proxy wrappers are not
 * unit-tested (same convention as the other sources). Deterministic.
 */

const NOW = Date.parse("2026-06-18T00:00:00.000Z");
const UNIVERSE = new Set(["AAA", "BBB"]);

describe("parseFeedItems", () => {
  it("parses RSS <item> blocks with CDATA + entities", () => {
    const xml = `<rss><channel>
      <item>
        <title><![CDATA[AAA wins FDA nod]]></title>
        <link>https://feed.example/aaa</link>
        <description>AAA &amp; partners announce approval</description>
        <pubDate>Mon, 16 Jun 2026 12:00:00 GMT</pubDate>
      </item>
      <item>
        <title>Plain title</title>
        <link>https://feed.example/x</link>
        <description>Body</description>
        <pubDate>Tue, 17 Jun 2026 09:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;
    const items = parseFeedItems(xml);
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe("AAA wins FDA nod");
    expect(items[0]!.description).toContain("&");
    expect(items[0]!.link).toBe("https://feed.example/aaa");
    expect(items[0]!.dateIso).toContain("2026-06-16");
  });

  it("parses Atom <entry> with href links and <summary>", () => {
    const xml = `<feed>
      <entry>
        <title>BBB Q2 beat</title>
        <link href="https://feed.example/bbb"/>
        <summary>Earnings summary</summary>
        <updated>2026-06-15T10:00:00Z</updated>
      </entry>
    </feed>`;
    const items = parseFeedItems(xml);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("BBB Q2 beat");
    expect(items[0]!.link).toBe("https://feed.example/bbb");
    expect(items[0]!.description).toBe("Earnings summary");
  });

  it("returns [] for empty/garbage input", () => {
    expect(parseFeedItems("")).toEqual([]);
    expect(parseFeedItems("not xml at all")).toEqual([]);
  });

  it("captures <category> exchange:ticker tags (GlobeNewswire shape)", () => {
    const xml = `<rss><channel>
      <item>
        <title>Coherus and Zumutor announce clinical collaboration</title>
        <link>https://feed.example/chrs</link>
        <description>Body</description>
        <pubDate>Mon, 16 Jun 2026 12:00:00 GMT</pubDate>
        <category>Nasdaq:CHRS</category>
        <category>Clinical Study</category>
      </item>
    </channel></rss>`;
    const items = parseFeedItems(xml);
    expect(items[0]!.categories).toContain("Nasdaq:CHRS");
    expect(items[0]!.categories).toContain("Clinical Study");
  });
});

function feedItem(over: Partial<FeedItem>): FeedItem {
  return {
    title: over.title ?? "",
    link: over.link ?? "https://feed.example/x",
    description: over.description ?? "",
    dateIso: over.dateIso ?? "2026-06-16T00:00:00.000Z",
    categories: over.categories ?? [],
  };
}

describe("tickersFromItem", () => {
  it("resolves a US ticker from a category tag", () => {
    expect(tickersFromItem(feedItem({ categories: ["Nasdaq:CHRS"] }))).toEqual(["CHRS"]);
  });

  it("resolves a US ticker from a (NYSE: X) pattern in the title", () => {
    expect(
      tickersFromItem(feedItem({ title: "Acme Corp (NYSE: ACME) wins contract" })),
    ).toEqual(["ACME"]);
  });

  it("ignores non-US exchanges (Paris/Brussels/Copenhagen)", () => {
    expect(
      tickersFromItem(feedItem({ categories: ["Paris:GNFT", "Brussels:ARGX"] })),
    ).toEqual([]);
  });

  it("keeps a US dual-listing while dropping its foreign twin", () => {
    expect(
      tickersFromItem(feedItem({ categories: ["Brussels:ARGX", "Nasdaq:ARGX"] })),
    ).toEqual(["ARGX"]);
  });

  it("dedupes repeated tickers", () => {
    expect(
      tickersFromItem(feedItem({ categories: ["Nasdaq:CHRS"], title: "(NASDAQ: CHRS) update" })),
    ).toEqual(["CHRS"]);
  });
});

describe("classifyCatalyst", () => {
  it("scores an FDA approval as a strong positive Clinical catalyst", () => {
    const c = classifyCatalyst("Acme receives FDA approval for its lead drug");
    expect(c?.type).toBe("Clinical");
    expect(c!.mag).toBeGreaterThan(0.6);
  });

  it("scores a trial failure as a negative Clinical catalyst", () => {
    const c = classifyCatalyst("Acme's Phase 3 trial fails to meet primary endpoint");
    expect(c?.type).toBe("Clinical");
    expect(c!.mag).toBeLessThan(0);
  });

  it("scores M&A and contract wins", () => {
    expect(classifyCatalyst("BigCo to acquire SmallCo in $2B deal")?.type).toBe("M&A");
    expect(classifyCatalyst("Acme awarded $50 million defense contract")?.type).toBe("Partnership");
  });

  it("scores an offering as a negative (dilution) catalyst", () => {
    const c = classifyCatalyst("Acme announces $30 million registered direct offering");
    expect(c!.mag).toBeLessThan(0);
  });

  it("returns null for generic, non-catalyst copy", () => {
    expect(classifyCatalyst("Acme to present at an investor conference next week")).toBeNull();
  });
});

describe("deriveEventsFromItems", () => {
  const NOW = Date.parse("2026-06-18T00:00:00.000Z");

  it("derives one event per (item, US ticker) that classifies", () => {
    const items: FeedItem[] = [
      feedItem({
        title: "Coherus receives FDA approval",
        categories: ["Nasdaq:CHRS"],
        link: "https://feed.example/chrs",
      }),
      feedItem({ title: "GENFIT positive phase 1b data", categories: ["Paris:GNFT"] }), // non-US → dropped
      feedItem({ title: "Investor conference next week", categories: ["Nasdaq:AAA"] }), // no catalyst → dropped
    ];
    const raw = deriveEventsFromItems(items, NOW);
    expect(raw).toHaveLength(1);
    expect(raw[0]!.ticker).toBe("CHRS");
    expect(raw[0]!.catalystType).toBe("Clinical");
  });

  it("round-trips through validateParsedEvents against the universe", () => {
    const items: FeedItem[] = [
      feedItem({ title: "Coherus receives FDA approval", categories: ["Nasdaq:CHRS"] }),
    ];
    const raw = deriveEventsFromItems(items, NOW);
    const events = validateParsedEvents(raw, new Set(["CHRS"]), NOW);
    expect(events).toHaveLength(1);
    expect(events[0]!.ticker).toBe("CHRS");
    expect(events[0]!.strength).toBeGreaterThan(0);
    // off-universe → dropped
    expect(validateParsedEvents(raw, new Set(["ZZZ"]), NOW)).toHaveLength(0);
  });
});

describe("validateParsedEvents", () => {
  function raw(over: Partial<RawParsedEvent>): RawParsedEvent {
    return {
      ticker: over.ticker ?? "AAA",
      catalystType: over.catalystType ?? "Clinical",
      date: over.date ?? "2026-06-16",
      summary: over.summary ?? "Phase 3 readout",
      sourceUrl: over.sourceUrl ?? "https://feed.example/aaa",
      strength: over.strength ?? 0.8,
    };
  }

  it("maps a valid event to a CatalystEvent", () => {
    const out = validateParsedEvents([raw({})], UNIVERSE, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.ticker).toBe("AAA");
    expect(out[0]!.catalystType).toBe("Clinical");
    expect(out[0]!.strength).toBeGreaterThan(0);
  });

  it("drops hallucinated tickers not in the universe", () => {
    expect(validateParsedEvents([raw({ ticker: "ZZZZ" })], UNIVERSE, NOW)).toHaveLength(0);
  });

  it("drops unknown catalyst types", () => {
    expect(validateParsedEvents([raw({ catalystType: "Vibes" })], UNIVERSE, NOW)).toHaveLength(0);
  });

  it("drops sub-floor strengths as noise", () => {
    expect(validateParsedEvents([raw({ strength: 0.1 })], UNIVERSE, NOW)).toHaveLength(0);
  });

  it("infers a negative catalyst from a negative model strength", () => {
    const out = validateParsedEvents([raw({ strength: -0.7 })], UNIVERSE, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.negative).toBe(true);
    expect(out[0]!.strength).toBeLessThan(0);
  });

  it("drops events with an unparseable date", () => {
    expect(validateParsedEvents([raw({ date: "soon" })], UNIVERSE, NOW)).toHaveLength(0);
  });

  it("maps the new Institutional type", () => {
    const out = validateParsedEvents([raw({ catalystType: "Institutional" })], UNIVERSE, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.catalystType).toBe("Institutional");
  });
});
