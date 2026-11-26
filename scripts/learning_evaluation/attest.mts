/**
 * Operator CLI: create RFC 3161 timestamp attestations for the five offline
 * learning admission subjects of a bundle.
 *
 * Usage:
 *   npx tsx scripts/learning_evaluation/attest.mts \
 *     <input-bundle.json> <output-attestations.json> \
 *     --tsa https://freetsa.org/tsr \
 *     --ca-file path/to/cacert.pem --tsa-cert path/to/tsa.crt \
 *     [--openssl openssl]
 *
 * For each subject this tool:
 *   1. recomputes the canonical, domain-separated subject digest with the
 *      exact same code the runner uses;
 *   2. builds an RFC 3161 query for that digest (`openssl ts -query`);
 *   3. POSTs it to the TSA over HTTPS and stores the raw DER response;
 *   4. verifies the signed response against the pinned certificate files
 *      (`openssl ts -verify`) and records the receipt.
 *
 * The output is an array of `AdmissionAttestationEnvelope` objects to place
 * in the bundle's `admissionAttestations` field. This tool never contacts a
 * market-data provider, uses no account or secret, and cannot change any
 * production surface. If `openssl` or the TSA is unavailable it fails closed
 * with no partial output file.
 *
 * Trainer bundles: when the bundle uses the deterministic trainer path
 * (empty `predictions` plus `trainer.configuration`), this tool regenerates
 * the identical predictions before hashing the prediction commitment, so the
 * attested bytes equal the bytes the runner will evaluate.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  LEARNING_ADMISSION_SCHEMA_VERSION,
  toVerifiedAdmissionRecord,
  type AdmissionAttestationEnvelope,
  type AdmissionSubjectKind,
} from "../../src/engine/learningAdmission";
import { computeAdmissionSubjectDigests } from "../../src/engine/learningAdmissionSubjects";
import { validateLearningConfigLedger } from "../../src/engine/learningConfigLedger";
import { generateShadowPredictions } from "../../src/engine/learningTrainer";
import { toVerifiedUniverseArtifact } from "../../src/engine/learningUniverseArtifact";
import { computeLearningUniversePayloadSha256 } from "../universe_scan/learningArchive.mts";
import type { OfflineLearningBundle } from "./offlineLearningRunner";

const execFileAsync = promisify(execFile);

interface CliOptions {
  bundlePath: string;
  outputPath: string;
  tsaUrl: string;
  caFile: string;
  tsaCertFile: string;
  opensslBinary: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const value = argv[index + 1];
      if (value == null) throw new Error(`Missing value for ${arg}.`);
      named.set(arg.slice(2), value);
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  const [bundlePath, outputPath] = positional;
  if (!bundlePath || !outputPath || !named.get("ca-file") || !named.get("tsa-cert")) {
    throw new Error(
      "Usage: attest.mts <input-bundle.json> <output-attestations.json> --ca-file cacert.pem --tsa-cert tsa.crt [--tsa https://freetsa.org/tsr] [--openssl openssl]",
    );
  }
  return {
    bundlePath,
    outputPath,
    tsaUrl: named.get("tsa") ?? "https://freetsa.org/tsr",
    caFile: named.get("ca-file")!,
    tsaCertFile: named.get("tsa-cert")!,
    opensslBinary: named.get("openssl") ?? "openssl",
  };
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function requestTimestamp(
  options: CliOptions,
  workDir: string,
  kind: AdmissionSubjectKind,
  digest: string,
): Promise<{ tokenBase64: string; command: string; output: string; verifiedAtISO: string }> {
  const queryPath = join(workDir, `${kind}.tsq`);
  const responsePath = join(workDir, `${kind}.tsr`);
  await execFileAsync(options.opensslBinary, [
    "ts", "-query", "-digest", digest, "-sha256", "-no_nonce", "-cert", "-out", queryPath,
  ]);
  const query = await readFile(queryPath);
  const response = await fetch(options.tsaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/timestamp-query" },
    body: query,
  });
  if (!response.ok) {
    throw new Error(`TSA request for '${kind}' failed with HTTP ${response.status}.`);
  }
  const tokenBytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(responsePath, tokenBytes);
  const verifyArgs = [
    "ts", "-verify", "-in", responsePath, "-digest", digest,
    "-CAfile", resolve(options.caFile), "-untrusted", resolve(options.tsaCertFile),
  ];
  const command = `${options.opensslBinary} ${verifyArgs.join(" ")}`;
  const { stdout, stderr } = await execFileAsync(options.opensslBinary, verifyArgs);
  const output = `${stdout}${stderr}`;
  if (!output.includes("Verification: OK")) {
    throw new Error(`openssl verification for '${kind}' did not report success:\n${output}`);
  }
  return {
    tokenBase64: Buffer.from(tokenBytes).toString("base64"),
    command,
    output,
    verifiedAtISO: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const bundle = JSON.parse(
    await readFile(resolve(options.bundlePath), "utf8"),
  ) as OfflineLearningBundle;

  if (bundle.configurationLedger == null) {
    throw new Error("The bundle must carry a configurationLedger before attestation.");
  }
  const ledger = validateLearningConfigLedger(bundle.configurationLedger);

  let predictions = bundle.predictions ?? [];
  if (bundle.trainer != null) {
    if (predictions.length > 0) {
      throw new Error("A trainer bundle must not also carry external predictions.");
    }
    const verifiedArtifacts = (bundle.archiveEnvelopes ?? []).map((envelope) =>
      toVerifiedUniverseArtifact(envelope, computeLearningUniversePayloadSha256(envelope.payload)),
    );
    predictions = generateShadowPredictions({
      rows: bundle.rows,
      manifests: bundle.manifests,
      evidence: {
        verifiedUniverseArtifacts: verifiedArtifacts,
        eligibleMarketClosesISO: [...bundle.eligibleMarketClosesISO],
      },
      split: bundle.split,
      walkForwardConfig: bundle.walkForwardConfig,
      configuration: bundle.trainer.configuration,
      reportAsOfISO: bundle.reportAsOfISO,
    });
  }

  const digests = computeAdmissionSubjectDigests({
    rows: bundle.rows,
    eligibleMarketClosesISO: bundle.eligibleMarketClosesISO,
    split: bundle.split,
    predictions,
    configurationLedger: ledger,
  });

  const caCertSha256 = await fileSha256(resolve(options.caFile));
  const tsaCertSha256 = await fileSha256(resolve(options.tsaCertFile));
  const workDir = await mkdtemp(join(tmpdir(), "catalyzed-attest-"));
  const envelopes: AdmissionAttestationEnvelope[] = [];
  try {
    for (const [kind, digest] of Object.entries(digests) as [AdmissionSubjectKind, string][]) {
      const stamped = await requestTimestamp(options, workDir, kind, digest);
      const envelope: AdmissionAttestationEnvelope = {
        schemaVersion: LEARNING_ADMISSION_SCHEMA_VERSION,
        subjectKind: kind,
        subjectSha256: digest,
        tokenBase64: stamped.tokenBase64,
        tsaUrl: options.tsaUrl,
        verification: {
          method: "openssl_ts_verify",
          verifiedAtISO: stamped.verifiedAtISO,
          command: stamped.command,
          output: stamped.output,
          caCertSha256,
          tsaCertSha256,
        },
      };
      // Round-trip through the fail-closed bridge before writing anything.
      toVerifiedAdmissionRecord(envelope, digest);
      envelopes.push(envelope);
      process.stdout.write(`Attested ${kind}: ${digest}\n`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  await writeFile(resolve(options.outputPath), `${JSON.stringify(envelopes, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Wrote ${envelopes.length} admission attestations to ${resolve(options.outputPath)}\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
