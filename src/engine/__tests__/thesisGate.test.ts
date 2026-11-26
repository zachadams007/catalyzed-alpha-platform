import { describe, expect, it } from "vitest";

import { MAX_THESIS_PENALTY, thesisGate } from "@/engine/thesisGate";
import type { ScoreCategoryKey } from "@/types";

function z(over: Partial<Record<ScoreCategoryKey, number>>): Partial<Record<ScoreCategoryKey, number>> {
  return over;
}

describe("thesisGate", () => {
  it("clears when a move leg and a solidity leg both pass the floor", () => {
    const r = thesisGate(z({ valuation: 1.2, fundamentals: 0.5 }));
    expect(r.cleared).toBe(true);
    expect(r.penalty).toBe(0);
    expect(r.reason).toMatch(/clears/i);
  });

  it("clears via the catalyst + growth legs and names them", () => {
    const r = thesisGate(z({ catalyst: 0.9, growth: 0.6 }));
    expect(r.cleared).toBe(true);
    expect(r.reason).toMatch(/catalyst/i);
    expect(r.reason).toMatch(/growth/i);
  });

  it("clears via the v2 inflection/pipeline third leg (a pre-revenue contract win)", () => {
    // Weak fundamentals & growth, but a real building pipeline backs the move.
    const r = thesisGate(z({ catalyst: 0.8, fundamentals: -1, growth: -1, pipeline: 0.9 }));
    expect(r.cleared).toBe(true);
    expect(r.reason).toMatch(/pipeline/i);
  });

  it("soft-gates a name weak on both legs (demote, never remove)", () => {
    // v2: the solidity leg is max(fundamentals, growth, inflection, pipeline), so all
    // four backers must be weak for the leg to fail.
    const r = thesisGate(
      z({ valuation: -2, catalyst: -2, fundamentals: -2, growth: -2, inflection: -2, pipeline: -2 }),
    );
    expect(r.cleared).toBe(false);
    expect(r.penalty).toBeGreaterThan(0);
    expect(r.penalty).toBeLessThanOrEqual(MAX_THESIS_PENALTY);
    expect(r.reason).toMatch(/value or catalyst/i);
    expect(r.reason).toMatch(/fundamentals/i);
  });

  it("soft-gates when only the solidity leg fails", () => {
    const r = thesisGate(
      z({ catalyst: 1.5, fundamentals: -1.5, growth: -1.5, inflection: -1.5, pipeline: -1.5 }),
    );
    expect(r.cleared).toBe(false);
    expect(r.reason).toMatch(/fundamentals & growth/i);
    expect(r.reason).not.toMatch(/value or catalyst/i);
  });

  it("caps the penalty for catastrophically weak names", () => {
    const r = thesisGate(
      z({
        valuation: -10,
        catalyst: -10,
        fundamentals: -10,
        growth: -10,
        inflection: -10,
        pipeline: -10,
      }),
    );
    expect(r.penalty).toBe(MAX_THESIS_PENALTY);
  });

  it("treats missing dimensions as neutral (z=0) and clears", () => {
    expect(thesisGate({}).cleared).toBe(true);
  });

  // --- P4: missing/cold-start data must not be NAMED as a thesis backer ----------
  it("does NOT cite a cold-start neutral-50 backer, but still clears softly", () => {
    // The midrank artifact: a no-data inflection sits at neutral-50 yet earns a
    // positive z because the no-data block outranks the real (lower) reads. The gate
    // must still clear (soft, never empties the feed) but must NOT claim it's
    // "backed by a fundamental inflection" it has no data for.
    const r = thesisGate(
      z({ valuation: 1.0, inflection: 0.3 }),
      { valuation: 62, inflection: 50, fundamentals: 50, growth: 50, pipeline: 50 },
    );
    expect(r.cleared).toBe(true);
    expect(r.reason).not.toMatch(/inflection/i);
    expect(r.reason).toMatch(/breadth|no single strong backer/i);
  });

  it("DOES cite a genuinely data-backed backer (raw ≥ 55)", () => {
    const r = thesisGate(
      z({ valuation: 1.0, inflection: 0.3 }),
      { valuation: 62, inflection: 72, fundamentals: 50, growth: 50, pipeline: 50 },
    );
    expect(r.cleared).toBe(true);
    expect(r.reason).toMatch(/inflection/i);
  });

  it("without raw scores, keeps legacy labelling (backward compatible)", () => {
    const r = thesisGate(z({ valuation: 1.0, inflection: 0.3 }));
    expect(r.cleared).toBe(true);
    expect(r.reason).toMatch(/inflection/i);
  });
});
