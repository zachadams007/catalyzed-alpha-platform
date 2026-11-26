# Candidate-universe archive contract

This archive is a prospective evidence source for future evaluation and learning
work. It does not train, label, alter production scoring/ranking, or render
anything today. It deterministically reproduces the already-made pre-rank
decision only to verify provenance fields.

## Boundary

The scanner captures immediately after `preRankUniverse` decides the enrichment
pool and before synthetic company construction or any fundamentals, price-history,
per-company news/catalyst enrichment, full-score, normalization, or UI processing.
The already-decided seed membership (including market-wide catalyst-driven seeds)
is retained only as pre-rank decision metadata; no catalyst content is archived.
`candidates` retains
every normalized snapshot observation returned for the requested source universe,
including rows that fail the price/liquidity floor. Mechanically recomputed
`eligibleTickers` (`floor pass OR seed bypass`) and the capped, ordered enrichment
selection are separate fields. This preserves both accepted and rejected evidence.

Historical `daily_signals`, saved board files, and published scores cannot
reconstruct the rejected candidates or provider coverage. They are therefore
never backfilled into this archive.

## Identity and bytes

- Schema: `catalyzed.minimum_coverage_candidate_universe`, version 1.
- A UUID-backed source-run ID is created before the first provider request.
- Objects use recursively sorted keys; set-like arrays are sorted copies;
  selection order is preserved.
- The artifact ID is a domain-separated SHA-256 of the canonical payload bytes.
- The final filename includes the digest. A source-run claim permanently binds
  one source-run ID to one digest.
- Local publication stages and flushes a file, creates the final name without
  replacement, and then reads and rehashes it.
- Remote publication is `insert` only. Exact retries are idempotent; any
  conflicting source-run bytes fail. A database trigger rejects update/delete.
- The production Finnhub minimum-coverage floor is 1,001 eligible entries, so an
  exact-1,000 truncation is rejected. Crossing that floor is not proof that the
  provider returned every current listing. Lower injected thresholds exist only
  in provider adapter tests and are rejected by archive validation.

## Admissibility

Admissibility is derived, never asserted by a caller. An artifact is quarantined
when any of these is true:

- Finnhub did not return at least the production minimum-coverage floor;
- Finnhub met the floor but complete current membership remains independently
  unproven;
- the curated fallback or a symbol cap was used;
- any Alpaca batch failed, was malformed, missed a requested symbol, or returned
  an unexpected symbol;
- price/prior-close/liquidity/range source timestamps are missing or a prior
  close was imputed from the current price;
- the source revision is not a full git SHA;
- the eligible pool is empty; or
- the scan is a dry/test run.

Current Finnhub runs therefore remain quarantined even when they meet the floor.
`toValidatedUniverseEvidence` exposes all integrity-checked candidates, including
rejected rows and their eligibility flags, for audit/recovery. The stricter
`toVerifiedUniverseArtifact` refuses to admit quarantined evidence to a future
learning-data consumer until an independent completeness proof is implemented.

### Independent completeness proof - what is still missing

The production floor (≥1,001 eligible) only rejects the common exact-1,000
truncation shape. Clearing `finnhub_universe_completeness_unproven` requires a
**second, independent membership source** that proves Finnhub returned every
current listing in the claimed Common Stock / ADR / REIT clean-root universe.

Cheapest lawful $0 candidate (already probed): the official NASDAQ Trader symbol
directories (`nasdaqlisted.txt` + `otherlisted.txt` from
`https://www.nasdaqtrader.com/dynamic/symdir/`), refreshed each trading day.

What a wired proof must do before admission can drop the quarantine reason:

1. Fetch both directory files at capture time and seal their digests into the
   Finnhub provider audit (so the cross-check is reproducible).
2. Filter them to the **same claim** as Finnhub (`^[A-Z]{1,5}$`, non-test,
   non-ETF, Common Stock / ADR / REIT). NASDAQ Trader does **not** expose
   Finnhub's type field; name heuristics are approximate and currently leave a
   residual mapping gap (ADR/REIT/ordinary-share wording differs; Finnhub
   `exchange=US` is not identical to the two directory files).
3. Require `reference ⊆ finnhubEligible` with zero misses **and**
   `reference.size ≥ FINNHUB_MIN_EXPECTED_ELIGIBLE`, then record that result in
   the sealed audit before `deriveQuarantineReasons` runs.
4. Until steps 1–3 are implemented and validated against live Finnhub pulls,
   keep quarantining. The operator diagnostic
   `scripts/universe_scan/checkFinnhubCompleteness.mts` measures coverage only;
   it does **not** mutate the admission gate.

## Privacy and feature exclusions

The schema is an exact allowlist. It excludes raw URLs, auth headers, keys,
secrets, exceptions/stacks, provider response objects, synthetic series,
fundamentals, news/social data, catalysts, enriched scores, labels, outcomes, and
future prices. Only the pre-rank score is retained, explicitly as decision
metadata rather than a raw market feature.

The Supabase table has RLS enabled, no anon/authenticated policy, and grants only
service-role insert/read. It is not exposed through the application UI.

`capturedAtISO` and `decisionAtISO` identify this scan attempt. They never relabel
the market evidence as a trading session. A Sunday decision may truthfully carry
Friday (or older) price, prior-close, liquidity, and range timestamps in its
candidate fields; the archive and future bridge preserve those source timestamps
verbatim and define no inferred `sessionDate`.

## Operational status

Scan metadata reports three independent dimensions:

- `archiveStatus`: `admissible`, `quarantined`, or `capture_failed`;
- `localStatus`: exclusive local persistence/verification state; and
- `remoteStatus`: insert/readback state.

Archive capture/upload errors are nonfatal to the daily board and cannot mutate
signal values, order, or scores. The standalone recovery publisher accepts only
a fresh saved board from the same US/Eastern civil day and, when invoked by the
wrapper, the exact expected source run created after that wrapper invocation
began. It re-verifies canonical bytes and the contract before upload and never
fabricates candidate-universe evidence for legacy board data.

Local dry runs still write a quarantined immutable artifact, but never upload the
archive or publish `daily_signals`. The local wrapper binds a clean checkout to
its current HEAD; any dirty checkout is marked `unverified-dirty-worktree` and is
therefore quarantined. CI binds the clean `${{ github.sha }}` revision.

The workflow retains local artifacts for 90 days as a recovery fallback. Durable
authenticated Supabase history begins only after an operator applies migration
`0027_learning_universe_artifacts.sql` and configures the existing service-role
secret; this change does not deploy that account-level migration.

## Offline adaptive-evaluation boundary

The repository now contains an executable, offline-only evaluation path:

```bash
npm run learning:evaluate -- path/to/input-bundle.json path/to/output-report.json
```

The command rehashes every supplied universe and outcome archive payload and
calls the canonical admission bridges before it applies an outcome observation,
builds a training fold, or evaluates a prediction. A quarantined or incomplete
artifact therefore produces a machine-readable `blocked` verdict with no
evaluation report. Under the current contract, Finnhub minimum coverage is still
independently unproven, so current prospective captures remain blocked.

After admission, the pure offline path enforces full-manifest membership,
feature/label availability timestamps, a sanctioned eligible-close calendar,
artifact-matched idempotent outcome feedback, non-overlapping embargoed walk-forward folds, and a
final frozen temporal holdout. It reports label coverage, selected hit rate and
expectancy, Brier/ECE calibration, sector/cap concentration, rank stability,
rank-IC delta, feature coverage, model age, and PSI drift in both development
and final-holdout slices.

Those metrics are diagnostic only today. The feature rows, exchange calendar,
split freeze, and predictions do not yet cross an independently timestamped
admission bridge; a digest proves exact bytes but not pre-holdout existence.
The executable therefore keeps the machine promotion verdict `blocked` even for
a clean synthetic fixture. `rejected` and `eligible_for_manual_review` remain
future vocabulary for authenticated inputs, not statuses this lane can earn.

This does not fit a production model, alter the deterministic scorer, change feed
order, publish a result, deploy a migration, or add an execution path.
