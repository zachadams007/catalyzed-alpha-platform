import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useTickerBeaconStore } from "@/store/useTickerBeaconStore";
import { PageHeader } from "@/components/common/PageHeader";
import { SymbolAutocomplete } from "@/components/common/SymbolAutocomplete";
import { resolveSymbol } from "@/data/symbols/symbolDirectory";
import { SignalCard } from "@/components/signal/SignalCard";
import { FeedSkeleton, LoadingNote } from "@/components/common/FeedSkeleton";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { IconSearch } from "@/components/icons";
import { isFinnhubConfigured } from "@/data/http";
import { verifyFinnhub, type FinnhubVerifyResult } from "@/data/finnhub/verify";
import { SymbolResolveError } from "@/data/finnhub/symbolSearch";
import { SYSTEM_NAV } from "@/config/navigationLabels";
import { isCuratedTicker } from "@/engine/lookupSignal";

/** Single-symbol resolve. */
export function TickerBeacon() {
  const nav = SYSTEM_NAV.beacon;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const urlTicker = params.get("t")?.trim().toUpperCase() ?? "";

  // Remember the last-looked-up ticker across in-session tab switches - mirrors
  // useResearchDeskStore's activeTicker: a module-scope store (not the URL param
  // alone) survives navigating away and back within the same session. The URL
  // param still wins when present (deep links / back-forward keep working).
  const storedTicker = useTickerBeaconStore((s) => s.activeTicker);
  const setStoredTicker = useTickerBeaconStore((s) => s.setActiveTicker);
  const paramTicker = urlTicker || storedTicker || "";

  const [query, setQuery] = useState(paramTicker);
  const [loading, setLoading] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [finnhubCheck, setFinnhubCheck] = useState<FinnhubVerifyResult | null>(null);
  const lookupTicker = useAppStore((s) => s.lookupTicker);
  const lookupCache = useAppStore((s) => s.lookupCache);

  const active = paramTicker ? lookupCache[paramTicker] : undefined;

  useEffect(() => {
    if (!isFinnhubConfigured()) {
      setFinnhubCheck({ status: "missing_key" });
      return;
    }
    let cancelled = false;
    void verifyFinnhub().then((r) => {
      if (!cancelled) setFinnhubCheck(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runLookup = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setLoading(true);
    setResolveError(null);
    try {
      const signal = await lookupTicker(trimmed);
      navigate(`/beacon?t=${encodeURIComponent(signal.ticker)}`, { replace: true });
      setQuery(signal.ticker);
      setStoredTicker(signal.ticker);
    } catch (err) {
      if (err instanceof SymbolResolveError) {
        const hint = err.suggestions.length ? ` Try ${err.suggestions.join(" or ")}.` : "";
        setResolveError(`${err.message}${hint}`);
      } else {
        // Network-bound failure (data load rejected) - show the banner instead
        // of a silent dead box. Covers both the form submit and the ?t= deep
        // link path above.
        setResolveError("Couldn’t load that ticker right now — check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!paramTicker) return;
    // Arrived without a ?t= (e.g. clicked "Ticker Scope" in the sidebar after
    // already scoping a ticker this session) - resync the URL to the restored
    // ticker so the address bar and any deep-link/share stay honest.
    if (!urlTicker) {
      navigate(`/beacon?t=${encodeURIComponent(paramTicker)}`, { replace: true });
    }
    if (!lookupCache[paramTicker]) {
      void runLookup(paramTicker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when ?t= changes
  }, [paramTicker]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Resolve names → canonical symbol against the offline directory first, so
    // "Ballard" or "Tesla" reach the right ticker even with no live key.
    const rec = resolveSymbol(query);
    void runLookup(rec ? rec.symbol : query);
  };

  return (
    <>
      <PageHeader title={nav.label} description={nav.tagline} />

      {finnhubCheck && (
        <p
          className={`lookup-banner beacon-banner ${finnhubCheck.status === "ok" ? "lookup-banner--curated" : ""}`}
        >
          {finnhubCheck.status === "ok" && (
            <>
              <strong>Finnhub verified.</strong> Live quotes are working
              {finnhubCheck.samplePrice != null && (
                <> (test: AAPL ${finnhubCheck.samplePrice.toFixed(2)})</>
              )}
              .
            </>
          )}
          {finnhubCheck.status === "missing_key" && (
            <>
              <strong>Live price data isn&apos;t available in this build.</strong> Ticker Scope will
              still show fundamental signals.
            </>
          )}
          {finnhubCheck.status === "invalid_key" && (
            <>
              <strong>Finnhub key rejected.</strong> {finnhubCheck.detail}
            </>
          )}
          {finnhubCheck.status === "error" && (
            <>
              <strong>Finnhub unreachable.</strong> {finnhubCheck.detail ?? "Try again."}
            </>
          )}
        </p>
      )}

      {resolveError && (
        <p className="lookup-banner beacon-banner">
          {resolveError}
        </p>
      )}

      <form className="beacon-lookup" onSubmit={onSubmit}>
        <SymbolAutocomplete
          value={query}
          onChange={setQuery}
          onPick={(rec) => {
            setQuery(rec.symbol);
            void runLookup(rec.symbol);
          }}
          placeholder="Ticker or company (e.g. Tesla, TSLA, AAPL)"
          ariaLabel="Look up a ticker or company"
          variant="panel"
          autoFocus={!paramTicker}
          leading={<IconSearch size={18} />}
          trailing={
            <button className="btn btn--primary" type="submit" disabled={loading || !query.trim()}>
              {loading ? <span className="spinner" /> : "Resolve"}
            </button>
          }
        />
      </form>

      {active && (
        <div className="lookup-result">
          {active.lookupProvenance === "finnhub" && (
            <p className="lookup-banner lookup-banner--curated">
              Live spot price & company name from Finnhub. Scores still use modeled momentum, social, and
              catalyst inputs until full fundamentals are wired.
            </p>
          )}
          {active.lookupProvenance === "synthetic" && (
            <p className="lookup-banner">
              Offline lookup — add VITE_FINNHUB_API_KEY for live quotes and news.
            </p>
          )}
          {!active.isLookup && isCuratedTicker(active.ticker) && (
            <p className="lookup-banner lookup-banner--curated">
              Research universe — same live pipeline as Today’s feed.
            </p>
          )}
          <SignalCard signal={active} />
          <div className="row gap-3 beacon-actions">
            <Link className="btn btn--ghost" to={`/signal/${active.ticker}`}>
              Full detail view
            </Link>
            <Link className="btn btn--ghost" to={SYSTEM_NAV.forge.path}>
              Open {SYSTEM_NAV.forge.label}
            </Link>
          </div>
        </div>
      )}

      {loading && !active && (
        <div className="lookup-result beacon-actions" aria-busy="true" aria-label="Resolving ticker">
          <LoadingNote
            label={query.trim() ? query.trim().toUpperCase() : "this ticker"}
            hint="Resolving the symbol and pulling its live read — not stuck."
          />
          <FeedSkeleton count={1} layout="list" />
        </div>
      )}

      {!active && !loading && (
        <div className="empty beacon-empty">
          <h3>Scope a ticker</h3>
          <p className="text-muted">
            Need a basket? Use{" "}
            <Link to={SYSTEM_NAV.forge.path} className="linkish">
              {SYSTEM_NAV.forge.label}
            </Link>{" "}
            to screen by horizon, cap, growth, and themes.
          </p>
        </div>
      )}

      <InvestingDisclaimer className="page-disclaimer" />
    </>
  );
}
