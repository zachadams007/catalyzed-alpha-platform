import { describe, expect, it } from "vitest";
import { highlightSegments, wrapIndex } from "@/components/common/SymbolAutocomplete";

describe("highlightSegments", () => {
  it("returns a single non-hit segment for an empty query", () => {
    expect(highlightSegments("Ballard Power Systems", "")).toEqual([
      { text: "Ballard Power Systems", hit: false },
    ]);
  });

  it("marks a case-insensitive prefix match", () => {
    expect(highlightSegments("BLDP", "bl")).toEqual([
      { text: "BL", hit: true },
      { text: "DP", hit: false },
    ]);
  });

  it("marks an interior substring match in a company name", () => {
    expect(highlightSegments("Ballard Power Systems", "power")).toEqual([
      { text: "Ballard ", hit: false },
      { text: "Power", hit: true },
      { text: " Systems", hit: false },
    ]);
  });

  it("returns one non-hit segment when there is no match", () => {
    expect(highlightSegments("OKLO", "zz")).toEqual([{ text: "OKLO", hit: false }]);
  });

  it("preserves the original casing of the matched run", () => {
    const segs = highlightSegments("MDA.TO", "mda");
    expect(segs[0]).toEqual({ text: "MDA", hit: true });
  });
});

describe("wrapIndex", () => {
  it("wraps forward past the end to the start", () => {
    expect(wrapIndex(3, 3)).toBe(0);
  });

  it("wraps backward past the start to the end", () => {
    expect(wrapIndex(-1, 3)).toBe(2);
  });

  it("returns -1 for an empty list", () => {
    expect(wrapIndex(0, 0)).toBe(-1);
  });

  it("is a no-op for an in-range index", () => {
    expect(wrapIndex(1, 4)).toBe(1);
  });
});
