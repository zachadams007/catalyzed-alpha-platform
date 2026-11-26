import { useSyncExternalStore } from "react";
import type { RankingMode } from "@/types";
import { subscribeApiUsage } from "@/lib/apiUsage";
import { researchAgentStatus, type ResearchAgentStatus } from "@/data/ai/researchAgent";

/**
 * Blueprint's unified research flow - one Run, two lanes, one board.
 *
 * Local scoring is continuous (the live screen effect). In the AI ranking
 * modes, "Run Blueprint" ALSO fires the hosted research agent; its findings
 * (niche tickers + a relevance vote) merge into the SAME ranked board. The
 * phases below narrate that single action - they are progress, not buttons.
 */

export type BlueprintResearchPhase =
  | "idle"
  | "local"
  | "web"
  | "hydrating"
  | "ranking"
  | "complete"
  /** The proxy's daily budget is spent (or live data paused) - calm, not an error. */
  | "paused"
  | "error";

export interface BlueprintResearchState {
  phase: BlueprintResearchPhase;
  localCount: number;
  aiCandidateCount: number;
  hydratedCount: number;
  acceptedCount: number;
  finalCount: number;
  /** Calm explanatory note for paused/error phases. */
  note?: string | null;
}

export const EMPTY_RESEARCH_STATE: BlueprintResearchState = {
  phase: "idle",
  localCount: 0,
  aiCandidateCount: 0,
  hydratedCount: 0,
  acceptedCount: 0,
  finalCount: 0,
  note: null,
};

/** Ranking modes whose Run includes the AI deep search. */
export const AI_RANKING_MODES: ReadonlySet<RankingMode> = new Set(["blended", "ai"]);

export function isAiMode(mode: RankingMode | undefined): boolean {
  return AI_RANKING_MODES.has(mode ?? "blended");
}

/** True while the unified run is mid-flight (board is preliminary). */
export function isResearchInFlight(phase: BlueprintResearchPhase): boolean {
  return phase === "local" || phase === "web" || phase === "hydrating" || phase === "ranking";
}

/** The four stages the gate deck narrates during a unified run. */
export const RESEARCH_STAGES: ReadonlyArray<{
  key: Extract<BlueprintResearchPhase, "local" | "web" | "hydrating" | "ranking">;
  label: string;
  detail: string;
}> = [
  { key: "local", label: "Local screen", detail: "Score the live universe" },
  { key: "web", label: "AI niche search", detail: "Agent hunts real tickers" },
  { key: "hydrating", label: "Hydrate", detail: "Quotes + fundamentals" },
  { key: "ranking", label: "One board", detail: "Same gates, one ranking" },
];

export type StageStatus = "idle" | "active" | "done";

export function researchStageStatus(
  stage: (typeof RESEARCH_STAGES)[number]["key"],
  phase: BlueprintResearchPhase,
): StageStatus {
  if (phase === "idle" || phase === "paused") return "idle";
  if (phase === "complete") return "done";
  if (phase === "error") return stage === "local" ? "done" : "idle";
  const order = RESEARCH_STAGES.findIndex((s) => s.key === stage);
  const current = RESEARCH_STAGES.findIndex((s) => s.key === phase);
  if (order < current) return "done";
  if (order === current) return "active";
  return "idle";
}

/**
 * Live availability of the AI lane (off / paused / ready), re-rendered whenever
 * the usage ledger or Operator controls change. Cached per notify so the
 * snapshot stays referentially stable between ledger events.
 */
let laneCache: ResearchAgentStatus | null = null;

function readLane(): ResearchAgentStatus {
  if (!laneCache) laneCache = researchAgentStatus();
  return laneCache;
}

function subscribeLane(onChange: () => void): () => void {
  // Re-read on (re)mount: Operator controls may have changed while no
  // Blueprint surface was subscribed to invalidate the cache.
  laneCache = null;
  return subscribeApiUsage(() => {
    laneCache = null;
    onChange();
  });
}

export function useResearchLane(): ResearchAgentStatus {
  return useSyncExternalStore(subscribeLane, readLane, readLane);
}
