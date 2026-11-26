import { create } from "zustand";
import { persist } from "zustand/middleware";
import { safeJSONStorage } from "./safeStorage";
import type {
  AnalystCoverage,
  InteractionEvent,
  InteractionKind,
  Portfolio,
  PortfolioDiscovery,
  PortfolioMode,
  PortfolioQuote,
  ResearchIntel,
  ResearchRun,
  ResearchRunStatus,
  ScreenCriteria,
  ScreenMatch,
  ScreenPreset,
  SocialAlert,
  StockSignal,
  ForYouFilterId,
  TradeHorizon,
  UserPreferences,
  WatchlistAlert,
} from "@/types";
import type { TerminalDensity, TerminalSpread } from "@/types/terminal";
import { defaultGrowthScreenCriteria, screenSignals } from "@/engine/screen";
import {
  buildRelevanceThesis,
  computeAiRelevance,
  hasUsableThesis,
  relevanceThesisSignature,
} from "@/feed/aiRelevance";
import { isResearchAgentAvailable, runResearchAgent } from "@/data/ai/researchAgent";
import {
  getActiveProvider,
  isDataSourceConfigured,
  isLiveDataActive,
  isLiveFunnelViable,
  isProviderResolutionPending,
  isResearchRunAllowed,
  isSampleDataModeEnabled,
  resolveProviderId,
} from "@/data/providers";
import { runResearch, type ResearchResult } from "@/engine/research";
import {
  fetchRecentSharedSignals,
  isDailySignalsCacheConfigured,
  marketDayKey,
  SHARED_BOARD_MAX_AGE_DAYS,
  uploadTodaySharedSignals,
  type BoardRegimeMeta,
  type SharedDailySignals,
} from "@/data/dailySignalsCache";
import {
  readCachedBoard,
  readMostRecentCachedBoard,
  writeCachedBoard,
} from "@/data/dailySignalsIdbCache";
import {
  appendOutcomes,
  emptyLedger,
  normalizeLedger,
  updateForwardReturns,
  type OutcomeLedger,
} from "@/engine/outcomeLedger";
import { buildModelScores } from "@/engine/modelScores";
import { compareModels } from "@/engine/outcomeEval";
import { getActiveVariant, postProcessUniverse, type EngineVariantId } from "@/engine/challenger";
import { overlayTrustedMajors } from "@/data/symbols/trustedMajors";
import { overlayCompanyBlurbs } from "@/data/symbols/companyDescriptions";
import { overlaySectorOverrides } from "@/data/symbols/sectorOverrides";
import { setVariantOverride } from "@/engine/variantOverride";
import {
  isGlobalControlsConfigured,
  saveGlobalControls,
  getScoreSpreadWeight,
  getQualityCapStrength,
} from "@/data/globalControls";
import {
  currentChampion,
  normalizeModelRegistry,
  promoteModelEntry,
  rollbackModelEntry,
  seedModelRegistry,
  variantForRegistry,
  type ModelRegistry,
} from "@/engine/modelRegistry";
import {
  snapshotWatchOutFacts,
  type WatchOutBaseline,
} from "@/feed/negativeSignals";
import { lookupSignalAsync } from "@/engine/lookupSignal";
import { resolveSymbolFromQuery, SymbolResolveError } from "@/data/finnhub/symbolSearch";
import { getSymbol } from "@/data/symbols/symbolDirectory";
import { countUnseenAlerts, deriveSocialAlerts } from "@/engine/socialAlerts";
import {
  applyInteraction,
  defaultPreferences,
  learnFromHoldings,
  tuneArchetypeTilt,
  type HoldingOutcome,
} from "@/feed/feedAlgorithm";
import { nextThemeScope } from "@/feed/emergingThemes";
import { selectToday } from "@/feed/feeds";
import { setCurrentRiskAppetite } from "@/feed/riskTilt";
import { setDiscoveryContext } from "@/data/funnel/modes";
import { isResearchFreshForToday } from "@/lib/researchSchedule";
import { getManualRefreshStatus, recordManualRefresh } from "@/lib/refreshLimiter";
import { isAdminEmail } from "@/lib/admin";
import { useAuthStore } from "@/store/useAuthStore";
import {
  applyTrackedDemoSeed,
  cleanupPortfolios,
  FAKE_TEST_PORTFOLIO_ID,
  MODE_ACCENT,
  SEED_PORTFOLIOS,
  seedPortfoliosForMode,
} from "@/data/seedPortfolios";
import { resolveDemoSignal } from "@/data/demoHoldings";
import { APP_STORAGE_KEY } from "@/lib/app";
import { normalizeTradeHorizon } from "@/lib/tradeHorizon";
import { enrichSignalsWithAnalyst } from "@/data/analyst/enrichFeedAnalyst";
import { fetchAnalystCoverage } from "@/data/analyst/fetchAnalystCoverage";
import { sanitizeSignalsAnalyst } from "@/data/analyst/sanitizeAnalystCoverage";
import { abortLiveDataRequests, isFinnhubConfigured } from "@/data/http";
import { fetchFinnhubPortfolioQuote } from "@/data/finnhub/liveCompany";
import { fetchLiveQuotes } from "@/data/alpaca/snapshots";
import { fetchStockSplits } from "@/data/corporateActions/splits";
import { computeSplitAdjustment } from "@/engine/portfolioSplits";
import {
  createPortfolioValuePoint,
  upsertDailyPortfolioValue,
} from "@/engine/portfolioHistory";

export interface Toast {
  id: string;
  message: string;
  tone: "info" | "success" | "warn";
  /** Optional in-app route - when set the toast is tappable and navigates there
   *  (e.g. a friend-request toast → "/friends"). */
  href?: string;
  /** Optional auto-dismiss override (ms). Defaults to 3200; social toasts linger
   *  longer so they can be tapped. */
  durationMs?: number;
}

/** Options for {@link AppState.pushToast}. */
export interface ToastOptions {
  href?: string;
  durationMs?: number;
}

type WatchlistSyncStatus = "idle" | "loading" | "synced" | "error";

interface AppState {
  // research / signals
  signals: StockSignal[];
  researchStatus: ResearchRunStatus;
  /** Market regime the SCAN scored today's board with (fear & greed + risk-offness),
   *  read from the published daily_signals meta. Drives the feed-tab panic banner.
   *  NOT persisted - refetched with the board on every boot; null when unknown. */
  boardRegime: BoardRegimeMeta | null;
  /**
   * Has this session actually CHECKED whether a published daily scan exists yet?
   * False until the boot shared-cache fetch resolves. The feeds show the loading
   * cue (not the "Scan Market" awaiting state) until this is true - so a slow boot
   * never flashes a "no scan" prompt while the published scan is still loading in.
   */
  hasCheckedSharedScan: boolean;
  currentRun?: ResearchRun;
  lastRun?: ResearchRun;
  runHistory: ResearchRun[];
  /** True when the current signals were read from the shared daily-compute cache
   *  (computed by the first tester to open the app today) rather than scanned on
   *  this device. Powers the honest "today's picks · computed HH:MM" provenance. */
  signalsFromShared: boolean;
  /** True when the current signals came from the local MockDataProvider (the
   *  fictional sample universe) rather than a live provider. Lets us PURGE any
   *  mock-sourced signals the instant live data activates, so the fictional
   *  universe can never linger under a "Live data" badge (the TOCTOU flip). */
  signalsFromMock: boolean;

  // usage tracking (lightweight, persisted) - how often the engine has worked
  /** ISO timestamps of completed research runs (capped). Powers the usage panel. */
  researchRunLog: string[];
  /** Durable all-time count; unlike the recent log, this is never capped. */
  researchRunTotal: number;
  /** Count of on-demand ticker lookups performed. */
  lookupCount: number;

  // personalization
  preferences: UserPreferences;
  interactions: InteractionEvent[];

  // adaptive-algorithm Phase 0 - observational only (see outcomeLedger.ts).
  /** Append-only record of how each published pick scored, vs. its forward return. */
  outcomeLedger: OutcomeLedger;
  /** Champion/challenger model registry + changelog (Operator console). */
  modelRegistry: ModelRegistry;
  /** Per-ticker snapshot of a name's negative-relevant facts when you first got
   *  involved with it (held / watchlisted / group / suggested). Watch-outs diff
   *  against this so only NEW or materially-worse changes surface - never a
   *  condition that was already true when you got in. */
  watchOutBaselines: Record<string, WatchOutBaseline>;

  // collections
  portfolios: Portfolio[];
  watchlist: string[]; // tickers
  /** Personal price-level research reminders, keyed by ticker. Not orders. */
  watchlistAlerts: Record<string, WatchlistAlert>;
  /** Transient cloud-pull lifecycle for gating the watchlist empty state. */
  watchlistSyncStatus: WatchlistSyncStatus;
  screenPresets: ScreenPreset[];
  /** Handles of public channels/accounts the user follows. Starts empty. */
  following: string[];

  // terminal UI state (persisted)
  /** Row density on the Terminal home wire (comfortable ↔ compact). */
  terminalDensity: TerminalDensity;
  /** ISO timestamp of the user's previous Terminal-home visit - powers the
   *  "new since last visit" markers. `null` until the first visit is stamped. */
  lastTerminalVisitAt: string | null;
  /** Personal research notes on the security workspace, keyed by uppercased
   *  ticker. Notes for your own research - never advice, never orders. */
  terminalNotes: Record<string, string>;
  /** Saved linked-parameter spread (shared symbol + selected panels). */
  terminalSpread: TerminalSpread;

  // AI relevance (session-only - never persisted; signals aren't either)
  /** Latest web-grounded research intel used to rank the AI modes. */
  aiRelevanceIntel?: ResearchIntel;
  /** Thesis signature the cached intel was fetched for (dedupes agent calls). */
  aiRelevanceSig?: string;
  /** Lifecycle of the background agent relevance fetch. */
  aiRelevanceStatus: "idle" | "loading" | "ready" | "error";

  // lookup + social
  lookupCache: Record<string, StockSignal>;
  portfolioQuotes: Record<string, PortfolioQuote>;
  /**
   * Live-price overlay (Alpaca IEX snapshots) keyed by ticker. Only the DISPLAYED
   * price / day-change ticks live; the daily research score is never touched.
   * Populated on view-open + manual refresh (no background polling).
   */
  livePrices: Record<string, PortfolioQuote>;
  /** ISO timestamp of the last successful live-price refresh (for the "as of" UI). */
  livePricesUpdatedAt: string | null;
  /** Session cache of live analyst coverage (filled on stock detail). */
  analystCache: Record<string, AnalystCoverage>;
  socialAlerts: SocialAlert[];
  seenAlertIds: string[];

  // ui
  toasts: Toast[];

  // actions
  bootstrap: () => void;
  runResearchNow: (trigger?: "manual" | "scheduled") => Promise<void>;
  recordInteraction: (kind: InteractionKind, signal: StockSignal) => void;
  toggleLike: (signal: StockSignal) => void;
  isLiked: (ticker: string) => boolean;
  toggleWatchlist: (signal: StockSignal) => void;
  /**
   * Add ANY directory-resolvable symbol (ticker or company name) to the
   * watchlist - no scored signal required, so US + Canadian (.TO/.V/.NE) names
   * that aren't in today's scored feed can still be saved. Canonicalizes the
   * input via the bundled symbol directory ("mda" → "MDA.TO"). Returns false if
   * it can't be resolved to a plausible security or is already saved.
   */
  addToWatchlistByTicker: (ticker: string) => boolean;
  isWatchlisted: (ticker: string) => boolean;
  /** Remove a ticker from the watchlist by symbol (no signal needed). */
  removeFromWatchlist: (ticker: string) => void;
  /** Attach or replace a price-level research reminder for a ticker. */
  setWatchlistAlert: (ticker: string, alert: { price: number; direction: "above" | "below" }) => void;
  /** Clear a ticker's research reminder. */
  clearWatchlistAlert: (ticker: string) => void;
  followChannel: (handle: string) => void;
  unfollowChannel: (handle: string) => void;
  isFollowing: (handle: string) => boolean;
  /** Set the Terminal-home row density. */
  setTerminalDensity: (density: TerminalDensity) => void;
  /**
   * Stamp "now" as the latest Terminal-home visit and return the PREVIOUS
   * visit's ISO timestamp (or null on the first ever visit) so the caller can
   * mark events that surfaced since then. Idempotent within a render via the
   * returned value - call once on mount.
   */
  markTerminalVisited: () => string | null;
  /** Save (or clear, when blank) the personal research note for a ticker. */
  setTerminalNote: (ticker: string, text: string) => void;
  /** Replace the whole per-ticker notes map at once (cross-device sync apply). */
  replaceTerminalNotes: (notes: Record<string, string>) => void;
  /** Replace the whole watchlist + alerts at once (cross-device sync apply). */
  replaceWatchlist: (tickers: string[], alerts: Record<string, WatchlistAlert>) => void;
  /** Set the transient cloud watchlist sync lifecycle. */
  setWatchlistSyncStatus: (status: WatchlistSyncStatus) => void;
  /** Patch the saved linked-parameter spread (shared symbol and/or panels). */
  setTerminalSpread: (patch: Partial<TerminalSpread>) => void;
  createPortfolio: (name: string, mode: PortfolioMode, description: string) => Portfolio;
  addToPortfolio: (portfolioId: string, signal: StockSignal) => void;
  addHoldingByTicker: (
    portfolioId: string,
    ticker: string,
    opts?: { shares?: number; costBasis?: number; value?: number },
  ) => boolean;
  addHoldingsBulk: (
    portfolioId: string,
    items: { ticker: string; shares?: number; costBasis?: number; value?: number }[],
  ) => number;
  upsertHoldingsBulk: (
    portfolioId: string,
    items: { ticker: string; shares?: number; costBasis?: number; value?: number }[],
  ) => { added: number; updated: number };
  updateHolding: (
    portfolioId: string,
    ticker: string,
    patch: { shares?: number; costBasis?: number; note?: string; value?: number },
  ) => void;
  removeFromPortfolio: (portfolioId: string, ticker: string) => void;
  /**
   * Fetch real corporate-action (stock split) records for every held ticker
   * with shares tracked, and rescale any holding whose lot predates a split
   * that hasn't been applied or rejected yet. Never silent: each rescale is
   * recorded as a `splitAdjustment` audit trail the UI surfaces with Undo.
   * Returns the count of holdings adjusted.
   */
  checkPortfolioSplits: (portfolioId: string) => Promise<number>;
  /** Restore a holding's original (pre-split) shares/costBasis and permanently
   *  exclude the undone split date(s) from future auto-detection. */
  undoSplitAdjustment: (portfolioId: string, ticker: string) => void;
  /** Hide a holding's split-adjustment note without reverting the rescale. */
  dismissSplitAdjustmentNote: (portfolioId: string, ticker: string) => void;
  deletePortfolio: (portfolioId: string) => void;
  /** Apply a synced set of the user's own ("me") portfolios (cloud pull). */
  replaceOwnPortfolios: (
    next: Portfolio[] | undefined,
    options?: { authoritative?: boolean },
  ) => void;
  signalByTicker: (ticker: string) => StockSignal | undefined;
  resolveSignal: (ticker: string) => StockSignal | undefined;
  lookupTicker: (ticker: string) => Promise<StockSignal>;
  refreshPortfolioQuotes: (portfolioId: string) => Promise<number>;
  /** Refresh the live-price overlay for the given tickers (Alpaca bulk snapshot). */
  refreshLivePrices: (tickers: string[]) => Promise<number>;
  recordPortfolioValues: () => void;
  setAnalystCache: (ticker: string, coverage: AnalystCoverage) => void;
  analystForTicker: (ticker: string) => AnalystCoverage | undefined;
  refreshSocialAlerts: (opts?: { notify?: boolean }) => void;
  markAlertsSeen: () => void;
  unseenSocialCount: () => number;
  resetPersonalization: () => void;
  setTradeHorizon: (horizon: TradeHorizon) => void;
  tuneArchetype: (dir: "more" | "less") => void;
  /** Toggle one For-You filter chip (hard filter - see src/feed/feedFilters.ts). */
  toggleForYouFilter: (id: ForYouFilterId) => void;
  /** Toggle an emerging-theme slug in the For-You theme scope (min 1 stays active). */
  toggleForYouTheme: (slug: string) => void;
  /** Restore the For-You theme scope to ALL curated themes. */
  setForYouThemesAll: () => void;
  /** Set the For-You risk dial by hand (0..1); locks out implicit nudges. */
  setRiskAppetite: (value: number) => void;
  learnFromPortfolios: () => void;
  /** Capture a watch-out baseline (first-sight, never overwritten) for each ticker
   *  the user is involved with, from the live signals - so future watch-outs surface
   *  only NEW / materially-worse changes. Idempotent. */
  ensureWatchOutBaselines: (tickers: string[], signals: StockSignal[]) => void;
  /** Operator-only: promote a model version to champion (sets the runtime variant). */
  promoteModel: (id: string) => void;
  /** Operator-only: roll the champion back to a prior version. */
  rollbackModel: (id: string) => void;
  /**
   * Re-rank the live feed to the GLOBAL active variant. Called on a remote
   * operator promotion (realtime) so a non-operator client adopts the new model
   * immediately without a reload. Reads getActiveVariant() (global-first), and
   * mirrors the registry's championId to match so the Operator/Model-Lab UI on
   * this device reflects the live model. No-op when the live model is unchanged.
   */
  syncActiveVariantFromGlobal: () => void;
  /**
   * Re-rank the in-memory `signals` (Today, Weekly, For-You, AI picks - every
   * surface reads the same array) when the operator's score-spread / quality-cap
   * sliders change, so a dial move is visible on already-loaded names IMMEDIATELY
   * instead of only on the next full load. Diffs the live `getScoreSpreadWeight()`
   * / `getQualityCapStrength()` values against what the board was last ranked
   * with (tracked by `rerankSignalsForVariant`) and no-ops when neither moved -
   * so this is safe to call on every global-controls notify, including ones
   * triggered by an unrelated field (sample mode, budgets, active variant).
   */
  applyDisplayControlsChange: () => void;
  /**
   * Purge any signals that were sourced from the local mock universe once LIVE
   * data is active. Defends against the boot-to-resolve TOCTOU: if the store ever
   * held mock signals (e.g. a sample window before the operator's controls
   * resolved) and the operator's choice then flips to live, the fictional tickers
   * must NOT linger under a "Live data" badge. Clears the feed back to a skeleton
   * so bootstrap re-runs against the live provider. No-op unless live is active
   * and the current signals are mock-sourced.
   */
  clearMockSignalsIfLive: () => void;
  runScreen: (
    horizon: TradeHorizon | TradeHorizon[],
    criteria: ScreenCriteria,
    description: string,
    excludeTickers?: string[],
  ) => ScreenMatch[];
  /**
   * Fetch (and cache) the hosted research agent's relevance intel for the active
   * thesis. Fire-and-forget: callers trigger it, then re-read `aiRelevanceIntel`
   * via `runScreen`. No-op when no agent is configured.
   */
  refreshAiRelevance: (
    horizon: TradeHorizon | TradeHorizon[],
    criteria: ScreenCriteria,
    description: string,
  ) => Promise<void>;
  /**
   * Install research intel that was ALREADY fetched (Blueprint's unified
   * "Run Blueprint" discover pass) as the active relevance map - same effect
   * as `refreshAiRelevance` without spending a second agent call.
   */
  adoptAiRelevanceIntel: (
    intel: ResearchIntel,
    criteria: ScreenCriteria,
    description: string,
  ) => void;
  saveScreenPreset: (preset: Omit<ScreenPreset, "id" | "createdAt" | "updatedAt"> & { id?: string }) => ScreenPreset;
  deleteScreenPreset: (id: string) => void;
  mergeScreenPresetResults: (presetId: string, tickers: string[]) => void;
  setPortfolioDiscovery: (portfolioId: string, discovery: PortfolioDiscovery) => void;
  runPortfolioDiscovery: (portfolioId: string, addCount?: number) => string[];
  pushToast: (message: string, tone?: Toast["tone"], opts?: ToastOptions) => void;
  dismissToast: (id: string) => void;
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A bare ticker shape (incl. Canadian "MDA.TO" / "GIB-A.TO" / "DEFI.NE"). */
const TICKER_RE = /^[A-Z][A-Z0-9]*([.\-][A-Z0-9]+)*$/;

/**
 * Canonicalize a typed symbol against the bundled offline directory so any real
 * listed security - US or Canadian, scored today or not - resolves to its
 * directory form ("mda" → "MDA.TO", "defi.ne" → "DEFI.NE"). Exact/suffix-tolerant
 * only (never a fuzzy name guess), so a holding/watch entry is never silently
 * mis-mapped. Falls back to the uppercased input for a still-plausible ticker the
 * bundle hasn't caught up to yet (brand-new listings); null for unresolvable junk.
 */
function canonicalizeSymbol(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const rec = getSymbol(trimmed);
  if (rec) return rec.symbol;
  const up = trimmed.toUpperCase();
  return TICKER_RE.test(up) && up.length <= 12 ? up : null;
}
const refreshingPortfolioQuotes = new Set<string>();
const checkingPortfolioSplits = new Set<string>();
let automaticResearchRetryUsed = false;
/** One-shot per session: don't re-toast the challenger-cleared-the-bar suggestion. */
let challengerPromotionNotified = false;
const AUTOMATIC_RESEARCH_RETRY_MS = 2_500;
/**
 * Hard ceiling for a single research scan. Belt-and-suspenders over the per-GET
 * timeout in `httpText`: even if some unforeseen step stalls without ever
 * emitting a rejection (a tight loop, a non-HTTP await, a hung dynamic import),
 * the whole run settles into the existing catch instead of leaving the Today
 * feed stuck on a skeleton forever. The catch flips researchStatus to 'error'
 * and surfaces the feed error console + Retry.
 */
const SCAN_BUDGET_MS = 180_000;
/** Rejects after `ms`, for racing an overall watchdog against an awaited run. */
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
const PORTFOLIO_SYNC_SNAPSHOT_KEY = `${APP_STORAGE_KEY}:portfolio-sync-snapshot`;
let portfolioSyncSnapshot = "";
/** Guards against duplicate in-flight agent relevance calls for one thesis. */
let inFlightRelevanceSig: string | null = null;
/** Per-thesis network timeout - comfortably exceeds the proxy's upstream budget. */
const RELEVANCE_TIMEOUT_MS = 30_000;

function snapshotOwnPortfolios(portfolios: Portfolio[]): void {
  if (portfolios.length === 0) return;
  portfolioSyncSnapshot = JSON.stringify({
    capturedAt: new Date().toISOString(),
    portfolios,
  });
  try {
    localStorage.setItem(PORTFOLIO_SYNC_SNAPSHOT_KEY, portfolioSyncSnapshot);
  } catch {
    // The in-memory snapshot still provides a recovery point for this session.
  }
}

/**
 * Re-rank the in-memory universe with `variant` so an operator promotion /
 * rollback takes effect on the LIVE feed immediately - not only on the next
 * research run. Recomputed from each signal's preserved RAW per-category scores
 * (never the already-published opportunityScore), then sorted exactly like a
 * fresh research publish. Pure + cheap (no vendor calls): the promoted model's
 * ranking is what the user sees the moment they promote. The time-aware
 * challenger refinements (EWMA / estimate-revision) re-engage on the next scan,
 * which carries the daily history context; the cap-balancing + thesis-gate
 * differences are visible right away.
 */
function rerankSignalsForVariant(
  signals: StockSignal[],
  variant: EngineVariantId,
  /**
   * The market regime the SCAN ranked this board with, read back from the
   * published board meta. Without it every client-side re-rank silently ran at
   * riskOffness 0 - so the panic-opportunity weight overlay and the amplified
   * discount tilt that the scan applied were dropped the moment the app re-ranked,
   * and the board the user saw drifted from the board that was published. Absent
   * (old rows / no meta) ⇒ neutral, exactly as before.
   */
  boardRegime?: BoardRegimeMeta | null,
): StockSignal[] {
  // Stamp the display-control values this rank was computed with - EVERY
  // re-rank path (ingest, promote/rollback, the global sync below) funnels
  // through this one function, so this is the single source of truth for
  // "what did the live board last see." applyDisplayControlsChange() diffs
  // against this to decide whether a realtime dial-move needs a fresh rank.
  lastAppliedSpreadWeight = getScoreSpreadWeight();
  lastAppliedCapStrength = getQualityCapStrength();
  if (signals.length === 0) return signals;
  const ctx =
    boardRegime && Number.isFinite(boardRegime.riskOffness)
      ? {
          regime: {
            riskOffness: boardRegime.riskOffness,
            label: boardRegime.label as "risk-on" | "neutral" | "risk-off" | undefined,
            fearGreed: boardRegime.fearGreed,
            fearGreedLabel: boardRegime.fearGreedLabel,
            fearGreedSource: boardRegime.fearGreedSource,
            reason: boardRegime.reason,
          },
        }
      : undefined;
  return postProcessUniverse(signals, variant, ctx).sort(
    (a, b) => b.score.opportunityScore - a.score.opportunityScore,
  );
}

/**
 * The score-spread / quality-cap values the in-memory `signals` were last
 * ranked with. Ephemeral (module-level, not persisted) - purely a dedup guard
 * so `applyDisplayControlsChange` only re-ranks when the operator's dials
 * actually moved, never on every unrelated realtime notify. `null` until the
 * first rank has happened this session, so the very first check is always a
 * pass-through (nothing to compare against yet).
 */
let lastAppliedSpreadWeight: number | null = null;
let lastAppliedCapStrength: number | null = null;

/**
 * Persist an operator's promoted/rolled-back variant as the LIVE model.
 *
 * GLOBAL-FIRST (mirrors the sample/pause controls): when Supabase is configured
 * the variant is written to `app_controls.active_variant` via the operator-only
 * RPC, so the model goes live for EVERY client - not just this device. Every
 * client reads that global value through getActiveVariant() on load + on the
 * realtime change, so promoting on the operator's device switches the model for
 * everyone. The device-local override is written ONLY as the dev fallback when no
 * global source exists. The RPC is operator-gated server-side, so a non-operator
 * call is a no-op (saveGlobalControls returns false before any write).
 */
function persistActiveVariant(variant: EngineVariantId): void {
  if (isGlobalControlsConfigured()) {
    void saveGlobalControls({ activeVariant: variant });
    return;
  }
  setVariantOverride(variant);
}

function allScoredSignals(signals: StockSignal[], lookupCache: Record<string, StockSignal>): StockSignal[] {
  const byTicker = new Map<string, StockSignal>();
  for (const s of signals) byTicker.set(s.ticker, s);
  for (const s of Object.values(lookupCache)) byTicker.set(s.ticker, s);
  return [...byTicker.values()];
}

/**
 * Apply a completed research result to the store - the single place that turns a
 * {run, signals} pair into the live feed + outcome-ledger updates, whether the
 * result was scanned locally on this device or read from the shared daily cache.
 * Keeping both paths funneled through here guarantees a shared-cache reader's
 * feed is byte-for-byte identical to a local computer's (same signals, scores,
 * ledger) - the device just skipped the vendor calls.
 */
function applyResearchResult(
  set: (updater: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState,
  result: ResearchResult,
  opts: {
    fromShared: boolean;
    /** True when these signals came from the local mock universe (not a live
     *  provider). Tracked so `clearMockSignalsIfLive` can purge them if live data
     *  later activates. Shared-cache reads are always live-sourced (fromMock=false). */
    fromMock?: boolean;
    /**
     * Local-scan only: called with the analyst-enriched signals once enrichment
     * finishes, so the shared cache is published COMPLETE (analyst coverage
     * baked in). That's what lets a cache reader render full parity with ZERO
     * vendor calls - see the fromShared branch below, which never enriches.
     */
    onEnriched?: (signals: StockSignal[], run: ResearchRun) => void;
  },
): void {
  const { run, normalizationContext } = result;
  // Correct cap + sector for the market-majors backbone on ingest: a throttled scan
  // can publish a synthetic seed for a big name (TSLA "Real Estate $5.4T", JPM
  // "$11.9T"). Overlay the trusted roster here, ONCE, so every surface (feed, cards,
  // search, detail, heatmap) renders real values. Off-roster names are untouched.
  // Also fill the "what this company does" blurb from the curated map on ingest,
  // so the already-scored shared board shows a real description instead of the
  // generic "<name> is a <sector> company" an older/throttled scan baked in.
  // And correct any known-mislabeled sector (CRSP/TNYA/EVMN/PCT/JOBY/... - see
  // sectorOverrides.ts) so a stale cached board self-heals without a rescan and
  // sector-neutralization stops demeaning biotechs against semiconductors.
  const overlaid = overlayCompanyBlurbs(overlayTrustedMajors(overlaySectorOverrides(result.signals)));
  // CHAMPION RANKS THE PUBLISHED FEED (catalyzed-feed-not-running-v2). A SHARED-cache
  // read is whatever the trusted scan uploaded - which, for any board produced before
  // the scan started champion-ranking (or by an older bundle), is the flat scoreCompany
  // average that bunches at 30-59 and under-weights catalysts. Re-rank it through the
  // ACTIVE variant on ingest so EVERY reader sees the champion's catalyst/discount/
  // cohort ranking + the 0-100 decompression - CLIENT-SIDE, no cloud redeploy or fresh
  // scan required. `postProcessUniverse` recomputes opportunityScore from the preserved
  // raw category + catalyst inputs (StockSignal extends CompanyData), so it is fully
  // IDEMPOTENT - running it on an already-champion-ranked board reproduces the same
  // scores. A LOCAL scan is already post-processed by the research pipeline, so we only
  // re-rank the shared path (keeps the local flow's analyst-enrichment seam untouched).
  const signals = opts.fromShared
    ? rerankSignalsForVariant(overlaid, getActiveVariant(), get().boardRegime)
    : overlaid;
  const publishedAt = run.finishedAt ?? new Date().toISOString();
  // Reconstruct BOTH variants' scores so the outcome ledger records champion +
  // challenger against the same prices. A shared-cache read carries no time-aware
  // normalization context, so it falls back to the cross-sectional view (ctx
  // undefined) - honest: that reader didn't run the challenger's EWMA pass.
  const models = buildModelScores(signals, getActiveVariant(), normalizationContext);
  set((state) => ({
    signals,
    lastRun: run,
    currentRun: run,
    researchStatus: "complete",
    hasCheckedSharedScan: true,
    signalsFromShared: opts.fromShared,
    signalsFromMock: opts.fromMock ?? false,
    runHistory: [run, ...state.runHistory].slice(0, 10),
    researchRunLog: [run.finishedAt ?? new Date().toISOString(), ...state.researchRunLog].slice(
      0,
      200,
    ),
    researchRunTotal: state.researchRunTotal + 1,
    outcomeLedger: updateForwardReturns(
      appendOutcomes(state.outcomeLedger, signals, publishedAt, {
        models,
        // Stamp WHICH engine made these picks, so the Track Record can be split
        // by version instead of mixing a new model's record into the old one's.
        liveVariant: getActiveVariant(),
      }),
      signals,
      publishedAt,
    ),
  }));

  // A shared-cache read must spend ZERO vendor calls - the cached signals were
  // already analyst-enriched by the device that computed them, so do NOT re-fetch
  // analyst coverage here (it would loop fetchAnalystCoverage over the whole
  // universe). The cached `signal.analyst` renders directly.
  if (opts.fromShared) return;

  // Local scan: enrich analyst coverage (per-name Finnhub calls), update the
  // store, then hand the ENRICHED set to the uploader so the published cache is
  // complete. If enrichment fails, still publish the un-enriched scan.
  void enrichSignalsWithAnalyst(signals)
    .then(({ signals: withAnalyst, cache }) => {
      set((state) => ({
        signals: withAnalyst,
        analystCache: { ...state.analystCache, ...cache },
      }));
      opts.onEnriched?.(withAnalyst, run);
    })
    .catch(() => {
      opts.onEnriched?.(signals, run);
    });
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      signals: [],
      researchStatus: "idle",
      boardRegime: null,
      hasCheckedSharedScan: false,
      currentRun: undefined,
      lastRun: undefined,
      runHistory: [],
      signalsFromShared: false,
      signalsFromMock: false,
      researchRunLog: [],
      researchRunTotal: 0,
      lookupCount: 0,
      aiRelevanceIntel: undefined,
      aiRelevanceSig: undefined,
      aiRelevanceStatus: "idle",
      preferences: defaultPreferences(),
      interactions: [],
      outcomeLedger: emptyLedger(),
      modelRegistry: seedModelRegistry(),
      watchOutBaselines: {},
      portfolios: seedPortfoliosForMode(),
      watchlist: [],
      watchlistAlerts: {},
      watchlistSyncStatus: "idle",
      screenPresets: [],
      following: [],
      terminalDensity: "comfortable",
      lastTerminalVisitAt: null,
      terminalNotes: {},
      terminalSpread: { symbol: "", panels: ["chart", "news", "ai", "score"] },
      lookupCache: {},
      portfolioQuotes: {},
      livePrices: {},
      livePricesUpdatedAt: null,
      analystCache: {},
      socialAlerts: [],
      seenAlertIds: [],
      toasts: [],

      bootstrap: () => {
        let { signals } = get();
        const { researchStatus, lastRun } = get();

        // PRIME-DIRECTIVE sanitize on rehydrate. Persisted signals (including a
        // shared-cache feed from a prior session) can carry sample-origin analyst
        // coverage ("Sample consensus" / status:"sample") baked in before the
        // honesty invariant existed. Outside Sample data mode that would render
        // fabricated targets under a "Live data" badge on app open, so strip it
        // here before anything reads `signals`. Sample mode ON keeps the
        // illustrative baseline. No-ops (returns the same array) when nothing is
        // sample-origin, so it's free for the common clean case.
        const cleaned = sanitizeSignalsAnalyst(signals, isSampleDataModeEnabled());
        if (cleaned !== signals) {
          signals = cleaned;
          set({ signals: cleaned });
        }

        // Same honesty pass for the persisted lookupCache: it holds full
        // StockSignal objects (analyst coverage included) cached at lookup time
        // - possibly under Sample mode - and is rendered directly by the
        // watchlist/portfolio/beacon resolvers, so without this a sample-origin
        // analyst payload survives a Sample→Live switch and paints fabricated
        // targets under a live badge. (Audit finding, 2026-07-02.)
        const cache = get().lookupCache;
        const cacheKeys = Object.keys(cache);
        if (cacheKeys.length > 0) {
          const values = cacheKeys.map((k) => cache[k]);
          const cleanedValues = sanitizeSignalsAnalyst(values, isSampleDataModeEnabled());
          if (cleanedValues !== values) {
            const nextCache: Record<string, StockSignal> = {};
            cacheKeys.forEach((k, i) => {
              nextCache[k] = cleanedValues[i];
            });
            set({ lookupCache: nextCache });
          }
        }

        // Sync the funnel's research-time risk dial with the persisted preference.
        setCurrentRiskAppetite(get().preferences.riskAppetite ?? 0.55);

        // Backfill analyst coverage onto any cached signals that lack it. This
        // path itself no-ops unless analyst enrichment is configured. Skip it for
        // signals pulled from the shared daily cache - those readers must spend
        // ZERO vendor calls (the computing device already baked analyst coverage
        // into the cached payload).
        if (signals.length > 0 && !get().signalsFromShared && signals.some((s) => !s.analyst)) {
          void enrichSignalsWithAnalyst(signals).then(({ signals: withAnalyst, cache }) => {
            set((state) => ({
              signals: withAnalyst,
              analystCache: { ...state.analystCache, ...cache },
            }));
          });
        }

        if (researchStatus === "running") return;
        // Honor the API kill switch / unconfigured-source guards. When a live
        // provider isn't ready (or access is paused), never auto-run.
        if (!isDataSourceConfigured() || !isResearchRunAllowed()) return;

        // Daily-cache contract: research refreshes at most once per "research
        // day" (the first open after VITE_RESEARCH_RUN_HOUR). If we already
        // hold signals from after today's boundary, reuse them - reopening the
        // app is instant and spends ZERO API quota. Scan the Market forces a fresh
        // run regardless (see runResearchNow("manual")).
        const freshForToday =
          signals.length > 0 && isResearchFreshForToday(lastRun?.finishedAt);
        if (freshForToday) {
          // Cached run is current; surface it without re-running.
          set((s) => ({
            researchStatus: s.researchStatus === "idle" ? "complete" : s.researchStatus,
            hasCheckedSharedScan: true,
          }));
          return;
        }

        // No cache, or it's from a prior day → run once for today. On the mock
        // provider this regenerates the sample universe (free); on a live
        // provider this is the single daily refresh.
        void get().runResearchNow("scheduled");
      },

      runResearchNow: async (trigger = "manual") => {
        const liveStatus = get().researchStatus;
        if (liveStatus === "running" || liveStatus === "loading") return;
        // Refused runs must not demote an existing error: the feeds key their
        // error console (with its Retry) off researchStatus === "error", and
        // flipping to "idle" would strand them on a skeleton that implies a
        // run is happening.
        if (!isDataSourceConfigured()) {
          set((s) => ({ researchStatus: s.researchStatus === "error" ? "error" : "idle" }));
          if (trigger === "manual") {
            get().pushToast("Connect a data source to scan the market (add an API key).", "warn");
          }
          return;
        }
        if (!isResearchRunAllowed()) {
          set((s) => ({
            researchStatus: s.researchStatus === "error" ? "error" : "idle",
            currentRun: undefined,
          }));
          if (trigger === "manual") {
            get().pushToast(
              "Live/API data access is OFF in the Operator Console. No research calls were started.",
              "warn",
            );
          }
          return;
        }
        // Per-user soft refresh limiter (manual runs only). This sits ON TOP of
        // the once-daily auto-cache above: the scheduled run is free and not
        // capped; manual "Scan the Market" presses are limited to MANUAL_REFRESH_LIMIT
        // per day. Admins (operator allowlist) bypass it. When the cap is hit we
        // leave researchStatus untouched so the cached feed (or an existing error
        // console) stays exactly as it was - no skeleton, no demotion.
        if (trigger === "manual") {
          const isAdmin = isAdminEmail(useAuthStore.getState().email);
          const limit = getManualRefreshStatus({ isAdmin });
          if (limit.blocked) {
            get().pushToast(
              `You've used all ${limit.limit} manual refreshes today — your feed already refreshed automatically. Fresh data runs again tomorrow.`,
              "warn",
            );
            return;
          }
          recordManualRefresh({ isAdmin });
        }

        // Shared daily compute - the free-tier rate-limit fix. On the once-daily
        // AUTO path, the first tester to open the app this market day computes the
        // scan; everyone else READS the finished result here, spending ZERO vendor
        // calls (no per-device Finnhub 60/min burst). A manual "Scan Market" press
        // skips this and forces a fresh local scan, which republishes the cache
        // below. Mock/sample data never touches it (it regenerates locally, free).
        if (trigger === "scheduled" && isLiveDataActive() && isDailySignalsCacheConfigured()) {
          // COLD-LOAD FIX (perf-diagnosis Finding #1): the 2nd+ open on the SAME
          // market day should paint the board with NO visible skeleton at all.
          // Today's `daily_signals` row is a first-writer-wins, immutable-for-the-
          // day snapshot (see dailySignalsCache.ts's uploadTodaySharedSignals doc
          // comment), so once THIS device has fetched it once today, re-fetching
          // it over the network on every later open is pure waste. Check the
          // local IndexedDB cache FIRST, keyed by the EXACT SAME `marketDayKey()`
          // used everywhere else (isSharedSignalsFresh, the scan writer) - no
          // second day-boundary rule invented here. A hit applies the board
          // directly and returns WITHOUT ever setting `researchStatus: "loading"`,
          // so the skeleton never paints. A miss (first open of the day, private
          // browsing, blocked storage, no IndexedDB, or any read error/timeout -
          // see dailySignalsIdbCache.ts) falls through to the existing network
          // path below, completely unchanged. The fail-closed gate above
          // (`isLiveDataActive()`) is re-evaluated fresh on every boot and wraps
          // this whole branch, so if the operator has since flipped sample-mode/
          // paused, this fast path is never reached - no separate gate needed.
          // Shared by every "we already have this board locally" branch below
          // (exact-today hit, and the fallback-day hit) so they stay
          // byte-for-byte identical instead of risking drift between
          // hand-copied blocks.
          const applyCachedBoard = (board: SharedDailySignals) => {
            const cleanCachedSignals = sanitizeSignalsAnalyst(
              board.signals,
              isSampleDataModeEnabled(),
            );
            set({ boardRegime: board.regime ?? null });
            applyResearchResult(
              set,
              get,
              { run: board.run, signals: cleanCachedSignals },
              { fromShared: true },
            );
            get().refreshSocialAlerts({ notify: false });
            get().recordPortfolioValues();
            get().learnFromPortfolios();
          };

          const todayKey = marketDayKey();
          // Belt-and-suspenders: readCachedBoard already resolves (never
          // rejects) on every internal failure, but a defensive `.catch` here
          // means even an unforeseen throw can't turn "no cache" into an
          // uncaught rejection on the boot path - it degrades to the exact
          // same network fallback as an ordinary miss.
          const cachedBoard = await readCachedBoard(todayKey).catch(() => null);
          if (cachedBoard && cachedBoard.signals.length > 0) {
            applyCachedBoard(cachedBoard);
            return;
          }

          // Gap in the exact-key check above: `writeCachedBoard` keys a record
          // by the row's OWN marketDay (never relabeled as "today" - see that
          // function's doc comment), and `fetchRecentSharedSignals` below can
          // legitimately return a board dated BEFORE today (pre-scan hours, a
          // delayed/failed nightly Action, a weekend the scan didn't cover).
          // On a day like that, the record written after the FIRST network
          // fetch is keyed by yesterday's date - so without this check, EVERY
          // later open that same day would miss the exact-key lookup above and
          // pay for a full ~5MB re-fetch again, even though the identical board
          // is already sitting in IndexedDB. Mirrors fetchRecentSharedSignals's
          // own staleness window (SHARED_BOARD_MAX_AGE_DAYS) so "recent enough"
          // never drifts between the two layers.
          const recentCached = await readMostRecentCachedBoard(
            todayKey,
            SHARED_BOARD_MAX_AGE_DAYS,
          ).catch(() => null);
          if (recentCached && recentCached.signals.length > 0) {
            applyCachedBoard(recentCached);
            return;
          }

          // Reading the published board is NOT a market scan. Enter the light
          // "loading" state (skeletons, no "Scanning…"/"Running research" copy) so
          // opening the app never LOOKS like it re-scans the market on every open
          // (the owner's repeated complaint) - and it dedups concurrent boot calls via
          // the running/loading guard at the top of this function.
          set({ researchStatus: "loading" });
          // Adopt the LATEST published scan on boot even if it isn't today's row (weekend,
          // pre-Action, or a delayed run). `fetchRecentSharedSignals` returns the most-recent
          // board within a freshness window, carrying its OWN "as of" scan date - so the app
          // boots straight to the cached board instead of an empty "scan now" prompt the morning
          // before today's scan lands.
          const shared = await fetchRecentSharedSignals();
          if (shared && shared.signals.length > 0) {
            // Write-through: cache this board locally (IndexedDB, best-effort,
            // fire-and-forget - never awaited, never throws) so the NEXT open
            // this same market day hits the fast path above instead of
            // re-fetching. Keyed by the row's OWN `marketDay` (today's row, or a
            // recent fallback day when today's scan hasn't landed yet - see
            // readMostRecentCachedBoard above, which is what makes that write
            // pay off on the NEXT open of a no-fresh-scan-yet day too).
            void writeCachedBoard(shared).catch(() => {});
            // PRIME-DIRECTIVE sanitize on ingest happens inside applyCachedBoard.
            // The already-published daily_signals cache can carry sample-origin
            // analyst coverage ("Sample consensus" / status:"sample") baked in by
            // a scan that ran before the upstream honesty invariant. A
            // shared-cache read never re-enriches, so that polluted coverage
            // would render verbatim under a "Live data" badge - sanitizing here
            // (we only reach this branch when isLiveDataActive(), i.e. sample
            // mode is OFF) neutralizes the deployed cache immediately, without a
            // re-scan.
            applyCachedBoard(shared);
            return;
          }
        }

        // BOOT NEVER CLIENT-SCANS in live mode. The GitHub Action is the scanner; only a manual
        // "Scan Market" press runs the local funnel. (Sample/mock mode is exempt - it
        // regenerates its universe locally + free.)
        if (trigger === "scheduled" && isLiveDataActive()) {
          set({
            researchStatus: get().signals.length > 0 ? "complete" : "idle",
            // We DID query the published cache (it just isn't there yet) - so the
            // feed can now honestly offer the "Scan Market" path instead of an
            // indefinite loading cue. This is the genuine "no scan yet" case.
            hasCheckedSharedScan: true,
          });
          return;
        }

        // VIABILITY GATE - determine BEFORE running the funnel whether its live
        // Full-Market screener sweep can actually work. The funnel is the default
        // live provider whenever FMP is "configured", but on the KEYLESS web build
        // the proxy injects a placeholder key (so isFmpConfigured() is true) while
        // FMP's paid-tier `/stock-screener` endpoint is unavailable on that path -
        // so the sweep returns 0 rows and FunnelDataProvider throws "produced no
        // candidates". Fired fire-and-forget on every boot, that throw spammed the
        // console and (with an empty feed) triggered the auto-retry, an error loop.
        //
        // When the active provider is the funnel but it is NOT viable (no real
        // local FMP key - i.e. the keyless web build), DO NOT run it. The real
        // pre-market scan for these clients lives in the cloud `daily_signals`
        // cache, which we already attempted above; reaching here means today's row
        // hasn't landed yet. Degrade HONESTLY with a single status - no throw, no
        // console error, no retry loop:
        //   - if we already hold this day's published scan, keep it (complete);
        //   - otherwise set 'error' once with a clear "live scan unavailable -
        //     showing the latest published scan" message (manual presses toast it).
        // Desktop / a real local FMP key is unaffected: isLiveFunnelViable() is
        // true there and the live funnel runs exactly as before.
        if (isLiveDataActive() && resolveProviderId() === "funnel" && !isLiveFunnelViable()) {
          if (get().signals.length > 0) {
            // Already have the published scan (cache adopted earlier this session
            // or persisted) - present it, don't disturb it with a failed live run.
            set({ researchStatus: "complete", hasCheckedSharedScan: true });
          } else {
            set({ researchStatus: "error", hasCheckedSharedScan: true });
            if (trigger === "manual") {
              get().pushToast(
                "Live market scan isn't available on the web app yet — showing the latest published scan once it lands.",
                "warn",
              );
            }
          }
          return;
        }

        // Push the live discovery context (Mission 5 blended modes) so the funnel
        // can lean the candidate pool toward the user's sectors/holdings/themes.
        const prefsForDiscovery = get().preferences;
        setDiscoveryContext({
          heldTickers: new Set(
            get()
              .portfolios.filter((p) => p.owner === "me")
              .flatMap((p) => p.holdings.map((h) => h.ticker.toUpperCase())),
          ),
          favoredSectors: new Set(
            (Object.entries(prefsForDiscovery.sectorWeights) as Array<[string, number]>)
              .filter(([, w]) => w > 0)
              .map(([s]) => s),
          ),
          themeTickers: new Set(
            (get().aiRelevanceIntel?.suggestions ?? []).map((s) => s.ticker.trim().toUpperCase()),
          ),
        });
        // Resolve the provider ONCE for this run (B-2 TOCTOU guard). The provider
        // selector reads sample/pause state live on every call - caches mutate via
        // realtime/poll - so re-reading it later in the run could disagree with the
        // mode we present. If the operator's GLOBAL choice is still resolving
        // (pending), bail to a skeleton instead of silently falling back to the
        // fictional mock universe: the controls subscription re-runs bootstrap once
        // they land. This makes "provider resolved to mock while presenting live"
        // unreachable - a mock run never sets a Live badge (isLiveDataActive() is
        // false whenever the resolved provider is mock) and a pending window never
        // serves the mock universe at all.
        if (isProviderResolutionPending()) {
          set((s) => ({ researchStatus: s.researchStatus === "error" ? "error" : "idle" }));
          return;
        }
        // A real client-side scan is now imminent (a manual "Scan Market" press,
        // or desktop / a real local key with a viable live funnel). Only NOW do we
        // enter "running" - the "Scanning…" pill + "Running research" copy. Boot's
        // cache read above never reaches here, so opening the app stays quiet.
        set({ researchStatus: "running" });
        const prevSignals = get().signals;
        const prevToday = selectToday(prevSignals).map((s) => s.ticker);
        try {
          // Resolve the provider INSIDE the try so a provider-resolution throw
          // ("No data source configured") routes through the catch below (sets
          // researchStatus:'error' + a toast) instead of escaping runResearchNow
          // as an unhandled rejection - this is fired fire-and-forget via
          // `void get().runResearchNow('scheduled')`, so an uncaught throw here
          // would otherwise vanish silently.
          const provider = getActiveProvider();
          // Overall scan watchdog (C-2): race the run against a hard budget so any
          // unforeseen stall settles into the catch below (researchStatus 'error'
          // + feed error console + Retry) rather than hanging the feed skeleton.
          // On a trip, release every in-flight socket so a wedged GET can't keep
          // a vendor budget slot reserved past the run.
          const result = await Promise.race([
            runResearch(provider, trigger, (live) => {
              set({ currentRun: live });
            }),
            rejectAfter(SCAN_BUDGET_MS, "Research scan timed out").catch((err) => {
              abortLiveDataRequests();
              throw err;
            }),
          ]);
          // Phase 0 outcome ledger + feed state (observational, additive - never
          // touches the signals array or its order). Both engine variants are
          // scored against the SAME price/return so champion/challenger stay
          // apples-to-apples; the challenger view uses the run's time-aware context.
          // Shared daily compute: testers READ the day's broad-universe feed from
          // the `daily_signals` cache. Publishing it is a TRUSTED, SERVER-ONLY
          // write (service-role key, scripts/universe_scan/upload.mjs) - the client
          // never writes it, because the shipped anon key would let any holder
          // pre-poison the shared row (see migration 0013 + uploadTodaySharedSignals
          // doc). The onEnriched hook stays wired as a single fire-and-forget seam,
          // but uploadTodaySharedSignals is now a deliberate client-side no-op.
          const publishToShared = provider.isLive && isDailySignalsCacheConfigured();
          applyResearchResult(set, get, result, {
            fromShared: false,
            fromMock: !provider.isLive,
            onEnriched: publishToShared
              ? (enriched, run) => void uploadTodaySharedSignals(enriched, run)
              : undefined,
          });
          automaticResearchRetryUsed = false;

          // Auto-suggest (never auto-promote): if the challenger has cleared the
          // pre-registered bar on the primary 30-day window and isn't already the
          // champion, nudge the operator once this session.
          if (!challengerPromotionNotified && variantForRegistry(get().modelRegistry) !== "challenger") {
            if (compareModels(get().outcomeLedger, "d30").promote) {
              challengerPromotionNotified = true;
              get().pushToast(
                "Challenger cleared the promotion bar — review it in the Operator console.",
                "success",
              );
            }
          }

          if (trigger === "manual") {
            const nextToday = selectToday(result.signals).map((s) => s.ticker);
            const todayUnchanged =
              prevToday.length > 0 &&
              prevToday.length === nextToday.length &&
              prevToday.every((t, i) => t === nextToday[i]);
            let scoreShifts = 0;
            for (const s of result.signals) {
              const old = prevSignals.find((p) => p.ticker === s.ticker);
              if (old && old.score.opportunityScore !== s.score.opportunityScore) scoreShifts++;
            }
            const shiftNote =
              scoreShifts > 0 ? ` · ${scoreShifts} score${scoreShifts === 1 ? "" : "s"} updated` : "";
            const todayNote = todayUnchanged
              ? " · Today’s lineup unchanged (ranks held)"
              : prevToday.length > 0
                ? " · Today’s feed refreshed"
                : "";
            get().pushToast(
              `Research complete — ${result.signals.length} signals scored${shiftNote}${todayNote}`,
              "success",
            );
          }
          get().refreshSocialAlerts({ notify: trigger === "manual" });
          get().recordPortfolioValues();
          // Learn from how the user's own holdings are doing (winners/losers
          // nudge sector/catalyst affinity + the discount-vs-chasing dial).
          get().learnFromPortfolios();
        } catch (err) {
          set({ researchStatus: "error" });
          const shouldRetry =
            trigger === "scheduled" &&
            get().signals.length === 0 &&
            !automaticResearchRetryUsed;

          if (shouldRetry) {
            automaticResearchRetryUsed = true;
            get().pushToast("Live data hiccup - retrying research once", "info");
            window.setTimeout(() => {
              const state = get();
              if (state.signals.length === 0 && state.researchStatus === "error") {
                void state.runResearchNow("scheduled");
              }
            }, AUTOMATIC_RESEARCH_RETRY_MS);
          } else {
            get().pushToast("Research run failed", "warn");
          }
          console.error(err);
        }
      },

      recordInteraction: (kind, signal) => {
        const event: InteractionEvent = {
          id: uid(),
          kind,
          ticker: signal.ticker,
          sector: signal.sector,
          catalystType: signal.catalystType,
          marketCapBucket: signal.marketCapBucket,
          at: new Date().toISOString(),
        };
        set((state) => ({
          preferences: applyInteraction(state.preferences, event),
          interactions: [event, ...state.interactions].slice(0, 200),
        }));
        // No toast for For-You tuning (more/less-like-this, sector/cap/style nudges,
        // horizon shifts): these are continuous filter-like adjustments the user is
        // actively making and can see (the feed re-ranks + the taste pills update),
        // so a toast per tap is noise. Toasts are reserved for events the user can't
        // see happen - a friend add, an invite, a finished research/Blueprint run.
      },

      toggleLike: (signal) => {
        const liked = get().preferences.likedTickers.includes(signal.ticker);
        if (liked) {
          set((state) => ({
            preferences: {
              ...state.preferences,
              likedTickers: state.preferences.likedTickers.filter((t) => t !== signal.ticker),
            },
          }));
        } else {
          get().recordInteraction("like", signal);
          get().pushToast(`Liked ${signal.ticker}`, "success");
        }
      },

      isLiked: (ticker) => get().preferences.likedTickers.includes(ticker),

      toggleWatchlist: (signal) => {
        const exists = get().watchlist.includes(signal.ticker);
        if (exists) {
          set((state) => ({ watchlist: state.watchlist.filter((t) => t !== signal.ticker) }));
          get().pushToast(`Removed ${signal.ticker} from watchlist`, "info");
        } else {
          // Cache the full signal so the watched name still RESOLVES after the scored universe
          // rotates (the daily run only carries ~top-500).
          set((state) => ({
            watchlist: [signal.ticker, ...state.watchlist],
            lookupCache: { ...state.lookupCache, [signal.ticker]: signal },
          }));
          get().recordInteraction("save_watchlist", signal);
          get().pushToast(`Saved ${signal.ticker} to watchlist`, "success");
        }
      },

      addToWatchlistByTicker: (rawTicker) => {
        const key = canonicalizeSymbol(rawTicker);
        if (!key) {
          get().pushToast(`Couldn't find a security for "${rawTicker.trim()}"`, "warn");
          return false;
        }
        if (get().watchlist.includes(key)) {
          get().pushToast(`${key} is already in your watchlist`, "info");
          return false;
        }
        set((state) => ({ watchlist: [key, ...state.watchlist] }));
        // Record the personalization signal only when today's feed actually scored
        // this name; a directory-only add (not in the feed) has no signal features.
        const signal = get().signalByTicker(key);
        if (signal) get().recordInteraction("save_watchlist", signal);
        get().pushToast(`Saved ${key} to watchlist`, "success");
        return true;
      },

      isWatchlisted: (ticker) => get().watchlist.includes(ticker),

      removeFromWatchlist: (ticker) => {
        const key = ticker.trim().toUpperCase();
        if (!get().watchlist.includes(key)) return;
        set((state) => {
          const nextAlerts = { ...state.watchlistAlerts };
          delete nextAlerts[key];
          return {
            watchlist: state.watchlist.filter((t) => t !== key),
            watchlistAlerts: nextAlerts,
          };
        });
        get().pushToast(`Removed ${key} from watchlist`, "info");
      },

      setWatchlistAlert: (ticker, alert) => {
        const key = ticker.trim().toUpperCase();
        if (!Number.isFinite(alert.price) || alert.price <= 0) return;
        set((state) => ({
          watchlistAlerts: {
            ...state.watchlistAlerts,
            [key]: {
              ticker: key,
              price: alert.price,
              direction: alert.direction,
              createdAt: new Date().toISOString(),
            },
          },
        }));
        get().pushToast(
          `Alert set for ${key} ${alert.direction} $${alert.price.toLocaleString("en-US")}`,
          "success",
        );
      },

      clearWatchlistAlert: (ticker) => {
        const key = ticker.trim().toUpperCase();
        if (!get().watchlistAlerts[key]) return;
        set((state) => {
          const nextAlerts = { ...state.watchlistAlerts };
          delete nextAlerts[key];
          return { watchlistAlerts: nextAlerts };
        });
      },

      followChannel: (handle) => {
        const h = handle.trim();
        if (!h || get().following.includes(h)) return;
        set((state) => ({ following: [h, ...state.following] }));
        get().pushToast(`Following ${h}`, "success");
      },

      unfollowChannel: (handle) => {
        if (!get().following.includes(handle)) return;
        set((state) => ({ following: state.following.filter((f) => f !== handle) }));
        get().pushToast(`Unfollowed ${handle}`, "info");
      },

      isFollowing: (handle) => get().following.includes(handle),

      setTerminalDensity: (density) => set({ terminalDensity: density }),

      markTerminalVisited: () => {
        const previous = get().lastTerminalVisitAt;
        set({ lastTerminalVisitAt: new Date().toISOString() });
        return previous;
      },

      setTerminalNote: (ticker, text) => {
        const key = ticker.trim().toUpperCase();
        if (!key) return;
        // Defensive cap; the panel also limits input length.
        const value = text.slice(0, 4000);
        set((state) => {
          const next = { ...state.terminalNotes };
          if (value.trim()) next[key] = value;
          else delete next[key];
          return { terminalNotes: next };
        });
      },

      replaceTerminalNotes: (notes) => {
        // Normalize: uppercase keys, drop blanks, cap body length (defense in
        // depth - the sync layer already merges, this just sanitizes the apply).
        const clean: Record<string, string> = {};
        for (const [ticker, body] of Object.entries(notes ?? {})) {
          const key = ticker.trim().toUpperCase();
          const value = (body ?? "").slice(0, 4000);
          if (key && value.trim()) clean[key] = value;
        }
        set({ terminalNotes: clean });
      },

      replaceWatchlist: (tickers, alerts) => {
        // Apply the cross-device-synced watchlist. De-dupe + normalize tickers,
        // and keep only alerts whose ticker is still watched (defense in depth -
        // the sync layer already merged this).
        const seen = new Set<string>();
        const cleanTickers: string[] = [];
        for (const raw of tickers ?? []) {
          const key = String(raw ?? "").trim().toUpperCase();
          if (key && !seen.has(key)) {
            seen.add(key);
            cleanTickers.push(key);
          }
        }
        const cleanAlerts: Record<string, WatchlistAlert> = {};
        for (const [ticker, alert] of Object.entries(alerts ?? {})) {
          const key = ticker.trim().toUpperCase();
          if (seen.has(key) && alert && typeof alert.price === "number") cleanAlerts[key] = alert;
        }
        set({ watchlist: cleanTickers, watchlistAlerts: cleanAlerts });
      },

      setWatchlistSyncStatus: (status) => set({ watchlistSyncStatus: status }),

      setTerminalSpread: (patch) =>
        set((state) => {
          const symbol =
            patch.symbol != null ? patch.symbol.trim().toUpperCase() : state.terminalSpread.symbol;
          const panels = patch.panels ?? state.terminalSpread.panels;
          return { terminalSpread: { symbol, panels } };
        }),

      createPortfolio: (name, mode, description) => {
        const now = new Date().toISOString();
        const portfolio: Portfolio = {
          id: `pf_${uid()}`,
          name: name.trim() || "Untitled Portfolio",
          mode,
          description: description.trim(),
          owner: "me",
          isPublic: false,
          holdings: [],
          createdAt: now,
          updatedAt: now,
          accent: MODE_ACCENT[mode],
        };
        set((state) => ({ portfolios: [portfolio, ...state.portfolios] }));
        get().pushToast(`Created portfolio "${portfolio.name}"`, "success");
        return portfolio;
      },

      addToPortfolio: (portfolioId, signal) => {
        const portfolio = get().portfolios.find((p) => p.id === portfolioId);
        if (!portfolio) return;
        if (portfolio.holdings.some((h) => h.ticker === signal.ticker)) {
          get().pushToast(`${signal.ticker} is already in "${portfolio.name}"`, "info");
          return;
        }
        set((state) => ({
          portfolios: state.portfolios.map((p) =>
            p.id === portfolioId
              ? {
                  ...p,
                  holdings: [...p.holdings, { ticker: signal.ticker, addedAt: new Date().toISOString() }],
                  updatedAt: new Date().toISOString(),
                }
              : p,
          ),
        }));
        get().recordInteraction("add_to_portfolio", signal);
        get().pushToast(`Added ${signal.ticker} to "${portfolio.name}"`, "success");
        get().recordPortfolioValues();
      },

      addHoldingByTicker: (portfolioId, rawTicker, opts) => {
        // Accept ANY directory-resolvable symbol (US or Canadian .TO/.V/.NE),
        // canonicalized to its directory form; still permits a plausible
        // brand-new ticker the bundle hasn't caught up to yet.
        const ticker = canonicalizeSymbol(rawTicker);
        if (!ticker) return false;
        const portfolio = get().portfolios.find((p) => p.id === portfolioId);
        if (!portfolio) return false;
        if (portfolio.holdings.some((h) => h.ticker === ticker)) {
          get().pushToast(`${ticker} is already in "${portfolio.name}"`, "info");
          return false;
        }
        const now = new Date().toISOString();
        set((state) => ({
          portfolios: state.portfolios.map((p) =>
            p.id === portfolioId
              ? {
                  ...p,
                  holdings: [
                    ...p.holdings,
                    { ticker, addedAt: now, shares: opts?.shares, costBasis: opts?.costBasis, value: opts?.value },
                  ],
                  updatedAt: now,
                }
              : p,
          ),
        }));
        const signal = get().signalByTicker(ticker);
        if (signal) get().recordInteraction("add_to_portfolio", signal);
        get().pushToast(`Added ${ticker} to "${portfolio.name}"`, "success");
        get().recordPortfolioValues();
        return true;
      },

      addHoldingsBulk: (portfolioId, items) => {
        const portfolio = get().portfolios.find((p) => p.id === portfolioId);
        if (!portfolio) return 0;
        const existing = new Set(portfolio.holdings.map((h) => h.ticker));
        const now = new Date().toISOString();
        const fresh = items
          .map((it) => ({ ...it, ticker: it.ticker.trim().toUpperCase() }))
          .filter((it) => it.ticker && !existing.has(it.ticker));
        // De-dupe within the batch itself.
        const seen = new Set<string>();
        const additions = fresh.filter((it) => {
          if (seen.has(it.ticker)) return false;
          seen.add(it.ticker);
          return true;
        });
        if (additions.length === 0) {
          get().pushToast("No new tickers to add", "info");
          return 0;
        }
        set((state) => ({
          portfolios: state.portfolios.map((p) =>
            p.id === portfolioId
              ? {
                  ...p,
                  holdings: [
                    ...p.holdings,
                    ...additions.map((it) => ({
                      ticker: it.ticker,
                      addedAt: now,
                      shares: it.shares,
                      costBasis: it.costBasis,
                      value: it.value,
                    })),
                  ],
                  updatedAt: now,
                }
              : p,
          ),
        }));
        get().pushToast(
          `Added ${additions.length} holding${additions.length === 1 ? "" : "s"} to "${portfolio.name}"`,
          "success",
        );
        get().recordPortfolioValues();
        return additions.length;
      },

      upsertHoldingsBulk: (portfolioId, items) => {
        const portfolio = get().portfolios.find((p) => p.id === portfolioId);
        if (!portfolio) return { added: 0, updated: 0 };

        const normalized = new Map<
          string,
          { ticker: string; shares?: number; costBasis?: number; value?: number }
        >();
        for (const item of items) {
          const ticker = item.ticker.trim().toUpperCase();
          if (ticker) normalized.set(ticker, { ...item, ticker });
        }

        const existing = new Set(portfolio.holdings.map((holding) => holding.ticker));
        const added = [...normalized.keys()].filter((ticker) => !existing.has(ticker)).length;
        const updated = normalized.size - added;
        if (normalized.size === 0) return { added: 0, updated: 0 };

        const now = new Date().toISOString();
        set((state) => ({
          portfolios: state.portfolios.map((item) => {
            if (item.id !== portfolioId) return item;

            const merged = item.holdings.map((holding) => {
              const incoming = normalized.get(holding.ticker);
              if (!incoming) return holding;
              normalized.delete(holding.ticker);
              return {
                ...holding,
                shares: incoming.shares ?? holding.shares,
                value: incoming.value ?? holding.value,
                costBasis: incoming.costBasis ?? holding.costBasis,
              };
            });

            for (const incoming of normalized.values()) {
              merged.push({
                ticker: incoming.ticker,
                addedAt: now,
                shares: incoming.shares,
                value: incoming.value,
                costBasis: incoming.costBasis,
              });
            }

            return { ...item, holdings: merged, updatedAt: now };
          }),
        }));

        const parts = [
          updated ? `updated ${updated}` : "",
          added ? `added ${added}` : "",
        ].filter(Boolean);
        get().pushToast(`Portfolio refreshed: ${parts.join(", ")}`, "success");
        get().recordPortfolioValues();
        return { added, updated };
      },

      updateHolding: (portfolioId, ticker, patch) => {
        const key = ticker.trim().toUpperCase();
        set((state) => ({
          portfolios: state.portfolios.map((p) =>
            p.id === portfolioId
              ? {
                  ...p,
                  holdings: p.holdings.map((h) =>
                    h.ticker === key
                      ? {
                          ...h,
                          shares: patch.shares !== undefined ? patch.shares : h.shares,
                          costBasis:
                            patch.costBasis !== undefined ? patch.costBasis : h.costBasis,
                          value: patch.value !== undefined ? patch.value : h.value,
                          note: patch.note !== undefined ? patch.note : h.note,
                        }
                      : h,
                  ),
                  updatedAt: new Date().toISOString(),
                }
              : p,
            ),
        }));
        get().recordPortfolioValues();
      },

      removeFromPortfolio: (portfolioId, ticker) => {
        set((state) => ({
          portfolios: state.portfolios.map((p) =>
            p.id === portfolioId
              ? {
                  ...p,
                  holdings: p.holdings.filter((h) => h.ticker !== ticker),
                  updatedAt: new Date().toISOString(),
                }
              : p,
          ),
        }));
        get().recordPortfolioValues();
      },

      checkPortfolioSplits: async (portfolioId) => {
        if (checkingPortfolioSplits.has(portfolioId)) return 0;
        const portfolio = get().portfolios.find((item) => item.id === portfolioId);
        // Only rescale portfolios the user owns/edits locally - a shared/
        // viewed book isn't ours to silently mutate, even with an audit trail.
        if (!portfolio || portfolio.owner !== "me") return 0;

        const targets = portfolio.holdings.filter((h) => (h.shares ?? 0) > 0);
        if (targets.length === 0) return 0;

        checkingPortfolioSplits.add(portfolioId);
        try {
          const earliestAdded = targets
            .map((h) => h.addedAt.slice(0, 10))
            .sort()[0]!;
          const eventsByTicker = await fetchStockSplits(
            targets.map((h) => h.ticker),
            { start: earliestAdded },
          );
          if (Object.keys(eventsByTicker).length === 0) return 0;

          let adjustedCount = 0;
          const adjustedTickers: string[] = [];
          set((state) => ({
            portfolios: state.portfolios.map((p) => {
              if (p.id !== portfolioId) return p;
              let changed = false;
              const holdings = p.holdings.map((h) => {
                const events = eventsByTicker[h.ticker.toUpperCase()];
                if (!events || events.length === 0) return h;
                const patch = computeSplitAdjustment(h, events);
                if (!patch) return h;
                changed = true;
                adjustedCount += 1;
                adjustedTickers.push(h.ticker);
                return { ...h, shares: patch.shares, costBasis: patch.costBasis, splitAdjustment: patch.splitAdjustment };
              });
              return changed ? { ...p, holdings, updatedAt: new Date().toISOString() } : p;
            }),
          }));

          if (adjustedCount > 0) {
            get().pushToast(
              adjustedCount === 1
                ? `Adjusted ${adjustedTickers[0]} for a stock split — see the note on its holding row`
                : `Adjusted ${adjustedCount} holdings for stock splits — see the notes on their holding rows`,
              "info",
            );
            get().recordPortfolioValues();
          }
          return adjustedCount;
        } catch {
          return 0;
        } finally {
          checkingPortfolioSplits.delete(portfolioId);
        }
      },

      undoSplitAdjustment: (portfolioId, ticker) => {
        const key = ticker.trim().toUpperCase();
        set((state) => ({
          portfolios: state.portfolios.map((p) => {
            if (p.id !== portfolioId) return p;
            return {
              ...p,
              holdings: p.holdings.map((h) => {
                if (h.ticker !== key || !h.splitAdjustment) return h;
                const rejected = new Set([...(h.rejectedSplitDates ?? []), ...h.splitAdjustment.appliedDates]);
                return {
                  ...h,
                  shares: h.splitAdjustment.originalShares,
                  costBasis: h.splitAdjustment.originalCostBasis,
                  splitAdjustment: undefined,
                  rejectedSplitDates: [...rejected],
                };
              }),
              updatedAt: new Date().toISOString(),
            };
          }),
        }));
        get().pushToast(`Reverted ${key} to your originally entered shares`, "info");
        get().recordPortfolioValues();
      },

      dismissSplitAdjustmentNote: (portfolioId, ticker) => {
        const key = ticker.trim().toUpperCase();
        set((state) => ({
          portfolios: state.portfolios.map((p) => {
            if (p.id !== portfolioId) return p;
            return {
              ...p,
              holdings: p.holdings.map((h) =>
                h.ticker === key && h.splitAdjustment
                  ? { ...h, splitAdjustment: { ...h.splitAdjustment, dismissedAt: new Date().toISOString() } }
                  : h,
              ),
            };
          }),
        }));
      },

      deletePortfolio: (portfolioId) => {
        const p = get().portfolios.find((x) => x.id === portfolioId);
        if (p && p.owner !== "me") {
          get().pushToast("You can only delete your own portfolios", "warn");
          return;
        }
        set((state) => ({ portfolios: state.portfolios.filter((x) => x.id !== portfolioId) }));
      },

      replaceOwnPortfolios: (next, options) => {
        set((state) => {
          const localOwn = state.portfolios.filter((p) => p.owner === "me");
          const nonOwn = state.portfolios.filter((p) => p.owner !== "me");
          if (!next) {
            if (localOwn.length > 0) {
              console.warn("Portfolio sync skipped an undefined replace to preserve local portfolios.");
            }
            return state;
          }

          const nextIds = new Set(next.map((p) => p.id));
          const wouldDropLocal = localOwn.some((p) => !nextIds.has(p.id));
          let safeNext = next;
          if (wouldDropLocal && !options?.authoritative) {
            console.warn(
              "Portfolio sync skipped a destructive replace and merged remote portfolios with local data.",
            );
            if (next.length === 0) return state;
            const byId = new Map(localOwn.map((p) => [p.id, p]));
            for (const portfolio of next) byId.set(portfolio.id, portfolio);
            safeNext = [...byId.values()];
          }

          snapshotOwnPortfolios(localOwn);
          return { portfolios: [...safeNext, ...nonOwn] };
        });
      },

      signalByTicker: (ticker) => get().signals.find((s) => s.ticker === ticker),

      resolveSignal: (ticker) => {
        const key = ticker.trim().toUpperCase();
        // During the boot/load window (provider choice still resolving) NEVER fall
        // back to a possibly-synthetic cached lookup - return nothing so callers
        // (portfolio/terminal/detail) render a skeleton instead of flashing fake
        // data under a Live badge. A real live match in `signals` is still allowed.
        const live = get().signals.find((s) => s.ticker === key);
        if (live) return live;
        if (isProviderResolutionPending()) return undefined;
        return (
          get().lookupCache[key] ??
          // Self-contained fallback so the sample-only "TESTING" demo book (real
          // tickers across sectors) always classifies + values, even when the
          // loaded research universe doesn't carry those names.
          (isSampleDataModeEnabled() ? resolveDemoSignal(key) : undefined)
        );
      },

      lookupTicker: async (input) => {
        let key: string;
        try {
          key = await resolveSymbolFromQuery(input);
        } catch (err) {
          const msg =
            err instanceof SymbolResolveError
              ? [err.message, ...err.suggestions].filter(Boolean).join(" ")
              : "Could not resolve that symbol.";
          get().pushToast(msg, "warn");
          throw err;
        }
        let signal;
        try {
          signal = await lookupSignalAsync(key);
        } catch (err) {
          // Network-bound failure (Finnhub/Yahoo unreachable, quote fetch
          // rejected, etc.) - surface honest feedback instead of a silent dead
          // box, then rethrow so callers can show their own error state.
          get().pushToast("Couldn’t load data for that ticker — try again.", "warn");
          throw err;
        }
        // Two-score consistency fix: a single-ticker lookup scores the name in
        // ISOLATION (scoreCompany - raw, e.g. 39), but the stock detail page reads
        // the universe-normalized + decompressed champion score (e.g. 57). When the
        // ticker is already on the live scored board, use THAT signal so Ticker Scope
        // shows the SAME opportunityScore (and dims/snowflake) as the detail page. A
        // lookup-only ticker (not on the board) keeps its single-company score.
        const universeSignal = get().signals.find((s) => s.ticker === key);
        if (universeSignal) signal = universeSignal;
        set((state) => ({
          lookupCache: { ...state.lookupCache, [key]: signal },
          lookupCount: state.lookupCount + 1,
        }));
        void fetchAnalystCoverage(key, signal.price).then((coverage) => {
          const enriched = { ...signal, analyst: coverage };
          set((state) => ({
            lookupCache: { ...state.lookupCache, [key]: enriched },
            analystCache: { ...state.analystCache, [key]: coverage },
          }));
        });
        get().refreshSocialAlerts({ notify: true });
        get().recordPortfolioValues();
        return signal;
      },

      refreshPortfolioQuotes: async (portfolioId) => {
        if (!isFinnhubConfigured() || refreshingPortfolioQuotes.has(portfolioId)) return 0;
        const portfolio = get().portfolios.find((item) => item.id === portfolioId);
        if (!portfolio) return 0;

        const freshnessCutoff = Date.now() - 15 * 60 * 1000;
        const targets = portfolio.holdings
          .filter((holding) => (holding.shares ?? 0) > 0)
          .map((holding) => holding.ticker)
          .filter((ticker) => {
            const quote = get().portfolioQuotes[ticker];
            return !quote || Date.parse(quote.updatedAt) < freshnessCutoff;
          });
        if (!targets.length) return 0;

        refreshingPortfolioQuotes.add(portfolioId);
        let refreshed = 0;
        try {
          const batchSize = 8;
          for (let index = 0; index < targets.length; index += batchSize) {
            const batch = targets.slice(index, index + batchSize);
            const quotes = await Promise.all(batch.map(fetchFinnhubPortfolioQuote));
            const valid = quotes.filter((quote): quote is PortfolioQuote => quote != null);
            if (valid.length) {
              refreshed += valid.length;
              set((state) => ({
                portfolioQuotes: {
                  ...state.portfolioQuotes,
                  ...Object.fromEntries(valid.map((quote) => [quote.ticker, quote])),
                },
              }));
            }
          }
          get().recordPortfolioValues();
          return refreshed;
        } finally {
          refreshingPortfolioQuotes.delete(portfolioId);
        }
      },

      refreshLivePrices: async (tickers) => {
        // Live overlay is meaningless in sample mode; the daily score stands.
        if (isSampleDataModeEnabled()) return 0;
        const unique = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
        if (unique.length === 0) return 0;
        try {
          const quotes = await fetchLiveQuotes(unique);
          const entries = Object.values(quotes);
          if (entries.length === 0) return 0;
          set((state) => ({
            livePrices: { ...state.livePrices, ...quotes },
            livePricesUpdatedAt: new Date().toISOString(),
          }));
          return entries.length;
        } catch {
          return 0;
        }
      },

      recordPortfolioValues: () => {
        const current = get();
        const signalMap = new Map<string, StockSignal>();
        for (const signal of current.signals) signalMap.set(signal.ticker, signal);
        for (const signal of Object.values(current.lookupCache)) {
          if (!signalMap.has(signal.ticker)) signalMap.set(signal.ticker, signal);
        }

        const now = new Date();
        set((state) => ({
          portfolios: state.portfolios.map((portfolio) => {
            if (portfolio.owner !== "me") return portfolio;
            const point = createPortfolioValuePoint(
              portfolio,
              (ticker) => signalMap.get(ticker.trim().toUpperCase()),
              // Live overlay (Alpaca) preferred; Finnhub portfolioQuotes is the fallback.
              (ticker) =>
                current.livePrices[ticker.trim().toUpperCase()] ??
                current.portfolioQuotes[ticker.trim().toUpperCase()],
              now,
            );
            if (!point) return portfolio;

            const today = point.date.slice(0, 10);
            const previous = portfolio.valueHistory?.find(
              (item) => item.date.slice(0, 10) === today,
            );
            if (
              previous &&
              previous.valuedCount === point.valuedCount &&
              Math.abs(previous.value - point.value) < 0.005
            ) {
              return portfolio;
            }

            return {
              ...portfolio,
              valueHistory: upsertDailyPortfolioValue(portfolio.valueHistory, point),
            };
          }),
        }));
      },

      setAnalystCache: (ticker, coverage) => {
        const key = ticker.trim().toUpperCase();
        set((state) => ({
          analystCache: { ...state.analystCache, [key]: coverage },
        }));
      },

      analystForTicker: (ticker) => {
        const key = ticker.trim().toUpperCase();
        return get().analystCache[key];
      },

      refreshSocialAlerts: (opts) => {
        const { signals, lookupCache, seenAlertIds } = get();
        const alerts = deriveSocialAlerts(allScoredSignals(signals, lookupCache));
        const unseen = countUnseenAlerts(alerts, seenAlertIds);
        set({ socialAlerts: alerts });
        if (opts?.notify && unseen > 0) {
          get().pushToast(
            `${unseen} new social alert${unseen === 1 ? "" : "s"} — check the Terminal`,
            "warn",
          );
        }
      },

      markAlertsSeen: () => {
        const ids = get().socialAlerts.map((a) => a.id);
        set({ seenAlertIds: ids });
      },

      unseenSocialCount: () => countUnseenAlerts(get().socialAlerts, get().seenAlertIds),

      resetPersonalization: () => {
        set({ preferences: defaultPreferences(), interactions: [] });
        get().pushToast("Personalization reset", "info");
      },

      setTradeHorizon: (horizon) => {
        set((state) => ({
          preferences: { ...state.preferences, tradeHorizon: horizon },
        }));
        // No toast - the horizon picker shows the active selection itself.
      },

      setRiskAppetite: (value) => {
        const clamped = Math.min(1, Math.max(0, value));
        set((state) => ({
          preferences: { ...state.preferences, riskAppetite: clamped, riskAppetiteLocked: true },
        }));
        // Mirror to the funnel's research-time dial (Stage-0 gate breadth).
        setCurrentRiskAppetite(clamped);
        // No toast - the slider + the "Moderate · 60%" pill already show the value;
        // a toast on every 5% drag was the notification spam the owner flagged.
      },

      tuneArchetype: (dir) => {
        set((state) => ({
          preferences: {
            ...state.preferences,
            archetypeTilt: tuneArchetypeTilt(state.preferences.archetypeTilt ?? 0.35, dir),
          },
        }));
        // No toast - the "Entry timing" control reflects the change in place.
      },

      toggleForYouFilter: (id) => {
        set((state) => {
          const current = state.preferences.forYouFilters ?? [];
          const next = current.includes(id)
            ? current.filter((f) => f !== id)
            : [...current, id];
          return { preferences: { ...state.preferences, forYouFilters: next } };
        });
        // No toast - the chip's active state + the feed recomposing IS the feedback.
      },

      toggleForYouTheme: (slug) => {
        set((state) => ({
          preferences: {
            ...state.preferences,
            // Select-first semantics - see nextThemeScope in emergingThemes.ts.
            forYouThemes: nextThemeScope(state.preferences.forYouThemes, slug),
          },
        }));
      },

      setForYouThemesAll: () => {
        set((state) => ({
          preferences: { ...state.preferences, forYouThemes: undefined },
        }));
      },

      learnFromPortfolios: () => {
        const { portfolios } = get();
        const mine = portfolios.filter((p) => p.owner === "me");
        const outcomes: HoldingOutcome[] = [];
        const seen = new Set<string>();
        for (const p of mine) {
          for (const h of p.holdings) {
            if (seen.has(h.ticker)) continue;
            const signal = get().signalByTicker(h.ticker);
            if (!signal) continue;
            seen.add(h.ticker);
            const plPct =
              h.shares != null && h.costBasis != null && h.costBasis > 0 && signal.price > 0
                ? (signal.price - h.costBasis) / h.costBasis
                : undefined;
            outcomes.push({ signal, plPct });
          }
        }
        if (outcomes.length === 0) return;
        set((state) => ({ preferences: learnFromHoldings(state.preferences, outcomes) }));
      },

      ensureWatchOutBaselines: (tickers, signals) => {
        const have = get().watchOutBaselines;
        const wanted = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
        const missing = wanted.filter((t) => !have[t]);
        if (missing.length === 0) return;
        const byTicker = new Map(signals.map((s) => [s.ticker.trim().toUpperCase(), s]));
        const nowISO = new Date().toISOString();
        const additions: Record<string, WatchOutBaseline> = {};
        for (const t of missing) {
          const sig = byTicker.get(t);
          if (!sig) continue; // no live signal yet - capture on a later pass
          const snap = snapshotWatchOutFacts(sig, nowISO);
          if (snap) additions[t] = snap; // null for sample/unquoted - never baseline a fake
        }
        if (Object.keys(additions).length === 0) return;
        set((state) => ({ watchOutBaselines: { ...state.watchOutBaselines, ...additions } }));
      },

      promoteModel: (id) => {
        const email = useAuthStore.getState().email;
        if (!isAdminEmail(email)) {
          get().pushToast("Only the operator can promote a model.", "warn");
          return;
        }
        const actor = email!.trim().toLowerCase();
        set((state) => ({
          modelRegistry: promoteModelEntry(state.modelRegistry, id, new Date().toISOString(), actor),
        }));
        const reg = get().modelRegistry;
        const variant = variantForRegistry(reg);
        // Make the decision REAL, IMMEDIATE, and APP-WIDE: persist the active
        // variant to the GLOBAL controls (so it's the live model for EVERY user,
        // server-side - the dev fallback is the device-local override) AND re-rank
        // THIS operator's feed now from the preserved raw scores, so the switch is
        // observable at once rather than only after the next research run. Other
        // clients pick it up via getActiveVariant() on their next load / realtime.
        persistActiveVariant(variant);
        set((state) => ({
          signals: rerankSignalsForVariant(state.signals, variant, state.boardRegime),
        }));
        get().recordPortfolioValues();
        get().pushToast(
          `Promoted "${currentChampion(reg)?.label ?? id}" to champion — now live for everyone.`,
          "success",
        );
      },

      rollbackModel: (id) => {
        const email = useAuthStore.getState().email;
        if (!isAdminEmail(email)) {
          get().pushToast("Only the operator can roll back a model.", "warn");
          return;
        }
        const actor = email!.trim().toLowerCase();
        set((state) => ({
          modelRegistry: rollbackModelEntry(state.modelRegistry, id, new Date().toISOString(), actor),
        }));
        const reg = get().modelRegistry;
        const variant = variantForRegistry(reg);
        // Same as promote: persist the active variant GLOBALLY (server-side for
        // every user; device-local only as the dev fallback) and re-rank this
        // operator's live feed now.
        persistActiveVariant(variant);
        set((state) => ({
          signals: rerankSignalsForVariant(state.signals, variant, state.boardRegime),
        }));
        get().recordPortfolioValues();
        get().pushToast(
          `Rolled back to "${currentChampion(reg)?.label ?? id}" — now live for everyone.`,
          "info",
        );
      },

      syncActiveVariantFromGlobal: () => {
        // The authoritative live variant (global-first; getActiveVariant reads
        // app_controls.active_variant when configured). A remote operator just
        // changed it - adopt it on this client.
        const variant = getActiveVariant();
        const reg = get().modelRegistry;
        if (variantForRegistry(reg) === variant) return; // already aligned
        // Mirror the registry's championId to the entry matching the live variant
        // so the Operator/Model-Lab UI reflects what's actually live on this
        // device, then re-rank the in-memory feed (no reload, no vendor calls).
        const target = reg.entries.find((e) => e.kind === variant);
        if (target) {
          set((state) => ({
            modelRegistry: promoteModelEntry(
              state.modelRegistry,
              target.id,
              new Date().toISOString(),
              "global",
            ),
          }));
        }
        set((state) => ({
          signals: rerankSignalsForVariant(state.signals, variant, state.boardRegime),
        }));
        get().recordPortfolioValues();
      },

      applyDisplayControlsChange: () => {
        const nextSpread = getScoreSpreadWeight();
        const nextCap = getQualityCapStrength();
        // No-op unless the dial genuinely moved since the board was last ranked
        // (rerankSignalsForVariant stamps these on every rank, including the one
        // this call itself triggers). Guards against redundant re-ranks on every
        // unrelated global-controls notify (sample mode, budgets, variant - those
        // already have their own handlers) and against re-entrant loops.
        if (lastAppliedSpreadWeight === nextSpread && lastAppliedCapStrength === nextCap) return;
        const { signals } = get();
        if (signals.length === 0) return; // nothing loaded yet to re-rank
        set((state) => ({
          signals: rerankSignalsForVariant(state.signals, getActiveVariant(), state.boardRegime),
        }));
        get().recordPortfolioValues();
      },

      clearMockSignalsIfLive: () => {
        // Only act once live data is genuinely active AND the in-memory feed is
        // mock-sourced. This is the TOCTOU guard: a sample/pre-load window may have
        // populated the store with the fictional universe; the moment the
        // operator's choice resolves to live we must drop those signals so they
        // can't render under a "Live data" badge. Clearing back to an empty feed +
        // idle status lets bootstrap re-run against the live provider (which shows a
        // skeleton, then the real universe) instead of leaving stale mock tickers.
        if (!isLiveDataActive()) return;
        const { signalsFromMock, signals } = get();
        if (!signalsFromMock || signals.length === 0) return;
        set({
          signals: [],
          signalsFromMock: false,
          researchStatus: "idle",
          currentRun: undefined,
          // Scrub the persisted lookup cache too: it can hold SYNTHETIC tickers a
          // prior sample-mode session resolved (companyForTicker), and resolveSignal
          // falls back to it - so without this they'd resurface as "real" on
          // portfolio/terminal/detail surfaces the moment live data activates.
          lookupCache: {},
        });
        void get().runResearchNow("scheduled");
      },

      runScreen: (horizon, criteria, description, excludeTickers = []) => {
        const exclude = new Set(excludeTickers.map((t) => t.toUpperCase()));
        const live = isLiveDataActive();
        const universe = allScoredSignals(get().signals, get().lookupCache).filter((s) => {
          if (exclude.has(s.ticker)) return false;
          // Never let fictional / synthesized lookups surface as screen matches.
          if (s.lookupProvenance === "synthetic") return false;
          if (live && s.lookupProvenance === "curated") return false;
          return true;
        });

        const mode = criteria.rankingMode ?? "blended";
        // The explicit "AI only" mode auto-refreshes real agent relevance in the
        // background (once per distinct thesis). Other modes reuse whatever map is
        // already cached but never spend an agent call on their own.
        if (mode === "ai" && universe.length > 0 && isResearchAgentAvailable()) {
          void get().refreshAiRelevance(horizon, criteria, description);
        }

        // Turn the cached web-grounded intel into a per-ticker 0..100 map (pure,
        // cheap). Absent intel → undefined → engine keeps its local proxy, so
        // offline / mock mode is unchanged.
        const intel = get().aiRelevanceIntel;
        const relevance = intel
          ? computeAiRelevance(universe, intel, {
              themeTags: criteria.themeTags,
              keywords: criteria.keywords,
            })
          : undefined;
        const aiRelevance =
          relevance && Object.keys(relevance).length > 0 ? relevance : undefined;

        return screenSignals(universe, horizon, criteria, description, aiRelevance);
      },

      refreshAiRelevance: async (horizon, criteria, description) => {
        if (!isResearchAgentAvailable()) return;
        const thesis = buildRelevanceThesis(description, criteria);
        if (!hasUsableThesis(thesis)) return;
        const sig = relevanceThesisSignature(thesis);
        // Already fetched (or failed) for this exact thesis, or a call is in
        // flight → don't spend another agent call. The signature is stamped on
        // both success AND error so a dead proxy isn't hammered every keystroke.
        if (get().aiRelevanceSig === sig || inFlightRelevanceSig === sig) return;

        inFlightRelevanceSig = sig;
        set({ aiRelevanceStatus: "loading" });
        try {
          const intel = await runResearchAgent(
            { task: "deep_research", narrative: thesis.narrative, themes: thesis.themes },
            { timeoutMs: RELEVANCE_TIMEOUT_MS },
          );
          set((state) => ({
            aiRelevanceIntel: intel,
            aiRelevanceSig: sig,
            aiRelevanceStatus: "ready",
            // Re-ref signals so the live Blueprint board re-screens against the
            // freshly-landed relevance map (the board's effect depends on signals).
            signals: [...state.signals],
          }));
        } catch {
          set({ aiRelevanceSig: sig, aiRelevanceStatus: "error" });
        } finally {
          if (inFlightRelevanceSig === sig) inFlightRelevanceSig = null;
        }
      },

      adoptAiRelevanceIntel: (intel, criteria, description) => {
        const thesis = buildRelevanceThesis(description, criteria);
        set((state) => ({
          aiRelevanceIntel: intel,
          // Stamp the thesis signature so the auto-refresh path treats this
          // intel as already-fetched and doesn't spend a duplicate agent call.
          aiRelevanceSig: relevanceThesisSignature(thesis),
          aiRelevanceStatus: "ready",
          // Re-ref signals so the live Blueprint board re-screens against the
          // freshly-adopted relevance map (the board's effect depends on signals).
          signals: [...state.signals],
        }));
      },

      saveScreenPreset: (input) => {
        const now = new Date().toISOString();
        const existing = input.id ? get().screenPresets.find((p) => p.id === input.id) : undefined;
        const preset: ScreenPreset = {
          id: existing?.id ?? `scr_${uid()}`,
          name: input.name.trim() || "Untitled screen",
          horizon: input.horizon,
          horizons: input.horizons ?? existing?.horizons,
          criteria: input.criteria,
          description: input.description,
          savedTickers: input.savedTickers ?? existing?.savedTickers ?? [],
          lastRunAt: input.lastRunAt ?? existing?.lastRunAt,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        set((state) => ({
          screenPresets: existing
            ? state.screenPresets.map((p) => (p.id === preset.id ? preset : p))
            : [preset, ...state.screenPresets],
        }));
        get().pushToast(`Saved screen "${preset.name}"`, "success");
        return preset;
      },

      deleteScreenPreset: (id) => {
        set((state) => ({ screenPresets: state.screenPresets.filter((p) => p.id !== id) }));
      },

      mergeScreenPresetResults: (presetId, tickers) => {
        set((state) => ({
          screenPresets: state.screenPresets.map((p) => {
            if (p.id !== presetId) return p;
            const merged = [...new Set([...p.savedTickers, ...tickers.map((t) => t.toUpperCase())])];
            return { ...p, savedTickers: merged, lastRunAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          }),
        }));
      },

      setPortfolioDiscovery: (portfolioId, discovery) => {
        set((state) => ({
          portfolios: state.portfolios.map((p) =>
            p.id === portfolioId ? { ...p, discovery, updatedAt: new Date().toISOString() } : p,
          ),
        }));
        get().pushToast("Portfolio discovery settings saved", "success");
      },

      runPortfolioDiscovery: (portfolioId, addCount = 3) => {
        const portfolio = get().portfolios.find((p) => p.id === portfolioId);
        if (!portfolio?.discovery) {
          get().pushToast("Save discovery settings first", "warn");
          return [];
        }
        const { discovery } = portfolio;
        const held = new Set(portfolio.holdings.map((h) => h.ticker));
        const discoveryHorizons =
          discovery.horizons?.length ? discovery.horizons : [discovery.horizon];
        const matches = get().runScreen(
          discoveryHorizons,
          { ...discovery.criteria, maxResults: discovery.targetCount + held.size },
          discovery.description,
          [...held],
        );
        const added: string[] = [];
        for (const m of matches) {
          if (added.length >= addCount) break;
          if (held.has(m.signal.ticker)) continue;
          get().addToPortfolio(portfolioId, m.signal);
          added.push(m.signal.ticker);
          held.add(m.signal.ticker);
        }
        const now = new Date().toISOString();
        set((state) => ({
          portfolios: state.portfolios.map((p) =>
            p.id === portfolioId
              ? { ...p, discovery: { ...discovery, lastRunAt: now }, updatedAt: now }
              : p,
          ),
        }));
        if (added.length > 0) {
          get().pushToast(`Added ${added.join(", ")} from discovery run`, "success");
        } else {
          get().pushToast("No new matches — try loosening filters or run again later", "info");
        }
        return added;
      },

      pushToast: (message, tone = "info", opts) => {
        const toast: Toast = { id: uid(), message, tone, href: opts?.href, durationMs: opts?.durationMs };
        set((state) => ({ toasts: [...state.toasts, toast] }));
        setTimeout(() => get().dismissToast(toast.id), opts?.durationMs ?? 3200);
      },

      dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
    }),
    {
      name: APP_STORAGE_KEY,
      // v28: UserPreferences gained optional forYouFilters/forYouThemes (For-You
      // filter chips). Backward-compatible - runtime defaults handle absence -
      // but bumped per the seed/shape-change rule; migrate passes v27 through.
      // v29: RankingMode collapsed from 5 to 3 pills - remaps any persisted
      // v30: V5 reversal-first is manually promoted live; reseed registry labels/state.
      // screen-preset criteria still carrying the retired "theme"/"ai_description"
      // values (see the `fromVersion < 29` migration step below).
      version: 30,
      // Quota-safe storage: a persisted write must NEVER throw into React. When
      // the payload outgrows localStorage's quota, safeJSONStorage sheds the
      // largest recomputable caches instead of throwing QuotaExceededError mid
      // commit (which previously unmounted the whole tree → blank-screen + reload).
      storage: safeJSONStorage,
      migrate: (persisted, fromVersion) => {
        const state = persisted as Record<string, unknown>;
        const prefs = (state.preferences as UserPreferences | undefined) ?? defaultPreferences();
        const migratedPrefs = {
          ...defaultPreferences(),
          ...prefs,
          tradeHorizon: normalizeTradeHorizon(prefs.tradeHorizon as string | undefined),
        };
        // v7 renamed the social list from `friends` (added people) to `following`
        // (followed public channels). Carry any prior follows over by handle.
        const following =
          (state.following as string[] | undefined) ??
          (state.friends as string[] | undefined) ??
          [];

        let next: Record<string, unknown>;
        if (fromVersion < 4) {
          next = {
            ...state,
            following,
            preferences: migratedPrefs,
            screenPresets: (state.screenPresets as ScreenPreset[] | undefined) ?? [],
          };
        } else if (fromVersion < 5) {
          next = { ...state, following, preferences: migratedPrefs };
        } else if (fromVersion < 7) {
          next = { ...state, following };
        } else if (fromVersion < 8) {
          const presets = (state.screenPresets as ScreenPreset[] | undefined) ?? [];
          next = {
            ...state,
            screenPresets: presets.map((p) => ({
              ...p,
              horizons: p.horizons?.length ? p.horizons : [p.horizon],
            })),
          };
        } else {
          next = state;
        }

        // v9: drop any persisted lookup cache so stale sample/synthetic tickers
        // (e.g. demo names cached before a live key was added) can't leak into
        // live screens or alerts.
        if (fromVersion < 9) {
          next = { ...next, lookupCache: {} };
        }
        if (fromVersion < 10) {
          const recentRuns = (next.researchRunLog as string[] | undefined) ?? [];
          next = {
            ...next,
            researchRunTotal:
              typeof next.researchRunTotal === "number"
                ? next.researchRunTotal
                : recentRuns.length,
          };
        }
        // v11 began persisting `signals` for the daily reuse cache. Drop any
        // signals carried from an older shape so bootstrap re-runs once cleanly.
        if (fromVersion < 11) {
          next = { ...next, signals: [] };
        }
        // v12 gave the two sample OWNED demo books tracked positions (shares +
        // cost) so the premium portfolio surfaces light up by default. This is
        // non-destructive: it ONLY upgrades a still-pristine sample book and
        // never touches an edited book or any real uploaded portfolio.
        if (fromVersion < 12) {
          next = {
            ...next,
            portfolios: applyTrackedDemoSeed(next.portfolios as Portfolio[] | undefined),
          };
        }
        // v14 shipped a new owned demo book ("Fake Portfolio for Testing") that
        // showcases the tracked experience. Inject it once for existing stores so
        // it appears without a fresh install. Done here (not in merge) so that a
        // user who later deletes it isn't forced to keep it on every reload.
        if (fromVersion < 14 && isSampleDataModeEnabled()) {
          // Sample-only: a live tester must never be handed the fictional book.
          const existing = (next.portfolios as Portfolio[] | undefined) ?? [];
          const seedFake = SEED_PORTFOLIOS.find((p) => p.id === FAKE_TEST_PORTFOLIO_ID);
          if (seedFake && !existing.some((p) => p.id === FAKE_TEST_PORTFOLIO_ID)) {
            next = { ...next, portfolios: [...existing, seedFake] };
          }
        }
        // v15: retire the original owned demo books - only "Fake Portfolio for
        // Testing" stays as the sample. Real uploads (pf_<uid>) are untouched;
        // public sample books are dropped automatically (no longer in the seed).
        if (fromVersion < 15) {
          const retired = new Set(["pf_my_catalyst", "pf_my_ai"]);
          const existing = (next.portfolios as Portfolio[] | undefined) ?? [];
          next = { ...next, portfolios: existing.filter((p) => !retired.has(p.id)) };
        }
        // v16 introduced the Phase 0 outcome ledger. Old stores never recorded
        // outcomes, so default to an empty ledger - tracking begins on the next
        // research run. (normalizeLedger also repairs any partial/corrupt blob.)
        if (fromVersion < 16) {
          next = { ...next, outcomeLedger: normalizeLedger(next.outcomeLedger) };
        }
        // v17 introduced the champion/challenger model registry. Seed it for
        // existing stores (the ledger gained an additive `modelScores` field;
        // pre-v17 entries simply lack the challenger view, handled by the eval).
        if (fromVersion < 17) {
          next = { ...next, modelRegistry: normalizeModelRegistry(next.modelRegistry) };
        }
        // v18 introduced Terminal UI state (home density + last-visit marker).
        // Default additively; the custom merge also backfills missing keys from
        // the initial state, but defaulting here keeps the shape explicit.
        if (fromVersion < 18) {
          next = {
            ...next,
            terminalDensity:
              (next.terminalDensity as TerminalDensity | undefined) ?? "comfortable",
            lastTerminalVisitAt: (next.lastTerminalVisitAt as string | null | undefined) ?? null,
          };
        }
        // v19 added per-ticker workspace notes.
        if (fromVersion < 19) {
          next = {
            ...next,
            terminalNotes:
              (next.terminalNotes as Record<string, string> | undefined) ?? {},
          };
        }
        // v20 added the saved linked-parameter spread (shared symbol + panels).
        if (fromVersion < 20) {
          next = {
            ...next,
            terminalSpread:
              (next.terminalSpread as TerminalSpread | undefined) ?? {
                symbol: "",
                panels: ["chart", "news", "ai", "score"],
              },
          };
        }
        // v21 - tester-ship safety: the fictional "Fake Portfolio for Testing"
        // book is SAMPLE-ONLY. A live user (sample mode OFF) who first opened an
        // older build may have it persisted (owner "me"), where it drives a fake
        // net-worth summary. Evict it once in live mode so they get the honest
        // empty Portfolios state. Sample-mode users keep it.
        if (fromVersion < 21 && !isSampleDataModeEnabled()) {
          const existing = (next.portfolios as Portfolio[] | undefined) ?? [];
          next = {
            ...next,
            portfolios: existing.filter((p) => p.id !== FAKE_TEST_PORTFOLIO_ID),
          };
        }
        // v22 - one-shot Portfolios cleanup. Collapse a messy tab down to the
        // user's REAL uploaded books (kept byte-for-byte) plus a single,
        // repaired "TESTING" demo. Empty/half-deleted junk, retired demo ids and
        // duplicate test books are dropped; a real book is never nuked. The demo
        // is (re)injected only in sample mode - a live tester keeps just their
        // real books. See {@link cleanupPortfolios}.
        if (fromVersion < 22) {
          next = {
            ...next,
            portfolios: cleanupPortfolios(next.portfolios as Portfolio[] | undefined, {
              sampleMode: isSampleDataModeEnabled(),
            }),
          };
        }
        // v23 - the shipped TESTING demo was rebuilt on REAL tickers across seven
        // sectors (it previously used synthetic names that resolved no sector →
        // "Unclassified" rings + dropped holdings). Re-run the same safe cleanup so
        // any still-synthetic TESTING book is replaced in place with the new
        // real-ticker book. Real user books (different ids / populated) are kept
        // byte-for-byte; the demo is only (re)seeded in sample mode.
        if (fromVersion < 23) {
          next = {
            ...next,
            portfolios: cleanupPortfolios(next.portfolios as Portfolio[] | undefined, {
              sampleMode: isSampleDataModeEnabled(),
            }),
          };
        }
        // v24 - the model registry's labels + blurbs are config-from-code (e.g. the
        // plain-language Champion description), but the registry is PERSISTED, so a
        // copy rewrite would otherwise never reach existing installs: the old text
        // rehydrates over the new seed. Refresh the static TEXT from seed while
        // preserving the operator's promote/rollback state (which model is champion
        // and when it was promoted). New copy reaches everyone on the next refresh.
        if (fromVersion < 24) {
          const seeded = seedModelRegistry();
          const prev = next.modelRegistry as ModelRegistry | undefined;
          const prevById = new Map((prev?.entries ?? []).map((e) => [e.id, e] as const));
          const championId =
            prev?.championId && seeded.entries.some((e) => e.id === prev.championId)
              ? prev.championId
              : seeded.championId;
          next = {
            ...next,
            modelRegistry: {
              championId,
              entries: seeded.entries.map((e) => {
                const old = prevById.get(e.id);
                return old
                  ? {
                      ...e, // fresh label + changeSummary from code
                      createdAtISO: old.createdAtISO ?? e.createdAtISO,
                      promotedAtISO: old.promotedAtISO ?? e.promotedAtISO,
                      promotedBy: old.promotedBy ?? e.promotedBy,
                    }
                  : e;
              }),
            },
          };
        }
        // The algorithm was refined from 2026-06-23, so every tracked pick published on or
        // before 2026-06-23 is stale and was muddying the Performance tab (2,401 old picks, one
        // settled). Drop them so the Track Record starts clean on the current engine; entries
        // published 2026-06-24+ are kept. droppedCount resets - this is a deliberate purge, not
        // a cap rotation.
        if (fromVersion < 25) {
          const led = normalizeLedger(next.outcomeLedger);
          const CUTOFF_ISO = "2026-06-24T00:00:00.000Z";
          const kept = led.entries.filter((e) => (e.publishedAtISO ?? "") >= CUTOFF_ISO);
          next = {
            ...next,
            outcomeLedger: { ...led, entries: kept, droppedCount: 0 },
          };
        }
        // v26 - promote V4 to the live Champion in the registry. The ENGINE already
        // runs V4 (the champion normalization = INFLECTION_V2 + archetypeOverlay +
        // regimeTilt), but the PERSISTED registry still labeled the champion "catalyst-
        // driven, promoted 2 weeks ago", so the Operator / Model Lab / Track Record
        // never surfaced V4. The entry ids changed (champion-v4-archetype-regime /
        // challenger-v3-catalyst-driven), so re-seed the registry outright - it is a
        // changelog/display artifact, not user data - to declare V4 the live Champion
        // and V3 the shadow, with correct dates. app_controls.active_variant stays
        // "champion", so the live engine is unchanged; only the LABEL becomes truthful.
        if (fromVersion < 26) {
          next = { ...next, modelRegistry: seedModelRegistry() };
        }
        // v27 - make the champion/challenger loop a REAL forward loop. V4 stays the
        // live Champion; the challenger slot becomes the NEW V5 reversal-first CANDIDATE
        // (V4 with momentum de-weighted ~70%), replacing the retired V3 shadow. Fixes
        // the "V3 registered 3 weeks ago" (it carried the v1 baseline date) and the
        // "Promote V3" (a rollback mislabeled as a promotion) bugs. Re-seed outright - a
        // changelog/display artifact, not user data. app_controls.active_variant stays
        // "champion", so the LIVE engine is unchanged; only the challenger ALGORITHM
        // (shadow) and the labels change. The engine's challenger normalization also
        // moved from CATALYST_DRIVEN (v3) to REVERSAL_V5, so the registry must match.
        if (fromVersion < 27) {
          next = { ...next, modelRegistry: seedModelRegistry() };
        }
        // v30 - the owner manually promoted V5 live and asked for the new algorithm
        // deployed. Re-seed the display registry so existing devices no longer
        // hydrate V4 as the champion from old local storage.
        if (fromVersion < 30) {
          next = { ...next, modelRegistry: seedModelRegistry() };
        }
        // A screen preset saved before this change can have `criteria.rankingMode: "theme" |
        // "ai_description"` persisted; remap those to "blended" so an old preset can't hand a
        // type-narrowed switch (modeFitScore, buildReasons, activeLaneKeys) a value it no longer
        // knows.
        if (fromVersion < 29) {
          const presets = (next.screenPresets as ScreenPreset[] | undefined) ?? [];
          const RETIRED_MODES = new Set(["theme", "ai_description"]);
          next = {
            ...next,
            screenPresets: presets.map((p) =>
              p.criteria?.rankingMode && RETIRED_MODES.has(p.criteria.rankingMode)
                ? { ...p, criteria: { ...p.criteria, rankingMode: "blended" } }
                : p,
            ),
          };
        }
        return next;
      },
      // Reconcile persisted portfolios against the code seed on every load:
      //  • Fresh install (nothing persisted yet) keeps the full code seed -
      //    owned demo books included. Without this branch a fresh install would
      //    drop the tracked demo books and show only the public samples.
      //  • Existing store: the user's OWNED books (real uploads pf_<uid> plus any
      //    demo book they kept/edited) are preserved byte-for-byte - so deletions
      //    and edits stick - while PUBLIC sample books (owner !== "me") ALWAYS
      //    come fresh from SEED_PORTFOLIOS, so stale tickers cached in
      //    localStorage can never survive a version upgrade. New owned demo books
      //    are introduced via the migration, not here, so they aren't resurrected
      //    after the user deletes them.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        // The runtime universe is NEVER restored from storage - it is re-fetched
        // on boot (bootstrap → fetchRecentSharedSignals). A stale blob from an
        // OLDER build (before these were dropped from partialize) can still carry
        // `signals` / `signalsFromMock`, and the `...p` spread below would
        // otherwise REHYDRATE the fictional sample universe (e.g. "ZNVTX / Novatryx
        // AI Systems") onto a LIVE boot - the heatmap + feeds then paint those mock
        // tiles for the window before the async live-scrub runs. Forcing them out
        // of `p` means rehydration can ONLY bring back durable, user-owned state;
        // the universe always starts empty (skeleton) until real data loads.
        delete (p as Record<string, unknown>).signals;
        delete (p as Record<string, unknown>).signalsFromMock;
        delete (p as Record<string, unknown>).signalsFromShared;
        delete (p as Record<string, unknown>).currentRun;
        delete (p as Record<string, unknown>).researchStatus;
        const publicSeed = SEED_PORTFOLIOS.filter((pf) => pf.owner !== "me");
        if (!p.portfolios) {
          return { ...current, ...p, portfolios: current.portfolios };
        }
        const ownedPersisted = p.portfolios.filter((pf) => pf.owner === "me");
        return { ...current, ...p, portfolios: [...ownedPersisted, ...publicSeed] };
      },
      // Persist durable, user-owned state plus the last research run's signals,
      // so reopening the app shows the most recent research instantly and only
      // re-runs (spending quota) once per research day - see bootstrap().
      partialize: (state) => ({
        preferences: state.preferences,
        interactions: state.interactions,
        outcomeLedger: state.outcomeLedger,
        modelRegistry: state.modelRegistry,
        watchOutBaselines: state.watchOutBaselines,
        portfolios: state.portfolios.filter((p) => p.owner === "me"),
        watchlist: state.watchlist,
        watchlistAlerts: state.watchlistAlerts,
        screenPresets: state.screenPresets,
        following: state.following,
        terminalDensity: state.terminalDensity,
        lastTerminalVisitAt: state.lastTerminalVisitAt,
        terminalNotes: state.terminalNotes,
        terminalSpread: state.terminalSpread,
        // The ~500-signal universe (`signals` + the `signalsFromShared` flag) is
        // intentionally NOT persisted: it's re-fetched on boot (bootstrap →
        // fetchRecentSharedSignals), so persisting it was pure bloat that pushed the
        // single localStorage blob past the ~5MB quota - making the ENTIRE persist
        // write fail silently (safeStorage swallows the quota error), so user-owned
        // state (watchlist, portfolios, alerts) "kept deleting" on reload. We KEEP
        // the small lookupCache below (needed to resolve watched names outside the
        // top-500 universe).
        lastRun: state.lastRun,
        runHistory: state.runHistory,
        researchRunLog: state.researchRunLog,
        researchRunTotal: state.researchRunTotal,
        lookupCount: state.lookupCount,
        lookupCache: state.lookupCache,
        seenAlertIds: state.seenAlertIds,
      }),
    },
  ),
);

// Dev-only handle so the headless verify harness (scripts/verify-fe.cjs) can
// drive degenerate store states (e.g. error-with-no-signals) that the happy
// path never reaches. Stripped from production builds.
// Guard on `window` too: this is a browser-only devtools handle, and in a
// non-DOM context (SSR / a node-env test that transitively imports this store)
// `import.meta.env.DEV` is still true but `window` is undefined - so the bare
// access would throw at module eval and break otherwise-unrelated test files.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __appStore?: typeof useAppStore }).__appStore = useAppStore;
}
