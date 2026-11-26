import { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useAppStore } from "@/store/useAppStore";
import { useCommandBar } from "@/store/useCommandBar";
import { useAuthStore } from "@/store/useAuthStore";
import { isAdminEmail } from "@/lib/admin";
import { fetchUsSymbolList } from "@/data/funnel/symbolList";
import {
  searchSymbols as searchDirectory,
  resolveSymbol as resolveDirectorySymbol,
} from "@/data/symbols/symbolDirectory";
import { formatPrice, formatPct } from "@/lib/format";
import type { StockSignal } from "@/types";
import {
  IconSearch,
  IconPulse,
  IconNews,
  IconLayers,
  IconScale,
  IconTarget,
  IconSparkle,
  IconCore,
  IconWatchlist,
  IconPortfolios,
  IconResearch,
  IconToday,
  IconWeekly,
  IconForYou,
  IconFriends,
  IconForge,
  IconBeacon,
  IconUser,
  IconShield,
  type IconProps,
} from "@/components/icons";

type IconCmp = (p: IconProps) => JSX.Element;
type Group = "primary" | "tickers" | "actions" | "pages";

interface Cmd {
  key: string;
  group: Group;
  label: string;
  sublabel?: string;
  hint?: string;
  Icon: IconCmp;
  run: () => void;
}

interface RouteDef {
  label: string;
  path: string;
  keywords: string;
  Icon: IconCmp;
  admin?: boolean;
}

/** Every routed destination, fuzzy-searchable by label or keywords. */
const ROUTES: RouteDef[] = [
  { label: "Terminal — market wire", path: "/terminal", keywords: "terminal wire home catalysts movers", Icon: IconPulse },
  { label: "Terminal — multi-pane spread", path: "/terminal/spread", keywords: "spread multi pane linked layout dashboard cockpit", Icon: IconLayers },
  { label: "Today", path: "/today", keywords: "today feed signals home", Icon: IconToday },
  { label: "Weekly", path: "/weekly", keywords: "weekly feed digest", Icon: IconWeekly },
  { label: "For You", path: "/for-you", keywords: "for you personalized recommended", Icon: IconForYou },
  { label: "Friends", path: "/friends", keywords: "friends social people", Icon: IconFriends },
  { label: "Blueprint — Signal Forge", path: "/forge", keywords: "blueprint forge screen screener filters discover", Icon: IconForge },
  { label: "Ticker Scope", path: "/beacon", keywords: "ticker scope lookup resolve symbol", Icon: IconBeacon },
  { label: "Algorithm", path: "/core", keywords: "algorithm core guide scoring how it works", Icon: IconCore },
  { label: "Portfolios", path: "/portfolios", keywords: "portfolios holdings books", Icon: IconPortfolios },
  { label: "Watchlist", path: "/watchlist", keywords: "watchlist saved follow", Icon: IconWatchlist },
  { label: "Research status", path: "/research", keywords: "research status runs pipeline", Icon: IconResearch },
  { label: "Performance", path: "/performance", keywords: "performance outcomes track record ledger", Icon: IconPulse },
  { label: "My Desk", path: "/desk", keywords: "desk dashboard usage account", Icon: IconUser },
  { label: "Operator console", path: "/admin", keywords: "admin operator console champion challenger", Icon: IconShield, admin: true },
];

interface ActionDef {
  id: string;
  /** Bare verb typed after a ticker or behind a "/". */
  verb: string;
  label: string;
  keywords: string;
  /** Query param the workspace reads to focus a panel (empty = overview). */
  panel: string;
  Icon: IconCmp;
}

/** Per-ticker actions. `panel` deep-links the workspace to that panel. */
const TICKER_ACTIONS: ActionDef[] = [
  { id: "overview", verb: "overview", label: "Open workspace", keywords: "open workspace overview des summary", panel: "", Icon: IconLayers },
  { id: "chart", verb: "chart", label: "Price chart", keywords: "chart price graph gp history", panel: "chart", Icon: IconPulse },
  { id: "news", verb: "news", label: "News wire", keywords: "news headlines press", panel: "news", Icon: IconNews },
  { id: "filings", verb: "filings", label: "SEC filings", keywords: "filings 8-k form 4 sec insider", panel: "filings", Icon: IconLayers },
  { id: "congress", verb: "congress", label: "Congress trades", keywords: "congress politician senate house", panel: "congress", Icon: IconScale },
  { id: "analyst", verb: "analyst", label: "Analyst targets", keywords: "analyst targets price target rating", panel: "analyst", Icon: IconTarget },
  { id: "ai", verb: "ai", label: "AI brief", keywords: "ai brief summary research explain", panel: "ai", Icon: IconSparkle },
  { id: "score", verb: "score", label: "Score breakdown", keywords: "score breakdown why rating", panel: "score", Icon: IconCore },
  { id: "social", verb: "social", label: "Social heat", keywords: "social heat reddit stocktwits mentions", panel: "social", Icon: IconPulse },
];

function isSubsequence(q: string, t: string): boolean {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (q[i] === t[j]) i++;
  }
  return i === q.length;
}

/** Higher is better; -1 = no match. */
function matchScore(query: string, text: string): number {
  const x = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!x) return 0;
  if (t === x) return 100;
  if (t.startsWith(x)) return 80;
  if (t.split(/[\s\-_/.,]+/).some((w) => w.startsWith(x))) return 60;
  if (t.includes(x)) return 40;
  if (isSubsequence(x, t)) return 20;
  return -1;
}

const TICKER_RE = /^>?\s*([A-Za-z][A-Za-z.\-]{0,7})$/;
const TICKER_ACTION_RE = /^>?\s*([A-Za-z][A-Za-z.\-]{0,7})\s+(.+)$/;
// "AAPL vs NVDA" (explicit pair) and "vs NVDA" / "/vs NVDA" (against the loaded ticker).
const VS_PAIR_RE = /^>?\s*([A-Za-z][A-Za-z.\-]{0,7})\s+(?:vs\.?|versus)\s+([A-Za-z][A-Za-z.\-]{0,7})$/i;
const VS_ONE_RE = /^\/?\s*(?:vs\.?|versus)\s+([A-Za-z][A-Za-z.\-]{0,7})$/i;

interface BuildCtx {
  contextTicker: string | null;
  byTicker: Map<string, StockSignal>;
  watchlist: string[];
  marketSymbols: Set<string>;
  isAdmin: boolean;
  goTicker: (t: string) => void;
  goAction: (t: string, panel: string) => void;
  goCompare: (a: string, b: string) => void;
  goRoute: (p: string) => void;
  toggleWatch: (t: string) => void;
  isWatched: (t: string) => boolean;
}

function tickerSublabel(sig: StockSignal | undefined): string | undefined {
  if (!sig) return undefined;
  return `${sig.name} · ${formatPrice(sig.price)} ${formatPct(sig.dayChange)}`;
}

function knownTicker(t: string, ctx: BuildCtx): boolean {
  return ctx.byTicker.has(t) || ctx.marketSymbols.has(t);
}

function compareCmd(a: string, b: string, ctx: BuildCtx): Cmd {
  return {
    key: `primary:compare:${a}:${b}`,
    group: "primary",
    label: `Compare ${a} vs ${b}`,
    sublabel: "Side-by-side: price, momentum, score, analyst upside",
    Icon: IconScale,
    run: () => ctx.goCompare(a, b),
  };
}

function routeCmds(query: string, ctx: BuildCtx, minScore = 0): Cmd[] {
  return ROUTES.filter((r) => !r.admin || ctx.isAdmin)
    .map((r) => ({ r, s: matchScore(query, `${r.label} ${r.keywords}`) }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .map(({ r }) => ({
      key: `route:${r.path}`,
      group: "pages" as const,
      label: r.label,
      Icon: r.Icon,
      run: () => ctx.goRoute(r.path),
    }));
}

function tickerNavCmds(query: string, ctx: BuildCtx, cap = 6): Cmd[] {
  const q = query.toUpperCase();
  const scored: { sig: StockSignal; s: number }[] = [];
  for (const sig of ctx.byTicker.values()) {
    const tScore = matchScore(query, sig.ticker);
    const nScore = matchScore(query, sig.name);
    // Boost ticker hits over name hits - but only when the ticker actually
    // matches, else a no-match (-1) would leak through as a positive score.
    // Names must clear "includes" (≥40): loose subsequence matches turn every
    // "… Capital" into a hit for a ticker query like AAPL.
    const s = Math.max(tScore >= 0 ? tScore + 5 : -1, nScore >= 40 ? nScore : -1);
    if (s >= 0) scored.push({ sig, s });
  }
  scored.sort((a, b) => b.s - a.s || a.sig.ticker.localeCompare(b.sig.ticker));
  const out: Cmd[] = scored.slice(0, cap).map(({ sig }) => ({
    key: `ticker:${sig.ticker}`,
    group: "tickers" as const,
    label: sig.ticker,
    sublabel: tickerSublabel(sig),
    Icon: IconBeacon,
    run: () => ctx.goTicker(sig.ticker),
  }));
  // Full-market tier: surface matching listed symbols not already in the universe.
  if (q.length >= 1) {
    const have = new Set(out.map((c) => c.label));
    const extra: string[] = [];
    for (const sym of ctx.marketSymbols) {
      if (sym.startsWith(q) && !have.has(sym)) extra.push(sym);
      if (extra.length >= cap) break;
    }
    extra.sort();
    for (const sym of extra.slice(0, cap)) {
      out.push({
        key: `ticker:${sym}`,
        group: "tickers",
        label: sym,
        sublabel: "Listed US symbol",
        Icon: IconBeacon,
        run: () => ctx.goTicker(sym),
      });
    }
  }
  // Offline directory tier: ~13.8k US + CA listings, searchable by symbol OR
  // company name. This is what kills the false "No matches" - every real
  // listed security resolves here even with no live key (e.g. BLDP, OKLO, MDA.TO).
  {
    const have = new Set(out.map((c) => c.label));
    for (const rec of searchDirectory(query, cap)) {
      if (have.has(rec.symbol)) continue;
      have.add(rec.symbol);
      out.push({
        key: `ticker:${rec.symbol}`,
        group: "tickers",
        label: rec.symbol,
        sublabel: `${rec.name} · ${rec.exchange}${rec.isEtf ? " · ETF" : ""}`,
        Icon: IconBeacon,
        run: () => ctx.goTicker(rec.symbol),
      });
    }
  }
  return out;
}

function actionCmds(ticker: string, query: string, ctx: BuildCtx): Cmd[] {
  const sig = ctx.byTicker.get(ticker);
  const watch: ActionDef = {
    id: "watch",
    verb: ctx.isWatched(ticker) ? "unwatch" : "watch",
    label: ctx.isWatched(ticker) ? "Remove from watchlist" : "Add to watchlist",
    keywords: "watchlist watch save follow",
    panel: "",
    Icon: IconWatchlist,
  };
  const defs = [...TICKER_ACTIONS, watch];
  return defs
    .map((a) => ({ a, s: query ? matchScore(query, `${a.verb} ${a.label} ${a.keywords}`) : 0 }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map(({ a }) => ({
      key: `action:${a.id}:${ticker}`,
      group: "actions" as const,
      label: `${a.label}`,
      sublabel: sig ? `${ticker} · ${sig.name}` : ticker,
      Icon: a.Icon,
      run: () => (a.id === "watch" ? ctx.toggleWatch(ticker) : ctx.goAction(ticker, a.panel)),
    }));
}

/** Parse the raw input into an ordered candidate list across groups. */
function buildCandidates(raw: string, ctx: BuildCtx): Cmd[] {
  const input = raw.trim();

  // Empty → useful defaults: jump back to a loaded ticker, the wire, watchlist.
  if (!input) {
    const out: Cmd[] = [];
    if (ctx.contextTicker) {
      out.push({
        key: `primary:back:${ctx.contextTicker}`,
        group: "primary",
        label: `Back to ${ctx.contextTicker} workspace`,
        Icon: IconLayers,
        run: () => ctx.goTicker(ctx.contextTicker!),
      });
    }
    out.push({
      key: "primary:wire",
      group: "primary",
      label: "Terminal — market wire",
      sublabel: "Live catalysts, insider buys & congress trades",
      Icon: IconPulse,
      run: () => ctx.goRoute("/terminal"),
    });
    for (const t of ctx.watchlist.slice(0, 6)) {
      const sig = ctx.byTicker.get(t);
      out.push({
        key: `ticker:${t}`,
        group: "tickers",
        label: t,
        sublabel: tickerSublabel(sig) ?? "On your watchlist",
        Icon: IconWatchlist,
        run: () => ctx.goTicker(t),
      });
    }
    out.push(...routeCmds("", ctx).filter((c) => c.key !== "route:/terminal"));
    return out;
  }

  // Compare: "AAPL vs NVDA" (explicit pair), anywhere.
  const vsPair = VS_PAIR_RE.exec(input);
  if (vsPair) {
    return [compareCmd(vsPair[1].toUpperCase(), vsPair[2].toUpperCase(), ctx)];
  }
  // Compare against the loaded ticker: "vs NVDA" or "/vs NVDA".
  if (ctx.contextTicker) {
    const vsOne = VS_ONE_RE.exec(input);
    if (vsOne) {
      return [compareCmd(ctx.contextTicker, vsOne[1].toUpperCase(), ctx)];
    }
  }

  // Action mode: "/news" acts on the loaded ticker.
  if (input.startsWith("/")) {
    const q = input.slice(1).trim();
    if (!ctx.contextTicker) {
      return [
        {
          key: "primary:no-ticker",
          group: "primary",
          label: "Type a ticker first, then an action",
          sublabel: "e.g. AAPL chart  ·  NVDA news",
          Icon: IconSearch,
          run: () => {},
        },
      ];
    }
    return actionCmds(ctx.contextTicker, q, ctx);
  }

  // "TICKER action" → act on the named ticker (e.g. NVDA news).
  const ta = TICKER_ACTION_RE.exec(input);
  if (ta) {
    const token = ta[1].toUpperCase();
    const word = ta[2].trim();
    if (knownTicker(token, ctx) || TICKER_RE.test(token)) {
      const actions = actionCmds(token, word, ctx);
      const primary: Cmd[] = actions.length
        ? [{ ...actions[0], key: `primary:${actions[0].key}`, group: "primary" }]
        : [];
      return [...primary, ...actions.slice(primary.length ? 1 : 0)];
    }
  }

  // Single token → ticker navigation (+ matching pages).
  const tn = TICKER_RE.exec(input);
  if (tn) {
    const token = tn[1].toUpperCase();
    const tickers = tickerNavCmds(token, ctx);
    const out: Cmd[] = [];
    const exact = ctx.byTicker.get(token);
    if (exact || ctx.marketSymbols.has(token)) {
      out.push({
        key: `primary:ticker:${token}`,
        group: "primary",
        label: `Open ${token} workspace`,
        sublabel: tickerSublabel(exact),
        Icon: IconLayers,
        run: () => ctx.goTicker(token),
      });
    } else if (token.length >= 1) {
      // Resolve the token against the offline directory (symbol OR name) so the
      // primary action headlines the right security - "Ballard"/"MDA" land on
      // BLDP/MDA.TO instead of a wrong synthetic ticker.
      const rec = resolveDirectorySymbol(token);
      out.push({
        key: `primary:open:${rec ? rec.symbol : token}`,
        group: "primary",
        label: rec ? `Open ${rec.symbol} workspace` : `Open “${token}” as a ticker`,
        sublabel: rec ? `${rec.name} · ${rec.exchange}` : "Resolves live in the workspace",
        Icon: IconBeacon,
        run: () => ctx.goTicker(rec ? rec.symbol : token),
      });
    }
    const seen = new Set(out.map((c) => c.label));
    out.push(...tickers.filter((c) => !seen.has(c.label)));
    // Only surface a page here when the token strongly matches it (word-prefix
    // or better) - a subsequence route match is noise next to a ticker.
    out.push(...routeCmds(token, ctx, 60));
    return out;
  }

  // Free text → fuzzy over tickers + pages (+ actions if a ticker is loaded).
  const tickers = tickerNavCmds(input, ctx, 5);
  const pages = routeCmds(input, ctx);
  const actions = ctx.contextTicker ? actionCmds(ctx.contextTicker, input, ctx).slice(0, 4) : [];
  const merged = [...tickers, ...pages, ...actions];
  if (merged.length) {
    const [first, ...rest] = merged;
    return [{ ...first, key: `primary:${first.key}`, group: "primary" }, ...rest];
  }
  return [];
}

const GROUP_HEADING: Record<Group, string> = {
  primary: "",
  tickers: "Tickers",
  actions: "Actions",
  pages: "Go to",
};

export function CommandBar() {
  const open = useCommandBar((s) => s.open);
  const setOpen = useCommandBar((s) => s.setOpen);
  const toggle = useCommandBar((s) => s.toggle);
  const contextTicker = useCommandBar((s) => s.contextTicker);

  const signals = useAppStore((s) => s.signals);
  const watchlist = useAppStore((s) => s.watchlist);
  const resolveSignal = useAppStore((s) => s.resolveSignal);
  const toggleWatchlist = useAppStore((s) => s.toggleWatchlist);
  const isWatchlisted = useAppStore((s) => s.isWatchlisted);
  const adminEmail = useAuthStore((s) => s.email);

  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const [input, setInput] = useState("");
  const [marketSymbols, setMarketSymbols] = useState<Set<string>>(new Set());
  const loadedMarket = useRef(false);

  // Global ⌘K / Ctrl-K toggle (+ Escape to close) - mounted once, app-wide.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        toggle();
      } else if (e.key === "Escape" && useCommandBar.getState().open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, setOpen]);

  // Reset the query whenever the palette closes.
  useEffect(() => {
    if (!open) setInput("");
  }, [open]);

  // Lazily warm the full-market symbol list the first time the bar opens
  // (one daily-cached Finnhub call; degrades to the in-memory universe).
  useEffect(() => {
    if (!open || loadedMarket.current) return;
    loadedMarket.current = true;
    void fetchUsSymbolList()
      .then((list) => setMarketSymbols(new Set(list.symbols)))
      .catch(() => {});
  }, [open]);

  const byTicker = useMemo(() => {
    const map = new Map<string, StockSignal>();
    for (const s of signals) map.set(s.ticker, s);
    return map;
  }, [signals]);

  const isAdmin = isAdminEmail(adminEmail);

  const candidates = useMemo(() => {
    const close = () => setOpen(false);
    const ctx: BuildCtx = {
      contextTicker,
      byTicker,
      watchlist,
      marketSymbols,
      isAdmin,
      goTicker: (t) => {
        navigate(`/terminal/${encodeURIComponent(t)}`);
        close();
      },
      goAction: (t, panel) => {
        navigate(`/terminal/${encodeURIComponent(t)}${panel ? `?panel=${panel}` : ""}`);
        close();
      },
      goCompare: (a, b) => {
        navigate(`/terminal/${encodeURIComponent(a)}/vs/${encodeURIComponent(b)}`);
        close();
      },
      goRoute: (p) => {
        navigate(p);
        close();
      },
      toggleWatch: (t) => {
        const sig = resolveSignal(t);
        if (sig) {
          toggleWatchlist(sig);
          close();
        } else {
          navigate(`/terminal/${encodeURIComponent(t)}`);
          close();
        }
      },
      isWatched: (t) => isWatchlisted(t),
    };
    return buildCandidates(input, ctx);
  }, [
    input,
    contextTicker,
    byTicker,
    watchlist,
    marketSymbols,
    isAdmin,
    navigate,
    setOpen,
    resolveSignal,
    toggleWatchlist,
    isWatchlisted,
  ]);

  // Preserve group order while letting cmdk render flat lists.
  const grouped = useMemo(() => {
    const order: Group[] = ["primary", "tickers", "actions", "pages"];
    return order
      .map((g) => ({ group: g, items: candidates.filter((c) => c.group === g) }))
      .filter((s) => s.items.length > 0);
  }, [candidates]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="cmdk-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.16 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <motion.div
            className="cmdk-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Command bar"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.99 }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 34 }}
          >
            <Command label="Command bar" shouldFilter={false} loop>
              <div className="cmdk-input-row">
                <IconSearch size={18} className="cmdk-input-row__icon" />
                <Command.Input
                  value={input}
                  onValueChange={setInput}
                  autoFocus
                  placeholder={
                    contextTicker
                      ? `Search, or act on ${contextTicker} (e.g. /news)…`
                      : "Search a ticker, command, or page…"
                  }
                />
                {contextTicker ? (
                  <span className="cmdk-context mono" title="Loaded security">
                    {contextTicker}
                  </span>
                ) : null}
                <kbd className="cmdk-kbd">esc</kbd>
              </div>

              <Command.List>
                <Command.Empty className="cmdk-empty">
                  No matches for “{input.trim()}”. Try a ticker like AAPL.
                </Command.Empty>

                {grouped.map(({ group, items }) => (
                  <Command.Group key={group} heading={GROUP_HEADING[group] || undefined}>
                    {items.map((c) => (
                      <Command.Item key={c.key} value={c.key} onSelect={c.run}>
                        <span className="cmdk-item__icon">
                          <c.Icon size={16} />
                        </span>
                        <span className="cmdk-item__body">
                          <span className="cmdk-item__label">{c.label}</span>
                          {c.sublabel ? (
                            <span className="cmdk-item__sub">{c.sublabel}</span>
                          ) : null}
                        </span>
                        {c.hint ? <span className="cmdk-item__hint mono">{c.hint}</span> : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>

              <div className="cmdk-foot">
                <span className="cmdk-foot__hint">
                  <kbd className="cmdk-kbd">↑</kbd>
                  <kbd className="cmdk-kbd">↓</kbd> navigate
                </span>
                <span className="cmdk-foot__hint">
                  <kbd className="cmdk-kbd">↵</kbd> open
                </span>
                <span className="cmdk-foot__brand">Catalyzed ⌘K</span>
              </div>
            </Command>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
