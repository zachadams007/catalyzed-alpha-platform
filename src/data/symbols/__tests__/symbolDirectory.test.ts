import { describe, it, expect } from "vitest";
import {
  resolveSymbol,
  searchSymbols,
  getSymbol,
  isKnownSymbol,
  directoryStats,
} from "../symbolDirectory";
import { SYMBOL_ROWS } from "../listings.generated";

describe("symbolDirectory", () => {
  it("bundles a comprehensive US + CA universe", () => {
    const s = directoryStats();
    expect(s.total).toBeGreaterThan(12000);
    expect(s.us).toBeGreaterThan(11000);
    // Canada is now the live TMX TSX + TSXV directory (was a stale ~975 dump) -
    // thousands of names, not just the TSX-60 spine.
    expect(s.ca).toBeGreaterThan(3000);
  });

  // This is the acceptance bar for the universe expansion.
  it("resolves the full watchlist to its exact symbol (US + CA)", () => {
    const watchlist = [
      "INFQ", "BLDP", "CEG", "VST", "TLN", "BWXT", "GFS", "APLD", "QBTS",
      "QUBT", "QTUM", "KLAR", "OKLO", "AMBA", "THM", "GLD", "SLV", "IREN",
      "HOOD", "MSFL", "NOK", "NOW", "IONQ", "IBM", "HON", "HNST", "OBDC",
      "HUMA", "UVIX", "SERV", "BLLN", "META", "MRNA", "NBIS",
      "MDA.TO", "GCU.TO", "DEFI.NE",
    ];
    const missing = watchlist.filter((t) => {
      const r = resolveSymbol(t);
      return !r || r.symbol !== t;
    });
    expect(missing, `failed to resolve exactly: ${missing.join(", ")}`).toEqual([]);
  });

  it("resolves Canadian listings incl. exchange suffixes + bare base", () => {
    expect(resolveSymbol("MDA.TO")?.country).toBe("CA");
    expect(resolveSymbol("GCU.TO")?.country).toBe("CA");
    expect(resolveSymbol("DEFI.NE")?.country).toBe("CA");
    // Suffix-tolerant: a bare Canadian-only base finds its .TO listing. (CSU has
    // no bare US ticker; where one exists, e.g. "MDA", the US listing correctly
    // wins the exact match - that's the intended US-biased resolution.)
    expect(getSymbol("CSU")?.symbol).toBe("CSU.TO");
    expect(getSymbol("CSU")?.name).toMatch(/Constellation/i);
    expect(isKnownSymbol("SHOP.TO")).toBe(true);
  });

  it("covers broad TSX / TSXV — share classes, units, and a .V listing", () => {
    // Share classes carry the Yahoo-style dash + exchange suffix.
    expect(getSymbol("GIB-A.TO")?.name).toMatch(/CGI/i);
    expect(getSymbol("TECK-B.TO")?.country).toBe("CA");
    expect(getSymbol("RCI-B.TO")?.country).toBe("CA");
    // A REIT unit line.
    expect(getSymbol("AP-UN.TO")?.country).toBe("CA");
    // TSX Venture (.V) coverage exists in the thousands.
    const venture = SYMBOL_ROWS.filter((r) => r.c === "CA" && r.x === "TSXV");
    expect(venture.length).toBeGreaterThan(1000);
  });

  it("flags Canadian ETFs distinctly from operating companies", () => {
    expect(getSymbol("XIU.TO")?.isEtf).toBe(true); // iShares S&P/TSX 60 Index ETF
    expect(getSymbol("SHOP.TO")?.isEtf).toBe(false); // Shopify Inc. (operating co)
  });

  it("finds securities by company name", () => {
    const hits = searchSymbols("apple", 10).map((h) => h.symbol);
    expect(hits).toContain("AAPL");
  });

  it("returns nothing for an empty query and unknown junk", () => {
    expect(searchSymbols("")).toEqual([]);
    expect(getSymbol("")).toBeNull();
    expect(resolveSymbol("zzzzzznotaticker")).toBeNull();
  });
});
