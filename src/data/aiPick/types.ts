/**
 * AI Pick of the Day - shared TypeScript type.
 *
 * Mirrors the `ai_picks` Supabase table (migration 0021_ai_picks.sql).
 *
 * rank 0 = hero ("Pick of the Day")
 * rank 1 = first runner-up
 * rank 2 = second runner-up
 *
 * Security: this type is READ-ONLY from the client. The table is hardened
 * so anon/authenticated roles have SELECT only; writing requires the
 * service-role key inside the `ai-pick` edge function.
 */
export interface AiPick {
  /** US Eastern calendar date the pick was generated for (YYYY-MM-DD). */
  market_day: string;

  /** 0 = hero, 1 = first runner-up, 2 = second runner-up. */
  rank: number;

  /** The recommended ticker symbol. */
  ticker: string;

  /**
   * Blended score: 0.6 × engine_score + 0.4 × judge_score (0–100).
   * Same 0–100 scale as the main feed's signal scores so they can be
   * displayed side-by-side in the same ScoreRing component.
   */
  final_score: number;

  /**
   * The deterministic engine score from daily_signals for this ticker (0–100).
   * Defaults to 50 if the ticker was absent from the universe that day.
   */
  engine_score: number;

  /** The AI judge's score for this ticker (0–100). */
  judge_score: number;

  /**
   * Judge's confidence in the pick (0–1).
   * The hero always has confidence ≥ 0.65 (pipeline invariant).
   */
  confidence: number;

  /** Suggested hold horizon in trading days (1–5). */
  horizon_days: number;

  /** One-line catalyst summary (from the Gemini deep-dive, Stage 3). */
  catalyst_summary: string;

  /**
   * Catalyst category.
   * One of: 'earnings' | 'fda' | 'insider_buy' | 'ma' | 'political' | 'guidance' | 'other'
   */
  catalyst_type: string;

  /** Primary grounded source URL (Gemini retrieved, ≤72h old at pick time). */
  primary_source_url: string;

  /** Bull advocate's case (from Groq Stage 4, stored verbatim). */
  bull_case: string;

  /** Bear advocate's case (from Groq Stage 4, stored verbatim). */
  bear_case: string;

  /**
   * Skeptic's note (Groq Stage 7, winner only).
   * "What must be false for this to work? Which assumptions are unverified?"
   * Shown verbatim in the card - the #1 trust differentiator.
   */
  skeptic_note: string;

  /**
   * True when the judge identified this as primarily macro-driven (not
   * company-specific). Shown as a warning badge in the UI.
   */
  macro_driven: boolean;

  /** ISO timestamp the row was created. */
  created_at: string;
}
