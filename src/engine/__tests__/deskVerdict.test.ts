import { describe, expect, it } from "vitest";

import { DERIVED_CONFIDENCE_CAP, resolveVerdict } from "@/engine/deskVerdict";
import type { ResearchIntel } from "@/types";

/**
 * The Research Desk must never answer "No verdict".
 *
 * The user did the reading and got no conclusion. These tests pin the two properties that fix
 * it: a stance ALWAYS resolves, and a stance we derived is labelled and weighted as weaker than
 * one the judge actually committed to.
 */

function intel(over: Partial<ResearchIntel> = {}): ResearchIntel {
  return {
    summary: "A company.",
    citations: [],
    ...over,
  };
}

describe("resolveVerdict — the judge committed", () => {
  it("uses the judge's stance and confidence verbatim", () => {
    const v = resolveVerdict(
      intel({ debate: { bull: "b", bear: "r", stance: "bearish", confidence: 78, keyCatalysts: [], keyRisks: [] } }),
    );
    expect(v.stance).toBe("bearish");
    expect(v.source).toBe("judge");
    expect(v.label).toBe("Bearish");
    expect(v.confidence).toBe(78);
  });

  it("keeps 'mixed' as a real answer when the judge genuinely called it that", () => {
    const v = resolveVerdict(
      intel({ debate: { bull: "b", bear: "r", stance: "mixed", confidence: 60, keyCatalysts: [], keyRisks: [] } }),
    );
    expect(v.stance).toBe("mixed");
    expect(v.source).toBe("judge");
    expect(v.label).toBe("Mixed");
    expect(v.confidence).toBe(60);
  });
});

describe("resolveVerdict — the judge did not commit", () => {
  it("never returns a 'no verdict' state, even with nothing to go on", () => {
    const v = resolveVerdict(intel());
    expect(["bullish", "bearish", "mixed"]).toContain(v.stance);
    expect(v.label).not.toMatch(/no verdict/i);
  });

  it("derives a bullish lean when the surviving evidence leans bull", () => {
    const v = resolveVerdict(
      intel({
        bullPoints: ["a", "b", "c", "d"],
        bearPoints: ["x"],
        sentiment: 0.3,
      }),
    );
    expect(v.stance).toBe("bullish");
    expect(v.source).toBe("derived");
    expect(v.label).toBe("Leaning bullish");
  });

  it("derives a bearish lean when the surviving evidence leans bear", () => {
    const v = resolveVerdict(
      intel({ bullPoints: ["a"], bearPoints: ["x", "y", "z", "w"], sentiment: -0.4 }),
    );
    expect(v.stance).toBe("bearish");
    expect(v.label).toBe("Leaning bearish");
  });

  it("counts citation-verified claims toward the lean, not just raw points", () => {
    const v = resolveVerdict(
      intel({
        citedBull: [
          { claim: "a", spans: [] },
          { claim: "b", spans: [] },
          { claim: "c", spans: [] },
        ] as unknown as ResearchIntel["citedBull"],
        sentiment: 0.2,
      }),
    );
    expect(v.stance).toBe("bullish");
  });

  it("says 'Balanced' — not 'No verdict' — when the evidence really is even", () => {
    const v = resolveVerdict(intel({ bullPoints: ["a", "b"], bearPoints: ["x", "y"], sentiment: 0 }));
    expect(v.stance).toBe("mixed");
    expect(v.label).toBe("Balanced");
    expect(v.basis).toMatch(/genuinely balances/i);
  });

  it("caps derived conviction below a real judged verdict", () => {
    const v = resolveVerdict(intel({ bullPoints: ["a", "b", "c"], confidence: 95 }));
    expect(v.confidence).toBeLessThanOrEqual(DERIVED_CONFIDENCE_CAP);
  });

  it("explains that the lean was derived, so the UI can be honest about it", () => {
    const v = resolveVerdict(intel({ bullPoints: ["a", "b", "c"] }));
    expect(v.basis).toMatch(/derived lean/i);
  });
});
