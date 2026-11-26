/**
 * Independently timestamped admission bridge for offline learning inputs.
 *
 * A content hash proves exact bytes, not that those bytes existed before a
 * holdout. This module verifies RFC 3161 trusted-timestamp attestations that
 * bind a canonical payload digest to a signed time from an external Time
 * Stamping Authority (TSA), so admission times become independently
 * verifiable rather than self-asserted.
 *
 * Boundary honesty: this pure module parses the DER TimeStampResp token,
 * verifies the message imprint binds the exact recomputed subject digest,
 * and enforces temporal ordering. It does NOT re-run the TSA's CMS/PKCS#7
 * signature cryptography; that verification is performed by the operator
 * tooling (`openssl ts -verify` in `scripts/learning_evaluation/attest.mts`)
 * against pinned certificate files, and its receipt - the exact command,
 * output, and certificate fingerprints - is a required part of the
 * attestation envelope. The raw token bytes are retained so any reviewer can
 * independently re-verify the signature offline. An envelope without a
 * structurally valid token, an exact digest binding, and a verification
 * receipt fails closed.
 */

import { sha256Hex } from "@/lib/sha256";

export const LEARNING_ADMISSION_SCHEMA_VERSION = 1 as const;

export type AdmissionSubjectKind =
  | "feature_rows"
  | "market_calendar"
  | "evaluation_split"
  | "predictions"
  | "configuration_ledger";

export const REQUIRED_ADMISSION_SUBJECT_KINDS: readonly AdmissionSubjectKind[] = [
  "feature_rows",
  "market_calendar",
  "evaluation_split",
  "predictions",
  "configuration_ledger",
];

/** OID constants required for a well-formed SHA-256 RFC 3161 token. */
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_CT_TST_INFO = "1.2.840.113549.1.9.16.1.4";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

export interface Rfc3161TokenInfo {
  /** PKIStatus from the TimeStampResp: 0 = granted, 1 = grantedWithMods. */
  pkiStatus: number;
  policyOid: string;
  hashAlgorithmOid: string;
  /** Lowercase hex of TSTInfo.messageImprint.hashedMessage. */
  hashedMessageHex: string;
  serialNumberHex: string;
  /** TSTInfo.genTime converted to a UTC ISO instant. */
  genTimeISO: string;
}

export interface AdmissionVerificationReceipt {
  method: "openssl_ts_verify";
  verifiedAtISO: string;
  command: string;
  /** Exact tool output; must contain the literal `Verification: OK`. */
  output: string;
  caCertSha256: string;
  tsaCertSha256: string;
}

export interface AdmissionAttestationEnvelope {
  schemaVersion: typeof LEARNING_ADMISSION_SCHEMA_VERSION;
  subjectKind: AdmissionSubjectKind;
  /** Claimed SHA-256 of the canonical subject bytes. */
  subjectSha256: string;
  /** Base64 DER TimeStampResp bytes exactly as returned by the TSA. */
  tokenBase64: string;
  tsaUrl: string;
  verification: AdmissionVerificationReceipt;
}

/** The only admission shape the promotion evaluator may consume. */
export interface VerifiedAdmissionRecord {
  subjectKind: AdmissionSubjectKind;
  subjectSha256: string;
  genTimeISO: string;
  policyOid: string;
  serialNumberHex: string;
  tsaUrl: string;
  tokenSha256: string;
  trustAnchors: { caCertSha256: string; tsaCertSha256: string };
}

function fail(message: string): never {
  throw new Error(`Invalid admission attestation: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

// ---------------------------------------------------------------------------
// Minimal deterministic DER reader (only what an RFC 3161 response needs).
// ---------------------------------------------------------------------------

interface DerNode {
  tag: number;
  /** Constructed bit already included in `tag`. */
  start: number;
  contentStart: number;
  contentEnd: number;
}

function readNode(bytes: Uint8Array, offset: number): DerNode {
  assert(offset < bytes.length, "truncated DER element");
  const tag = bytes[offset]!;
  assert((tag & 0x1f) !== 0x1f, "multi-byte DER tags are not supported");
  let cursor = offset + 1;
  assert(cursor < bytes.length, "truncated DER length");
  let lengthByte = bytes[cursor]!;
  cursor += 1;
  let length: number;
  if ((lengthByte & 0x80) === 0) {
    length = lengthByte;
  } else {
    const lengthOfLength = lengthByte & 0x7f;
    assert(lengthOfLength >= 1 && lengthOfLength <= 4, "unsupported DER length-of-length");
    assert(cursor + lengthOfLength <= bytes.length, "truncated DER long-form length");
    length = 0;
    for (let index = 0; index < lengthOfLength; index += 1) {
      length = length * 256 + bytes[cursor + index]!;
    }
    cursor += lengthOfLength;
  }
  assert(cursor + length <= bytes.length, "DER content exceeds buffer");
  return { tag, start: offset, contentStart: cursor, contentEnd: cursor + length };
}

/** Read the direct children of a constructed node in order. */
function readChildren(bytes: Uint8Array, node: DerNode): DerNode[] {
  assert((node.tag & 0x20) === 0x20, "expected a constructed DER element");
  const children: DerNode[] = [];
  let cursor = node.contentStart;
  while (cursor < node.contentEnd) {
    const child = readNode(bytes, cursor);
    assert(child.contentEnd <= node.contentEnd, "nested DER element overflows parent");
    children.push(child);
    cursor = child.contentEnd;
  }
  assert(cursor === node.contentEnd, "constructed DER element has trailing bytes");
  return children;
}

function content(bytes: Uint8Array, node: DerNode): Uint8Array {
  return bytes.subarray(node.contentStart, node.contentEnd);
}

function decodeOid(bytes: Uint8Array, node: DerNode): string {
  assert(node.tag === 0x06, "expected an OBJECT IDENTIFIER");
  const body = content(bytes, node);
  assert(body.length > 0, "empty OBJECT IDENTIFIER");
  const first = body[0]!;
  const parts: number[] = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let index = 1; index < body.length; index += 1) {
    const byte = body[index]!;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function decodeIntegerHex(bytes: Uint8Array, node: DerNode): string {
  assert(node.tag === 0x02, "expected an INTEGER");
  const body = content(bytes, node);
  assert(body.length > 0, "empty INTEGER");
  return [...body].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeSmallInteger(bytes: Uint8Array, node: DerNode): number {
  const hex = decodeIntegerHex(bytes, node);
  assert(hex.length <= 8, "INTEGER too large");
  return Number.parseInt(hex, 16);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeGeneralizedTime(bytes: Uint8Array, node: DerNode): string {
  assert(node.tag === 0x18, "expected a GeneralizedTime");
  const text = String.fromCharCode(...content(bytes, node));
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{1,3})?Z$/.exec(text);
  assert(match, `GeneralizedTime '${text}' is not a supported UTC instant`);
  const [, year, month, day, hour, minute, second, fraction] = match;
  const millis = fraction ? `${fraction.slice(1).padEnd(3, "0")}` : "000";
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
  assert(Number.isFinite(Date.parse(iso)), `GeneralizedTime '${text}' is not a valid instant`);
  return iso;
}

function decodeBase64(text: string): Uint8Array {
  assert(
    typeof text === "string" && text.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text),
    "token must be non-empty standard base64",
  );
  assert(text.length % 4 === 0, "token base64 length must be a multiple of 4");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = text.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    assert(value >= 0, "token contains an invalid base64 character");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Parse a DER RFC 3161 TimeStampResp and extract the fields required to bind
 * an attestation. Throws on any structural deviation.
 */
export function parseRfc3161TimeStampResp(tokenBytes: Uint8Array): Rfc3161TokenInfo {
  const root = readNode(tokenBytes, 0);
  assert(root.tag === 0x30, "TimeStampResp must be a SEQUENCE");
  assert(root.contentEnd === tokenBytes.length, "TimeStampResp has trailing bytes");
  const rootChildren = readChildren(tokenBytes, root);
  assert(rootChildren.length >= 1, "TimeStampResp is missing PKIStatusInfo");

  const statusInfo = rootChildren[0]!;
  assert(statusInfo.tag === 0x30, "PKIStatusInfo must be a SEQUENCE");
  const statusChildren = readChildren(tokenBytes, statusInfo);
  assert(statusChildren.length >= 1, "PKIStatusInfo is missing its status");
  const pkiStatus = decodeSmallInteger(tokenBytes, statusChildren[0]!);
  assert(pkiStatus === 0 || pkiStatus === 1, `TSA did not grant the timestamp (status ${pkiStatus})`);
  assert(rootChildren.length === 2, "granted TimeStampResp must carry a TimeStampToken");

  const contentInfo = rootChildren[1]!;
  assert(contentInfo.tag === 0x30, "TimeStampToken must be a ContentInfo SEQUENCE");
  const contentChildren = readChildren(tokenBytes, contentInfo);
  assert(contentChildren.length === 2, "ContentInfo must have a type and content");
  assert(decodeOid(tokenBytes, contentChildren[0]!) === OID_SIGNED_DATA, "TimeStampToken must be CMS SignedData");
  const explicitContent = contentChildren[1]!;
  assert(explicitContent.tag === 0xa0, "ContentInfo content must be [0] EXPLICIT");
  const signedDataNodes = readChildren(tokenBytes, explicitContent);
  assert(signedDataNodes.length === 1, "ContentInfo content must wrap exactly one SignedData");

  const signedData = signedDataNodes[0]!;
  assert(signedData.tag === 0x30, "SignedData must be a SEQUENCE");
  const signedChildren = readChildren(tokenBytes, signedData);
  assert(signedChildren.length >= 3, "SignedData is missing encapContentInfo");
  const encap = signedChildren[2]!;
  assert(encap.tag === 0x30, "encapContentInfo must be a SEQUENCE");
  const encapChildren = readChildren(tokenBytes, encap);
  assert(encapChildren.length === 2, "encapContentInfo must carry TSTInfo content");
  assert(decodeOid(tokenBytes, encapChildren[0]!) === OID_CT_TST_INFO, "encapContentInfo must be id-ct-TSTInfo");
  const eContent = encapChildren[1]!;
  assert(eContent.tag === 0xa0, "TSTInfo content must be [0] EXPLICIT");
  const octetNodes = readChildren(tokenBytes, eContent);
  assert(octetNodes.length === 1 && octetNodes[0]!.tag === 0x04, "TSTInfo must be an OCTET STRING");

  const tstBytes = content(tokenBytes, octetNodes[0]!);
  const tstRoot = readNode(tstBytes, 0);
  assert(tstRoot.tag === 0x30, "TSTInfo must be a SEQUENCE");
  assert(tstRoot.contentEnd === tstBytes.length, "TSTInfo has trailing bytes");
  const tstChildren = readChildren(tstBytes, tstRoot);
  assert(tstChildren.length >= 5, "TSTInfo is missing required fields");
  assert(decodeSmallInteger(tstBytes, tstChildren[0]!) === 1, "TSTInfo version must be 1");
  const policyOid = decodeOid(tstBytes, tstChildren[1]!);

  const messageImprint = tstChildren[2]!;
  assert(messageImprint.tag === 0x30, "messageImprint must be a SEQUENCE");
  const imprintChildren = readChildren(tstBytes, messageImprint);
  assert(imprintChildren.length === 2, "messageImprint must have an algorithm and digest");
  const algorithm = imprintChildren[0]!;
  assert(algorithm.tag === 0x30, "messageImprint algorithm must be a SEQUENCE");
  const algorithmChildren = readChildren(tstBytes, algorithm);
  assert(algorithmChildren.length >= 1, "messageImprint algorithm is empty");
  const hashAlgorithmOid = decodeOid(tstBytes, algorithmChildren[0]!);
  const digestNode = imprintChildren[1]!;
  assert(digestNode.tag === 0x04, "hashedMessage must be an OCTET STRING");
  const hashedMessageHex = toHex(content(tstBytes, digestNode));

  const serialNumberHex = decodeIntegerHex(tstBytes, tstChildren[3]!);
  const genTimeISO = decodeGeneralizedTime(tstBytes, tstChildren[4]!);

  return { pkiStatus, policyOid, hashAlgorithmOid, hashedMessageHex, serialNumberHex, genTimeISO };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  assert(
    actual.length === allowed.length && actual.every((key, index) => key === allowed[index]),
    `${path} has unexpected or missing fields`,
  );
}

function assertISO(value: unknown, path: string): asserts value is string {
  assert(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value)),
    `${path} must be a valid UTC ISO instant`,
  );
}

function assertSha256(value: unknown, path: string): asserts value is string {
  assert(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), `${path} must be lowercase SHA-256 hex`);
}

/**
 * Fail-closed admission: validate the envelope, parse the token, and require
 * the token's message imprint to equal the digest this run recomputed from
 * the exact subject bytes it is about to evaluate.
 */
export function toVerifiedAdmissionRecord(
  envelope: unknown,
  recomputedSubjectSha256: string,
): VerifiedAdmissionRecord {
  assertSha256(recomputedSubjectSha256.toLowerCase(), "recomputed subject digest");
  assert(isRecord(envelope), "envelope must be an object");
  assertExactKeys(
    envelope,
    ["schemaVersion", "subjectKind", "subjectSha256", "tokenBase64", "tsaUrl", "verification"],
    "envelope",
  );
  assert(envelope.schemaVersion === LEARNING_ADMISSION_SCHEMA_VERSION, "schemaVersion is unsupported");
  assert(
    typeof envelope.subjectKind === "string" &&
      (REQUIRED_ADMISSION_SUBJECT_KINDS as readonly string[]).includes(envelope.subjectKind),
    "subjectKind is invalid",
  );
  assertSha256(envelope.subjectSha256, "subjectSha256");
  assert(
    envelope.subjectSha256 === recomputedSubjectSha256.toLowerCase(),
    "subject digest does not match the recomputed canonical bytes",
  );
  assert(
    typeof envelope.tsaUrl === "string" && /^https:\/\/[^\s]+$/.test(envelope.tsaUrl),
    "tsaUrl must be an https URL",
  );

  assert(isRecord(envelope.verification), "verification receipt is required");
  assertExactKeys(
    envelope.verification,
    ["method", "verifiedAtISO", "command", "output", "caCertSha256", "tsaCertSha256"],
    "verification",
  );
  const verification = envelope.verification;
  assert(verification.method === "openssl_ts_verify", "verification method is unsupported");
  assertISO(verification.verifiedAtISO, "verification.verifiedAtISO");
  assert(
    typeof verification.command === "string" && verification.command.includes("ts") && verification.command.includes("-verify"),
    "verification.command must be an openssl ts -verify invocation",
  );
  assert(
    typeof verification.output === "string" && verification.output.includes("Verification: OK"),
    "verification output does not attest success",
  );
  assertSha256(verification.caCertSha256, "verification.caCertSha256");
  assertSha256(verification.tsaCertSha256, "verification.tsaCertSha256");

  const tokenBytes = decodeBase64(envelope.tokenBase64 as string);
  const token = parseRfc3161TimeStampResp(tokenBytes);
  assert(token.hashAlgorithmOid === OID_SHA256, "token message imprint must use SHA-256");
  assert(
    token.hashedMessageHex === envelope.subjectSha256,
    "token message imprint does not bind the subject digest",
  );
  assert(
    Date.parse(token.genTimeISO) <= Date.parse(verification.verifiedAtISO),
    "verification receipt predates the token generation time",
  );

  return {
    subjectKind: envelope.subjectKind as AdmissionSubjectKind,
    subjectSha256: envelope.subjectSha256,
    genTimeISO: token.genTimeISO,
    policyOid: token.policyOid,
    serialNumberHex: token.serialNumberHex,
    tsaUrl: envelope.tsaUrl,
    tokenSha256: sha256Hex(tokenBytes),
    trustAnchors: {
      caCertSha256: verification.caCertSha256,
      tsaCertSha256: verification.tsaCertSha256,
    },
  };
}

/** Digest set the runner recomputes from the exact evaluated subject bytes. */
export type AdmissionSubjectDigests = Readonly<Record<AdmissionSubjectKind, string>>;

export interface AdmissionEvidence {
  records: readonly VerifiedAdmissionRecord[];
  /** Recomputed by the caller from the exact canonical bytes under evaluation. */
  subjectDigests: AdmissionSubjectDigests;
}

export interface AdmissionOrderingBoundaries {
  /** Split freeze and configuration registration must precede this instant. */
  holdoutStartISO: string;
  /**
   * Predictions, the split, and the configuration ledger must all be attested
   * before any holdout label became observable; otherwise the commitment
   * could have been written after peeking at outcomes.
   */
  earliestHoldoutLabelObservedAtISO: string | null;
  reportAsOfISO: string;
}

/**
 * Check completeness, binding, and temporal ordering of admission records.
 * Returns blocker strings; an empty array means admission holds.
 */
export function admissionBlockers(
  evidence: AdmissionEvidence | undefined,
  boundaries: AdmissionOrderingBoundaries,
): string[] {
  if (!evidence) {
    return [
      "Promotion authentication is unavailable: feature rows, market-session calendar, evaluation split, and predictions have not crossed an independently timestamped admission bridge.",
    ];
  }
  const blockers: string[] = [];
  const byKind = new Map<AdmissionSubjectKind, VerifiedAdmissionRecord[]>();
  for (const record of evidence.records) {
    const list = byKind.get(record.subjectKind) ?? [];
    list.push(record);
    byKind.set(record.subjectKind, list);
  }
  const holdoutStartMs = Date.parse(boundaries.holdoutStartISO);
  const reportMs = Date.parse(boundaries.reportAsOfISO);
  const earliestLabelMs =
    boundaries.earliestHoldoutLabelObservedAtISO == null
      ? null
      : Date.parse(boundaries.earliestHoldoutLabelObservedAtISO);

  for (const kind of REQUIRED_ADMISSION_SUBJECT_KINDS) {
    const records = byKind.get(kind) ?? [];
    if (records.length !== 1) {
      blockers.push(
        records.length === 0
          ? `Admission is missing an independently timestamped record for '${kind}'.`
          : `Admission has conflicting records for '${kind}'.`,
      );
      continue;
    }
    const record = records[0]!;
    const expectedDigest = evidence.subjectDigests[kind];
    if (!/^[0-9a-f]{64}$/.test(expectedDigest ?? "")) {
      blockers.push(`Admission subject digest for '${kind}' was not recomputed.`);
      continue;
    }
    if (record.subjectSha256 !== expectedDigest) {
      blockers.push(`Admission record for '${kind}' does not bind the evaluated bytes.`);
      continue;
    }
    const genMs = Date.parse(record.genTimeISO);
    if (!Number.isFinite(genMs) || !Number.isFinite(reportMs) || genMs > reportMs) {
      blockers.push(`Admission record for '${kind}' is timestamped after the report as-of time.`);
      continue;
    }
    if (
      (kind === "evaluation_split" || kind === "configuration_ledger") &&
      (!Number.isFinite(holdoutStartMs) || genMs >= holdoutStartMs)
    ) {
      blockers.push(`Admission record for '${kind}' was not attested strictly before the final holdout.`);
    }
    if (
      (kind === "predictions" || kind === "evaluation_split" || kind === "configuration_ledger") &&
      earliestLabelMs != null &&
      Number.isFinite(earliestLabelMs) &&
      genMs > earliestLabelMs
    ) {
      blockers.push(
        `Admission record for '${kind}' was attested after a holdout label became observable.`,
      );
    }
  }
  for (const kind of byKind.keys()) {
    if (!(REQUIRED_ADMISSION_SUBJECT_KINDS as readonly string[]).includes(kind)) {
      blockers.push(`Admission record kind '${kind}' is not recognized.`);
    }
  }
  return blockers;
}
