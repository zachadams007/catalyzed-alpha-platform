import { useState } from "react";
import { Link } from "react-router-dom";
import { useGroupsStore } from "@/store/useGroupsStore";
import { getSymbol } from "@/data/symbols/symbolDirectory";
import { IconPlus, IconWatchlist, IconTrash, IconRefresh } from "@/components/icons";
import { IconMegaphone } from "./icons";
import { GroupAvatar, Money, SymbolHint } from "./shared";

/**
 * The collective group watchlist. Any member adds a ticker (resolved against the
 * bundled symbol directory); everyone sees it with a live price and who added it.
 */
export function SharedWatchlist({
  currentUserId,
  isAdmin,
  onCall,
}: {
  currentUserId: string | null;
  isAdmin: boolean;
  onCall: (ticker: string) => void;
}) {
  const watchlist = useGroupsStore((s) => s.watchlist);
  const prices = useGroupsStore((s) => s.prices);
  const pricesLoading = useGroupsStore((s) => s.pricesLoading);
  const addTicker = useGroupsStore((s) => s.addTicker);
  const removeTicker = useGroupsStore((s) => s.removeTicker);
  const refreshPrices = useGroupsStore((s) => s.refreshPrices);

  const [ticker, setTicker] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!ticker.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const r = await addTicker(ticker, note);
    setBusy(false);
    if (r.ok) {
      setTicker("");
      setNote("");
    } else {
      setErr(r.error ?? "Couldn't add that ticker.");
    }
  };

  return (
    <section className="grp-panel" aria-labelledby="grp-watchlist-title">
      <header className="grp-panel__head">
        <div className="grp-panel__title" id="grp-watchlist-title">
          <IconWatchlist size={17} />
          <span>Shared watchlist</span>
          {watchlist.length > 0 && <span className="grp-panel__count mono">{watchlist.length}</span>}
        </div>
        <button
          className="grp-iconbtn"
          onClick={() => void refreshPrices()}
          disabled={pricesLoading}
          title="Refresh live prices (Alpaca IEX)"
          aria-label="Refresh live prices"
        >
          <IconRefresh size={15} className={pricesLoading ? "grp-spin" : ""} />
        </button>
      </header>

      <div className="grp-add">
        <div className="grp-add__row">
          <input
            className="grp-add__ticker mono"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            placeholder="Ticker"
            aria-label="Ticker to add"
            maxLength={12}
          />
          <input
            className="grp-add__note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
            placeholder="Why it's interesting (optional)"
            aria-label="Note"
            maxLength={160}
          />
          <button className="btn btn--primary btn--sm" onClick={() => void add()} disabled={busy || !ticker.trim()}>
            <IconPlus size={14} /> Add
          </button>
        </div>
        <div className="grp-add__hint">
          <SymbolHint query={ticker} />
        </div>
        {err && <p className="grp-form__error" role="alert">{err}</p>}
      </div>

      {watchlist.length === 0 ? (
        <div className="empty grp-empty">
          <IconWatchlist size={24} />
          <p>No tickers yet. Add the first name your group is watching.</p>
        </div>
      ) : (
        <ul className="grp-watch-list">
          {watchlist.map((w) => {
            const rec = getSymbol(w.ticker);
            const canRemove = isAdmin || w.addedBy.id === currentUserId;
            return (
              <li key={w.id} className="grp-watch">
                <Link to={`/signal/${w.ticker}`} className="grp-watch__id" title={rec?.name ?? w.ticker}>
                  <span className="ticker mono grp-watch__ticker">{w.ticker}</span>
                  {rec?.name && <span className="grp-watch__name">{rec.name}</span>}
                </Link>

                <div className="grp-watch__price">
                  <Money value={prices[w.ticker]} />
                </div>

                <div className="grp-watch__by" title={`Added by ${w.addedBy.displayName ?? w.addedBy.handle ?? "a member"}`}>
                  <GroupAvatar profile={w.addedBy} size={22} />
                </div>

                <div className="grp-watch__actions">
                  <button className="grp-chipbtn" onClick={() => onCall(w.ticker)} title={`Call ${w.ticker}`}>
                    <IconMegaphone size={13} /> Call
                  </button>
                  {canRemove && (
                    <button
                      className="grp-iconbtn grp-iconbtn--danger"
                      onClick={() => void removeTicker(w.id)}
                      title="Remove from watchlist"
                      aria-label={`Remove ${w.ticker}`}
                    >
                      <IconTrash size={14} />
                    </button>
                  )}
                </div>

                {w.note && <p className="grp-watch__note">{w.note}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
