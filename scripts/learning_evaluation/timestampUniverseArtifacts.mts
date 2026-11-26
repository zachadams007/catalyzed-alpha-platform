/**
 * Timestamp sealed learning-universe archive digests with a public RFC 3161 TSA
 * (FreeTSA by default). Complements attest.mts, which timestamps the five
 * OfflineLearningBundle admission subjects once a full evaluation bundle exists.
 *
 * Usage:
 *   npx tsx scripts/learning_evaluation/timestampUniverseArtifacts.mts \
 *     --archive-root scripts/universe_scan/learning-archive \
 *     --ca-file scripts/learning_evaluation/freetsa/cacert.pem \
 *     --tsa-cert scripts/learning_evaluation/freetsa/tsa.crt \
 *     [--openssl "C:\Program Files\Git\usr\bin\openssl.exe"] \
 *     [--tsa https://freetsa.org/tsr]
 *
 * Reads claim files under <archive-root>/_source-runs/*.sha256 (one digest per
 * source-run). Writes sidecar JSON receipts next to each claim. $0, no account.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface CliOptions {
  archiveRoot: string;
  tsaUrl: string;
  caFile: string;
  tsaCertFile: string;
  opensslBinary: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const named = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value == null) throw new Error(`Missing value for ${arg}`);
    named.set(arg.slice(2), value);
    index += 1;
  }
  const archiveRoot = named.get("archive-root");
  const caFile = named.get("ca-file");
  const tsaCertFile = named.get("tsa-cert");
  if (!archiveRoot || !caFile || !tsaCertFile) {
    throw new Error(
      "Usage: timestampUniverseArtifacts.mts --archive-root <dir> --ca-file cacert.pem --tsa-cert tsa.crt [--tsa https://freetsa.org/tsr] [--openssl openssl]",
    );
  }
  return {
    archiveRoot: resolve(archiveRoot),
    tsaUrl: named.get("tsa") ?? "https://freetsa.org/tsr",
    caFile: resolve(caFile),
    tsaCertFile: resolve(tsaCertFile),
    opensslBinary: named.get("openssl") ?? "openssl",
  };
}

async function timestampDigest(
  options: CliOptions,
  workDir: string,
  digest: string,
  label: string,
): Promise<{ tokenBase64: string; verifiedOutput: string; verifiedAtISO: string }> {
  const queryPath = join(workDir, `${label}.tsq`);
  const responsePath = join(workDir, `${label}.tsr`);
  await execFileAsync(options.opensslBinary, [
    "ts",
    "-query",
    "-digest",
    digest,
    "-sha256",
    "-no_nonce",
    "-cert",
    "-out",
    queryPath,
  ]);
  const query = await readFile(queryPath);
  const response = await fetch(options.tsaUrl, {
    method: "POST",
    headers: { "Content-Type": "application/timestamp-query" },
    body: query,
  });
  if (!response.ok) {
    throw new Error(`TSA request failed for ${label}: HTTP ${response.status}`);
  }
  const tokenBytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(responsePath, tokenBytes);
  const { stdout, stderr } = await execFileAsync(options.opensslBinary, [
    "ts",
    "-verify",
    "-in",
    responsePath,
    "-digest",
    digest,
    "-CAfile",
    options.caFile,
    "-untrusted",
    options.tsaCertFile,
  ]);
  return {
    tokenBase64: Buffer.from(tokenBytes).toString("base64"),
    verifiedOutput: `${stdout}${stderr}`.trim(),
    verifiedAtISO: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const claimDir = join(options.archiveRoot, "_source-runs");
  const receiptDir = join(options.archiveRoot, "_rfc3161-receipts");
  await mkdir(receiptDir, { recursive: true });
  const claimFiles = (await readdir(claimDir)).filter((name) => name.endsWith(".sha256"));
  if (claimFiles.length === 0) {
    throw new Error(`No claim files found under ${claimDir}`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "catalyzed-universe-tsa-"));
  const results: unknown[] = [];
  try {
    for (const name of claimFiles) {
      const claimPath = join(claimDir, name);
      const digest = (await readFile(claimPath, "utf8")).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`Invalid digest in ${claimPath}`);
      }
      const receiptPath = join(receiptDir, `${basename(name, ".sha256")}.rfc3161.json`);
      const stamped = await timestampDigest(options, workDir, digest, basename(name, ".sha256"));
      const receipt = {
        kind: "learning_universe_artifact_sha256",
        sourceRunClaimFile: name,
        artifactSha256: digest,
        tsaUrl: options.tsaUrl,
        opensslBinary: options.opensslBinary,
        caFileSha256: createHash("sha256").update(await readFile(options.caFile)).digest("hex"),
        tsaCertSha256: createHash("sha256").update(await readFile(options.tsaCertFile)).digest("hex"),
        ...stamped,
      };
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      results.push({ claim: name, receiptPath, artifactSha256: digest, verifiedAtISO: stamped.verifiedAtISO });
      console.log(`timestamped ${name} -> ${receiptPath}`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ stamped: results.length, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
