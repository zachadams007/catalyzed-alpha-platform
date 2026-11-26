import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import { useAppStore } from "@/store/useAppStore";
import { SymbolAutocomplete } from "@/components/common/SymbolAutocomplete";
import { resolveSymbol } from "@/data/symbols/symbolDirectory";
import { WatchlistRow } from "@/components/watchlist/WatchlistRow";
import { FeedAwaitingRun, feedIsPreparing } from "@/components/common/FeedState";
import { LoadingNote } from "@/components/common/FeedSkeleton";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { LivePriceControl } from "@/components/common/LivePriceControl";
import { IconBell, IconExternal, IconLayers, IconPlus, IconPulse, IconSearch, IconTarget } from "@/components/icons";
import { hypeTierKey } from "@/components/signal/HypeStrip";
import { SYSTEM_NAV } from "@/config/navigationLabels";
import { formatPct } from "@/lib/format";
import { isMarketDataUnavailable } from "@/lib/marketData";
import type { HypeTier, StockSignal, WatchlistAlert } from "@/types";

type SortMode = "score" | "day" | "hype" | "ticker" | "added";
type GroupMode = "none" | "sector" | "heat";

const SORT_OPTIONS: ReadonlyArray<{ value: SortMode; label: string }> = [
  { value: "score", label: "Opportunity score" },
  { value: "day", label: "Day change" },
  { value: "hype", label: "Hype" },
  { value: "ticker", label: "Ticker (A–Z)" },
  { value: "added", label: "Recently added" },
];

const GROUP_OPTIONS: ReadonlyArray<{ value: GroupMode; label: string }> = [
  { value: "none", label: "No grouping" },
  { value: "sector", label: "By sector" },
  { value: "heat", label: "By heat" },
];

const MOVER_THRESHOLD = 0.03;
const CATALYST_WINDOW_DAYS = 7;

const HEAT_TIERS: ReadonlyArray<HypeTier> = ["On fire", "Heating up", "Warming", "Cooling"];

function sortSignals(list: StockSignal[], mode: SortMode): StockSignal[] {
  if (mode === "added") return list;
  return [...list].sort((a, b) => {
    switch (mode) {
      case "score":
        return b.score.opportunityScore - a.score.opportunityScore;
      case "day":
        return (b.dayChange ?? 0) - (a.dayChange ?? 0);
      case "hype":
        return b.hype.score - a.hype.score;
      case "ticker":
        return a.ticker.localeCompare(b.ticker);
      default:
        return 0;
    }
  });
}

function alertTriggered(alert: WatchlistAlert | undefined, price: number | undefined): boolean {
  if (!alert || price == null) return false;
  return alert.direction === "above" ? price >= alert.price : price <= alert.price;
}

function WatchlistSkeleton() {
  return (
    <div className="wl-skeleton" aria-busy="true" aria-label="Loading your watchlist">
      <LoadingNote
        label="your watchlist"
        hint="Re-scoring your watched names on the latest run — not stuck."
      />
      <span className="skeleton wl-skeleton__desk" />
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className="skeleton wl-skeleton__row" />
      ))}
    </div>
  );
}

export function WatchlistPage() {
  const watchlist = useAppStore((s) => s.watchlist);
  const signals = useAppStore((s) => s.signals);
  const lookupCache = useAppStore((s) => s.lookupCache);
  const alerts = useAppStore((s) => s.watchlistAlerts);
  const watchlistSyncStatus = useAppStore((s) => s.watchlistSyncStatus);
  const researchStatus = useAppStore((s) => s.researchStatus);
  const lookupTicker = useAppStore((s) => s.lookupTicker);
  const toggleWatchlist = useAppStore((s) => s.toggleWatchlist);
  const isWatchlisted = useAppStore((s) => s.isWatchlisted);
  const removeFromWatchlist = useAppStore((s) => s.removeFromWatchlist);
  const setWatchlistAlert = useAppStore((s) => s.setWatchlistAlert);
  const clearWatchlistAlert = useAppStore((s) => s.clearWatchlistAlert);
  const runResearchNow = useAppStore((s) => s.runResearchNow);
  const pushToast = useAppStore((s) => s.pushToast);

  const [sortMode, setSortMode] = useState<SortMode>("score");
  const [groupMode, setGroupMode] = useState<GroupMode>("none");
  const [heatFilter, setHeatFilter] = useState<HypeTier | "all">("all");
  const [sectorFilter, setSectorFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const watchlistSyncLoading = watchlistSyncStatus === "loading";

  const resolver = useMemo(() => {
    const map = new Map<string, StockSignal>();
    for (const s of signals) map.set(s.ticker, s);
    for (const s of Object.values(lookupCache)) if (!map.has(s.ticker)) map.set(s.ticker, s);
    return map;
  }, [signals, lookupCache]);

  const watched = useMemo(
    () => watchlist.map((t) => resolver.get(t)).filter((s): s is StockSignal => Boolean(s)),
    [watchlist, resolver],
  );
  const unresolved = useMemo(
    () => watchlist.filter((t) => !resolver.has(t)),
    [watchlist, resolver],
  );

  // Self-heal watched names that aren't in the current scored run and were never
  // cached (e.g. saved from a card before the toggleWatchlist cache-fix, or after
  // the universe rotated). Resolving each once writes it into lookupCache, so it
  // renders instead of silently hiding under the "not in the current run" footnote.
  // Attempt each ticker at most once per mount to avoid a resolve loop.
  const resolveAttempted = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of unresolved) {
      if (resolveAttempted.current.has(t)) continue;
      resolveAttempted.current.add(t);
      void lookupTicker(t).catch(() => {
        /* lookupTicker surfaces its own resolve-error toast; nothing to do here */
      });
    }
  }, [unresolved, lookupTicker]);

  const sectorsPresent = useMemo(
    () => Array.from(new Set(watched.map((s) => s.sector))).sort(),
    [watched],
  );

  // Desk aggregates must only count names with real, live market data - a
  // directory-confirmed listing carries no honest opportunity score or hype tier,
  // so folding it in would average a fabricated number into the summary console.
  const scored = useMemo(() => watched.filter((s) => !isMarketDataUnavailable(s)), [watched]);
  const avgScore = scored.length
    ? Math.round(scored.reduce((a, s) => a + s.score.opportunityScore, 0) / scored.length)
    : 0;
  const onFire = scored.filter((s) => s.hype.tier === "On fire").length;
  const triggeredAlerts = watched.filter((s) => alertTriggered(alerts[s.ticker], s.price)).length;
  const alertsSet = Object.keys(alerts).filter((t) => watchlist.includes(t)).length;

  const movers = useMemo(
    () =>
      watched
        .filter((s) => Math.abs(s.dayChange ?? 0) >= MOVER_THRESHOLD)
        .sort((a, b) => Math.abs(b.dayChange ?? 0) - Math.abs(a.dayChange ?? 0))
        .slice(0, 6),
    [watched],
  );
  const catalystSoon = useMemo(
    () =>
      watched
        .filter((s) => s.catalyst && s.catalyst.daysAway <= CATALYST_WINDOW_DAYS && s.catalyst.daysAway >= -2)
        .sort((a, b) => (a.catalyst?.daysAway ?? 0) - (b.catalyst?.daysAway ?? 0))
        .slice(0, 6),
    [watched],
  );

  const filtered = useMemo(
    () =>
      watched.filter(
        (s) =>
          (heatFilter === "all" || s.hype.tier === heatFilter) &&
          (sectorFilter === "all" || s.sector === sectorFilter),
      ),
    [watched, heatFilter, sectorFilter],
  );

  const groups = useMemo(() => {
    if (groupMode === "none") {
      return [{ key: "all", label: "", items: sortSignals(filtered, sortMode) }];
    }
    const buckets = new Map<string, StockSignal[]>();
    for (const s of filtered) {
      const key = groupMode === "sector" ? s.sector : s.hype.tier;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(s);
    }
    const order =
      groupMode === "heat"
        ? HEAT_TIERS.filter((t) => buckets.has(t))
        : Array.from(buckets.keys()).sort();
    return order.map((key) => ({
      key,
      label: key,
      items: sortSignals(buckets.get(key) ?? [], sortMode),
    }));
  }, [filtered, groupMode, sortMode]);

  const addTicker = async (raw: string) => {
    const q = raw.trim();
    if (!q || adding) return;
    setAdding(true);
    try {
      // Resolve names/tickers against the offline directory before lookup so
      // the right security lands on the radar even with no live key.
      const rec = resolveSymbol(q);
      const sig = await lookupTicker(rec ? rec.symbol : q);
      if (isWatchlisted(sig.ticker)) {
        pushToast(`${sig.ticker} is already on your watchlist`, "info");
      } else {
        toggleWatchlist(sig);
      }
      setQuery("");
      setExpanded(sig.ticker);
    } catch {
      // lookupTicker surfaces its own resolve-error toast.
    } finally {
      setAdding(false);
    }
  };

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    void addTicker(query);
  };

  // Loading / error gates - the watchlist reads the global research universe.
  if (signals.length === 0) {
    if (researchStatus === "error") {
      return (
        <div className="wl-page">
          <header className="wl-hero">
            <div>
              <span className="wl-hero__eyebrow">Radar</span>
              <h1>Watchlist</h1>
            </div>
          </header>
          <div className="empty wl-state wl-state--error" role="alert">
            <h3>Research couldn&rsquo;t load</h3>
            <p>Your watched names re-score on every research run. The last run didn&rsquo;t complete.</p>
            <button type="button" className="btn btn--primary" onClick={() => void runResearchNow("manual")}>
              Retry research
            </button>
          </div>
        </div>
      );
    }
    if (feedIsPreparing(researchStatus)) {
      return (
        <div className="wl-page">
          <header className="wl-hero">
            <div>
              <span className="wl-hero__eyebrow">Radar</span>
              <h1>Watchlist</h1>
            </div>
          </header>
          <WatchlistSkeleton />
        </div>
      );
    }
    return (
      <div className="wl-page">
        <header className="wl-hero">
          <div>
            <span className="wl-hero__eyebrow">Radar</span>
            <h1>Watchlist</h1>
          </div>
        </header>
        {watchlist.length === 0 ? (
          watchlistSyncLoading ? (
            <WatchlistSkeleton />
          ) : (
            <div className="empty wl-state">
              <span className="wl-state__spark" aria-hidden>
                <IconPulse size={26} />
              </span>
              <h3>Your watchlist is empty</h3>
              <p>Add tickers above to start tracking companies across every research run.</p>
              <div className="wl-state__cta">
                <Link className="btn btn--primary" to="/today">
                  Browse Today
                </Link>
              </div>
            </div>
          )
        ) : (
          <FeedAwaitingRun onRun={() => void runResearchNow("manual")} />
        )}
      </div>
    );
  }

  const hasFiltered = filtered.length > 0;

  return (
    <div className="wl-page">
      <header className="wl-hero">
        <div className="wl-hero__lede">
          <span className="wl-hero__eyebrow">Radar</span>
          <h1>Watchlist</h1>
          <p>
            Names you&rsquo;re tracking, re-scored on every research run. Open any row for a Ticker Scope
            mini-rundown, or jump to the full scope.
          </p>
          {watched.length > 0 && <LivePriceControl tickers={watched.map((s) => s.ticker)} />}
        </div>
        <form className="wl-lookup-ac" onSubmit={onAdd} role="search">
          <SymbolAutocomplete
            value={query}
            onChange={setQuery}
            onPick={(rec) => void addTicker(rec.symbol)}
            placeholder="Add a ticker or company — e.g. NVDA, Palantir"
            ariaLabel="Look up and add a ticker to your watchlist"
            variant="pill"
            size="sm"
            leading={<IconSearch size={17} />}
            trailing={
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={adding || !query.trim()}
              >
                {adding ? <span className="spinner" /> : <IconPlus size={15} />}
                Add
              </button>
            }
          />
        </form>
      </header>

      {/* Desk summary console */}
      <section className="wl-desk" aria-label="Watchlist summary">
        <div className="wl-desk__metric">
          <span className="wl-desk__label">Watching</span>
          <span className="wl-desk__value mono">
            <NumberFlow value={watched.length} aria-label={`${watched.length}`} />
          </span>
        </div>
        <div className="wl-desk__metric">
          <span className="wl-desk__label">Avg opportunity</span>
          <span className="wl-desk__value mono">
            <NumberFlow value={avgScore} aria-label={`${avgScore}`} />
            <span className="wl-desk__denominator mono">/100</span>
          </span>
        </div>
        <div className="wl-desk__metric">
          <span className="wl-desk__label">On fire</span>
          <span className="wl-desk__value mono">
            <NumberFlow value={onFire} aria-label={`${onFire}`} />
          </span>
        </div>
        <div className="wl-desk__metric">
          <span className="wl-desk__label">
            <IconBell size={12} /> Alerts {triggeredAlerts > 0 ? "live" : "set"}
          </span>
          <span className={`wl-desk__value mono ${triggeredAlerts > 0 ? "pl-pos" : ""}`}>
            <NumberFlow value={triggeredAlerts > 0 ? triggeredAlerts : alertsSet} aria-label={`${alertsSet}`} />
          </span>
        </div>
      </section>

      {watched.length === 0 ? (
        watchlist.length === 0 && watchlistSyncLoading ? (
          <WatchlistSkeleton />
        ) : (
          <div className="empty wl-state">
            <span className="wl-state__spark" aria-hidden>
              <IconPulse size={26} />
            </span>
            <h3>Nothing on your radar yet</h3>
            <p>
              Add a ticker above, or tap Watch on any feed card. Watched names are re-scored every
              research run and surface here with a one-click Ticker Scope rundown.
            </p>
            <div className="wl-state__cta">
              <Link className="btn btn--primary" to="/today">
                Browse Today
              </Link>
              <Link className="btn btn--ghost" to={SYSTEM_NAV.beacon.path}>
                {SYSTEM_NAV.beacon.label}
                <IconExternal size={14} />
              </Link>
            </div>
          </div>
        )
      ) : (
        <>
          {(movers.length > 0 || catalystSoon.length > 0) && (
            <section className="wl-pulse" aria-label="Movers and upcoming catalysts">
              {movers.length > 0 && (
                <div className="wl-pulse__group">
                  <span className="wl-pulse__title">
                    <IconPulse size={13} /> Moved today
                  </span>
                  <div className="wl-pulse__chips">
                    {movers.map((s) => (
                      <button
                        key={s.ticker}
                        type="button"
                        className="wl-pulse__chip"
                        onClick={() => setExpanded(s.ticker)}
                      >
                        <span className="mono">{s.ticker}</span>
                        <span className={`mono ${(s.dayChange ?? 0) > 0 ? "pl-pos" : "pl-neg"}`}>
                          {formatPct(s.dayChange ?? 0)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {catalystSoon.length > 0 && (
                <div className="wl-pulse__group">
                  <span className="wl-pulse__title">
                    <IconTarget size={13} /> Near catalyst
                  </span>
                  <div className="wl-pulse__chips">
                    {catalystSoon.map((s) => (
                      <button
                        key={s.ticker}
                        type="button"
                        className="wl-pulse__chip"
                        onClick={() => setExpanded(s.ticker)}
                      >
                        <span className="mono">{s.ticker}</span>
                        <span className="text-faint">
                          {s.catalyst!.type}
                          {s.catalyst!.daysAway >= 0 ? ` ${s.catalyst!.daysAway}d` : " now"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          <div className="wl-controls">
            <div className="wl-controls__filters" role="group" aria-label="Filter by heat">
              <button
                type="button"
                className={`wl-heat${heatFilter === "all" ? " is-active" : ""}`}
                aria-pressed={heatFilter === "all"}
                onClick={() => setHeatFilter("all")}
              >
                All
              </button>
              {HEAT_TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  className={`wl-heat wl-heat--${hypeTierKey(tier)}${heatFilter === tier ? " is-active" : ""}`}
                  aria-pressed={heatFilter === tier}
                  onClick={() => setHeatFilter((cur) => (cur === tier ? "all" : tier))}
                >
                  {tier}
                </button>
              ))}
            </div>
            <div className="wl-controls__selects">
              {sectorsPresent.length > 1 && (
                <label className="wl-select">
                  <span className="sr-only">Filter by sector</span>
                  <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}>
                    <option value="all">All sectors</option>
                    {sectorsPresent.map((sec) => (
                      <option key={sec} value={sec}>
                        {sec}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="wl-select">
                <span className="sr-only">Group by</span>
                <IconLayers size={14} />
                <select value={groupMode} onChange={(e) => setGroupMode(e.target.value as GroupMode)}>
                  {GROUP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wl-select">
                <span className="sr-only">Sort by</span>
                <select value={sortMode} onChange={(e) => setSortMode(e.target.value as SortMode)}>
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {hasFiltered ? (
            groups.map((group) => (
              <section key={group.key} className="wl-group">
                {group.label && (
                  <div className="wl-group__head">
                    <span className="wl-group__label">{group.label}</span>
                    <span className="wl-group__count mono">{group.items.length}</span>
                  </div>
                )}
                <ul className="wl-list">
                  {group.items.map((signal, i) => (
                    <WatchlistRow
                      key={signal.ticker}
                      signal={signal}
                      alert={alerts[signal.ticker]}
                      expanded={expanded === signal.ticker}
                      index={i}
                      onToggle={() =>
                        setExpanded((cur) => (cur === signal.ticker ? null : signal.ticker))
                      }
                      onRemove={() => removeFromWatchlist(signal.ticker)}
                      onSetAlert={(price, direction) =>
                        setWatchlistAlert(signal.ticker, { price, direction })
                      }
                      onClearAlert={() => clearWatchlistAlert(signal.ticker)}
                    />
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <div className="empty wl-state wl-state--filter">
              <h3>No matches</h3>
              <p>No watched names match this filter. Clear it to see your full radar.</p>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setHeatFilter("all");
                  setSectorFilter("all");
                }}
              >
                Clear filters
              </button>
            </div>
          )}

          {unresolved.length > 0 && (
            <p className="wl-unresolved text-faint">
              {unresolved.length} watched {unresolved.length === 1 ? "ticker isn't" : "tickers aren't"} in the
              current research run.{" "}
              <Link to={SYSTEM_NAV.beacon.path} className="linkish">
                Resolve in {SYSTEM_NAV.beacon.label}
              </Link>
              .
            </p>
          )}
        </>
      )}

      <InvestingDisclaimer className="page-disclaimer" />
    </div>
  );
}
