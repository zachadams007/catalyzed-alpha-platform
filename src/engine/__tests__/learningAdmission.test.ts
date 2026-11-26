import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/sha256";
import {
  admissionBlockers,
  LEARNING_ADMISSION_SCHEMA_VERSION,
  parseRfc3161TimeStampResp,
  toVerifiedAdmissionRecord,
  type AdmissionAttestationEnvelope,
  type AdmissionEvidence,
  type AdmissionSubjectKind,
} from "@/engine/learningAdmission";
import {
  buildTimeStampResp,
  TEST_POLICY_OID,
} from "./rfc3161TestToken";

const SUBJECT = JSON.stringify({ canonical: "subject-bytes", v: 1 });
const SUBJECT_SHA = sha256Hex(SUBJECT);

/** Pure base64 decode (no Buffer) so the browser-lib typecheck covers this file. */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function envelope(overrides: Partial<AdmissionAttestationEnvelope> = {}): AdmissionAttestationEnvelope {
  return {
    schemaVersion: LEARNING_ADMISSION_SCHEMA_VERSION,
    subjectKind: "evaluation_split",
    subjectSha256: SUBJECT_SHA,
    tokenBase64: buildTimeStampResp({ hashedMessageHex: SUBJECT_SHA, genTime: "20260301101500Z" }),
    tsaUrl: "https://freetsa.org/tsr",
    verification: {
      method: "openssl_ts_verify",
      verifiedAtISO: "2026-03-01T11:00:00.000Z",
      command: "openssl ts -verify -in split.tsr -queryfile split.tsq -CAfile cacert.pem -untrusted tsa.crt",
      output: "Verification: OK\n",
      caCertSha256: "a".repeat(64),
      tsaCertSha256: "b".repeat(64),
    },
    ...overrides,
  };
}

describe("parseRfc3161TimeStampResp — deterministic DER extraction", () => {
  it("extracts status, policy, imprint, serial, and genTime from a granted token", () => {
    const base64 = buildTimeStampResp({ hashedMessageHex: SUBJECT_SHA, genTime: "20260301101500.5Z" });
    const bytes = fromBase64(base64);
    const info = parseRfc3161TimeStampResp(bytes);
    expect(info.pkiStatus).toBe(0);
    expect(info.policyOid).toBe(TEST_POLICY_OID);
    expect(info.hashAlgorithmOid).toBe("2.16.840.1.101.3.4.2.1");
    expect(info.hashedMessageHex).toBe(SUBJECT_SHA);
    expect(info.genTimeISO).toBe("2026-03-01T10:15:00.500Z");
    expect(info.serialNumberHex.length).toBeGreaterThan(0);
  });

  it("rejects a response whose TSA status is rejection", () => {
    const base64 = buildTimeStampResp({
      hashedMessageHex: SUBJECT_SHA,
      genTime: "20260301101500Z",
      pkiStatus: 2,
    });
    const bytes = fromBase64(base64);
    expect(() => parseRfc3161TimeStampResp(bytes)).toThrow(/did not grant/);
  });

  it("rejects truncated bytes", () => {
    const base64 = buildTimeStampResp({ hashedMessageHex: SUBJECT_SHA, genTime: "20260301101500Z" });
    const bytes = fromBase64(base64).slice(0, 24);
    expect(() => parseRfc3161TimeStampResp(bytes)).toThrow(/Invalid admission attestation/);
  });
});

describe("toVerifiedAdmissionRecord — fail-closed envelope admission", () => {
  it("admits a well-formed envelope whose token binds the recomputed digest", () => {
    const record = toVerifiedAdmissionRecord(envelope(), SUBJECT_SHA);
    expect(record.subjectKind).toBe("evaluation_split");
    expect(record.subjectSha256).toBe(SUBJECT_SHA);
    expect(record.genTimeISO).toBe("2026-03-01T10:15:00.000Z");
    expect(record.trustAnchors.caCertSha256).toBe("a".repeat(64));
    expect(record.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects when the recomputed subject digest differs from the claim", () => {
    const otherDigest = sha256Hex("tampered");
    expect(() => toVerifiedAdmissionRecord(envelope(), otherDigest)).toThrow(
      /does not match the recomputed canonical bytes/,
    );
  });

  it("rejects when the token imprint does not bind the subject digest", () => {
    const otherDigest = sha256Hex("other-bytes");
    const bad = envelope({
      tokenBase64: buildTimeStampResp({ hashedMessageHex: otherDigest, genTime: "20260301101500Z" }),
    });
    expect(() => toVerifiedAdmissionRecord(bad, SUBJECT_SHA)).toThrow(/does not bind the subject digest/);
  });

  it("rejects a missing or unsuccessful verification receipt", () => {
    const noReceipt = envelope();
    // @ts-expect-error deliberate contract violation
    delete noReceipt.verification;
    expect(() => toVerifiedAdmissionRecord(noReceipt, SUBJECT_SHA)).toThrow(/unexpected or missing fields/);

    const failedReceipt = envelope({
      verification: { ...envelope().verification, output: "Verification: FAILED" },
    });
    expect(() => toVerifiedAdmissionRecord(failedReceipt, SUBJECT_SHA)).toThrow(
      /does not attest success/,
    );
  });

  it("rejects a non-SHA-256 imprint algorithm", () => {
    const bad = envelope({
      tokenBase64: buildTimeStampResp({
        hashedMessageHex: SUBJECT_SHA,
        genTime: "20260301101500Z",
        hashAlgorithmOid: "1.3.14.3.2.26",
      }),
    });
    expect(() => toVerifiedAdmissionRecord(bad, SUBJECT_SHA)).toThrow(/must use SHA-256/);
  });

  it("rejects a receipt that predates the token generation time", () => {
    const bad = envelope({
      verification: { ...envelope().verification, verifiedAtISO: "2026-03-01T09:00:00.000Z" },
    });
    expect(() => toVerifiedAdmissionRecord(bad, SUBJECT_SHA)).toThrow(/predates the token/);
  });
});

describe("admissionBlockers — completeness, binding, and temporal ordering", () => {
  const KINDS: AdmissionSubjectKind[] = [
    "feature_rows",
    "market_calendar",
    "evaluation_split",
    "predictions",
    "configuration_ledger",
  ];

  function evidenceFor(
    genTimes: Partial<Record<AdmissionSubjectKind, string>> = {},
  ): AdmissionEvidence {
    const subjectDigests = Object.fromEntries(
      KINDS.map((kind) => {
        const digest = sha256Hex(`subject:${kind}`);
        return [kind, digest];
      }),
    ) as Record<AdmissionSubjectKind, string>;
    return {
      subjectDigests,
      records: KINDS.map((kind) => ({
        subjectKind: kind,
        subjectSha256: subjectDigests[kind],
        genTimeISO: genTimes[kind] ?? "2026-02-20T00:00:00.000Z",
        policyOid: TEST_POLICY_OID,
        serialNumberHex: "01",
        tsaUrl: "https://freetsa.org/tsr",
        tokenSha256: "c".repeat(64),
        trustAnchors: { caCertSha256: "a".repeat(64), tsaCertSha256: "b".repeat(64) },
      })),
    };
  }

  const boundaries = {
    holdoutStartISO: "2026-03-01T00:00:00.000Z",
    earliestHoldoutLabelObservedAtISO: "2026-03-02T21:00:00.000Z",
    reportAsOfISO: "2026-04-01T00:00:00.000Z",
  };

  it("returns the canonical unavailable blocker when no evidence is supplied", () => {
    const blockers = admissionBlockers(undefined, boundaries);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/have not crossed an independently timestamped admission bridge/);
  });

  it("passes a complete, correctly ordered admission set", () => {
    expect(admissionBlockers(evidenceFor(), boundaries)).toEqual([]);
  });

  it("blocks a missing subject kind", () => {
    const evidence = evidenceFor();
    const partial = { ...evidence, records: evidence.records.slice(1) };
    expect(admissionBlockers(partial, boundaries)).toEqual([
      "Admission is missing an independently timestamped record for 'feature_rows'.",
    ]);
  });

  it("blocks a record that does not bind the evaluated bytes", () => {
    const evidence = evidenceFor();
    const tampered = {
      ...evidence,
      subjectDigests: { ...evidence.subjectDigests, predictions: "d".repeat(64) },
    };
    expect(admissionBlockers(tampered, boundaries)).toEqual([
      "Admission record for 'predictions' does not bind the evaluated bytes.",
    ]);
  });

  it("blocks a split attested inside the holdout window", () => {
    const late = evidenceFor({ evaluation_split: "2026-03-05T00:00:00.000Z" });
    const blockers = admissionBlockers(late, boundaries);
    expect(blockers).toContain(
      "Admission record for 'evaluation_split' was not attested strictly before the final holdout.",
    );
  });

  it("blocks predictions attested after a holdout label became observable", () => {
    const late = evidenceFor({ predictions: "2026-03-10T00:00:00.000Z" });
    expect(admissionBlockers(late, boundaries)).toEqual([
      "Admission record for 'predictions' was attested after a holdout label became observable.",
    ]);
  });

  it("blocks records timestamped after the report as-of time", () => {
    const future = evidenceFor({ market_calendar: "2026-05-01T00:00:00.000Z" });
    expect(admissionBlockers(future, boundaries)).toEqual([
      "Admission record for 'market_calendar' is timestamped after the report as-of time.",
    ]);
  });
});
