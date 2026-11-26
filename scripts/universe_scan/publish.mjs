/**
 * Publish a saved scan (scripts/universe_scan/last-scan.json) to the shared
 * daily_signals cache from PLAIN NODE.
 *
 * The scan computes under vite-node (where the TS engine resolves), but the
 * in-process Supabase upload occasionally throws a low-level "fetch failed" on
 * the large body. This standalone publisher uses the proven plain-node fetch path
 * and the retrying uploader, so a finished compute can always be pushed without
 * recomputing. Loads server creds from .scan.env like the scan runner.
 *
 *   node scripts/universe_scan/publish.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { uploadDailySignals } from "./upload.mjs";
import {
  resolveArchiveReference,
  validateSavedScanForPublish,
} from "./publishRecovery.mjs";
import {
  readAndVerifyArchiveEnvelope,
  uploadLearningUniverseArtifact,
} from "./uploadLearningArchive.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Load .scan.env (server creds) into process.env for local runs.
const envFile = join(here, ".scan.env");
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    if (process.env[key] === undefined) process.env[key] = line.slice(i + 1).trim();
  }
}

const file = join(here, "last-scan.json");
if (!existsSync(file)) {
  console.error("No last-scan.json found — run the scan first (npm run scan:universe).");
  process.exit(1);
}

const { signals, run, meta } = JSON.parse(readFileSync(file, "utf8"));
const expectedSourceRunId = process.env.CATALYZED_EXPECTED_SOURCE_RUN_ID?.trim();
const minimumStartedAtISO = process.env.CATALYZED_WRAPPER_STARTED_AT_ISO?.trim();
validateSavedScanForPublish(run, meta, { expectedSourceRunId, minimumStartedAtISO });

const publishMeta = structuredClone(meta ?? {});
const archive = publishMeta.learningArchive;
if (archive?.relativePath) {
  try {
    const archiveRoot = resolve(
      process.env.LEARNING_ARCHIVE_ROOT?.trim() || join(here, "learning-archive"),
    );
    const artifactPath = resolveArchiveReference(archiveRoot, archive.relativePath);
    const verified = await readAndVerifyArchiveEnvelope(artifactPath);
    if (
      verified.envelope.payload.sourceRunId !== archive.sourceRunId ||
      verified.envelope.artifactId !== archive.artifactId
    ) {
      throw new Error("Learning-universe archive reference does not match last-scan.json.");
    }
    const result = await uploadLearningUniverseArtifact(verified.envelope);
    archive.remoteStatus = result.status;
    console.log(`Learning-universe archive ${result.status}.`);
  } catch {
    archive.remoteStatus = "remote_failed";
    console.warn("Learning-universe recovery failed; publishing the independently computed daily board only.");
  }
} else {
  console.warn("This scan has no verified candidate-universe artifact; no historical archive will be fabricated.");
}

const res = await uploadDailySignals(signals, run, publishMeta);
console.log(`Published ${res.count} signals to daily_signals for ${res.day}. ✅`);
