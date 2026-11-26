# `market-proxy` edge function

The production replacement for "vendor keys in the client bundle". A web/phone
build sets `VITE_MARKET_PROXY_URL` to this function's URL; the client seam
([`src/data/marketProxy.ts`](../../../src/data/marketProxy.ts)) rewrites every
recognized vendor call to `<proxy>/<vendorId>/<path>?<query-without-secrets>` and
strips its own secrets. This function re-attaches the real key server-side,
forwards the GET, and streams the response back - so the per-ticker workspace,
`MoversPane`, and `EarningsCalendarPane` work on a keyless bundle. It is also the
production replacement for the dev-only `/__sec` Vite proxy (relays EDGAR + adds
the fair-access User-Agent).

Keep `UPSTREAM` in sync with `VENDOR_UPSTREAM` in `src/data/marketProxy.ts`.

## Secrets (server-side only - never `VITE_*`)

```bash
supabase secrets set \
  FMP_API_KEY=...        FINNHUB_API_KEY=... \
  ALPACA_API_KEY=...     ALPACA_API_SECRET=... \
  SEC_CONTACT="Your Name you@example.com"
```

Keyless vendors (`yahoo`, `sec`, `stocktwits`, `apewisdom`) need no secret;
`sec` only needs the `SEC_CONTACT` User-Agent.

## Deploy

```bash
# No Supabase auth header is sent by the seam, so disable JWT verification.
supabase functions deploy market-proxy --no-verify-jwt
```

## Safety posture

- **GET + OPTIONS only** - an injected key can never ride a write.
- **Vendor allowlist** - unknown first path segment → `404` (never an open relay).
- **TODO (hardening):** a per-`(vendor, day)` rate ceiling in a KV store →
  `429` + `Retry-After` when exceeded. For ~10-friend traffic the allowlist +
  GET-only posture is sufficient; revisit before any public launch.
