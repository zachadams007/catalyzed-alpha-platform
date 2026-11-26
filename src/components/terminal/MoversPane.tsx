import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TerminalPanel } from "./TerminalPanel";
import { FeedState } from "@/components/common/FeedState";
import { Skeleton } from "@/components/common/Skeleton";
import { IconRefresh } from "@/components/icons";
import { fetchMovers, type Mover, type MoverKind, type MoversResult } from "@/data/movers/fetchMovers";
import { formatPct, formatPrice } from "@/lib/format";
import { useSampleDataMode } from "@/hooks/useSampleDataMode";

const TABS: { id: MoverKind; label: string }[] = [
  { id: "actives", label: "Active" },
  { id: "gainers", label: "Gainers" },
  { id: "losers", label: "Losers" },
];

function MoverRow({ m }: { m: Mover }) {
  const up = m.changePct >= 0;
  return (
    <Link to={`/signal/${encodeURIComponent(m.ticker)}`} className="data-row tw-mover-row" title={m.name}>
      <span className="data-cell mono tw-mover-row__ticker">{m.ticker}</span>
      <span className="data-cell text-muted">{m.name}</span>
      <span className="data-cell--num">{formatPrice(m.price)}</span>
      <span className={`data-cell--num ${up ? "text-bull" : "text-bear"}`}>{formatPct(m.changePct)}</span>
    </Link>
  );
}

/** Day movers (most-active / gainers / losers) - each row opens the workspace. */
export function MoversPane({ id }: { id?: string }) {
  const [data, setData] = useState<MoversResult | null>(null);
  const [status, setStatus] = useState<"loading" | "done" | "error">("loading");
  const [tab, setTab] = useState<MoverKind>("actives");
  // The data layer FAILS CLOSED to sample-mode while the operator's global
  // controls are still loading, so a pane that mounts in that window gets a
  // truthful-at-the-time "unconfigured" and - with an empty dep array - kept
  // showing "Movers need an FMP key" forever, even once the controls landed and
  // live data was available. Re-running on the sample-mode flip fixes that.
  const sampleMode = useSampleDataMode();

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetchMovers(8)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setStatus("done");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sampleMode]);

  const rows = data ? data[tab] : [];

  const tabs = (
    <span className="tw-tabs" role="tablist" aria-label="Mover lane">
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={tab === t.id}
          className={`tw-tab${tab === t.id ? " tw-tab--on" : ""}`}
          onClick={() => setTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </span>
  );

  let body;
  if (status === "loading") {
    body = (
      <div className="col gap-2" aria-busy="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} height={20} radius={6} />
        ))}
      </div>
    );
  } else if (status === "error") {
    body = <FeedState variant="error" title="Couldn’t load movers" />;
  } else if (data?.unconfigured) {
    body = (
      <FeedState title="Movers need an FMP key">
        Add <span className="mono">VITE_FMP_API_KEY</span> to pull most-active, gainers, and losers.
      </FeedState>
    );
  } else if (rows.length === 0) {
    body = <FeedState title="No movers right now">The {tab} lane came back empty — try again shortly.</FeedState>;
  } else {
    body = (
      <div className="data-list">
        {rows.map((m) => (
          <MoverRow key={m.ticker} m={m} />
        ))}
      </div>
    );
  }

  return (
    <TerminalPanel id={id} title="Movers" hint="FMP · day" headerRight={tabs}>
      {body}
    </TerminalPanel>
  );
}
