# Daily broad-universe scan

Computes the day's **broad U.S. universe** once and publishes it to the shared
`daily_signals` Supabase cache, so every tester reads the same result with **zero
vendor API calls**. This is what replaced the old ~75-name curated cap.

## What it does

```
Finnhub /stock/symbol?exchange=US   → a broad US common-stock response (~thousands)
        ↓  (src/data/finnhub/symbolList.ts)
Alpaca /v2/stocks/snapshots (batched) → price / prev-close / $volume / range
        ↓  (src/data/alpaca/snapshots.ts)
preRankUniverse()                    → price + liquidity floors, anti-megacap blend
        ↓  (src/engine/preRank.ts)            → top ~500 names
fetchFinnhubCompany + live enrichers → real price, history, fundamentals, news
        ↓  (the SAME engine the app uses)
scoreCompany + toStockSignal         → the real 0–100 scores  (src/engine)
        ↓
daily_signals upsert (service role)  → shared cache the clients read unchanged
```

Scoring/ranking is the real, pure engine - never re-implemented. Every published
name carries a **real Alpaca price** even if Finnhub throttles a fundamentals/news
lane (those degrade to the modeled value, the name still appears).

## Run it locally

```bash
cp scripts/universe_scan/.scan.env.example scripts/universe_scan/.scan.env   # fill in keys
powershell -ExecutionPolicy Bypass -File scripts\universe_scan\run_scan.ps1   # full run + publish
powershell ... run_scan.ps1 -Dry      # compute + print; local archive only, no remote/board publish
powershell ... run_scan.ps1 -Probe    # print env booleans only (no keys)
```

`run_scan.ps1` loads `.scan.env` into the process env **before** `vite-node`, so
the current `VITE_*` keys win over any stale value in the app's `.env`.

### Env knobs

| Var | Default | Meaning |
| --- | --- | --- |
| `UNIVERSE_TARGET` | 500 | Top-N names to fully score & publish |
| `SCAN_MIN_PRICE` | 1.5 | Price floor (drops sub-penny junk) |
| `SCAN_MIN_DOLLAR_VOLUME` | 2000000 | Liquidity floor ($/day) |
| `SEED_GAP_MS` | 350 | Pacing between Finnhub seed builds |
| `SCAN_LIMIT_SYMBOLS` | 0 | Cap the symbol universe (testing only) |
| `SCAN_DRY_RUN` | off | Compute + print, don't publish |
| `LEARNING_ARCHIVE_ROOT` | `scripts/universe_scan/learning-archive` | Optional local immutable archive root |
| `CATALYZED_CODE_REVISION` | current git HEAD locally / `${{ github.sha }}` in Actions | Source revision bound into the artifact |

## Prospective learning-universe archive

Every scan creates a unique source-run ID before its first provider request. At
the pre-rank boundary it captures every normalized snapshot observation returned
for the requested source universe, including rows that fail the floor. The
`floor pass OR seed bypass` eligible membership and the smaller expensive-
enrichment selection are recorded separately. This is a prospective evidence
stream only: old `daily_signals` rows and `last-scan.json` files are never
promoted or backfilled as candidate-universe history.

The content-addressed JSON contains only an allowlisted raw decision DTO:

- sanitized Finnhub and Alpaca request audits, including exact requested,
  missing, and unexpected membership;
- normalized eligibility configuration, source/request membership, all returned
  candidate rows, recomputed eligible membership, and the selected-for-enrichment
  subset;
- separate source kind and timestamp for price, prior close, liquidity, and
  range, plus the pre-rank score as decision metadata;
- source revision, capture/decision timestamps, run attempt, admissibility, and
  mechanically derived quarantine reasons.

It never contains provider keys/headers/URLs/errors, synthetic series, enriched
scores, fundamentals, news/social material, catalysts, outcome labels, or future
prices. The 1,001-name Finnhub floor detects a common truncation shape but cannot
prove complete current membership, so even a floor-passing run is explicitly
quarantined as `finnhub_universe_completeness_unproven`. Missing provider batches,
fallback/capped/dry inputs, incomplete field provenance, and unverified revisions
add their own quarantine reasons. Audit/recovery can inspect every accepted and
rejected candidate; the future verified learning bridge rejects quarantined runs.

Local files are staged, flushed, published without replacement, and rehashed.
The source-run ID is separately bound to one digest so a retry is idempotent but
different bytes are fatal. Migration `0027_learning_universe_artifacts.sql`
adds the private service-role-only, insert-only remote store with mutation
triggers and read-after-write verification. `archiveStatus`, `localStatus`, and
`remoteStatus` remain separate in scan metadata; an archive failure never changes
the published signal values/order or blocks the daily board.

GitHub Actions also retains the local artifact/claim directory for 90 days when
remote persistence is unavailable. The recovery publisher verifies freshness,
source-run identity, filename, schema, digest, and canonical bytes before retrying
the archive. Legacy saved boards can still recover `daily_signals`, but they are
explicitly reported as having no learning artifact - no fake history is created.

The wrapper also requires recovery data to be from the same US/Eastern civil day,
even when the source-run ID matches, and rejects runs started before this wrapper
invocation. Weekend scans use the weekend decision time while preserving each
field's actual provider timestamp (often Friday); no market session date is
inferred. A dry run writes only a quarantined local artifact. A dirty local
checkout is likewise revision-quarantined instead of being falsely attributed to
HEAD.

## Schedule it

**Cloud (preferred) - GitHub Actions:** `docs/ops/daily-universe.workflow.yml`,
copied to `.github/workflows`, runs daily (including weekends) once the Action secrets
are set (mirror `.scan.env`). Runs even when no machine is on. That workflow is
the **pre-market board publisher**.

**Learning clock (after US close) - Windows Scheduled Task:** use
`run_learning_clock.ps1` so each capture is a sealed data record and each
artifact digest is RFC 3161-timestamped via FreeTSA ($0). Captures remain
quarantined as `finnhub_universe_completeness_unproven` until the independent
directory proof in `docs/LEARNING-UNIVERSE-ARCHIVE.md` is wired into admission.

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
             -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PWD\scripts\universe_scan\run_learning_clock.ps1`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 4:30PM
Register-ScheduledTask -TaskName "CatalyzedLearningClock" -Action $action -Trigger $trigger
# Remove later:  Unregister-ScheduledTask -TaskName "CatalyzedLearningClock" -Confirm:$false
```

**Local board-only task** (the older `CatalyzedTerminalWire` pattern):

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
             -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PWD\scripts\universe_scan\run_scan.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At 8:00AM
Register-ScheduledTask -TaskName "CatalyzedUniverseScan" -Action $action -Trigger $trigger
# Remove later:  Unregister-ScheduledTask -TaskName "CatalyzedUniverseScan" -Confirm:$false
```

The shared-cache read path (`src/data/dailySignalsCache.ts`) is the durable
interface - the writer can be cloud or local and the clients don't change.

## Secrets - never commit

`.scan.env` is gitignored. It holds the current vendor keys + the Supabase
**service-role** key (bypasses RLS; server-side only). The client bundle never
ships any of these.
