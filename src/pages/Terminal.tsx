import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { PageHeader } from "@/components/common/PageHeader";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { ExternalLink } from "@/components/common/ExternalLink";
import { WatchlistMonitor } from "@/components/terminal/WatchlistMonitor";
import { MoversPane } from "@/components/terminal/MoversPane";
import { EarningsCalendarPane } from "@/components/terminal/EarningsCalendarPane";
import { TerminalErrorBoundary } from "@/components/terminal/TerminalErrorBoundary";
import { IconExternal, IconPulse } from "@/components/icons";
import { relativeTime, formatCurrency } from "@/lib/format";
import { loadTerminalFeed } from "@/data/terminal/terminalFeed";
import { sortTerminalEvents } from "@/data/terminal/relevance";
import { countNewSince, isNewSince } from "@/data/terminal/newSince";
import { useAppStore } from "@/store/useAppStore";
import { useSampleDataMode } from "@/hooks/useSampleDataMode";
import type {
  TerminalEvent,
  TerminalFeedResult,
  TerminalFilter,
} from "@/types/terminal";

const SEV_CLASS: Record<string, string> = {
  high: "alert-card--high",
  elevated: "alert-card--elevated",
  watch: "alert-card--watch",
};

const KIND_LABEL: Record<TerminalEvent["kind"], string> = {
  catalyst_news: "News",
  insider_buy: "Insider buy",
  insider_sell: "Insider sell",
  filing_8k: "8-K · material event",
  politician_trade: "Congress",
  gov_contract: "Gov contract",
};

const FILTERS: { id: TerminalFilter; label: string; hint?: string }[] = [
  { id: "all", label: "All" },
  { id: "catalyst_news", label: "Catalyst news", hint: "A catalyst is an event that can move a stock — earnings, FDA news, a contract, a deal." },
  { id: "filing_8k", label: "8-K filings", hint: "8-K = an SEC filing companies must make when something material happens." },
  { id: "insider_buy", label: "Insider buys", hint: "A company executive or director buying their own company's stock on the open market." },
  { id: "insider_sell", label: "Insider sells", hint: "A company executive or director selling their own company's stock." },
  { id: "politician_trade", label: "Congress", hint: "Stock trades disclosed by members of the U.S. House and Senate." },
];

function eventMatchesFilter(e: TerminalEvent, f: TerminalFilter): boolean {
  return f === "all" || e.kind === f;
}

/** Honest, lane-specific empty copy so a quiet lane never reads as broken. */
const FILTER_EMPTY: Record<TerminalFilter, { title: string; body: string }> = {
  all: {
    title: "The wire is quiet",
    body: "No catalysts surfaced for this window. The SEC 8-K and insider feeds update through the day — refresh to scan again.",
  },
  catalyst_news: {
    title: "No breaking catalysts",
    body: "No market-moving headlines on the wire right now. Switch to All or refresh to scan again.",
  },
  filing_8k: {
    title: "No recent 8-K filings",
    body: "No material-event (8-K) filings surfaced for this window. They appear here the moment companies file them with the SEC.",
  },
  insider_buy: {
    title: "No recent insider buys",
    body: "No open-market insider purchases (SEC Form 4, code P) disclosed in this window. Buys appear here as soon as they're filed.",
  },
  insider_sell: {
    title: "No recent insider sells",
    body: "No open-market insider sales disclosed in this window. They appear here as Form 4s are filed.",
  },
  politician_trade: {
    title: "No congressional trades",
    body: "No House or Senate disclosures surfaced for this window. New periodic transaction reports appear here as they're published.",
  },
  gov_contract: {
    title: "No government contracts",
    body: "No contract awards surfaced for this window.",
  },
};

function TradeLine({ event }: { event: TerminalEvent }) {
  const { trade, actor } = event;
  if (!trade) return null;
  return (
    <p className="alert-card__summary">
      {actor?.name}
      {actor?.role ? ` · ${actor.role}` : ""}
      {trade.valueUsd ? (
        <>
          {" — "}
          <span className="mono">{formatCurrency(trade.valueUsd)}</span>
        </>
      ) : null}
      {trade.pricePerShare ? (
        <span className="text-faint mono"> @ ${trade.pricePerShare.toFixed(2)}</span>
      ) : null}
    </p>
  );
}

function TerminalInner() {
  const [data, setData] = useState<TerminalFeedResult | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("loading");
  const [filter, setFilter] = useState<TerminalFilter>("all");
  // "relevance" floats the IMPORTANT items (major stocks / policy / big insider &
  // politician trades) to the top even if a day old - so a market-mover (e.g. the
  // president naming a stock) isn't buried behind minutes-old minor PR. "latest" is
  // the pure-chronological wire. Default to relevance: catalyst-hunting is the point.
  const [sort, setSort] = useState<"relevance" | "latest">("relevance");

  const density = useAppStore((s) => s.terminalDensity);
  const setTerminalDensity = useAppStore((s) => s.setTerminalDensity);
  const markTerminalVisited = useAppStore((s) => s.markTerminalVisited);

  // Freeze the "previous visit" threshold once on mount, then stamp this visit.
  // Everything that surfaced after `sinceTs` gets a NEW marker for this view.
  const [sinceTs, setSinceTs] = useState<string | null>(null);
  const visited = useRef(false);
  useEffect(() => {
    if (visited.current) return;
    visited.current = true;
    setSinceTs(markTerminalVisited());
  }, [markTerminalVisited]);

  const refresh = useCallback(async () => {
    setStatus("loading");
    try {
      const result = await loadTerminalFeed();
      setData(result);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }, []);

  // The whole data layer fails closed to sample-mode until the operator's global
  // controls load, so a first paint can legitimately come back "live data
  // blocked". Re-run when that flips, otherwise the wire stays empty with a
  // stale sample-mode explanation for the rest of the session.
  const sampleMode = useSampleDataMode();
  useEffect(() => {
    void refresh();
  }, [refresh, sampleMode]);

  const visible = useMemo(
    () =>
      sortTerminalEvents(
        (data?.events ?? []).filter((e) => eventMatchesFilter(e, filter)),
        sort,
        Date.now(),
      ),
    [data, filter, sort],
  );

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: data?.events.length ?? 0 };
    for (const e of data?.events ?? []) map[e.kind] = (map[e.kind] ?? 0) + 1;
    return map;
  }, [data]);

  // Count of fresh events across the WHOLE feed (not just the active filter), so
  // the badge reflects everything new since you last looked.
  const newCount = useMemo(
    () => countNewSince(data?.events ?? [], sinceTs),
    [data, sinceTs],
  );

  const loading = status === "loading";

  return (
    <>
      <PageHeader
        title="Terminal"
        description="Live market-intelligence wire — breaking catalysts, insider buying, and political trades the moment they surface. Real data from sanctioned sources; research & discovery only."
        action={
          <button className="btn btn--primary" onClick={() => void refresh()} disabled={loading}>
            {loading ? <span className="spinner" /> : <IconPulse size={16} />}
            {loading ? "Scanning…" : "Refresh"}
          </button>
        }
      />

      {/* Monitors - watchlist + day movers + upcoming earnings, each row opens
          the security workspace. Sits above the wire so the home reads like a
          terminal. */}
      <div className="tw-monitors tw-monitors--3">
        <WatchlistMonitor id="tw-watchlist" />
        <MoversPane id="tw-movers" />
        <EarningsCalendarPane id="tw-earnings" />
      </div>

      {/* Sticky control deck: source-status strip + filter chips + density.
          Pins while the wire scrolls so context never leaves the viewport. */}
      <div className="tw-wire-controls">
        {data && (
          <div className="tw-source-strip" role="status" aria-label="Source status">
            {data.sources.map((s) => (
              <span
                key={s.id}
                className={`pill ${s.ok ? "pill--severity-watch" : ""}`}
                title={s.note ?? `${s.count} item${s.count === 1 ? "" : "s"}`}
                style={{ opacity: s.ok ? 1 : 0.5 }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "var(--r-pill)",
                    marginRight: "var(--sp-2)",
                    background: s.ok ? "var(--bull)" : "var(--faint)",
                  }}
                />
                {s.name}
                {s.ok ? ` · ${s.count}` : s.note ? ` · ${s.note}` : ""}
              </span>
            ))}
          </div>
        )}

        <div className="tw-wire-controls__row">
          <div className="row gap-2 wrap">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`btn ${filter === f.id ? "btn--primary" : "btn--ghost"}`}
                onClick={() => setFilter(f.id)}
                title={f.hint}
              >
                {f.label}
                {counts[f.id] != null && counts[f.id] > 0 ? (
                  <span className="mono text-faint" style={{ marginLeft: "var(--sp-2)" }}>
                    {counts[f.id]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="tw-wire-controls__right">
            {newCount > 0 ? (
              <span className="pill pill--new" title="Surfaced since your last visit">
                {newCount} new
              </span>
            ) : null}
            <span className="tw-tabs" role="group" aria-label="Sort order">
              <button
                type="button"
                className={`tw-tab${sort === "relevance" ? " tw-tab--on" : ""}`}
                aria-pressed={sort === "relevance"}
                title="Float the most important items up — major stocks, policy, big insider/politician trades — even if a day old"
                onClick={() => setSort("relevance")}
              >
                Relevance
              </button>
              <button
                type="button"
                className={`tw-tab${sort === "latest" ? " tw-tab--on" : ""}`}
                aria-pressed={sort === "latest"}
                title="Pure chronological wire — newest first"
                onClick={() => setSort("latest")}
              >
                Latest
              </button>
            </span>
            <span className="tw-tabs" role="group" aria-label="Row density">
              <button
                type="button"
                className={`tw-tab${density === "comfortable" ? " tw-tab--on" : ""}`}
                aria-pressed={density === "comfortable"}
                onClick={() => setTerminalDensity("comfortable")}
              >
                Comfortable
              </button>
              <button
                type="button"
                className={`tw-tab${density === "compact" ? " tw-tab--on" : ""}`}
                aria-pressed={density === "compact"}
                onClick={() => setTerminalDensity("compact")}
              >
                Compact
              </button>
            </span>
          </div>
        </div>
      </div>

      {/* States */}
      {loading && !data ? (
        <div className="alert-list">
          {[0, 1, 2].map((i) => (
            <motion.div
              key={i}
              className="alert-card"
              animate={{ opacity: [0.4, 0.7, 0.4] }}
              transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.15 }}
              style={{ height: "96px" }}
            />
          ))}
        </div>
      ) : status === "error" ? (
        <div className="empty">
          <h3>Couldn’t reach the wire</h3>
          <p>The scan was interrupted. Refresh to try again.</p>
          <button className="btn btn--primary" onClick={() => void refresh()} style={{ marginTop: "var(--sp-3)" }}>
            Retry
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <h3>{FILTER_EMPTY[filter].title}</h3>
          <p>{FILTER_EMPTY[filter].body}</p>
          <button
            className="btn btn--ghost"
            onClick={() => void refresh()}
            style={{ marginTop: "var(--sp-3)" }}
          >
            <IconPulse size={14} />
            Refresh
          </button>
        </div>
      ) : (
        <div className={`alert-list${density === "compact" ? " alert-list--compact" : ""}`}>
          {visible.map((e, i) => {
            const fresh = isNewSince(e.surfacedAt, sinceTs);
            return (
              <motion.article
                key={e.id}
                className={`alert-card ${SEV_CLASS[e.severity] ?? ""}${fresh ? " alert-card--new" : ""}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, delay: Math.min(i * 0.03, 0.3) }}
              >
                <div className="alert-card__head">
                  {fresh ? (
                    <span className="pill pill--new" title="Surfaced since your last visit">
                      New
                    </span>
                  ) : null}
                  <span className={`pill pill--severity-${e.severity}`}>{e.severity}</span>
                  <span className="pill" style={{ opacity: 0.8 }}>
                    {KIND_LABEL[e.kind] ?? "Filing"}
                  </span>
                  <span className="text-faint" style={{ fontSize: "var(--type-sm)", marginLeft: "auto" }}>
                    {relativeTime(e.surfacedAt)}
                  </span>
                </div>

                <h3 className="alert-card__title">{e.headline}</h3>
                {e.trade ? <TradeLine event={e} /> : null}
                {e.summary ? <p className="alert-card__summary alert-card__blurb">{e.summary}</p> : null}

                <div className="alert-card__meta">
                  {e.ticker ? (
                    <Link to={`/terminal/${e.ticker}`} className="ticker" style={{ fontSize: "15px" }}>
                      {e.ticker}
                    </Link>
                  ) : (
                    <span className="text-faint">Market</span>
                  )}
                  {e.relatedTickers && e.relatedTickers.length > 0 ? (
                    <span className="text-faint mono">+{e.relatedTickers.join(" ")}</span>
                  ) : null}
                  {e.reason ? (
                    <>
                      <span className="text-muted">·</span>
                      <span className="text-faint">{e.reason}</span>
                    </>
                  ) : null}
                </div>

                <div className="row gap-2 alert-card__actions" style={{ marginTop: "var(--sp-2)" }}>
                  {e.source?.url ? (
                    <ExternalLink className="btn btn--ghost" href={e.source.url}>
                      <IconExternal size={14} />
                      {e.source.name ?? "Source"}
                    </ExternalLink>
                  ) : null}
                  {e.ticker ? (
                    <Link className="btn btn--ghost" to={`/terminal/${e.ticker}`}>
                      Open workspace
                    </Link>
                  ) : null}
                </div>
              </motion.article>
            );
          })}
        </div>
      )}

      <InvestingDisclaimer className="page-disclaimer" />
    </>
  );
}

/**
 * Public route component. The error boundary wraps the whole page so a data
 * hiccup in any monitor or wire item degrades to a retry card instead of
 * white-screening the entire app.
 */
export function Terminal() {
  return (
    <TerminalErrorBoundary label="Terminal wire">
      <TerminalInner />
    </TerminalErrorBoundary>
  );
}
