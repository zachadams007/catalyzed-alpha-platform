import { describe, expect, it } from "vitest";

import {
  resolveListings,
  normalizeCompanyName,
  exchangeShortLabel,
  exchangeTier,
  listingCurrency,
} from "@/data/symbols/listingResolver";

describe("normalizeCompanyName", () => {
  it("reduces a listing name to a comparable company core", () => {
    expect(normalizeCompanyName("Shopify Inc. - Class A Subordinate Voting Shares")).toBe("shopify");
    expect(normalizeCompanyName("Shopify Inc.")).toBe("shopify");
    expect(normalizeCompanyName("Wheaton Precious Metals Corp Common Shares (Canada)")).toBe(
      "wheaton precious metals",
    );
    expect(normalizeCompanyName("Wheaton Precious Metals Corp.")).toBe("wheaton precious metals");
  });

  it("matches across small directory spelling/case differences", () => {
    expect(normalizeCompanyName("Nexgen Energy Ltd. Common Shares")).toBe(
      normalizeCompanyName("NexGen Energy Ltd."),
    );
    expect(normalizeCompanyName("Suncor Energy  Inc. Common Stock")).toBe(
      normalizeCompanyName("Suncor Energy Inc."),
    );
  });

  it("keeps genuinely different companies distinct", () => {
    expect(normalizeCompanyName("Abacus Global Management, Inc. Class A Common Stock")).not.toBe(
      normalizeCompanyName("Barrick Gold Corporation"),
    );
    expect(normalizeCompanyName("Clear Channel Outdoor Holdings, Inc. Common Stock")).not.toBe(
      normalizeCompanyName("Cameco Corporation"),
    );
  });
});

describe("exchange helpers", () => {
  it("labels exchanges for display", () => {
    expect(exchangeShortLabel("TSX")).toBe("TSX");
    expect(exchangeShortLabel("TSXV")).toBe("TSX-V");
    expect(exchangeShortLabel("Cboe Canada")).toBe("Cboe CA");
    expect(exchangeShortLabel("NASDAQ")).toBe("NASDAQ");
  });

  it("maps country to trading currency", () => {
    expect(listingCurrency("CA")).toBe("CAD");
    expect(listingCurrency("US")).toBe("USD");
  });

  it("tiers exchanges", () => {
    expect(exchangeTier("NYSE", "US")).toBe("senior_us");
    expect(exchangeTier("TSX", "CA")).toBe("senior_ca");
    expect(exchangeTier("TSXV", "CA")).toBe("venture");
    expect(exchangeTier("Cboe Canada", "CA")).toBe("other");
  });
});

describe("resolveListings — Canadian-only name (the GCU case)", () => {
  it("resolves a bare base to its TSX listing with CAD + no false cross-listing", () => {
    const r = resolveListings("GCU");
    expect(r).not.toBeNull();
    expect(r!.primary.symbol).toBe("GCU.TO");
    expect(r!.primary.country).toBe("CA");
    expect(r!.primary.currency).toBe("CAD");
    expect(r!.primary.exchangeLabel).toBe("TSX");
    expect(r!.alternates).toHaveLength(0);
  });

  it("honors an explicit .TO query", () => {
    const r = resolveListings("GCU.TO");
    expect(r!.primary.symbol).toBe("GCU.TO");
    expect(r!.primary.currency).toBe("CAD");
  });
});

describe("resolveListings — genuine cross-listings", () => {
  it("links SHOP (NASDAQ/USD) with SHOP.TO (TSX/CAD), primary = the queried listing", () => {
    const us = resolveListings("SHOP");
    expect(us!.primary.symbol).toBe("SHOP");
    expect(us!.primary.currency).toBe("USD");
    expect(us!.alternates.map((a) => a.symbol)).toContain("SHOP.TO");

    const ca = resolveListings("SHOP.TO");
    expect(ca!.primary.symbol).toBe("SHOP.TO");
    expect(ca!.primary.currency).toBe("CAD");
    expect(ca!.alternates.map((a) => a.symbol)).toContain("SHOP");
  });

  it("links other real dual-listings (SU, NXE, WPM, BB)", () => {
    for (const [base, alt] of [
      ["SU", "SU.TO"],
      ["NXE", "NXE.TO"],
      ["WPM", "WPM.TO"],
      ["BB", "BB.TO"],
    ] as const) {
      const r = resolveListings(base);
      expect(r, base).not.toBeNull();
      expect(r!.alternates.map((a) => a.symbol), base).toContain(alt);
    }
  });
});

describe("resolveListings — rejects false cross-listings (real recycled symbols)", () => {
  it("does NOT link ABX (Abacus, US) with ABX.TO (Barrick, CA)", () => {
    const r = resolveListings("ABX");
    expect(r!.primary.symbol).toBe("ABX");
    expect(r!.alternates.map((a) => a.symbol)).not.toContain("ABX.TO");
  });

  it("does NOT link CCO (Clear Channel, US) with CCO.TO (Cameco, CA)", () => {
    const r = resolveListings("CCO");
    expect(r!.alternates.map((a) => a.symbol)).not.toContain("CCO.TO");
  });

  it("does NOT treat the AAPL.TO CDR as a listing of Apple", () => {
    const r = resolveListings("AAPL");
    expect(r!.primary.symbol).toBe("AAPL");
    expect(r!.alternates.map((a) => a.symbol)).not.toContain("AAPL.TO");
  });
});

describe("resolveListings — ordering + misses", () => {
  it("orders alternates most-liquid first when a liquidity hint is given", () => {
    const r = resolveListings("SHOP", { liquidity: { "SHOP.TO": 1_000_000 } });
    expect(r!.alternates[0]!.symbol).toBe("SHOP.TO");
  });

  it("returns null for a symbol that isn't in the directory", () => {
    expect(resolveListings("ZQWXTEST")).toBeNull();
  });
});
