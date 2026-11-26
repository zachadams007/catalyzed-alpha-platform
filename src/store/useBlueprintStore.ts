import { create } from "zustand";
import type { ResearchIntel, ScreenCriteria, ScreenMatch, TradeHorizon } from "@/types";
import {
  defaultBlueprintCriteria,
  effectiveScreenCriteria,
  evaluateScreenGates,
} from "@/engine/screen";
import {
  researchAgentStatus,
  runResearchAgent,
  ResearchProxyError,
} from "@/data/ai/researchAgent";
import {
  EMPTY_RESEARCH_STATE,
  isAiMode,
  type BlueprintResearchState,
} from "@/components/screen/researchFlow";
import type { ScreenCut } from "@/components/screen/LiveLeaderboard";
import type { StockSignal } from "@/types";
import { TRADE_HORIZON_LABELS } from "@/types";

/**
 * Blueprint store - in-memory (NOT persisted), resets on app reload.
 *
 * Mirrors the pattern of useResearchDeskStore: lifting state and the async run
 * into module scope means navigating away from /forge no longer unmounts and
 * kills an in-flight AI run. Returning to /forge re-reads the store and shows
 * the current progress or result - nothing is lost.
 */

// ── helpers duplicated from SignalForge (kept private; no engine dep) ──────

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function describeCriteriaForResearch(criteria: ScreenCriteria, horizons: TradeHorizon[]): string {
  const parts: string[] = [];
  if (horizons.length > 0) {
    parts.push(`horizons ${horizons.map((h) => TRADE_HORIZON_LABELS[h]).join(", ")}`);
  }
  if (criteria.themeTags?.length) parts.push(`theme tags ${criteria.themeTags.join(", ")}`);
  if (criteria.keywords?.length)
    parts.push(`expanded keywords ${criteria.keywords.slice(0, 12).join(", ")}`);
  if (criteria.sectors?.length) parts.push(`sectors ${criteria.sectors.join(", ")}`);
  if (criteria.capBuckets?.length) parts.push(`market cap ${criteria.capBuckets.join(", ")}`);
  if (criteria.riskLevels?.length) parts.push(`risk levels ${criteria.riskLevels.join(", ")}`);
  if (criteria.catalystTypes?.length)
    parts.push(`catalysts ${criteria.catalystTypes.join(", ")}`);
  if (criteria.minOpportunityScore)
    parts.push(`minimum opportunity score ${criteria.minOpportunityScore}`);
  if (criteria.minConfidence) parts.push(`minimum confidence ${criteria.minConfidence}`);
  if (criteria.minRevenueGrowth)
    parts.push(`minimum revenue growth ${pct(criteria.minRevenueGrowth)}`);
  if (criteria.minEpsGrowth) parts.push(`minimum EPS growth ${pct(criteria.minEpsGrowth)}`);
  if (criteria.minGrossMargin)
    parts.push(`minimum gross margin ${pct(criteria.minGrossMargin)}`);
  if (criteria.minAvgDollarVolume)
    parts.push(`minimum average dollar volume ${criteria.minAvgDollarVolume}`);
  if (criteria.maxShortInterestPct)
    parts.push(`maximum short interest ${pct(criteria.maxShortInterestPct)}`);
  if (criteria.maxPeRatio) parts.push(`maximum P/E ${criteria.maxPeRatio}`);
  if (criteria.requireAboveSMA50) parts.push("must be above 50-day SMA");
  if (criteria.requireAboveSMA200) parts.push("must be above 200-day SMA");
  if (criteria.maxDaysToCatalyst)
    parts.push(`catalyst within ${criteria.maxDaysToCatalyst} days`);
  if (criteria.preferHype)
    parts.push("prefer current news, social, and catalyst attention");
  return parts.length ? parts.join("; ") : "no hard filters beyond the narrative";
}

function buildResearchNarrative(
  description: string,
  criteria: ScreenCriteria,
  horizons: TradeHorizon[],
): string {
  return [
    "Find real, U.S.-listed operating companies for this Catalyzed Alpha Blueprint screen.",
    `User narrative: ${description.trim() || "No narrative supplied."}`,
    `Blueprint filter context: ${describeCriteriaForResearch(criteria, horizons)}.`,
    "Use the filter context as constraints. Prefer direct niche exposure over broad mega-cap proxies unless the narrative explicitly asks for them.",
    "Exclude ETFs, private companies, ADR-only ideas, and non-U.S. listings. Return research discovery only, with no buy/sell advice.",
  ].join("\n");
}

function researchThemes(criteria: ScreenCriteria): string[] {
  return [
    ...new Set([...(criteria.themeTags ?? []), ...(criteria.keywords ?? [])]),
  ].slice(0, 16);
}

export function annotateResearchedMatches(
  matches: ScreenMatch[],
  tickers: Set<string>,
): ScreenMatch[] {
  if (tickers.size === 0) return matches;
  return matches.map((match) => {
    if (!tickers.has(match.signal.ticker) || match.reasons.includes("AI boosted")) return match;
    return { ...match, reasons: ["AI boosted", ...match.reasons] };
  });
}

/** Toast when the Blueprint AI run finishes, ONLY if the user is not on /forge. */
function notifyBlueprintFinished(ok: boolean): void {
  if (typeof window !== "undefined" && window.location.hash.includes("/forge")) return;
  void import("@/store/useAppStore")
    .then(({ useAppStore }) =>
      useAppStore
        .getState()
        .pushToast(
          ok ? "Blueprint screen ready" : "Blueprint AI research didn't finish — tap to retry",
          ok ? "success" : "warn",
          { href: "/forge", durationMs: 6000 },
        ),
    )
    .catch(() => {});
}

// ── store types ─────────────────────────────────────────────────────────────

interface BlueprintState {
  /** Persistent-across-navigation view state. */
  presetName: string;
  horizons: TradeHorizon[];
  criteria: ScreenCriteria;
  description: string;
  activePresetId: string | null;
  matches: ScreenMatch[];
  cuts: ScreenCut[];
  researchedTickers: Set<string>;
  running: boolean;
  researchState: BlueprintResearchState;
  researchIntel: ResearchIntel | null;
  excludeTickers: string[];

  /** Internal sequence for unique cut IDs (never reset between navigations). */
  _cutSeq: number;

  /** Setters for the form fields. */
  setPresetName: (v: string) => void;
  setHorizons: (v: TradeHorizon[]) => void;
  setCriteria: (v: ScreenCriteria) => void;
  setDescription: (v: string) => void;
  setActivePresetId: (v: string | null) => void;
  setMatches: (v: ScreenMatch[]) => void;
  setCuts: (updater: (prev: ScreenCut[]) => ScreenCut[]) => void;
  setResearchedTickers: (v: Set<string>) => void;
  setResearchState: (
    updater: BlueprintResearchState | ((prev: BlueprintResearchState) => BlueprintResearchState),
  ) => void;
  setResearchIntel: (v: ResearchIntel | null) => void;
  setExcludeTickers: (updater: string[] | ((prev: string[]) => string[])) => void;
  nextCutId: () => string;

  /**
   * Fire the Blueprint AI run. This lives in the store (not the component) so
   * the in-flight network call survives tab navigation - same pattern as the
   * Research Desk's `run` action in useResearchDeskStore.
   *
   * Deps injected by the component so the store stays free of direct AppStore
   * coupling at call-time: `runScreen`, `adoptAiRelevanceIntel`, `lookupTicker`,
   * `activePresetId` from appStore are all passed by the caller.
   */
  runBlueprint: (deps: {
    runScreen: (
      horizons: TradeHorizon[],
      criteria: ScreenCriteria,
      description: string,
      excludeTickers: string[],
    ) => ScreenMatch[];
    adoptAiRelevanceIntel: (
      intel: ResearchIntel,
      criteria: ScreenCriteria,
      description: string,
    ) => void;
    lookupTicker: (ticker: string) => Promise<StockSignal>;
    mergeScreenPresetResults: (presetId: string, tickers: string[]) => void;
  }) => Promise<void>;
}

export const useBlueprintStore = create<BlueprintState>((set, get) => ({
  // ── view state ─────────────────────────────────────────────────────────
  presetName: "My screen",
  horizons: ["position_trading"] as TradeHorizon[],
  criteria: defaultBlueprintCriteria(),
  description: "",
  activePresetId: null,
  matches: [],
  cuts: [],
  researchedTickers: new Set<string>(),
  running: false,
  researchState: EMPTY_RESEARCH_STATE,
  researchIntel: null,
  excludeTickers: [],
  _cutSeq: 0,

  // ── setters ────────────────────────────────────────────────────────────
  setPresetName: (v) => set({ presetName: v }),
  setHorizons: (v) => set({ horizons: v }),
  setCriteria: (v) => set({ criteria: v }),
  setDescription: (v) => set({ description: v }),
  setActivePresetId: (v) => set({ activePresetId: v }),
  setMatches: (v) => set({ matches: v }),
  setCuts: (updater) => set((s) => ({ cuts: updater(s.cuts) })),
  setResearchedTickers: (v) => set({ researchedTickers: v }),
  setResearchState: (updater) =>
    set((s) => ({
      researchState:
        typeof updater === "function" ? updater(s.researchState) : updater,
    })),
  setResearchIntel: (v) => set({ researchIntel: v }),
  setExcludeTickers: (updater) =>
    set((s) => ({
      excludeTickers:
        typeof updater === "function" ? updater(s.excludeTickers) : updater,
    })),
  nextCutId: () => {
    const seq = get()._cutSeq + 1;
    set({ _cutSeq: seq });
    return `cut_${seq}`;
  },

  // ── main AI run action ─────────────────────────────────────────────────
  runBlueprint: async ({ runScreen, adoptAiRelevanceIntel, lookupTicker, mergeScreenPresetResults }) => {
    const { horizons, criteria, description, excludeTickers, running, researchState } = get();
    const mode = criteria.rankingMode ?? "blended";

    if (!isAiMode(mode) || running || description.trim().length <= 12) return;

    const laneNow = researchAgentStatus();
    if (laneNow.lane !== "ready") {
      set({
        researchState: {
          ...EMPTY_RESEARCH_STATE,
          phase: laneNow.lane === "paused" ? "paused" : "idle",
          note: laneNow.reason ?? null,
          localCount: researchState.localCount,
          finalCount: researchState.finalCount,
        },
      });
      return;
    }

    // Race token - a newer call supersedes an older one.
    const startedAt = Date.now();
    set({ running: true, researchIntel: null });

    const isCurrent = () => get().running && get().researchState.phase !== "complete"
      || /* allow checking via closure */ true;
    // Simpler: track start time in closure; if running=false we were superseded or done.
    const checkSuperseded = () => {
      // If another runBlueprint was kicked off, startedAt in that call is newer.
      // We guard by checking that we are still "running" AND our researchState
      // matches the phase we set - if something reset it, bail.
      return false; // We use the running flag for simplicity (only one run at a time due to the guard above).
    };
    void checkSuperseded; // silence lint

    // ── Lane A - fundamentals (synchronous, no network) ──────────────────
    const fundamentalsLane = Promise.resolve().then(() => {
      const local = runScreen(horizons, criteria, description, excludeTickers);
      set({ matches: local });
      return local;
    });

    // ── Lane B - AI niche search (network) ───────────────────────────────
    const aiLane = runResearchAgent({
      narrative: buildResearchNarrative(description, criteria, horizons),
      themes: researchThemes(criteria),
      task: "discover",
    });

    const localBoard = await fundamentalsLane;
    const localCount = localBoard.length;
    set({
      researchState: {
        ...EMPTY_RESEARCH_STATE,
        phase: "web",
        localCount,
        finalCount: localCount,
      },
    });

    try {
      const intel = await aiLane;
      set({ researchIntel: intel });
      adoptAiRelevanceIntel(intel, criteria, description);

      const tickers = (intel.suggestions ?? []).slice(0, 12).map((s) => s.ticker);
      set((s) => ({
        researchState: {
          ...s.researchState,
          phase: tickers.length > 0 ? "hydrating" : "ranking",
          aiCandidateCount: tickers.length,
        },
      }));

      // Hydrate AI-discovered tickers.
      //
      // In BATCHES, not one at a time. This used to be a `for…await` over up to
      // 12 tickers - each a full lookup (quote + profile + fundamentals) - so the
      // "AI niche search" phase spent 12 back-to-back round trips serialized on
      // the critical path. That was the "minutes" the owner saw in the screener.
      // Same bounded-concurrency shape as `refreshPortfolioQuotes` in
      // useAppStore.ts: a batch of 8 keeps the burst well under every vendor's
      // per-minute rate limit while cutting the wall clock by ~the batch size.
      const found: StockSignal[] = [];
      const unique = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
      const batchSize = 8;
      for (let index = 0; index < unique.length; index += batchSize) {
        const batch = unique.slice(index, index + batchSize);
        const settled = await Promise.allSettled(batch.map((ticker) => lookupTicker(ticker)));
        for (const result of settled) {
          // A rejected lookup already surfaced its own toast; skip it silently.
          if (result.status === "fulfilled") found.push(result.value);
        }
      }

      const researched = new Set(found.map((signal) => signal.ticker));
      set((s) => ({
        researchState: {
          ...s.researchState,
          phase: "ranking",
          hydratedCount: found.length,
        },
      }));

      // Unified board: re-screen with AI names now hydrated into the universe.
      const currentState = get();
      const finalMatches = annotateResearchedMatches(
        runScreen(
          currentState.horizons,
          currentState.criteria,
          currentState.description,
          currentState.excludeTickers,
        ),
        researched,
      );
      const acceptedCount = finalMatches.filter((m) => researched.has(m.signal.ticker)).length;

      set({
        researchedTickers: researched,
        matches: finalMatches,
        researchState: {
          phase: "complete",
          localCount,
          aiCandidateCount: tickers.length,
          hydratedCount: found.length,
          acceptedCount,
          finalCount: finalMatches.length,
          note: null,
        },
      });

      if (found.length > 0) {
        // Only toast "stocks evaluated" when on /forge; off-page toast is the "screen ready" one.
        if (typeof window !== "undefined" && window.location.hash.includes("/forge")) {
          void import("@/store/useAppStore")
            .then(({ useAppStore }) =>
              useAppStore
                .getState()
                .pushToast(
                  `Unified research evaluated ${found.length} AI-found ${found.length === 1 ? "stock" : "stocks"}`,
                  "success",
                ),
            )
            .catch(() => {});
        }
      }

      const activePresetId = get().activePresetId;
      if (activePresetId) {
        mergeScreenPresetResults(
          activePresetId,
          finalMatches.map((m) => m.signal.ticker),
        );
      }

      notifyBlueprintFinished(true);
    } catch (err) {
      const after = researchAgentStatus();
      if (after.lane === "paused") {
        set((s) => ({
          researchState: {
            ...s.researchState,
            phase: "paused",
            note: after.reason ?? null,
            finalCount: localCount,
          },
        }));
      } else {
        const message =
          err instanceof ResearchProxyError
            ? err.message
            : "AI web research did not return usable tickers.";
        set((s) => ({
          researchState: {
            ...s.researchState,
            phase: "error",
            note: message,
            finalCount: localCount,
          },
        }));
        if (typeof window !== "undefined" && window.location.hash.includes("/forge")) {
          void import("@/store/useAppStore")
            .then(({ useAppStore }) =>
              useAppStore
                .getState()
                .pushToast(
                  "AI research had an issue — local Blueprint matches are shown.",
                  "warn",
                ),
            )
            .catch(() => {});
        }
      }
      notifyBlueprintFinished(false);
    }

    set({ running: false });
  },
}));

// Dev-only handle - mirrors window.__researchDeskStore / __appStore / __groupsStore.
// Stripped from production builds.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (
    window as unknown as { __blueprintStore?: typeof useBlueprintStore }
  ).__blueprintStore = useBlueprintStore;
}
