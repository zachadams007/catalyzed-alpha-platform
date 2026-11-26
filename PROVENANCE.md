# Provenance

This repository is a public copy of selected files from a private repository. It has fresh history because the private history contains personal data.

| | |
|---|---|
| Source revision | `df0d558`, committed 2026-09-20 |
| Private history at that revision | 442 commits from 2026-06-11 to 2026-09-20 |
| Method | Files read from the committed revision with `git archive`, then passed through a scripted allowlist, redaction and deny-list check |

## Files written for this copy

- `README.md`, `PROVENANCE.md`, `docs/data-model.md`, `.gitleaks.toml`, `.github/workflows/ci.yml`
- `docs/images/*`, captured from the deployed site on 2026-11-24

Everything else is project code, config or project documentation.

## Left out

- Environment files, deployment settings, agent instruction files and internal planning notes
- Research notes and reports that contain results of the ranking over time
- Generated mobile icon sets, build output, compiler build info and dependencies
- A setup script and a one-off bar-data probe from `scripts/universe_scan`, and one browser scratch script
- The FreeTSA timestamp-authority certificates, which `run_learning_clock.ps1` downloads when they are missing

## Changed

- Email addresses, home-directory paths, project identifiers and hosted URLs are replaced with placeholders.
- Sentences that state ranking performance are removed or have the number replaced with a marker. Mechanism parameters such as weights, tilt sizes and thresholds are unchanged.
- Quoted remarks are removed from comments, and the author's first name is replaced with "the owner" in comments.
- Em dashes in code comments are normalised to hyphens. Interface strings and model prompts are unchanged.
- The chatbot widget id in `index.html`, the repository address in migration 0015 and one portfolio name in a test fixture are placeholders.
- One archive-path test hard-coded Windows paths. It now builds them with `node:path`, so it passes on Linux and macOS too.
- A few comments use neutral wording in place of internal jargon. Some comments cite internal documents that are not published.
- `package.json` has a rewritten description.
- 193 double-encoded characters in interface strings in `src/viz/pipelineModel.ts` are repaired.
- `.github/workflows/daily-universe.yml` is renamed to `docs/ops/daily-universe.workflow.yml` so that a clone does not schedule it.

## Verification

`npm ci`, `npx tsc --noEmit`, `npx vitest run --testTimeout=20000` and `npm run build` were run on this copy with no environment file present.
