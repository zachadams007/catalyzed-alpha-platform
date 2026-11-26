import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "@/components/common/AppErrorBoundary";
import { initElfsightMobileFix } from "@/lib/elfsightMobileFix";

// Self-hosted fonts (offline-safe for the Tauri desktop shell).
// Geist = body/UI face (replaces Inter); Space Grotesk = distinctive display face.
import "@fontsource-variable/geist";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/avatar.css";
import "./styles/forge-live.css";
import "./styles/portfolio-detail.css";
import "./styles/stock-detail.css";
import "./styles/watchlist.css";
import "./styles/ops.css";
import "./styles/operator-controls.css";
import "./styles/performance.css";
import "./styles/terminal.css";
// algorithm.css is imported by AlgorithmStory so it code-splits with /core.

// Global last-resort observability for ASYNC failures. React error boundaries
// only catch render-phase throws - fire-and-forget promises (scheduled research,
// realtime binding, portfolio/notes sync, presence init) and stray runtime
// errors bypass them entirely and would otherwise vanish silently, masking real
// provider/Supabase outages. Log them loudly (and visibly in dev) so a broken
// data path is observable instead of a quiet no-op.
window.addEventListener("unhandledrejection", (event) => {
  console.error("[App] unhandled promise rejection:", event.reason);
});
window.addEventListener("error", (event) => {
  // `error` is undefined for some resource-load failures (e.g. <img>/<script>);
  // fall back to the event's message so the log is never empty.
  console.error("[App] uncaught error:", event.error ?? event.message);
});

// iOS standalone PWA full-bleed is handled in pure CSS now: the mobile shell uses
// `height: 100lvh` (the LARGE viewport = the full physical screen in a standalone PWA,
// where dvh under-reports). Verified on-device: dvh 873 vs lvh 932 = the real screen.
// No JS measurement needed - see components.css .app-shell.

// Announce the live build id (git SHA + UTC build minute) on boot.
console.info(`%cCatalyzed Alpha build ${__BUILD_ID__}`, "color:#c9a227;font-weight:600");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);

// Register the PWA service worker only in a real browser build - never inside the
// Tauri desktop webview, and not in dev (it would fight Vite HMR).
// The PWA service worker has been REMOVED - it pinned users to stale builds (a
// warm iOS standalone PWA never re-navigates, so deploys never showed) and offline
// caching is useless for an app that needs the network for live quotes/signals.
// We no longer register one. We DO actively unregister any SW a previous build
// installed: update() fetches the new kill-switch sw.js, which purges caches,
// unregisters itself, and reloads the page onto the fresh, SW-free build. No-op on
// devices that never had one. Skipped inside the Tauri desktop shell.
const isTauriShell = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
if (!isTauriShell && "serviceWorker" in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.forEach((reg) => reg.update().catch(() => {})))
    .catch(() => {});
}

// Self-update on boot (web/PWA only). Here we fetch the freshly-deployed build id (no-store, so
// it bypasses every cache) and, if it differs from the one compiled into THIS bundle, reload
// once onto the new build. Loop-safe: a sessionStorage flag keyed to the target id guarantees we
// reload at most once per new version per session, even in the pathological case where the
// reload somehow doesn't pick up the new bundle.
if (!isTauriShell) {
  void (async () => {
    try {
      const res = await fetch(`/build-id.txt?_=${__BUILD_ID__}`, { cache: "no-store" });
      if (!res.ok) return;
      const deployed = (await res.text()).trim();
      if (!deployed || deployed === __BUILD_ID__) return;
      const guard = `ca:reloaded-for:${deployed}`;
      if (sessionStorage.getItem(guard)) return; // already tried this id - don't loop
      sessionStorage.setItem(guard, "1");
      console.info(`[App] newer build ${deployed} available — reloading from ${__BUILD_ID__}`);
      location.reload();
    } catch {
      /* offline or fetch blocked - keep the current build, no harm */
    }
  })();
}

// The Elfsight chatbot is WEB/MOBILE only. Inside the Tauri DESKTOP shell, strip the
// external CDN embed and never run the shadow-DOM observer: that observer walks the
// DOM on every mutation and, in the WebView2 desktop shell, can starve the main
// thread enough that the boot `app_controls` fetch stalls - leaving the app fail-
// closed ("API access off", nothing loads). The desktop doesn't need the chatbot,
// so remove it as a variable entirely. Web/mobile are unchanged.
if (isTauriShell) {
  document
    .querySelectorAll('script[src*="elfsightcdn.com"], [class*="elfsight-app-"], #__EAAPS_PORTAL')
    .forEach((n) => n.remove());
} else {
  initElfsightMobileFix();
}
