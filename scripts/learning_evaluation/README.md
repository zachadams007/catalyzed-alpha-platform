# Offline adaptive-learning evaluation

This command evaluates a future shadow reranker without changing Catalyzed
Alpha's published scorer or feed:

```bash
npm run learning:evaluate -- input-bundle.json output-report.json
```

The input is the versioned `OfflineLearningBundle` (schema 3) defined in
`offlineLearningRunner.ts`:

- canonical candidate-universe archive envelopes;
- one full-universe manifest and feature row for every eligible ticker/run;
- a sanctioned eligible-market-close calendar;
- optional append-only outcome feedback backed by canonical outcome envelopes;
- EITHER externally generated shadow predictions tagged with their exact
  walk-forward fold or frozen final holdout cutoff, OR a `trainer` block naming
  one registered candidate configuration - never both;
- an immutable split record and the registered attempted-configuration ledger
  (`src/engine/learningConfigLedger.ts`, content-addressed, append-only,
  record-before-view);
- optional RFC 3161 admission attestation envelopes for the five admission
  subjects (feature rows, market calendar, evaluation split, label-free
  prediction commitments, configuration ledger);
- explicit, pre-registered walk-forward, selection, promotion, and drift policy.

## Trainer path

When `trainer` is supplied, the deterministic offline trainer
(`src/engine/learningTrainer.ts`) fits the frozen candidate configuration -
a regularized ridge baseline or a restrained shallow gradient-boosted
challenger, both with isotonic calibration - inside each embargoed fold and
generates every required out-of-sample prediction. Feature rows are built with
the canonical extractor (`src/engine/learningFeatures.ts`), which encodes the
entry-state (valley/falling-knife/staleness), quality-vs-financing-vs-demand,
valuation, catalyst, and verified open-market insider mechanisms as separate
point-in-time features and never fabricates missing values.

## Per-pick post-mortems ("ask why" on every bad pick)

`src/engine/learningPostMortem.ts` attributes every labeled pick to its
features by deterministic neutralization (re-scoring with each feature made
unavailable): a miss names exactly which features pushed its score up
(`misleadingFeatures`) and which evidence was missing at decision time.
`aggregatePostMortems` rolls misses into a recurring-misleader table - the
evidence a NEW challenger configuration should cite when it is registered in
the ledger. Post-mortems never edit the live scorer; corrections flow only
through the registered champion/challenger loop and its fail-closed gates.

## Admission

The command recomputes candidate-universe and outcome payload digests before
creating either verified-evidence registry, and - when attestations are
supplied - recomputes all five admission subject digests from the exact bytes
this run evaluates (`src/engine/learningAdmissionSubjects.ts`) before verifying
each RFC 3161 token against them (`src/engine/learningAdmission.ts`).
Prediction commitments are hashed label-free, so a prediction attestation can
exist before any label is observable. Operators produce attestation envelopes
with `attest.mts` (OpenSSL + a public TSA such as FreeTSA; $0, no account).

Daily universe captures are sealed digests under
`scripts/universe_scan/learning-archive/_source-runs/`. Timestamp those digests
with `timestampUniverseArtifacts.mts` (same OpenSSL + FreeTSA path). Full
`attest.mts` applies only once an `OfflineLearningBundle` exists - set
`LEARNING_ATTEST_BUNDLE` for `run_learning_clock.ps1` to invoke it after capture.

Any quarantine reason, incomplete manifest, future feature/label, conflicting
outcome, invalid market close, overlapping fold, rolling retrain inside the
holdout, missing prediction, missing policy, unregistered candidate
configuration, digest/token mismatch, out-of-order attestation time, or drift
evidence failure produces a machine-readable `blocked` verdict.

## What still blocks promotion

Promotion reaches a non-blocked verdict only when every admission subject
carries a verified, temporally ordered RFC 3161 attestation and every gate
passes. Content hashes prove exact bytes, not that those bytes existed before a
holdout; only the independent timestamp does that. Every report records
`automaticPromotion: false`, `productionMutationAllowed: false`, and three
false production-effect flags - promotion remains a human decision.

There is intentionally no provider call, production-score import, state/store
import, deployment step, or order path here. Current Finnhub minimum-coverage
archives remain quarantined until independent completeness is proven, so real
evaluation of live-captured universes correctly stops at admission today: the
one remaining external dependency is a prospective, independently timestamped
capture window (or a lawfully admissible historical point-in-time archive).
