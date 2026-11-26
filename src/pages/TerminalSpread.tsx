import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useSecuritySnapshot, type SecuritySnapshot } from "@/components/terminal/useSecuritySnapshot";
import { QuoteHeader } from "@/components/terminal/QuoteHeader";
import { AiBriefPanel } from "@/components/terminal/AiBriefPanel";
import { SocialHeatPanel } from "@/components/terminal/SocialHeatPanel";
import { NotesPanel } from "@/components/terminal/NotesPanel";
import {
  AnalystPanelCard,
  ChartPanel,
  CongressPanelCard,
  FilingsPanelCard,
  NewsPanelCard,
  ScorePanelCard,
} from "@/components/terminal/workspacePanels";
import { FeedState } from "@/components/common/FeedState";
import { Skeleton } from "@/components/common/Skeleton";
import { LoadingNote } from "@/components/common/FeedSkeleton";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { TerminalErrorBoundary } from "@/components/terminal/TerminalErrorBoundary";
import { IconChevronLeft, IconSearch } from "@/components/icons";
import type { StockSignal } from "@/types";
import type { YahooHistory } from "@/data/prices/yahooHistory";

interface PanelCtx {
  signal: StockSignal;
  history: YahooHistory | null;
}

/** The panels available in a spread, in canonical render order. */
const SPREAD_PANELS: { id: string; label: string; render: (ctx: PanelCtx) => ReactNode }[] = [
  { id: "chart", label: "Chart", render: ({ signal, history }) => <ChartPanel signal={signal} history={history} /> },
  { id: "ai", label: "AI brief", render: ({ signal }) => <AiBriefPanel ticker={signal.ticker} companyName={signal.name} /> },
  { id: "news", label: "News", render: ({ signal }) => <NewsPanelCard signal={signal} /> },
  { id: "filings", label: "Filings", render: ({ signal }) => <FilingsPanelCard signal={signal} /> },
  { id: "congress", label: "Congress", render: ({ signal }) => <CongressPanelCard signal={signal} /> },
  { id: "analyst", label: "Analyst", render: ({ signal }) => <AnalystPanelCard signal={signal} /> },
  { id: "social", label: "Social", render: ({ signal }) => <SocialHeatPanel ticker={signal.ticker} /> },
  { id: "notes", label: "Notes", render: ({ signal }) => <NotesPanel ticker={signal.ticker} /> },
  { id: "score", label: "Score", render: ({ signal }) => <ScorePanelCard signal={signal} /> },
];

function SpreadBody({ snap }: { snap: SecuritySnapshot }) {
  const panels = useAppStore((s) => s.terminalSpread.panels);
  const { signal, quote, history, resolving } = snap;

  if (!signal) {
    return resolving ? (
      <>
        <LoadingNote
          label={snap.ticker}
          hint="Resolving its live read across the panels — not stuck."
        />
        <div className="tw-grid" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div className="tw-panel" key={i} style={{ minHeight: 160 }}>
              <Skeleton width="40%" height={12} />
              <Skeleton width="100%" height={90} radius={12} style={{ marginTop: 14 }} />
            </div>
          ))}
        </div>
      </>
    ) : (
      <FeedState
        variant="error"
        title={`Couldn’t load ${snap.ticker}`}
        action={
          <Link className="btn btn--ghost btn--sm" to="/terminal">
            Back to the wire
          </Link>
        }
      >
        No live data resolved for {snap.ticker}. Check the symbol and try another.
      </FeedState>
    );
  }

  const active = SPREAD_PANELS.filter((p) => panels.includes(p.id));

  return (
    <>
      <QuoteHeader
        signal={signal}
        quote={quote}
        history={history}
        quoteLoading={quote == null}
      />
      {active.length === 0 ? (
        <FeedState title="No panels selected">
          Toggle a panel above to build your spread — chart, news, filings, AI brief, and more, all
          tracking {signal.ticker}.
        </FeedState>
      ) : (
        <div className="tw-grid" key={signal.ticker}>
          {active.map((p) => (
            <div key={p.id} className="tw-spread__cell">
              {p.render({ signal, history })}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Linked-parameter spread (/terminal/spread) - Phase 3. One shared symbol drives
 * a user-chosen set of panels; changing the symbol relinks every pane at once
 * (OpenBB's linked-parameter model). The spread (symbol + panels) is persisted,
 * so it's restored on reopen, and a `?symbol=` URL param can deep-link one.
 */
function TerminalSpreadInner() {
  const spread = useAppStore((s) => s.terminalSpread);
  const setTerminalSpread = useAppStore((s) => s.setTerminalSpread);
  const [params, setParams] = useSearchParams();

  const [draft, setDraft] = useState(spread.symbol);
  const snap = useSecuritySnapshot(spread.symbol || undefined);

  // Deep-link: a `?symbol=` param sets the linked symbol once, then is cleared.
  useEffect(() => {
    const urlSymbol = params.get("symbol");
    if (urlSymbol && urlSymbol.trim()) {
      const sym = urlSymbol.trim().toUpperCase();
      setTerminalSpread({ symbol: sym });
      setDraft(sym);
      const next = new URLSearchParams(params);
      next.delete("symbol");
      setParams(next, { replace: true });
    }
  }, [params, setParams, setTerminalSpread]);

  const submitSymbol = (e: React.FormEvent) => {
    e.preventDefault();
    setTerminalSpread({ symbol: draft });
  };

  const togglePanel = (id: string) => {
    const has = spread.panels.includes(id);
    setTerminalSpread({
      panels: has ? spread.panels.filter((p) => p !== id) : [...spread.panels, id],
    });
  };

  return (
    <div className="tw-spread">
      <div className="tw-spread__bar">
        <Link to="/terminal" className="back-link">
          <IconChevronLeft size={16} /> Terminal wire
        </Link>

        <form className="tw-spread__symbol" onSubmit={submitSymbol} role="search">
          <IconSearch size={16} className="text-faint" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase().slice(0, 8))}
            placeholder="Shared symbol (e.g. AAPL)"
            aria-label="Spread symbol — links every panel"
            spellCheck={false}
            autoCapitalize="characters"
          />
          <button type="submit" className="btn btn--primary btn--sm" disabled={!draft.trim()}>
            Link
          </button>
        </form>
      </div>

      <div className="tw-spread__panels" role="group" aria-label="Panels in this spread">
        <span className="tw-spread__panels-label text-faint">Panels</span>
        {SPREAD_PANELS.map((p) => {
          const on = spread.panels.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              className={`tw-chip${on ? " tw-chip--on" : ""}`}
              aria-pressed={on}
              onClick={() => togglePanel(p.id)}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {spread.symbol ? (
        <SpreadBody snap={snap} />
      ) : (
        <FeedState title="Link a symbol to begin">
          Type a ticker above (or open one with ⌘K) and every selected panel will track it. Change
          the symbol once and the whole spread relinks.
        </FeedState>
      )}

      <InvestingDisclaimer className="page-disclaimer" />
    </div>
  );
}

/** Public route component, wrapped so a snapshot hiccup degrades gracefully. */
export function TerminalSpread() {
  return (
    <TerminalErrorBoundary label="spread">
      <TerminalSpreadInner />
    </TerminalErrorBoundary>
  );
}
