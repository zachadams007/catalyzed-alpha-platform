import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useGroupsStore } from "@/store/useGroupsStore";
import { relativeTime } from "@/lib/format";
import { rankCalls, type CallPerformance } from "@/data/groups/leaderboard";
import type { CallDirection } from "@/data/groups/types";
import { IconTrash } from "@/components/icons";
import { IconMegaphone } from "./icons";
import { GroupAvatar, Money, ReturnValue, SymbolHint } from "./shared";

function StatusPill({ perf }: { perf: CallPerformance }) {
  if (perf.status === "unpriced") {
    return <span className="grp-status grp-status--none" title="No live quote available yet">No quote</span>;
  }
  if (perf.status === "pending") {
    return (
      <span className="grp-status grp-status--pending" title="Too soon to rank — a call needs ~1h of market action before it counts toward the leaderboard.">
        Pending
      </span>
    );
  }
  if (perf.call.direction === "buy") {
    return <span className="grp-status grp-status--ranked" title="Counts toward the leaderboard">Ranked</span>;
  }
  return <span className="grp-status grp-status--watch" title="Tracked, but a watch doesn't move the leaderboard">Tracked</span>;
}

/** Composer + the append-only call ledger with live performance per call. */
export function CallLedger({
  currentUserId,
  isAdmin,
  prefillTicker,
  onPrefillConsumed,
}: {
  currentUserId: string | null;
  isAdmin: boolean;
  prefillTicker: string | null;
  onPrefillConsumed: () => void;
}) {
  const calls = useGroupsStore((s) => s.calls);
  const prices = useGroupsStore((s) => s.prices);
  const logCall = useGroupsStore((s) => s.logCall);
  const removeCall = useGroupsStore((s) => s.removeCall);

  const [ticker, setTicker] = useState("");
  const [direction, setDirection] = useState<CallDirection>("buy");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prefillTicker) {
      setTicker(prefillTicker.toUpperCase());
      tickerRef.current?.focus();
      onPrefillConsumed();
    }
  }, [prefillTicker, onPrefillConsumed]);

  const submit = async () => {
    if (!ticker.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const r = await logCall(ticker, direction, note);
    setBusy(false);
    if (r.ok) {
      setTicker("");
      setNote("");
    } else {
      setErr(r.error ?? "Couldn't log that call.");
    }
  };

  const now = Date.now();
  const ranked = rankCalls(calls, prices, now);

  return (
    <section className="grp-panel" aria-labelledby="grp-ledger-title">
      <header className="grp-panel__head">
        <div className="grp-panel__title" id="grp-ledger-title">
          <IconMegaphone size={17} />
          <span>Call ledger</span>
          {calls.length > 0 && <span className="grp-panel__count mono">{calls.length}</span>}
        </div>
      </header>

      <div className="grp-composer">
        <div className="grp-composer__row">
          <input
            ref={tickerRef}
            className="grp-add__ticker mono"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="Ticker"
            aria-label="Ticker to call"
            maxLength={12}
          />
          <div className="segmented grp-composer__dir" role="group" aria-label="Call direction">
            <button className={direction === "buy" ? "active" : ""} onClick={() => setDirection("buy")} type="button">
              Buy
            </button>
            <button className={direction === "watch" ? "active" : ""} onClick={() => setDirection("watch")} type="button">
              Watch
            </button>
          </div>
        </div>
        <div className="grp-composer__row">
          <input
            className="grp-add__note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="Your thesis (optional)"
            aria-label="Call note"
            maxLength={200}
          />
          <button className="btn btn--primary btn--sm grp-composer__submit" onClick={() => void submit()} disabled={busy || !ticker.trim()}>
            <IconMegaphone size={14} /> {busy ? "Logging…" : "Log call"}
          </button>
        </div>
        <div className="grp-add__hint">
          <SymbolHint query={ticker} />
        </div>
        <p className="grp-composer__fineprint text-faint">
          We snapshot the live price the moment you log it — that's the honest entry your performance is measured from.
        </p>
        {err && <p className="grp-form__error" role="alert">{err}</p>}
      </div>

      {ranked.length === 0 ? (
        <div className="empty grp-empty">
          <IconMegaphone size={24} />
          <p>No calls yet. Make the first one — buy or watch — and we'll track it from today's price.</p>
        </div>
      ) : (
        <ul className="grp-calls">
          {ranked.map((perf) => {
            const c = perf.call;
            const canDelete = isAdmin || c.author.id === currentUserId;
            return (
              <li key={c.id} className="grp-call" data-dir={c.direction}>
                <GroupAvatar profile={c.author} size={30} />
                <div className="grp-call__main">
                  <div className="grp-call__line">
                    <span className={`grp-dir grp-dir--${c.direction}`}>{c.direction === "buy" ? "Buy" : "Watch"}</span>
                    <Link to={`/signal/${c.ticker}`} className="ticker mono grp-call__ticker">{c.ticker}</Link>
                    <span className="grp-call__author">
                      {c.author.displayName || c.author.handle || "Member"}
                    </span>
                    <span className="grp-call__time text-faint">{relativeTime(c.calledAt, now)}</span>
                  </div>
                  {c.note && <p className="grp-call__note">“{c.note}”</p>}
                </div>
                <div className="grp-call__perf">
                  <ReturnValue ratio={perf.returnPct} className="grp-call__return" />
                  <div className="grp-call__prices mono">
                    <Money value={c.calledPrice} className="grp-call__from" />
                    <span className="grp-call__arrow">→</span>
                    <Money value={perf.currentPrice} />
                  </div>
                  <StatusPill perf={perf} />
                </div>
                {canDelete && (
                  <button
                    className="grp-iconbtn grp-iconbtn--danger grp-call__del"
                    onClick={() => void removeCall(c.id)}
                    title="Delete call"
                    aria-label={`Delete ${c.ticker} call`}
                  >
                    <IconTrash size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
