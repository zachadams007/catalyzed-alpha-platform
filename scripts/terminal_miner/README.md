# Terminal Miners - SEC & Market Data Scripts

Standalone Python 3 scripts (stdlib only, no pip installs) that fetch free public
financial data and emit **normalized JSON to stdout**. Each script:

- Requires **no API key**.
- Uses a descriptive `User-Agent` per source's responsible-access policy.
- Rate-limits itself (≥ 0.15 s between requests for SEC; ≥ 0.25 s for third-party).
- Handles gzip responses transparently.
- Prints warnings to stderr and exits cleanly on partial or total failure.

---

## `wire_writer.py` - the Terminal wire CACHE WRITER (web/phone parity)

This is the piece that makes the Terminal **wire** render on a production
web/phone build. That bundle ships no vendor keys and has no `/__sec` dev proxy,
so it reads the wire from the `terminal-feed` edge function, which serves the
Supabase `terminal_events` cache. `wire_writer.py` is that cache's **writer**: it
crawls the wire sources once (the "offload API usage to Python" play - every
client then reads the cache cheaply instead of each hammering the vendors),
normalizes to the same `TerminalEvent` contract the desktop produces, and upserts
with the **service-role key**.

Sources (each degrades to `[]` independently - one dead source never blanks the wire):

| Source | Key? | Notes |
|--------|------|-------|
| SEC 8-K full-text (`efts.sec.gov`) | keyless | port of `src/data/terminal/edgar8k.ts` |
| SEC Form 4 insider | keyless | reuses `form4_miner.py` |
| FMP congress (`senate-latest`+`house-latest`) | `FMP_API_KEY` | port of `politicianTrades.ts` |
| Alpaca news wire | `ALPACA_API_KEY` + `_SECRET` | port of `alpacaWire.ts` |

Severity/headline logic is a faithful port of `src/data/terminal/severity.ts`
(kept in sync; covered by `test_wire.py`).

### Verify without writing (no service-role key needed)

```bash
python scripts/terminal_miner/wire_writer.py --dry-run --no-congress --no-news --verbose
python scripts/terminal_miner/test_wire.py        # offline unit tests
```

### Write the cache (a scheduled tick)

Set the server-only env (NEVER in the client bundle / `.env`):

```bash
SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...        # required (service-role!)
FMP_API_KEY=...   ALPACA_API_KEY=...  ALPACA_API_SECRET=...   # optional (keyed sources)
python scripts/terminal_miner/wire_writer.py --once
```

| Flag | Meaning |
|------|---------|
| `--once` | single pass (default; what a cron tick runs) |
| `--loop N` | re-run every N seconds (fallback scheduler; prefer OS cron) |
| `--dry-run` | gather + normalize, print counts, **no write** |
| `--no-8k` / `--no-insider` / `--no-congress` / `--no-news` | skip a source |
| `--limit-8k` / `--limit-insider` / `--limit-news` | per-source caps |

### Schedule it (Windows)

1. `cp scripts/terminal_miner/.writer.env.example scripts/terminal_miner/.writer.env`
   and fill it in (gitignored; holds the service-role key).
2. Register the Scheduled Task that runs `run_writer.ps1` every 30 min - the exact
   `Register-ScheduledTask` command is in the header of
   [`run_writer.ps1`](./run_writer.ps1). It loads `.writer.env`, runs one pass, and
   appends to `wire_writer.log`.

On macOS/Linux, a crontab line works the same way:
`*/30 * * * * cd /path/to/repo && SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python scripts/terminal_miner/wire_writer.py --once`.

### Deploy the read side

The cache is only useful once the table + edge function exist. Push the
migrations and deploy `terminal-feed`, `research-agent` and `market-proxy`
with the Supabase CLI. Then set
`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (public, safe in the bundle) so the
web build's `cacheFeed.ts` reads the wire.

---

## `form4_miner.py` - SEC Form 4 insider trades

Scans the SEC EDGAR Form 4 feed for recent insider purchases (`P`) and sales (`S`).

### Run

```bash
python scripts/terminal_miner/form4_miner.py --limit 20
python scripts/terminal_miner/form4_miner.py --limit 80 --min-value 100000 --out form4.json
```

### Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--limit N` | 80 | Number of recent Form 4 filings to scan |
| `--min-value N` | - | Drop transactions whose dollar value is below N |
| `--out PATH` | - | Also write JSON to this file |

### Output schema

```json
[
  {
    "id": "ACME-Jane Doe-2026-06-09-1000",
    "kind": "insider_buy",
    "ticker": "ACME",
    "companyName": "Acme Corp",
    "severity": "watch",
    "headline": "Jane Doe bought 1,000 sh ACME ($25,500)",
    "summary": "Officer: CEO; Director",
    "actor": {
      "name": "Jane Doe",
      "role": "Officer: CEO; Director"
    },
    "trade": {
      "direction": "buy",
      "shares": 1000,
      "pricePerShare": 25.5,
      "valueUsd": 25500.0,
      "code": "P"
    },
    "occurredAt": "2026-06-09",
    "surfacedAt": "2026-06-10T12:34:56-04:00",
    "source": {
      "name": "SEC Form 4 - EDGAR",
      "url": "https://www.sec.gov/Archives/edgar/data/..."
    },
    "reason": "Open-market insider purchase"
  }
]
```

---

## `edgar_8k_miner.py` - SEC EDGAR 8-K material event filings by ticker

Resolves one or more tickers to their EDGAR CIK, then fetches the company's
filing history and returns all 8-K and 8-K/A filings within a look-back window.
Item numbers (2.02, 5.02, …) are decoded into human-readable descriptions.

**Sources used:**

| URL | Purpose |
|-----|---------|
| `https://www.sec.gov/files/company_tickers.json` | Ticker → CIK lookup (cached per process) |
| `https://data.sec.gov/submissions/CIK{cik}.json` | Per-company filing index with item codes |

### Run

```bash
python scripts/terminal_miner/edgar_8k_miner.py AAPL
python scripts/terminal_miner/edgar_8k_miner.py AAPL MSFT GOOGL --days 30
python scripts/terminal_miner/edgar_8k_miner.py TSLA --limit 10 --out tsla_8k.json
```

### Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `tickers` (positional) | required | One or more stock tickers |
| `--limit N` | 20 | Max 8-K filings to return **per ticker** |
| `--days N` | 90 | Look-back window in calendar days |
| `--out PATH` | - | Also write JSON to this file |

### Output schema

```json
[
  {
    "id": "AAPL-0000320193-24-000010",
    "kind": "8k_filing",
    "ticker": "AAPL",
    "companyName": "Apple Inc.",
    "cik": "320193",
    "filedAt": "2026-05-01",
    "accessionNo": "0000320193-26-000010",
    "formType": "8-K",
    "items": ["2.02", "9.01"],
    "itemDescriptions": [
      "Item 2.02: Results of Operations / Financial Condition",
      "Item 9.01: Financial Statements and Exhibits"
    ],
    "sourceUrl": "https://www.sec.gov/Archives/edgar/data/320193/..."
  }
]
```

**Notes:**

- Results are sorted newest-first across all requested tickers.
- The EDGAR submissions index holds roughly the last 1,000 filings. Very old 8-Ks
  (> ~3–5 years depending on the company) may be in separate paginated files and
  are not fetched by this script.
- On first run the 1.7 MB `company_tickers.json` file is downloaded; subsequent
  tickers within the same invocation reuse the in-memory cache.

---

## `movers_miner.py` - Most-active / top-gainers / top-losers

Returns a ranked list of stocks from a public screener.

**Primary source:** Yahoo Finance screener JSON API (automatically handles the
cookie + crumb session their web app uses).

**Fallback:** Finviz HTML screener (stdlib `html.parser`), used if Yahoo Finance
is unreachable or returns an empty result.

### Run

```bash
python scripts/terminal_miner/movers_miner.py
python scripts/terminal_miner/movers_miner.py --type gainers --limit 50
python scripts/terminal_miner/movers_miner.py --type losers --out losers.json
```

### Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--type` | `most-active` | `most-active`, `gainers`, or `losers` |
| `--limit N` | 25 | Maximum number of stocks to return |
| `--out PATH` | - | Also write JSON to this file |

### Output schema

```json
[
  {
    "rank": 1,
    "ticker": "GME",
    "companyName": "GameStop Corp.",
    "price": 25.50,
    "changeAbs": 5.25,
    "changePct": 25.9,
    "volume": 45000000,
    "avgVolume30d": 8000000,
    "marketCapRaw": 8500000000,
    "screenerType": "most-active",
    "fetchedAt": "2026-06-11T12:00:00Z",
    "source": "yahoo_finance",
    "sourceUrl": "https://finance.yahoo.com/most-active"
  }
]
```

**Notes:**

- `changeAbs` and `avgVolume30d` may be `null` when the Finviz fallback is active
  (Finviz's basic view does not expose raw change or average volume directly).
- `marketCapRaw` is in USD as a raw integer/float (not a formatted string).
- The script does not store cookies between invocations. Each run re-establishes
  the Yahoo Finance session (two lightweight requests before the screener call).

---

## `earnings_miner.py` - Earnings calendar

Returns upcoming or historical earnings announcements for a date range.

**Primary source:** Nasdaq public earnings calendar API (`api.nasdaq.com`).

**Fallback:** Yahoo Finance earnings calendar API.

### Run

```bash
# Today's earnings
python scripts/terminal_miner/earnings_miner.py

# Specific date
python scripts/terminal_miner/earnings_miner.py --date 2026-06-16

# Current calendar week (Mon–Fri)
python scripts/terminal_miner/earnings_miner.py --week

# Next 5 trading days from a start date
python scripts/terminal_miner/earnings_miner.py --date 2026-06-16 --days 5 --out week.json
```

### Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--date YYYY-MM-DD` | today | Start date to fetch |
| `--week` | - | Fetch the current Mon–Fri calendar week (overrides `--date`) |
| `--days N` | 1 | Number of calendar days to fetch from `--date` |
| `--out PATH` | - | Also write JSON to this file |

`--date` and `--week` are mutually exclusive. Weekend dates are automatically
skipped (no earnings reported Sat/Sun).

### Output schema

```json
[
  {
    "id": "AAPL-2026-06-16",
    "kind": "earnings",
    "ticker": "AAPL",
    "companyName": "Apple Inc.",
    "reportDate": "2026-06-16",
    "reportTime": "after-hours",
    "fiscalQuarterEnding": "Jun 2026",
    "epsEstimate": 1.45,
    "numAnalysts": 30,
    "lastYearEps": 1.46,
    "lastYearReportDate": "2025-07-31",
    "source": "nasdaq",
    "sourceUrl": "https://www.nasdaq.com/market-activity/earnings"
  }
]
```

**Field notes:**

| Field | Values |
|-------|--------|
| `reportTime` | `"pre-market"`, `"after-hours"`, `"TBA"` |
| `epsEstimate` | Analyst consensus EPS estimate; `null` if unavailable |
| `numAnalysts` | Number of analyst estimates in the consensus; `null` if unavailable |
| `lastYearEps` | Prior-year same-quarter EPS; `null` if unavailable |
| `source` | `"nasdaq"` (primary) or `"yahoo_finance"` (fallback) |
