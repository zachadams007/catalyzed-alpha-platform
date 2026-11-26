import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useCommandBar } from "@/store/useCommandBar";
import { resolveSymbolFromQuery, SymbolResolveError } from "@/data/finnhub/symbolSearch";
import { IconRefresh, IconSearch } from "@/components/icons";
import { AccountChip } from "@/components/layout/AccountChip";
import { DataModePill } from "@/components/screen/DataModePill";
import { useApiUsage } from "@/components/ops/ApiQuotaBoard";
import { useRefreshLimit } from "@/components/ops/RefreshLimit";
import { isResearchRunAllowed } from "@/data/providers";
import { APP_NAME } from "@/lib/app";
import { SYSTEM_NAV } from "@/config/navigationLabels";

const ROUTE_LABELS: Array<{ prefix: string; label: string }> = [
  { prefix: "/today", label: "Today" },
  { prefix: "/weekly", label: "Weekly" },
  { prefix: "/for-you", label: "For You" },
  { prefix: "/friends", label: "Friends" },
  { prefix: "/groups", label: "Groups" },
  { prefix: "/heatmap", label: "Market Map" },
  { prefix: "/portfolios", label: "Portfolios" },
  { prefix: "/watchlist", label: "Watchlist" },
  { prefix: "/research", label: "Research" },
  { prefix: SYSTEM_NAV.forge.path, label: SYSTEM_NAV.forge.label },
  { prefix: SYSTEM_NAV.beacon.path, label: SYSTEM_NAV.beacon.label },
  { prefix: SYSTEM_NAV.core.path, label: SYSTEM_NAV.core.label },
  { prefix: SYSTEM_NAV.terminal.path, label: SYSTEM_NAV.terminal.label },
  { prefix: "/desk", label: "Your Desk" },
  { prefix: "/admin", label: "Operator Console" },
  { prefix: "/performance", label: "Performance" },
  { prefix: "/signal", label: "Signal Detail" },
];

/** Mock market session label derived from local time (illustrative only). */
function marketSession(): { label: string; tone: string } {
  const h = new Date().getHours();
  if (h >= 9 && h < 16) return { label: "Market Open", tone: "var(--bull)" };
  if (h >= 4 && h < 9) return { label: "Pre-Market", tone: "var(--warn)" };
  if (h >= 16 && h < 20) return { label: "After Hours", tone: "var(--accent)" };
  return { label: "Market Closed", tone: "var(--faint)" };
}

export function TopBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const status = useAppStore((s) => s.researchStatus);
  const runResearchNow = useAppStore((s) => s.runResearchNow);
  const signalByTicker = useAppStore((s) => s.signalByTicker);
  const openCommandBar = useCommandBar((s) => s.setOpen);
  const label =
    ROUTE_LABELS.find((r) => location.pathname.startsWith(r.prefix))?.label ?? APP_NAME;
  const session = marketSession();
  const running = status === "running";
  useApiUsage();
  const researchAllowed = isResearchRunAllowed();
  const refreshLimit = useRefreshLimit();
  // Manual cap is hit (non-operator) - the button parks in a calm "limit
  // reached" state. The feed stays populated from the daily auto-cache.
  const limited = refreshLimit.blocked;

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const raw = query.trim();
    if (!raw || searching) return;
    setSearching(true);
    void resolveSymbolFromQuery(raw)
      .then((ticker) => {
        if (signalByTicker(ticker)) {
          navigate(`/signal/${ticker}`);
        } else {
          navigate(`/beacon?t=${encodeURIComponent(ticker)}`);
        }
        setQuery("");
      })
      .catch((err) =>
        useAppStore
          .getState()
          .pushToast(
            err instanceof SymbolResolveError
              ? [err.message, ...err.suggestions].filter(Boolean).join(" ")
              : "Couldn’t reach search — check your connection.",
            "warn",
          ),
      )
      .finally(() => setSearching(false));
  };

  return (
    <header className="topbar">
      <div className="col">
        <span className="topbar__title">{label}</span>
      </div>

      <span className="pill topbar__session-pill" style={{ color: session.tone, marginLeft: 4 }}>
        <span className="pill__dot" style={{ animation: "pulseGlow 2s ease infinite" }} />
        {session.label}
      </span>

      <DataModePill />

      <div className="grow" />

      <form className="search" role="search" onSubmit={submitSearch}>
        {/* Leading glyph is decorative; the IconSearch <svg> is already aria-hidden. */}
        <IconSearch size={16} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ticker or company (e.g. Tesla, TSLA)"
          aria-label="Search ticker or company"
          spellCheck={false}
          // Stay editable while a lookup is in flight - disabling the field
          // greys the whole search out and reads as "broken". The submit guard
          // in submitSearch() already prevents a double request.
        />
        <button
          type="submit"
          className="search__submit"
          aria-label={searching ? "Searching…" : "Search"}
          aria-busy={searching}
          disabled={searching}
        >
          {searching ? <span className="spinner" /> : <IconSearch size={14} />}
        </button>
      </form>

      <button
        type="button"
        className="cmdk-trigger"
        onClick={() => openCommandBar(true)}
        title="Open command bar (Ctrl/⌘ K)"
        aria-label="Open command bar"
      >
        <IconSearch size={14} />
        <kbd className="cmdk-kbd">⌘K</kbd>
      </button>

      <div className="topbar__actions">
        <div className="topbar__account">
          <AccountChip compact />
        </div>
        <button
          className="btn btn--primary"
          onClick={() => runResearchNow("manual")}
          disabled={running || !researchAllowed || limited}
          title={
            !researchAllowed
              ? "Live/API data access is off in the Operator Console"
              : limited
                ? `Daily manual-refresh limit reached (${refreshLimit.limit}/${refreshLimit.limit}). Resets at midnight — your feed still auto-refreshes once a day.`
                : refreshLimit.unlimited
                  ? undefined
                  : `${refreshLimit.remaining} of ${refreshLimit.limit} manual refreshes left today`
          }
        >
          {running ? <span className="spinner" /> : <IconRefresh size={16} />}
          {running
            ? "Scanning…"
            : !researchAllowed
              ? "API access off"
              : limited
                ? "Limit reached"
                : "Scan Market"}
        </button>
      </div>
    </header>
  );
}
