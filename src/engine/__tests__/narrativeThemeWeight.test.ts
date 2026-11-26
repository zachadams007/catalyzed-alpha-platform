import { describe, it, expect } from "vitest";
import { buildNarrativeIntel, scoreNarrativeMatch } from "@/engine/narrativeIntel";
import type { StockSignal } from "@/types";

/**
 * Guards the 2026-06-26 theme-specificity change (Blueprint "fit"):
 *  - A SPECIFIC core token (quantum, robot…) is near-conclusive - a real quantum
 *    name scores high even when the user ALSO selected robotics (no dilution).
 *  - SOFT adjacency words ("automation", "warehouse") are NOT conclusive - a bank
 *    that merely "automates" must not pass as on-theme robotics.
 * Without this, generic high-quality names floated to the top of theme screens.
 */

const themeKw = buildNarrativeIntel("", ["quantum", "robotics"]).keywords;
const sig = (thesis: string) =>
  ({ ticker: "T", name: "Test Inc", sector: "Technology", thesis }) as unknown as StockSignal;

describe("scoreNarrativeMatch — theme specificity", () => {
  it("a specific quantum match scores high even when combined with robotics tags", () => {
    expect(scoreNarrativeMatch(sig("a quantum computing pure-play"), themeKw).score).toBeGreaterThanOrEqual(65);
  });

  it("a real robotics token scores high", () => {
    expect(scoreNarrativeMatch(sig("builds humanoid robot systems"), themeKw).score).toBeGreaterThanOrEqual(65);
  });

  it("a generic 'automation' mention is NOT conclusive (soft token → capped)", () => {
    expect(scoreNarrativeMatch(sig("a bank investing in automation"), themeKw).score).toBeLessThanOrEqual(42);
  });

  it("an off-theme name with no theme token is capped", () => {
    expect(scoreNarrativeMatch(sig("a consumer fintech payments app"), themeKw).score).toBeLessThanOrEqual(42);
  });
});
