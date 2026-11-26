import { execSync } from "node:child_process";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Build stamp - a short, human-checkable id for the bundle that's actually live.
// Injected into the client as `__BUILD_ID__` so the app can log/show it; lets us
// (and the owner) confirm at a glance which deploy a browser/PWA is really running,
// instead of guessing whether a cache is stale. Git SHA + UTC build minute.
function buildId(): string {
  let sha = "nogit";
  try {
    sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    /* not a git checkout (e.g. CI tarball) - fall back to the timestamp alone */
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${sha} · ${stamp}Z`;
}

// Compute ONCE so the value baked into the client (__BUILD_ID__) is byte-identical
// to the one written to /build-id.txt - the boot-time self-update check compares
// them, and a per-call timestamp drift would make every load think it's stale.
const BUILD_ID = buildId();

// Emit /build-id.txt next to index.html. Served no-store (see vercel.json), it lets
// the running client detect when a newer build has shipped and reload itself onto it
function emitBuildId(): Plugin {
  return {
    name: "catalyzed-emit-build-id",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build-id.txt", source: BUILD_ID });
    },
  };
}

/**
 * Keyless-web invariant guard (security, prevents a real P0).
 *
 * Vite inlines EVERY `VITE_`-prefixed env value into the public client bundle, so
 * a provider key placed in `.env.production.local` would be readable at View
 * Source. The production build is therefore intentionally KEYLESS: both the web
 * AND the desktop (Tauri) bundle are built with `vite build` (production mode),
 * which loads `.env.production.local` - where the provider keys are EMPTY and only
 * `VITE_MARKET_PROXY_URL` is set. So BOTH talk to vendors through the Supabase
 * market-proxy edge function; real Finnhub/FMP/Alpaca/Gemini keys live ONLY in
 * Supabase function secrets. (A few keyless sources - congress via
 * raw.githubusercontent.com, and SEC/Yahoo direct paths - bypass the proxy and so
 * must also be in the Tauri http allowlist; see src-tauri/capabilities/default.json.)
 * `.env` (no `.local`) carries real keys for `npm run dev` only.
 *
 * This plugin makes that invariant MECHANICAL: when a proxy URL is configured
 * (i.e. we're producing the web bundle), the build FAILS if any provider secret
 * VITE_ var is non-empty - so a leaked key can never silently ship.
 */
function keylessWebGuard(mode: string): Plugin {
  return {
    name: "catalyzed-keyless-web-guard",
    apply: "build",
    config() {
      const env = loadEnv(mode, process.cwd(), "");
      const proxy = (env.VITE_MARKET_PROXY_URL ?? "").trim();
      // No proxy configured → desktop-style build; keys are permitted there.
      if (!proxy) return;

      // Any VITE_ var that names an API key/secret/token must be empty in a
      // proxied (web) build. Matches VITE_FINNHUB_API_KEY, VITE_FMP_API_KEY,
      // VITE_ALPACA_API_KEY, VITE_ALPACA_API_SECRET, VITE_GEMINI_API_KEY, etc.
      // ANYWHERE in the name - the old `$`-anchored form silently missed the
      // rotation-pool suffixes (VITE_FINNHUB_API_KEY_2…_7, VITE_FMP_API_KEY_2…_4)
      // and VITE_GEMINI_API_KEY_BACKUP, which the client genuinely reads: a real
      // key in any of those would have inlined into the public bundle unguarded
      // (pre-commercial audit 2026-07-03).
      const secretLike = /^VITE_.*(API_KEY|API_SECRET|_SECRET|_TOKEN)/i;
      // Boolean FLAGS that are merely key-*named*: VITE_GEMINI_API_KEY_BACKUP=1
      // tells the client "the proxy holds a backup key server-side" (apiUsage.ts) -
      // the value is a truthy marker, never the key itself. Allow ONLY literal
      // flag values in such vars; anything key-shaped still fails the build.
      const flagValue = /^(1|true)$/i;
      const leaked = Object.entries(env)
        .filter(([k, v]) => {
          const val = (v ?? "").trim();
          return secretLike.test(k) && val !== "" && !flagValue.test(val);
        })
        .map(([k]) => k);

      if (leaked.length > 0) {
        throw new Error(
          "[keyless-web-guard] Refusing to build the web bundle: VITE_MARKET_PROXY_URL " +
            "is set (web build), but these provider-secret env vars are non-empty and " +
            "would be inlined into the PUBLIC bundle (readable at View Source): " +
            `${leaked.join(", ")}. Move real keys to Supabase function secrets / the ` +
            "gitignored desktop .env and leave them empty in the web build env.",
        );
      }
    },
  };
}

// Vite config tuned for Tauri (fixed dev port, no clearing the Rust logs).
// https://tauri.app/start/frontend/vite/
export default defineConfig(({ mode }) => ({
  plugins: [react(), keylessWebGuard(mode), emitBuildId()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    // Pin to IPv4 so the Tauri webview (which hits 127.0.0.1 on Windows) can
    // reach the dev server. `host: false` binds only IPv6 [::1] and the desktop
    // window loads a blank/unreachable page.
    host: "127.0.0.1",
    watch: {
      // Don't watch the Rust source from the web dev server.
      ignored: ["**/src-tauri/**"],
    },
    // SEC EDGAR proxy (dev only). EDGAR's full-text search (efts.sec.gov) drops
    // its CORS header when an Origin is present, so a browser can't call it
    // directly - only the Tauri desktop build can (no browser CORS there). This
    // proxy lets the Terminal's SEC 8-K source work in `npm run dev` too: it
    // forwards a compliant User-Agent (SEC requires one) and strips the browser
    // Origin/Referer so EDGAR responds. See src/data/terminal/edgar8k.ts.
    proxy: {
      "/__sec": {
        target: "https://efts.sec.gov",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/__sec/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader(
              "User-Agent",
              "Catalyzed Alpha research contact@example.com",
            );
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        },
      },
      // Yahoo Finance chart API (dev only). Yahoo drops its CORS header when an
      // Origin is present, so a browser can't call query1.finance.yahoo.com
      // directly - only the Tauri desktop build can (no browser CORS). This proxy
      // lets the keyless TSX/US quote+chart path work in `npm run dev` too: it
      // forwards a browser User-Agent and strips the Origin/Referer so Yahoo
      // responds. See src/data/prices/yahooChart.ts.
      "/__yahoo": {
        target: "https://query1.finance.yahoo.com",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/__yahoo/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("User-Agent", "Mozilla/5.0 (Catalyzed Alpha research)");
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        },
      },
    },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split long-lived third-party code into its own vendor chunk so it
        // caches across deploys (app code changes far more often than these
        // libs). Combined with the route-level React.lazy splits in App.tsx,
        // this keeps the eager index chunk small instead of shipping one ~2.97MB
        // bundle.
        //
        // gsap/lenis must ride along with the lazy CoreGuide chunk - the
        // Algorithm story is their ONLY consumer. This comment used to SAY that,
        // but the trailing `return "vendor"` catch-all quietly pinned them into
        // the eager vendor chunk anyway, so every user paid ~45-50KB gzip on
        // first load for a page most never open. The early `return undefined`
        // below fixes that. The router/motion regexes also only matched the
        // parent package name, so `@remix-run/router` and `motion-dom` /
        // `motion-utils` fell into the catch-all and defeated the per-library
        // cache isolation this config exists to provide.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // Lazy-route-only libs (the Algorithm story is their only consumer):
          // hand them back to Rollup so they follow the dynamic import into the
          // CoreGuide chunk instead of being pinned into the eager vendor chunk.
          if (/[\\/]node_modules[\\/](gsap|lenis)[\\/]/.test(id)) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "vendor-react";
          }
          if (/[\\/]node_modules[\\/](react-router(-dom)?|@remix-run[\\/]router)[\\/]/.test(id)) {
            return "vendor-router";
          }
          if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) {
            return "vendor-supabase";
          }
          if (/[\\/]node_modules[\\/](framer-motion|motion|motion-dom|motion-utils)[\\/]/.test(id)) {
            return "vendor-motion";
          }
          return "vendor";
        },
      },
    },
  },
}));
