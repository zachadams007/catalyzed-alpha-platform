import { Suspense, lazy, useEffect } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { Loader } from "@/components/common/Loader";
// TodayFeed is the index redirect target (every "/" lands on "/today"), so it
// stays eager - lazy-loading it would just add a Suspense flash to first paint.
// The remaining lightweight feeds that share TodayFeed's deps are also eager so
// in-app feed↔feed navigation is instant.
import { TodayFeed } from "@/pages/TodayFeed";
import { WeeklyFeed } from "@/pages/WeeklyFeed";
import { ForYouFeed } from "@/pages/ForYouFeed";
import { FriendsFeed } from "@/pages/FriendsFeed";
import { Groups } from "@/pages/Groups";
import { PortfoliosPage } from "@/pages/PortfoliosPage";
import { WatchlistPage } from "@/pages/WatchlistPage";
import { StockDetail } from "@/pages/StockDetail";
import { TickerBeacon } from "@/pages/TickerBeacon";
import { MyDesk } from "@/pages/MyDesk";

// Heavy, non-default routes are code-split with React.lazy so /today's first
// paint never parses the Terminal / Heatmap / Admin / Performance / research
// surfaces a user may never open. Each is wrapped in <Suspense fallback={<Loader/>}>
// at the <Route> below (same proven pattern CoreGuide already uses under
// HashRouter). The Algorithm story (CoreGuide) is also the only consumer of
// gsap/ScrollTrigger/lenis - splitting it keeps that weight off every other page.
const CoreGuide = lazy(() =>
  import("@/pages/CoreGuide").then((m) => ({ default: m.CoreGuide })),
);
const Heatmap = lazy(() =>
  import("@/pages/Heatmap").then((m) => ({ default: m.Heatmap })),
);
const PortfolioDetail = lazy(() =>
  import("@/pages/PortfolioDetail").then((m) => ({ default: m.PortfolioDetail })),
);
const ResearchDesk = lazy(() =>
  import("@/pages/ResearchDesk").then((m) => ({ default: m.ResearchDesk })),
);
const SignalForge = lazy(() =>
  import("@/pages/SignalForge").then((m) => ({ default: m.SignalForge })),
);
const Terminal = lazy(() =>
  import("@/pages/Terminal").then((m) => ({ default: m.Terminal })),
);
// The per-ticker Terminal workspace is retired as a standalone page - every
// "open a stock" link now lands on the canonical stock page (/signal/:ticker),
// which carries the migrated Terminal data (AI brief, 8-K/insider, congress, news).
// Any remaining /terminal/:ticker link (movers, watchlist, earnings, command bar)
// redirects there so there's one consistent full stock page, never an isolated view.
// The query string is forwarded (not dropped) because the command bar's
// per-ticker actions rely on `?panel=` to deep-link to a section of the page.
function TickerRedirect() {
  const { ticker = "" } = useParams<{ ticker: string }>();
  const location = useLocation();
  return <Navigate to={`/signal/${ticker}${location.search}`} replace />;
}
const TerminalCompare = lazy(() =>
  import("@/pages/TerminalCompare").then((m) => ({ default: m.TerminalCompare })),
);
const TerminalSpread = lazy(() =>
  import("@/pages/TerminalSpread").then((m) => ({ default: m.TerminalSpread })),
);
const Admin = lazy(() =>
  import("@/pages/Admin").then((m) => ({ default: m.Admin })),
);
const Performance = lazy(() =>
  import("@/pages/Performance").then((m) => ({ default: m.Performance })),
);
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { initGroupsSync } from "@/store/useGroupsStore";
import { initPortfolioSync } from "@/data/supabase/portfolioSync";
import { initFriendsSync } from "@/data/supabase/friendsSync";
import { initNotesSync } from "@/data/supabase/notesSync";
import { initWatchlistSync } from "@/data/supabase/watchlistSync";
import { initPresence } from "@/data/supabase/presence";
import { syncOperatorSafetyFromAccount } from "@/data/operatorSafety";
import {
  initGlobalControls,
  subscribeGlobalControls,
  getGlobalControls,
  isGlobalControlsConfigured,
} from "@/data/globalControls";

export default function App() {
  const bootstrap = useAppStore((s) => s.bootstrap);
  const initAuth = useAuthStore((s) => s.init);
  const authReady = useAuthStore((s) => s.ready);
  const userId = useAuthStore((s) => s.userId);
  const email = useAuthStore((s) => s.email);

  // Restore any existing Supabase session, then wire cross-device portfolio sync
  // (both no-ops if auth isn't configured).
  useEffect(() => {
    void initAuth();
    initPortfolioSync();
    initFriendsSync();
    initNotesSync();
    initWatchlistSync();
    initPresence();
    initGroupsSync();
  }, [initAuth]);

  // Fail closed: do not select a provider or start research until the GLOBAL
  // operator controls (Supabase `app_controls`) have loaded. They govern the
  // whole app for every user - signed in OR anonymous - so a signed-out browser
  // can't ignore the operator's sample/pause choice. `syncOperatorSafetyFromAccount`
  // now defers to the global controls when configured (legacy per-operator
  // metadata sync only runs on an unconfigured dev build).
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    void initGlobalControls()
      .then(() => syncOperatorSafetyFromAccount())
      .then(({ changed }) => {
        if (cancelled) return;
        if (changed) {
          window.location.reload();
          return;
        }
        bootstrap();
      })
      .catch((err) => {
        // A failed global-controls load must NOT hang the app on a blank/skeleton
        // forever. The provider layer already fails closed (no live data, no mock
        // universe - a skeleton) while the controls cache is null, so still run
        // bootstrap: feeds render their honest "loading / data-unavailable" state
        // and the realtime/poll loop keeps retrying the controls fetch underneath.
        console.error("Global controls failed to load on boot", err);
        if (cancelled) return;
        bootstrap();
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, bootstrap, email, userId]);

  // React to a REMOTE operator flip (realtime/poll).
  //  • Sample-mode: the resolved provider switches mock↔live for everyone, so a
  //    reload is the safe way to re-run bootstrap with the new universe.
  //  • Active variant (the operator's "Promote → Champion", now GLOBAL): the
  //    universe is unchanged - only the ranking model changes - so we re-rank the
  //    live feed in place (no reload), making the promoted model go live for
  //    every client the moment the operator promotes.
  //  • Score-spread / quality-cap sliders: same in-place re-rank as the variant
  //    switch - the universe is unchanged, only the DISPLAY decompression/ceiling
  //    changes, so today's already-loaded names update live the moment the
  //    operator drags a dial, not just on the next full load.
  // All three guard against the operator's own optimistic echo: the variant/
  // sample checks track the last seen value explicitly, and
  // applyDisplayControlsChange() has its own internal "did the dial actually
  // move since the board was last ranked" guard - so it's safe (and cheap) to
  // call on every notify, including ones triggered by an unrelated field.
  useEffect(() => {
    if (!isGlobalControlsConfigured()) return;
    let lastSample = getGlobalControls()?.sampleMode ?? null;
    let lastVariant = getGlobalControls()?.activeVariant ?? null;
    const unsubscribe = subscribeGlobalControls(() => {
      const g = getGlobalControls();
      const nextSample = g?.sampleMode ?? null;
      const nextVariant = g?.activeVariant ?? null;
      if (lastSample !== null && nextSample !== null && nextSample !== lastSample) {
        window.location.reload();
        return;
      }
      // First resolution (controls were null at subscribe time, so `lastSample`
      // started null and the flip-reload above doesn't fire): if the resolved
      // choice is live but the store still holds mock signals from a pre-load
      // sample window, purge them so the fictional universe never lingers under a
      // Live badge (the boot-to-resolve TOCTOU). No-op when live isn't active or
      // the feed isn't mock-sourced.
      useAppStore.getState().clearMockSignalsIfLive();
      // Align the persisted registry with the global variant on the FIRST
      // resolution as well as on a later change: a client whose stored registry
      // still crowned V5 kept labelling V5 as live after a remote promotion to
      // V7 (the feed itself was already ranking with V7). The sync is idempotent.
      if (nextVariant !== null && nextVariant !== lastVariant) {
        useAppStore.getState().syncActiveVariantFromGlobal();
      }
      // Score-spread / quality-cap: no "last seen" tracking needed here - the
      // store action itself diffs against what the board was last ranked with.
      useAppStore.getState().applyDisplayControlsChange();
      lastSample = nextSample;
      lastVariant = nextVariant;
    });
    return unsubscribe;
  }, []);

  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/today" replace />} />
          <Route path="/today" element={<TodayFeed />} />
          <Route path="/weekly" element={<WeeklyFeed />} />
          <Route path="/for-you" element={<ForYouFeed />} />
          <Route path="/friends" element={<FriendsFeed />} />
          <Route path="/groups" element={<Groups />} />
          <Route
            path="/heatmap"
            element={
              <Suspense fallback={<Loader text="Mapping the market…" />}>
                <Heatmap />
              </Suspense>
            }
          />
          <Route path="/portfolios" element={<PortfoliosPage />} />
          <Route
            path="/portfolios/:id"
            element={
              <Suspense fallback={<Loader text="Opening portfolio…" />}>
                <PortfolioDetail />
              </Suspense>
            }
          />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route
            path="/research"
            element={
              <Suspense fallback={<Loader text="Opening research desk…" />}>
                <ResearchDesk />
              </Suspense>
            }
          />
          <Route path="/beacon" element={<TickerBeacon />} />
          <Route
            path="/forge"
            element={
              <Suspense fallback={<Loader text="Firing up the forge…" />}>
                <SignalForge />
              </Suspense>
            }
          />
          <Route
            path="/core"
            element={
              <Suspense fallback={<Loader text="Opening the algorithm…" />}>
                <CoreGuide />
              </Suspense>
            }
          />
          <Route path="/lookup" element={<Navigate to="/beacon" replace />} />
          <Route path="/desk" element={<MyDesk />} />
          <Route
            path="/admin"
            element={
              <Suspense fallback={<Loader text="Opening operator console…" />}>
                <Admin />
              </Suspense>
            }
          />
          <Route
            path="/performance"
            element={
              <Suspense fallback={<Loader text="Loading performance…" />}>
                <Performance />
              </Suspense>
            }
          />
          <Route
            path="/terminal"
            element={
              <Suspense fallback={<Loader text="Booting the terminal…" />}>
                <Terminal />
              </Suspense>
            }
          />
          <Route
            path="/terminal/spread"
            element={
              <Suspense fallback={<Loader text="Booting the terminal…" />}>
                <TerminalSpread />
              </Suspense>
            }
          />
          <Route
            path="/terminal/:a/vs/:b"
            element={
              <Suspense fallback={<Loader text="Booting the terminal…" />}>
                <TerminalCompare />
              </Suspense>
            }
          />
          <Route path="/terminal/:ticker" element={<TickerRedirect />} />
          <Route path="/social" element={<Navigate to="/terminal" replace />} />
          <Route path="/signal/:ticker" element={<StockDetail />} />
          <Route path="*" element={<Navigate to="/today" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
