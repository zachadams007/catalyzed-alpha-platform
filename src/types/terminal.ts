/**
 * Terminal feed contract.
 *
 * The Terminal tab (working name; "Bloomberg-style" market intelligence wire)
 * unifies several real-time discovery sources behind a single `TerminalEvent`
 * shape so the UI never has to know which provider an item came from:
 *
 *   - catalyst_news - real-time news wire (Alpaca / Benzinga et al.)
 *   - insider_buy/sell - SEC Form 4 transactions (FMP market-wide, or the
 *                         Python deep-miner cache for richer parsing)
 *   - filing_8k - SEC 8-K material-event filings, market-wide, via the
 *                         EDGAR full-text search API (keyless; direct in Tauri,
 *                         dev-proxied in the browser)
 *   - politician_trade - congressional disclosures (Quiver Quant, when keyed)
 *   - gov_contract - government contract awards (Quiver / USAspending)
 *
 * Like the scoring engine, this stays a pure data contract: sources fan out and
 * normalize into `TerminalEvent[]`; severity is derived by a transparent,
 * documented heuristic (see `src/data/terminal/severity.ts`), never a black box.
 */

export type TerminalEventKind =
  | "catalyst_news"
  | "insider_buy"
  | "insider_sell"
  | "filing_8k"
  | "politician_trade"
  | "gov_contract";

/** Shared severity vocabulary with SocialAlert so styling/pills are consistent. */
export type TerminalSeverity = "high" | "elevated" | "watch";

export interface TerminalTrade {
  direction: "buy" | "sell";
  /** Notional USD value of the transaction when computable (shares × price). */
  valueUsd?: number;
  shares?: number;
  pricePerShare?: number;
  /** Raw SEC transaction code when known, e.g. "P" (purchase), "S" (sale). */
  code?: string;
}

export interface TerminalActor {
  /** Person behind the event - insider name or politician name. */
  name: string;
  /** Their role, e.g. "Officer: CEO", "Senator (R-FL)", "Director". */
  role?: string;
}

export interface TerminalSource {
  /** Display label, e.g. "Alpaca", "FMP", "Quiver Quantitative". */
  name: string;
  /** Canonical outbound link (article, SEC filing, disclosure). */
  url: string;
}

export interface TerminalEvent {
  /** Stable id used for de-duplication and "seen" tracking. */
  id: string;
  kind: TerminalEventKind;
  severity: TerminalSeverity;
  /** Primary symbol (uppercased). May be "" for macro/multi-ticker news. */
  ticker: string;
  /** Other symbols the event touches (Alpaca tags several per article). */
  relatedTickers?: string[];
  companyName?: string;
  /** One-line headline shown on the card. */
  headline: string;
  /** Optional longer blurb. */
  summary?: string;
  /** The person behind an insider/politician event. */
  actor?: TerminalActor;
  /** Trade economics for insider/politician events. */
  trade?: TerminalTrade;
  /** When the underlying event happened (trade/publish time), ISO. */
  occurredAt: string;
  /** When it was filed/disclosed/surfaced to us, ISO. */
  surfacedAt: string;
  source: TerminalSource;
  /** Short, transparent reason this was flagged at its severity. */
  reason?: string;
}

/** Tab filter - "all" plus one entry per event kind. */
export type TerminalFilter = "all" | TerminalEventKind;

/** Row density on the Terminal home wire. */
export type TerminalDensity = "comfortable" | "compact";

/**
 * Saved linked-parameter spread (/terminal/spread): one shared symbol plus the
 * set of panel ids to show. Reopening restores the last spread.
 */
export interface TerminalSpread {
  /** The shared, linked symbol every pane tracks ("" until first set). */
  symbol: string;
  /** Panel ids to render, in order (see SPREAD_PANELS in TerminalSpread.tsx). */
  panels: string[];
}

export interface TerminalSourceStatus {
  id: string;
  name: string;
  /** True when the source returned successfully (even with zero rows). */
  ok: boolean;
  /** Rows contributed this run. */
  count: number;
  /** Why a source is unavailable (missing key, error, tier-limited). */
  note?: string;
}

export interface TerminalFeedResult {
  events: TerminalEvent[];
  sources: TerminalSourceStatus[];
  generatedAt: string;
}
