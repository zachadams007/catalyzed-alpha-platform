/// <reference types="vite/client" />

// Typed environment variables (all optional; the app runs without any of them).
interface ImportMetaEnv {
  readonly VITE_DATA_PROVIDER?: string;
  readonly VITE_RESEARCH_RUN_HOUR?: string;
  readonly VITE_ALPHAVANTAGE_API_KEY?: string;
  readonly VITE_FINNHUB_API_KEY?: string;
  readonly VITE_POLYGON_API_KEY?: string;
  readonly VITE_FMP_API_KEY?: string;
  readonly VITE_NEWSAPI_KEY?: string;
  readonly VITE_MARKETAUX_API_KEY?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Build stamp injected by vite.config.ts `define` - git SHA + UTC build minute.
// Lets the running app report exactly which deploy it is, so a stale cache is
// diagnosable by looking instead of guessing.
declare const __BUILD_ID__: string;
