// Quick environment probe for the daily scan - prints BOOLEANS only (never key
// values). Validates that (a) the bootstrap import-order disables sample-mode in
// Node, and (b) which vendor keys + Supabase creds are configured.
//
//   npm run scan:probe   (run through run_scan.ps1 so the current keys are set)
import "./bootstrap.mjs";

import { isFinnhubConfigured, isAlpacaConfigured, isFmpConfigured } from "@/data/http";
import { isSampleDataModeEnabled } from "@/data/providers/sampleDataMode";

const env = import.meta.env as Record<string, string | undefined>;

console.log(
  JSON.stringify(
    {
      sampleModeEnabled: isSampleDataModeEnabled(), // MUST be false for live fetches
      finnhubConfigured: isFinnhubConfigured(),
      alpacaConfigured: isAlpacaConfigured(),
      fmpConfigured: isFmpConfigured(),
      hasSupabaseUrl: Boolean(env.VITE_SUPABASE_URL || process.env.SUPABASE_URL),
      hasServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    null,
    2,
  ),
);
process.exit(0);
