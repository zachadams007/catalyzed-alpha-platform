import { useEffect, useState } from "react";
import { useAppStore } from "@/store/useAppStore";
import { resolveSymbolFromQuery } from "@/data/finnhub/symbolSearch";
import { fetchFinnhubPortfolioQuote } from "@/data/finnhub/liveCompany";
import { fetchYahooHistory, type YahooHistory } from "@/data/prices/yahooHistory";
import type { PortfolioQuote, StockSignal } from "@/types";

export interface SecuritySnapshot {
  ticker: string | undefined;
  signal: StockSignal | undefined;
  quote: PortfolioQuote | null;
  history: YahooHistory | null;
  /** True while the signal is being looked up live (not in the scored universe). */
  resolving: boolean;
}

/**
 * Resolve one security's signal + live quote + 1Y history, looking it up live
 * when it isn't already in the scored universe. Shared by the compare view and
 * the linked-parameter spread so both stay in lockstep with the workspace's
 * fetch discipline. Each consumer keys its render by ticker so a symbol change
 * cleanly remounts.
 */
export function useSecuritySnapshot(rawTicker: string | undefined): SecuritySnapshot {
  const input = rawTicker?.trim().toUpperCase();
  const resolveSignal = useAppStore((s) => s.resolveSignal);
  const lookupTicker = useAppStore((s) => s.lookupTicker);

  // The CANONICAL symbol the rest of the hook keys off. An alias, a company
  // name, or a class-share form in the URL/command must be normalized first -
  // otherwise lookupTicker caches under the resolved symbol while we keep
  // reading the raw param, and the pane sticks on its skeleton/error forever.
  // The compare/spread consumers render inline (no route to redirect), so the
  // hook owns canonicalization itself.
  const [resolved, setResolved] = useState<string | undefined>(input);
  const [resolving, setResolving] = useState(false);
  const [quote, setQuote] = useState<PortfolioQuote | null>(null);
  const [history, setHistory] = useState<YahooHistory | null>(null);

  useEffect(() => {
    if (!input) {
      setResolved(undefined);
      return;
    }
    // Fast path: a symbol already in the scored universe needs no network resolve.
    if (resolveSignal(input)) {
      setResolved(input);
      return;
    }
    let cancelled = false;
    void resolveSymbolFromQuery(input)
      .then((sym) => {
        if (!cancelled) setResolved(sym);
      })
      .catch(() => {
        if (!cancelled) setResolved(input);
      });
    return () => {
      cancelled = true;
    };
  }, [input, resolveSignal]);

  const signal = resolved ? resolveSignal(resolved) : undefined;

  // Look the resolved signal up live when it isn't in the scored universe.
  useEffect(() => {
    if (!resolved || signal) return;
    let cancelled = false;
    setResolving(true);
    void lookupTicker(resolved).finally(() => {
      if (!cancelled) setResolving(false);
    });
    return () => {
      cancelled = true;
    };
  }, [resolved, signal, lookupTicker]);

  // Live quote + real 1Y history once a signal exists.
  useEffect(() => {
    if (!resolved || !signal) return;
    let cancelled = false;
    setQuote(null);
    setHistory(null);
    // Fire-and-forget, but ALWAYS catch: an unhandled rejection here (a hung or
    // blocked quote/history fetch) surfaces as a global error in the Tauri
    // webview, which is one way the Terminal could white-screen. Degrade to the
    // null placeholder the panels already handle instead.
    void fetchFinnhubPortfolioQuote(resolved)
      .then((q) => {
        if (!cancelled) setQuote(q);
      })
      .catch(() => {
        if (!cancelled) setQuote(null);
      });
    void fetchYahooHistory(resolved)
      .then((h) => {
        if (!cancelled) setHistory(h);
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [resolved, signal?.ticker]);

  return { ticker: resolved ?? input, signal, quote, history, resolving };
}
