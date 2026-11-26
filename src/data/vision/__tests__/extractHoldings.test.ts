import { describe, it, expect } from "vitest";

import { extractHoldingsFromImage } from "@/data/vision/extractHoldings";

async function extractFromContent(content: string) {
  const originalFetch = globalThis.fetch;
  const testEnv = import.meta.env as Record<string, string | undefined>;
  const originalApiKey = testEnv.VITE_VISION_API_KEY;

  testEnv.VITE_VISION_API_KEY = "test-key";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      { status: 200 },
    );

  try {
    return await extractHoldingsFromImage("data:image/png;base64,test");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey !== undefined) {
      testEnv.VITE_VISION_API_KEY = originalApiKey;
    } else {
      delete testEnv.VITE_VISION_API_KEY;
    }
  }
}

describe("extractHoldingsFromImage number coercion", () => {
  it("coerces comma- and currency-formatted strings to numbers", async () => {
    const holdings = await extractFromContent(
      JSON.stringify([
        { ticker: "AAPL", shares: "1,875.20" },
        { ticker: "MSFT", value: "$1,875" },
        { ticker: "NVDA", value: "$1,875.20" },
      ]),
    );

    expect(holdings).toEqual([
      { ticker: "AAPL", shares: 1875.2, value: undefined },
      { ticker: "MSFT", shares: undefined, value: 1875 },
      { ticker: "NVDA", shares: undefined, value: 1875.2 },
    ]);
  });
});

describe("extractHoldingsFromImage JSON-array extraction", () => {
  it("extracts an array from a fenced JSON code block", async () => {
    const holdings = await extractFromContent(
      '```json\n[{"ticker":"aapl","shares":"2.5","value":"$500"}]\n```',
    );

    expect(holdings).toEqual([{ ticker: "AAPL", shares: 2.5, value: 500 }]);
  });

  it("extracts an array embedded in prose", async () => {
    const holdings = await extractFromContent(
      'Visible positions: [{"ticker":"msft","shares":3,"value":"1,200.50"}]. End.',
    );

    expect(holdings).toEqual([{ ticker: "MSFT", shares: 3, value: 1200.5 }]);
  });

  it.each([
    ["malformed JSON", 'Before [{"ticker":"AAPL",}] after'],
    ["an absent JSON array", "No holdings were visible in the screenshot."],
  ])("returns an empty array for %s", async (_, content) => {
    expect(await extractFromContent(content)).toEqual([]);
  });
});
