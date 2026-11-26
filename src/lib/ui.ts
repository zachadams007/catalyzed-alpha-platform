/** UI-only helpers: mapping scores/tones to colors. */

export interface GradientStops {
  a: string;
  b: string;
  solid: string;
}

/** Two-stop gradient + a solid color for a 0..100 score.
 *  Literals (not var()) because these feed SVG gradient stops; keep in sync
 *  with the score-band tokens in src/styles/tokens.css - blue family only,
 *  green is reserved for gain/loss. */
export function scoreColors(score: number): GradientStops {
  if (score >= 75) return { a: "#45d4ff", b: "#1ab2e8", solid: "#45d4ff" }; // --score-high
  if (score >= 60) return { a: "#1ab2e8", b: "#1577b8", solid: "#1ab2e8" }; // --score-good
  if (score >= 45) return { a: "#d9a04a", b: "#e8bc6e", solid: "#d9a04a" }; // --score-mid
  return { a: "#e85d6f", b: "#f08a98", solid: "#e85d6f" }; // --score-low
}

export function scoreLabel(score: number): string {
  if (score >= 80) return "Exceptional";
  if (score >= 70) return "Strong";
  if (score >= 58) return "Constructive";
  if (score >= 45) return "Mixed";
  return "Weak";
}
