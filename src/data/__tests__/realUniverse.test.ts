import { describe, it, expect } from "vitest";

import {
  isRealUniverseTicker,
  isCuratedResearchTicker,
  REAL_UNIVERSE_TICKERS,
} from "@/data/realUniverse";

describe("isRealUniverseTicker — directory-backed 'is this a real listing?'", () => {
  it("accepts real US listings beyond the curated set", () => {
    expect(isRealUniverseTicker("BLDP")).toBe(true);
    expect(isRealUniverseTicker("INFQ")).toBe(true);
    expect(isRealUniverseTicker("OKLO")).toBe(true);
  });

  it("accepts real Canadian listings incl. exchange suffixes", () => {
    expect(isRealUniverseTicker("GCU.TO")).toBe(true);
    expect(isRealUniverseTicker("DEFI.NE")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isRealUniverseTicker("  bldp ")).toBe(true);
  });

  it("rejects junk that isn't a listed security", () => {
    expect(isRealUniverseTicker("ZZZZNOTATICKER")).toBe(false);
  });
});

describe("isCuratedResearchTicker — the small hand-picked universe only", () => {
  it("matches members of the curated ~75-name set", () => {
    expect(isCuratedResearchTicker("AAPL")).toBe(true);
    expect(isCuratedResearchTicker(REAL_UNIVERSE_TICKERS[0]!)).toBe(true);
  });

  it("does NOT match a real listing that is outside the curated set", () => {
    // BLDP / GCU.TO are real (directory-known) but not curated research names.
    expect(isCuratedResearchTicker("BLDP")).toBe(false);
    expect(isCuratedResearchTicker("GCU.TO")).toBe(false);
  });
});
