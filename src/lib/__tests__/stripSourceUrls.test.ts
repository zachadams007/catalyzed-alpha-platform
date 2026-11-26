import { describe, it, expect } from "vitest";
import { stripSourceUrls } from "@/lib/format";

describe("stripSourceUrls", () => {
  it("removes the appended grounding-redirect Source clause", () => {
    const polluted =
      "Daktronics (DAKT) designs and manufactures large-screen video displays. " +
      "This positive earnings surprise is driving the upside case. " +
      "Source: https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZfVQG6nCaF4JQG78S36MzpiqMMqU-imvOgMOsgy7Z4m5vHEj4w2KDCx9Papx5F7YE9hd7D63YHeYLuUJNQ1pdIkiEy-a9cOnFUop2sQsQ3x4pYhD-QR6NgdIhNCXxsTxpdhfWLOmUrz8jXHzSVAqkYyc7RyDnIsFi62J-1y8Qp95esN3zdOP4=";
    const clean = stripSourceUrls(polluted);
    expect(clean).not.toContain("http");
    expect(clean).not.toContain("vertexaisearch");
    expect(clean).toMatch(/driving the upside case\.$/);
  });

  it("removes a parenthesised source and a bare inline URL", () => {
    expect(stripSourceUrls("Beat on revenue (Source: https://x.com/a/b).")).toBe("Beat on revenue.");
    expect(stripSourceUrls("See https://reuters.com/x for detail.")).toBe("See for detail.");
  });

  it("leaves clean prose untouched and handles empties", () => {
    expect(stripSourceUrls("A clean thesis with no links.")).toBe("A clean thesis with no links.");
    expect(stripSourceUrls("")).toBe("");
    expect(stripSourceUrls(null)).toBe("");
    expect(stripSourceUrls(undefined)).toBe("");
  });
});
