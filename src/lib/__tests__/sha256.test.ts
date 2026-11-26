import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/sha256";

/** Independent reference digest via WebCrypto (browser-lib typed, Node ≥18). */
async function webCryptoSha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("sha256Hex — FIPS 180-4 vectors and WebCrypto parity", () => {
  it("matches the published empty-string vector", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the published 'abc' vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches WebCrypto on multi-block UTF-8 payloads including boundary lengths", async () => {
    const samples = [
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(65),
      "a".repeat(1000),
      JSON.stringify({ nested: { unicode: "évidence – 点在时间", n: 42 } }),
    ];
    for (const sample of samples) {
      expect(sha256Hex(sample)).toBe(await webCryptoSha256Hex(sample));
    }
  });

  it("hashes raw bytes identically to WebCrypto", async () => {
    const bytes = new Uint8Array(300).map((_, index) => (index * 7 + 3) % 256);
    expect(sha256Hex(bytes)).toBe(await webCryptoSha256Hex(bytes));
  });
});
