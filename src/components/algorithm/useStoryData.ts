import { useMemo } from "react";
import { useAppStore } from "@/store/useAppStore";
import { selectToday, selectWeekly } from "@/feed/feeds";
import { researchRankScore } from "@/engine/ranking";
import type { ResearchRun, StockSignal } from "@/types";
import type { PipelineStageKey } from "@/viz/pipelineModel";

/**
 * Live + representative data feeding the Algorithm story.
 *
 * When the store holds real scored signals, every scene renders REAL numbers
 * (the top signal's enrichment fields, score breakdown, and the actual feed
 * lineups). With an empty store the scenes fall back to a representative
 * walkthrough example and say so - never presenting sample values as live.
 */

export interface StoryExample {
  ticker: string;
  name: string;
  sector: string;
  /** True when this is the labeled representative sample, not a live signal. */
  representative: boolean;
  signal?: StockSignal;
}

/** Representative walkthrough values - used ONLY when no live run exists. */
const SAMPLE_EXAMPLE: StoryExample = {
  ticker: "IONQ",
  name: "IonQ, Inc.",
  sector: "Technology",
  representative: true,
};

export interface LiveStageInfo {
  status: "pending" | "running" | "done";
  detail?: string;
}

export interface StoryData {
  isRunning: boolean;
  researchStatus: ReturnType<typeof useAppStore.getState>["researchStatus"];
  currentRun?: ResearchRun;
  hasSignals: boolean;
  signalCount: number;
  universeSize: number;
  /** Honest one-line summary of how the universe was assembled (funnel runs). */
  discoverySummary?: string;
  example: StoryExample;
  today: StockSignal[];
  weekly: StockSignal[];
  /** Per-stage live status keyed by the real stage keys. */
  liveStages: Partial<Record<PipelineStageKey, LiveStageInfo>>;
  runResearchNow: (trigger?: "manual" | "scheduled") => Promise<void>;
}

export function useStoryData(): StoryData {
  const signals = useAppStore((s) => s.signals);
  const researchStatus = useAppStore((s) => s.researchStatus);
  const currentRun = useAppStore((s) => s.currentRun);
  const lastRun = useAppStore((s) => s.lastRun);
  const runResearchNow = useAppStore((s) => s.runResearchNow);

  return useMemo(() => {
    const hasSignals = signals.length > 0;
    // Same sort the feeds use - so the walkthrough's "top-ranked signal" is
    // the exact name that sits at #1 on the ranking board and in Today.
    const top = hasSignals
      ? [...signals].sort((a, b) => researchRankScore(b) - researchRankScore(a))[0]
      : undefined;
    const example: StoryExample = top
      ? {
          ticker: top.ticker,
          name: top.name,
          sector: top.sector,
          representative: false,
          signal: top,
        }
      : SAMPLE_EXAMPLE;

    const liveStages: StoryData["liveStages"] = {};
    if (currentRun) {
      for (const stage of currentRun.stages) {
        liveStages[stage.key as PipelineStageKey] = {
          status: stage.status,
          detail: stage.detail,
        };
      }
    }

    return {
      isRunning: researchStatus === "running",
      researchStatus,
      currentRun,
      hasSignals,
      signalCount: signals.length,
      universeSize: lastRun?.universeSize ?? currentRun?.universeSize ?? 0,
      discoverySummary: currentRun?.discoverySummary ?? lastRun?.discoverySummary,
      example,
      today: hasSignals ? selectToday(signals) : [],
      weekly: hasSignals ? selectWeekly(signals) : [],
      liveStages,
      runResearchNow,
    };
  }, [signals, researchStatus, currentRun, lastRun, runResearchNow]);
}
