import { describe, it, expect } from "vitest";
import { scoreRingLabel } from "./ScoreRing";

// The ring's accessible name is what a screen reader announces for the gauge -
// it must always read as a whole-number score out of 100, clamped to range, so
// an out-of-band or fractional score never produces a misleading label. (The
// repo's vitest runs in the node environment, so the pure label builder - not a
// rendered <div> - is the unit under test.)
describe("scoreRingLabel", () => {
  it("rounds to a whole number out of 100", () => {
    expect(scoreRingLabel(72)).toBe("Opportunity score 72 of 100");
    expect(scoreRingLabel(72.4)).toBe("Opportunity score 72 of 100");
    expect(scoreRingLabel(72.6)).toBe("Opportunity score 73 of 100");
  });

  it("clamps below 0 and above 100", () => {
    expect(scoreRingLabel(-15)).toBe("Opportunity score 0 of 100");
    expect(scoreRingLabel(140)).toBe("Opportunity score 100 of 100");
  });

  it("handles the exact bounds", () => {
    expect(scoreRingLabel(0)).toBe("Opportunity score 0 of 100");
    expect(scoreRingLabel(100)).toBe("Opportunity score 100 of 100");
  });
});
