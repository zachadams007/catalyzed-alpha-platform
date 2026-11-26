/**
 * SEC EDGAR endpoint resolver - the fix for "catalysts never reach the cloud board".
 *
 * SEC blocks datacenter IPs: the GitHub Actions daily scan got 0 results from EDGAR
 * (8-K / 13D / Form-4) even with absolute URLs + a compliant User-Agent. When a SEC
 * proxy is configured we route SEC through the Supabase market-proxy's `/sec` path -
 * its `secOrigin()` relays to the right subdomain BY PATH (efts/www/data) from an
 * allowed IP and attaches the fair-access UA. This is SEC-ONLY: the keyed vendors
 * (Finnhub/Alpaca/FMP) are untouched and keep their direct/keyed path.
 *
 * Resolution order:
 *   1. proxy - `VITE_SEC_PROXY_URL` (or `VITE_MARKET_PROXY_URL`): `<proxy>/sec<path>`
 *   2. direct - Node (the scan, vite-node) or Tauri desktop: `https://<sub>.sec.gov<path>`
 *   3. dev - browser dev server: the Vite `/__sec` proxy (efts only; www/data direct)
 */
function secProxyBase(): string {
  const env = import.meta.env as Record<string, string | undefined>;
  const v = (env.VITE_SEC_PROXY_URL ?? "").trim() || (env.VITE_MARKET_PROXY_URL ?? "").trim();
  return v.replace(/\/+$/, "");
}

export function secEndpoint(sub: "efts" | "www" | "data", path: string): string {
  const proxy = secProxyBase();
  if (proxy) return `${proxy}/sec${path}`;
  const isBrowser = typeof window !== "undefined";
  const desktop = isBrowser && "__TAURI__" in window;
  if (!isBrowser || desktop) return `https://${sub}.sec.gov${path}`;
  // Browser dev: only efts has a Vite proxy (CORS); www/data fetch absolute.
  return sub === "efts" ? `/__sec${path}` : `https://${sub}.sec.gov${path}`;
}
