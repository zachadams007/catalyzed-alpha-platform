import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// The research agent talks to the hosted desk through `postJson`, gated by
// `researchProxyUrl`. Mock the HTTP seam so we can drive the exact proxy
// responses (and failures) the live desk produces - no network, no env coupling.
vi.mock("@/data/http", () => ({
  researchProxyUrl: vi.fn(() => "https://desk.example.dev/research"),
  isResearchProxyConfigured: vi.fn(() => true),
  postJson: vi.fn(),
}));

// `researchAgentStatus` peeks the usage gate; keep it "allowed" by default.
vi.mock("@/lib/apiUsage", () => ({
  peekApiAllowed: vi.fn(() => ({ allowed: true })),
}));

import { postJson, researchProxyUrl } from "@/data/http";
import { peekApiAllowed } from "@/lib/apiUsage";
import {
  runResearchAgent,
  researchAgentStatus,
  ResearchProxyError,
} from "@/data/ai/researchAgent";

const postJsonMock = postJson as unknown as Mock;
const proxyUrlMock = researchProxyUrl as unknown as Mock;
const peekMock = peekApiAllowed as unknown as Mock;

/**
 * A realistic `task: "deep_research"` payload from the Gemini-backed desk: the
 * headline lives in `thesis`, the evidence in `citedBull`/`citedBear`. The thin
 * lane's `summary`/`themes`/`suggestions` are absent - exactly the shape the old
 * usability gate rejected.
 */
const DESK_RESPONSE = {
  ticker: "NOW",
  model: "gemini-desk",
  thesis: "ServiceNow's platform breadth keeps net-retention durable into FY26.",
  confidence: 71,
  whatWouldFlipIt: ["A sustained drop in cRPO growth below 20%."],
  callScore: { score: 64, label: "constructive", available: true, source: "Q4'25 call" },
  asOfDate: "2026-02-01",
  filingsUsed: [{ form: "10-K", filingDate: "2026-01-29", url: "https://sec.gov/x" }],
  citedBull: [
    {
      claim: "cRPO grew 24% YoY in Q4.",
      citations: [{ source: "10-K", date: "2026-01-29", quote: "cRPO increased 24%" }],
    },
  ],
  citedBear: [
    {
      claim: "Stock trades at 55x forward earnings.",
      citations: [{ source: "Q4'25 call", date: "2026-01-29" }],
    },
  ],
};

beforeEach(() => {
  proxyUrlMock.mockReturnValue("https://desk.example.dev/research");
  peekMock.mockReturnValue({ allowed: true });
  postJsonMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runResearchAgent — desk response acceptance (root-cause regression)", () => {
  it("accepts a deep_research desk response that has thesis + cited claims but no summary", async () => {
    postJsonMock.mockResolvedValue(DESK_RESPONSE);
    const intel = await runResearchAgent({ task: "deep_research", ticker: "NOW" });
    expect(intel.ticker).toBe("NOW");
    expect(intel.thesis).toContain("net-retention");
    expect(intel.citedBull).toHaveLength(1);
    expect(intel.citedBear).toHaveLength(1);
    expect(intel.confidence).toBe(71);
  });

  it("still accepts the thin lane (summary only)", async () => {
    postJsonMock.mockResolvedValue({ ticker: "SOFI", summary: "A fintech with a bank charter." });
    const intel = await runResearchAgent({ task: "deep_research", ticker: "SOFI" });
    expect(intel.summary).toContain("bank charter");
  });

  it("accepts a confidence-only / whatWouldFlipIt-only partial read", async () => {
    postJsonMock.mockResolvedValue({
      ticker: "ACHR",
      whatWouldFlipIt: ["FAA type certification slips past 2026."],
    });
    const intel = await runResearchAgent({ task: "deep_research", ticker: "ACHR" });
    expect(intel.whatWouldFlipIt).toHaveLength(1);
  });

  it("throws an 'empty' ResearchProxyError when the desk returns nothing usable", async () => {
    postJsonMock.mockResolvedValue({ ticker: "NOW" });
    await expect(runResearchAgent({ task: "deep_research", ticker: "NOW" })).rejects.toMatchObject({
      kind: "empty",
    });
  });
});

describe("runResearchAgent — honest, classified failures (fail soft)", () => {
  it("classifies a 5xx / unreachable proxy as a friendly 'unavailable' message", async () => {
    postJsonMock.mockRejectedValue(new Error("HTTP 500"));
    const err = await runResearchAgent({ task: "deep_research", ticker: "NOW" }).catch((e) => e);
    expect(err).toBeInstanceOf(ResearchProxyError);
    expect(err.kind).toBe("unreachable");
    expect(err.message).toMatch(/unavailable/i);
  });

  it("classifies a timeout/abort distinctly", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    postJsonMock.mockRejectedValue(abort);
    const err = await runResearchAgent({ task: "deep_research", ticker: "NOW" }).catch((e) => e);
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/timed out|try again/i);
  });

  it("classifies a 429 as rate-limited", async () => {
    postJsonMock.mockRejectedValue(new Error("HTTP 429"));
    const err = await runResearchAgent({ task: "deep_research", ticker: "NOW" }).catch((e) => e);
    expect(err.kind).toBe("rate_limited");
  });

  it("classifies a 4xx as a bad-request / misconfig", async () => {
    postJsonMock.mockRejectedValue(new Error("HTTP 404"));
    const err = await runResearchAgent({ task: "deep_research", ticker: "NOW" }).catch((e) => e);
    expect(err.kind).toBe("bad_request");
  });

  it("passes a usage-gate reason through unchanged (paused/budget)", async () => {
    postJsonMock.mockRejectedValue(new Error("Live data is paused from the Operator console."));
    const err = await runResearchAgent({ task: "deep_research", ticker: "NOW" }).catch((e) => e);
    expect(err.message).toMatch(/paused/i);
  });

  it("throws an 'unconfigured' error when no proxy URL is set", async () => {
    proxyUrlMock.mockReturnValue(undefined);
    const err = await runResearchAgent({ task: "deep_research", ticker: "NOW" }).catch((e) => e);
    expect(err).toBeInstanceOf(ResearchProxyError);
    expect(err.kind).toBe("unconfigured");
    expect(postJsonMock).not.toHaveBeenCalled();
  });
});

describe("researchAgentStatus — lane reflects config + gate", () => {
  it("is 'off' with no proxy configured", () => {
    proxyUrlMock.mockReturnValue(undefined);
    expect(researchAgentStatus().lane).toBe("off");
  });

  it("is 'paused' when the gate blocks (budget/pause)", () => {
    peekMock.mockReturnValue({ allowed: false, reason: "Daily budget spent." });
    const status = researchAgentStatus();
    expect(status.lane).toBe("paused");
    expect(status.reason).toBe("Daily budget spent.");
  });

  it("is 'ready' when configured and within budget", () => {
    expect(researchAgentStatus().lane).toBe("ready");
  });
});
