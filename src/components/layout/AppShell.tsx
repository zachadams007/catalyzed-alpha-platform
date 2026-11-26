import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { DeskRunIndicator } from "@/components/research/DeskRunIndicator";
import { TopBar } from "./TopBar";
import { ToastHost } from "./ToastHost";
import { ResearchNarrator } from "./ResearchNarrator";
import { DataSourceGate } from "./DataSourceGate";
import { CommandBar } from "@/components/terminal/CommandBar";
import { RouteErrorBoundary } from "@/components/common/RouteErrorBoundary";
import { isDataSourceConfigured, isProviderResolutionPending } from "@/data/providers";
import { useSampleDataMode } from "@/hooks/useSampleDataMode";
import { useSocialNotifications } from "@/hooks/useSocialNotifications";

// Pages that explain setup and can still render with no data configured.
const ALLOWED_WHEN_UNCONFIGURED = new Set(["/core", "/research"]);

// Immersive pages that escape the centered 1180px column and the page-enter
// transform (a transformed ancestor would break scroll-pinned scenes).
const FULL_BLEED = new Set(["/core"]);

// Workbench pages that keep the centered column but earn a wider cap - the
// Blueprint cockpit runs two live columns and wants the horizontal room.
const WIDE = new Set(["/forge"]);

// The Market Map is a near-full-width discovery surface (treemap + summary tape).
const MAP = new Set(["/heatmap"]);

/** Top-level chrome: persistent sidebar + topbar wrapping the routed page. */
export function AppShell() {
  const { pathname } = useLocation();
  const contentRef = useRef<HTMLElement>(null);

  // The app shell scrolls its own pane (.content), not the window - so reset
  // THAT element to the top on every route change, otherwise a new tab inherits
  // the previous tab's scroll position. Instant (no smooth) so the new page
  // simply starts at the top.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname]);

  // Subscribe to the operator's global controls so this shell RE-RENDERS when the
  // pending → live transition resolves (otherwise the gate below snapshots a stale
  // pre-load read and gets stuck).
  useSampleDataMode();
  // Surface friend-request / group-invite / share events as bottom-right toasts -
  // including ones that arrived while the app was closed (fires on reopen).
  useSocialNotifications();
  // Distinguish "global controls still loading" (pending) from "genuinely no data
  // source configured". During the pending window we must render the route - which
  // shows cached real signals instantly or its own skeleton - NOT the "Live data
  // isn't enabled in this build" gate, which previously flashed on every boot of
  // the keyless build (proxy + cloud cache ARE a valid live source).
  const pending = isProviderResolutionPending();
  const configured = isDataSourceConfigured();
  const showGate = !pending && !configured && !ALLOWED_WHEN_UNCONFIGURED.has(pathname);
  const bleed = FULL_BLEED.has(pathname) && !showGate;
  // The Terminal security workspace (/terminal/:ticker) runs a dense panel board
  // and earns the wider cap, like the Blueprint cockpit.
  const wide = (WIDE.has(pathname) || pathname.startsWith("/terminal/")) && !showGate;
  const map = MAP.has(pathname) && !showGate;

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <Sidebar />
      <div className="main">
        <TopBar />
        <main className="content" id="main-content" tabIndex={-1} ref={contentRef}>
          <div
            className={`content__inner page-view${bleed ? " content__inner--bleed" : ""}${wide ? " content__inner--wide" : ""}${map ? " content__inner--map" : ""}`}
            key={pathname}
          >
            <ResearchNarrator />
            {showGate ? (
              <DataSourceGate />
            ) : (
              <RouteErrorBoundary resetKey={pathname}>
                <Outlet />
              </RouteErrorBoundary>
            )}
          </div>
        </main>
      </div>
      <ToastHost />
      <CommandBar />
      <DeskRunIndicator />
    </div>
  );
}
