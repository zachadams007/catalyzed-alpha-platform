import { create } from "zustand";
import type { ResearchIntel } from "@/types";
import {
  runResearchAgent,
  researchAgentStatus,
  ResearchProxyError,
  type ResearchProxyErrorKind,
} from "@/data/ai/researchAgent";

/**
 * Research Desk store - keyed by ticker, in-memory (NOT persisted).
 *
 * Why a store and not component `useState`: leaving the Research Desk tab
 * mid-run used to destroy everything - the run died and the result was gone on
 * return. Lifting the run state here (module scope, not component scope) fixes
 * both: an in-flight run keeps going when you navigate away (the fetch promise is
 * owned by the action, not the component), and returning to the desk re-reads the
 * finished/progressing entry for the active ticker.
 *
 * Deliberately NOT persisted to localStorage: a grounded research read is a
 * point-in-time live snapshot, so showing yesterday's read on a fresh app launch
 * would violate the no-stale-data rule. It survives tab navigation; it resets on
 * app restart (where a fresh run is the honest behavior).
 */

/** Deep diligence is a real grounded run: Gemini searches the live web, reads
 *  news/filings/catalysts, and writes a cited brief - ~60-120s. Give it headroom
 *  so a thorough run completes instead of aborting at the old edge. */
const DEEP_TIMEOUT_MS = 150_000;

export type DeskRunState = "loading" | "done" | "error";

export interface DeskEntry {
  ticker: string;
  state: DeskRunState;
  intel?: ResearchIntel | null;
  error?: string;
  errorKind?: ResearchProxyErrorKind;
  /** ms epoch the run started - also the race token (a newer run supersedes). */
  startedAt: number;
}

interface ResearchDeskState {
  entries: Record<string, DeskEntry>;
  /** The ticker whose result the desk is currently showing. */
  activeTicker: string | null;
  setActiveTicker: (ticker: string | null) => void;
  /**
   * Start (or re-focus) a run for `ticker`. Idempotent: if a run is already
   * loading or finished for this ticker it just re-focuses it - pass
   * `{ force: true }` to re-run. Always sets `activeTicker`. Never a silent dead
   * button: lane-off / paused produce a visible error entry.
   */
  run: (ticker: string, opts?: { force?: boolean }) => void;
  clear: (ticker: string) => void;
}

export const useResearchDeskStore = create<ResearchDeskState>((set, get) => ({
  entries: {},
  activeTicker: null,
  setActiveTicker: (ticker) => set({ activeTicker: ticker }),
  clear: (ticker) =>
    set((s) => {
      const entries = { ...s.entries };
      delete entries[ticker.trim().toUpperCase()];
      return { entries };
    }),
  run: (rawTicker, opts) => {
    const ticker = rawTicker.trim().toUpperCase();
    if (!ticker) return;
    set({ activeTicker: ticker });

    const existing = get().entries[ticker];
    // Already running, or finished and not forced → keep what we have (this is the
    // "don't re-fetch on remount" guarantee).
    if (!opts?.force && existing && (existing.state === "loading" || existing.state === "done")) {
      return;
    }

    const writeError = (errorKind: ResearchProxyErrorKind, error: string) =>
      set((s) => ({
        entries: {
          ...s.entries,
          [ticker]: { ticker, state: "error", errorKind, error, startedAt: Date.now() },
        },
      }));

    // Lane gating - mirror the desk's pre-flight checks so the store is the single
    // source of truth for whether a run can fire.
    const live = researchAgentStatus();
    if (live.lane === "off") {
      writeError(
        "unconfigured",
        "The research desk isn’t connected in this build. Set VITE_RESEARCH_PROXY_URL to your hosted desk to turn it on.",
      );
      return;
    }
    if (live.lane !== "ready") {
      writeError(
        "rate_limited",
        live.reason ?? "The desk’s daily budget is spent — it resets at local midnight.",
      );
      return;
    }

    const startedAt = Date.now();
    set((s) => ({ entries: { ...s.entries, [ticker]: { ticker, state: "loading", startedAt } } }));

    const isCurrent = () => get().entries[ticker]?.startedAt === startedAt;

    void runResearchAgent({ task: "deep_research", ticker }, { timeoutMs: DEEP_TIMEOUT_MS })
      .then((res) => {
        if (!isCurrent()) return; // a newer run for this ticker superseded
        set((s) => ({
          entries: { ...s.entries, [ticker]: { ticker, state: "done", intel: res, startedAt } },
        }));
        notifyDeskFinished(ticker, true);
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        const errorKind: ResearchProxyErrorKind =
          err instanceof ResearchProxyError ? err.kind : "unreachable";
        const error =
          err instanceof ResearchProxyError ? err.message : "Research service unavailable — try again.";
        set((s) => ({
          entries: { ...s.entries, [ticker]: { ticker, state: "error", errorKind, error, startedAt } },
        }));
        notifyDeskFinished(ticker, false);
      });
  },
}));

/**
 * Toast when a deep-research run FINISHES - but only if the user has navigated
 * AWAY from the desk (the whole point: kick off research, go do something else,
 * get pinged when it's ready). If they're still on the desk they can see the
 * result land, so a toast there would be noise. Tapping the toast returns to the
 * desk (which shows this ticker as the active read). Dynamic import avoids a
 * circular dep (useAppStore ←→ stores).
 */
function notifyDeskFinished(ticker: string, ok: boolean): void {
  if (typeof window !== "undefined" && window.location.hash.includes("/research")) return;
  void import("@/store/useAppStore")
    .then(({ useAppStore }) =>
      useAppStore
        .getState()
        .pushToast(
          ok ? `Research ready for ${ticker}` : `Research for ${ticker} didn't finish — tap to retry`,
          ok ? "success" : "warn",
          { href: "/research", durationMs: 6000 },
        ),
    )
    .catch(() => {});
}

// Dev-only handle so the headless screenshot harness can render a finished desk
// read without a live research proxy (mirrors window.__appStore / __authStore /
// __groupsStore). Stripped from production builds.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __researchDeskStore?: typeof useResearchDeskStore }).__researchDeskStore =
    useResearchDeskStore;
}

