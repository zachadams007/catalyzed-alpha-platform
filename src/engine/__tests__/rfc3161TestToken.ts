/**
 * Deterministic DER builder producing a structurally valid RFC 3161
 * TimeStampResp for tests. The token carries a clearly synthetic policy OID
 * and no real signature - it exercises the parser and binding logic only and
 * can never satisfy an operator's `openssl ts -verify` against real TSA
 * certificates.
 */

export const TEST_POLICY_OID = "1.3.6.1.4.1.99999.1";

const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_CT_TST_INFO = "1.2.840.113549.1.9.16.1.4";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

/** Pure base64 (no Buffer) so the browser-lib typecheck covers this helper. */
function toBase64(bytes: number[]): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: number[]): number[] {
  return [tag, ...encodeLength(content.length), ...content];
}

function derOid(oid: string): number[] {
  const parts = oid.split(".").map((part) => Number.parseInt(part, 10));
  const body: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let value = part;
    do {
      chunk.unshift(value & 0x7f);
      value >>= 7;
    } while (value > 0);
    for (let index = 0; index < chunk.length - 1; index += 1) chunk[index]! |= 0x80;
    body.push(...chunk);
  }
  return tlv(0x06, body);
}

function derInteger(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  } while (remaining > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, bytes);
}

function derOctetStringHex(hex: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return tlv(0x04, bytes);
}

function derGeneralizedTime(text: string): number[] {
  return tlv(0x18, [...text].map((char) => char.charCodeAt(0)));
}

export interface TestTokenOptions {
  hashedMessageHex: string;
  /** GeneralizedTime text, e.g. `20260301101500Z` or `20260301101500.5Z`. */
  genTime: string;
  pkiStatus?: number;
  hashAlgorithmOid?: string;
  policyOid?: string;
  serialNumber?: number;
}

/** Build a base64 DER TimeStampResp. */
export function buildTimeStampResp(options: TestTokenOptions): string {
  const status = options.pkiStatus ?? 0;
  const statusInfo = tlv(0x30, derInteger(status));
  if (status !== 0 && status !== 1) {
    return toBase64(tlv(0x30, statusInfo));
  }

  const messageImprint = tlv(0x30, [
    ...tlv(0x30, [...derOid(options.hashAlgorithmOid ?? OID_SHA256), ...tlv(0x05, [])]),
    ...derOctetStringHex(options.hashedMessageHex),
  ]);
  const tstInfo = tlv(0x30, [
    ...derInteger(1),
    ...derOid(options.policyOid ?? TEST_POLICY_OID),
    ...messageImprint,
    ...derInteger(options.serialNumber ?? 4919),
    ...derGeneralizedTime(options.genTime),
  ]);
  const encapContentInfo = tlv(0x30, [
    ...derOid(OID_CT_TST_INFO),
    ...tlv(0xa0, tlv(0x04, tstInfo)),
  ]);
  const signedData = tlv(0x30, [
    ...derInteger(3),
    ...tlv(0x31, []), // digestAlgorithms SET (empty; parser does not require entries)
    ...encapContentInfo,
    ...tlv(0x31, []), // signerInfos SET (synthetic token carries no real signature)
  ]);
  const contentInfo = tlv(0x30, [...derOid(OID_SIGNED_DATA), ...tlv(0xa0, signedData)]);
  const response = tlv(0x30, [...statusInfo, ...contentInfo]);
  return toBase64(response);
}
