import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TerminalPanel } from "./TerminalPanel";
import { FeedState } from "@/components/common/FeedState";
import { Skeleton } from "@/components/common/Skeleton";
import { useAppStore } from "@/store/useAppStore";
import { useSampleDataMode } from "@/hooks/useSampleDataMode";
import { isFinnhubQueryable, isFmpQueryable } from "@/data/http";
import {
  fetchEarningsCalendarMap,
  fetchFinnhubNextEarnings,
  isEarningsCalendarConfigured,
} from "@/data/earnings/earningsCalendar";
import {
  rankUpcoming,
  type EarningsCandidate,
  type UpcomingEarnings,
} from "@/data/earnings/upcomingEarnings";

const WINDOW_DAYS = 45;
const MAX_ROWS = 12;
/** Cap the per-ticker Finnhub fallback so it can't blow the daily budget. */
const FINNHUB_FALLBACK_CAP = 12;

function epsText(eps: number | null): string {
  if (eps == null) return "—";
  return `${eps < 0 ? "-" : ""}$${Math.abs(eps).toFixed(2)}`;
}

/** Local-calendar YYYY-MM-DD, so "today" matches the user's clock (and the
 *  local-time row labels) rather than the UTC day. */
function localISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "Today" / "Tom" / "3d" / "12d" countdown label. */
function countdownText(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Tom";
  return `${days}d`;
}

function monthDay(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function Row({ e }: { e: UpcomingEarnings }) {
  const soon = e.daysUntil <= 2;
  return (
    <Link
      to={`/signal/${encodeURIComponent(e.ticker)}`}
      className="data-row tw-earn-row"
      title={`${e.name} — reports ${monthDay(e.dateISO)}${e.epsEstimate != null ? ` · est. EPS ${epsText(e.epsEstimate)}` : ""}`}
    >
      <span className="data-cell mono tw-earn-row__ticker">{e.ticker}</span>
      <span className="data-cell text-muted">{e.name}</span>
      <span className="data-cell--num text-faint">{epsText(e.epsEstimate)}</span>
      <span className={`data-cell--num tw-earn-row__when${soon ? " tw-earn-row__when--soon" : ""}`}>
        {monthDay(e.dateISO)} · {countdownText(e.daysUntil)}
      </span>
    </Link>
  );
}

/**
 * Upcoming earnings among the names the user researches (scored universe ∪
 * watchlist) over the next ~45 days. One whole-market FMP call, intersected
 * locally; Finnhub per-ticker is the FMP-absent fallback. Each row opens the
 * security workspace. Degrades to loading / empty / error / unconfigured.
 */
export function EarningsCalendarPane({ id }: { id?: string }) {
  const watchlist = useAppStore((s) => s.watchlist);
  const signals = useAppStore((s) => s.signals);
  const resolveSignal = useAppStore((s) => s.resolveSignal);

  const [rows, setRows] = useState<UpcomingEarnings[]>([]);
  const [status, setStatus] = useState<"loading" | "done" | "error" | "unconfigured">("loading");
  // See MoversPane: the data layer fails closed to sample-mode until the
  // operator's global controls load, so this must re-run on that flip or a cold
  // load permanently renders the unconfigured state.
  const sampleMode = useSampleDataMode();

  useEffect(() => {
    let cancelled = false;

    if (!isEarningsCalendarConfigured()) {
      setStatus("unconfigured");
      return;
    }
    setStatus("loading");

    // Universe of names worth surfacing: the scored signals plus the watchlist.
    const universe = new Map<string, string>();
    for (const s of signals) universe.set(s.ticker, s.name);
    for (const t of watchlist) if (!universe.has(t)) universe.set(t, resolveSignal(t)?.name ?? t);

    const now = new Date();
    const todayISO = localISODate(now);
    const toISO = localISODate(new Date(now.getTime() + WINDOW_DAYS * 86_400_000));

    void (async () => {
      // The two transports are COMPLEMENTARY, not primary-and-backup, so both
      // run and the results merge:
      //
      //  • FMP `/stable/earnings-calendar` is one cheap whole-market call, but on
      //    a free plan it answers with a ~16-name mega-cap sample rather than the
      //    full market - great for COST/ADBE/FDX, blind to everything else.
      //  • Finnhub `/calendar/earnings` is per-ticker (so budget-capped) but
      //    covers whatever the user actually researches.
      //
      // Running FMP alone is what made this pane read "No reports scheduled"
      // even when the user's own watchlist had a report next week. Ticker is the
      // merge key; the FMP row wins a tie because it carries the vendor's
      // consensus EPS.
      const viaFmp = async (): Promise<EarningsCandidate[]> => {
        if (!isFmpQueryable()) return [];
        const map = await fetchEarningsCalendarMap(todayISO, toISO);
        const found: EarningsCandidate[] = [];
        for (const [ticker, name] of universe) {
          const event = map.get(ticker);
          if (event) found.push({ ticker, name, event });
        }
        return found;
      };

      // Watchlist first, then scored signals, so a capped fan-out always spends
      // its budget on the names the user explicitly tracks.
      const viaFinnhub = async (): Promise<EarningsCandidate[]> => {
        if (!isFinnhubQueryable()) return [];
        const ordered = [
          ...watchlist.filter((t) => universe.has(t)),
          ...[...universe.keys()].filter((t) => !watchlist.includes(t)),
        ];
        const targets = ordered.slice(0, FINNHUB_FALLBACK_CAP);
        const events = await Promise.all(
          targets.map(async (t) => {
            const event = await fetchFinnhubNextEarnings(t, todayISO, toISO);
            return event
              ? ({ ticker: t, name: universe.get(t) ?? t, event } as EarningsCandidate)
              : null;
          }),
        );
        return events.filter((e): e is EarningsCandidate => e !== null);
      };

      try {
        // `Promise.all` is safe: both helpers swallow their own vendor errors and
        // resolve to [], so one dead vendor can never blank the other's rows.
        const [fmpRows, finnhubRows] = await Promise.all([viaFmp(), viaFinnhub()]);
        const byTicker = new Map<string, EarningsCandidate>();
        for (const c of finnhubRows) byTicker.set(c.ticker, c);
        for (const c of fmpRows) byTicker.set(c.ticker, c); // FMP wins: carries consensus EPS
        const built = rankUpcoming([...byTicker.values()], todayISO, MAX_ROWS);
        if (!cancelled) {
          setRows(built);
          setStatus("done");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [watchlist, signals, resolveSignal, sampleMode]);

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
    body = <FeedState variant="error" title="Couldn’t load the calendar" />;
  } else if (status === "unconfigured") {
    body = (
      <FeedState title="Earnings need a data key">
        Add <span className="mono">VITE_FMP_API_KEY</span> (whole-market) or{" "}
        <span className="mono">VITE_FINNHUB_API_KEY</span> to surface upcoming reports.
      </FeedState>
    );
  } else if (rows.length === 0) {
    body = (
      <FeedState title="No reports scheduled">
        Nothing on the calendar for your universe or watchlist in the next {WINDOW_DAYS} days.
      </FeedState>
    );
  } else {
    body = (
      <div className="data-list">
        {rows.map((e) => (
          <Row key={e.ticker} e={e} />
        ))}
      </div>
    );
  }

  return (
    <TerminalPanel id={id} title="Earnings" hint={`next ${WINDOW_DAYS}d`}>
      {body}
    </TerminalPanel>
  );
}
