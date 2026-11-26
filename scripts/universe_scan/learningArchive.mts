import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  canonicalizeLearningUniverseJson,
  validateLearningUniverseEnvelope,
  validateLearningUniversePayload,
  type LearningUniverseArtifactEnvelope,
  type LearningUniverseArtifactPayload,
} from "../../src/engine/learningUniverseArtifact";

const HASH_DOMAIN = "catalyzed.learning-universe.v1\0";

export type LocalArchivePersistenceStatus = "local_verified" | "local_idempotent";

export interface LocalArchiveWriteResult {
  status: LocalArchivePersistenceStatus;
  filePath: string;
  envelope: LearningUniverseArtifactEnvelope;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeLearningUniversePayloadSha256(payload: unknown): string {
  return sha256(`${HASH_DOMAIN}${canonicalizeLearningUniverseJson(payload)}`);
}

export function sealLearningUniverseArtifact(
  payload: LearningUniverseArtifactPayload,
): LearningUniverseArtifactEnvelope {
  validateLearningUniversePayload(payload);
  const artifactSha256 = computeLearningUniversePayloadSha256(payload);
  return {
    artifactId: `sha256:${artifactSha256}`,
    artifactSha256,
    payload,
  };
}

function safeRunId(sourceRunId: string): string {
  return sourceRunId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function learningUniverseArtifactPath(
  archiveRoot: string,
  envelope: LearningUniverseArtifactEnvelope,
): string {
  const day = envelope.payload.decisionAtISO.slice(0, 10);
  return join(
    archiveRoot,
    day,
    `${safeRunId(envelope.payload.sourceRunId)}--${envelope.artifactSha256}.json`,
  );
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows may reject directory handles. The staged file itself is still fsynced.
  }
}

async function claimSourceRun(
  archiveRoot: string,
  sourceRunId: string,
  artifactSha256: string,
): Promise<void> {
  const claimDirectory = join(archiveRoot, "_source-runs");
  await mkdir(claimDirectory, { recursive: true });
  const claimPath = join(claimDirectory, `${safeRunId(sourceRunId)}.sha256`);
  const claimBytes = `${artifactSha256}\n`;
  const stagePath = join(claimDirectory, `.${basename(claimPath)}.${randomUUID()}.tmp`);
  const stage = await open(stagePath, "wx", 0o600);
  try {
    await stage.writeFile(claimBytes, "utf8");
    await stage.sync();
  } finally {
    await stage.close();
  }
  try {
    try {
      await link(stagePath, claimPath);
      await syncDirectoryBestEffort(claimDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(claimPath, "utf8");
      if (existing !== claimBytes) {
        throw new Error("Learning-universe sourceRunId is already bound to a different digest");
      }
    }
  } finally {
    await unlink(stagePath).catch(() => undefined);
  }
}

/** Read, schema-check, filename-check, and rehash the exact persisted artifact. */
export async function readAndVerifyLearningUniverseArtifact(
  filePath: string,
): Promise<LearningUniverseArtifactEnvelope> {
  const bytes = await readFile(filePath, "utf8");
  const parsed = JSON.parse(bytes) as unknown;
  if (!parsed || typeof parsed !== "object" || !("payload" in parsed)) {
    throw new Error("Learning-universe archive is not an envelope");
  }
  const record = parsed as { payload: unknown };
  const recomputedSha256 = computeLearningUniversePayloadSha256(record.payload);
  validateLearningUniverseEnvelope(parsed, recomputedSha256);
  const canonicalBytes = `${canonicalizeLearningUniverseJson(parsed)}\n`;
  if (bytes !== canonicalBytes) {
    throw new Error("Learning-universe archive bytes are not canonical");
  }
  const expectedSuffix = `--${recomputedSha256}.json`;
  if (!basename(filePath).endsWith(expectedSuffix)) {
    throw new Error("Learning-universe archive filename does not match its digest");
  }
  return parsed;
}

/**
 * Crash-safe, no-replace local persistence: fsync a unique stage file, hard-link
 * it into the content-addressed final name, then re-read and verify. A concurrent
 * identical retry is accepted; different bytes can never replace the final file.
 */
export async function writeLearningUniverseArtifact(
  archiveRoot: string,
  envelope: LearningUniverseArtifactEnvelope,
): Promise<LocalArchiveWriteResult> {
  const recomputedSha256 = computeLearningUniversePayloadSha256(envelope.payload);
  validateLearningUniverseEnvelope(envelope, recomputedSha256);
  await claimSourceRun(
    archiveRoot,
    envelope.payload.sourceRunId,
    envelope.artifactSha256,
  );
  const filePath = learningUniverseArtifactPath(archiveRoot, envelope);
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const bytes = `${canonicalizeLearningUniverseJson(envelope)}\n`;
  const stagePath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  let published = false;

  const stage = await open(stagePath, "wx", 0o600);
  try {
    await stage.writeFile(bytes, "utf8");
    await stage.sync();
  } finally {
    await stage.close();
  }

  try {
    try {
      await link(stagePath, filePath);
      published = true;
      await syncDirectoryBestEffort(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = await readFile(filePath, "utf8");
      if (existing !== bytes) {
        throw new Error("Immutable learning-universe path already contains different bytes");
      }
    }
  } finally {
    await unlink(stagePath).catch(() => undefined);
  }

  const verified = await readAndVerifyLearningUniverseArtifact(filePath);
  return {
    status: published ? "local_verified" : "local_idempotent",
    filePath,
    envelope: verified,
  };
}
