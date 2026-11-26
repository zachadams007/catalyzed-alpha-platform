import { createHash } from "node:crypto";

import {
  validateLearningOutcomePayload,
  type LearningOutcomeArtifactEnvelope,
  type LearningOutcomeArtifactPayload,
} from "../../src/engine/learningOutcomeArtifact";
import { canonicalizeLearningUniverseJson as canonicalizeJson } from "../../src/engine/learningUniverseArtifact";

const HASH_DOMAIN = "catalyzed.learning-outcome.v1\0";

export function computeLearningOutcomePayloadSha256(payload: unknown): string {
  return createHash("sha256")
    .update(`${HASH_DOMAIN}${canonicalizeJson(payload)}`, "utf8")
    .digest("hex");
}

export function sealLearningOutcomeArtifact(
  payload: LearningOutcomeArtifactPayload,
): LearningOutcomeArtifactEnvelope {
  validateLearningOutcomePayload(payload);
  const artifactSha256 = computeLearningOutcomePayloadSha256(payload);
  return {
    artifactId: `sha256:${artifactSha256}`,
    artifactSha256,
    payload,
  };
}
