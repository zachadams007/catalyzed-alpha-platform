/**
 * Extract stock holdings from one or more screenshots of a brokerage portfolio
 * (e.g. Wealthsimple, Robinhood) using a vision-capable, OpenAI-compatible chat
 * endpoint.
 *
 * Config (all VITE_ env, never hardcode a key):
 *   VITE_VISION_API_KEY - required to enable the feature.
 *   VITE_VISION_BASE_URL - default https://api.groq.com/openai/v1
 *   VITE_VISION_MODEL - default qwen/qwen3.8-27b
 *
 * MODEL CHOICE (2026-09-03): the previous default,
 * `meta-llama/llama-4-scout-17b-16e-instruct`, was DECOMMISSIONED by Groq -
 * every request returned HTTP 404 `model_not_found`, which accounted for 100%
 * of this app's Groq failures (11 of 11 calls). Groq no longer serves any
 * Llama-4 vision model; `qwen/qwen3.8-27b` is the current vision-capable model
 * on the free tier and is verified to transcribe a screenshot correctly. If
 * Groq rotates models again, override VITE_VISION_MODEL rather than editing
 * this. OpenRouter free vision models work too - point BASE_URL/MODEL at them.
 * With no key the caller falls back to manual entry.
 */

import { recordApiCall } from "@/lib/apiUsage";

export interface ExtractedHolding {
  ticker: string;
  /** Quantity of shares, when visible. */
  shares?: number;
  /** Market value of the position in USD, when visible (drives weighting). */
  value?: number;
}

function env(key: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)[key]?.trim() || undefined;
}

export function visionApiKey(): string | undefined {
  return env("VITE_VISION_API_KEY");
}

export function isVisionConfigured(): boolean {
  return Boolean(visionApiKey());
}

function baseUrl(): string {
  return env("VITE_VISION_BASE_URL") ?? "https://api.groq.com/openai/v1";
}

function model(): string {
  return env("VITE_VISION_MODEL") ?? "qwen/qwen3.8-27b";
}

const PROMPT =
  "You are reading a screenshot of a stock brokerage portfolio (e.g. Wealthsimple, Robinhood). " +
  "Extract every individual stock or ETF position you can see. " +
  'Return ONLY a compact JSON array, each element {"ticker":"AAPL","shares":10.5,"value":1875.20}. ' +
  "Use the US exchange ticker symbol in uppercase. " +
  "The `value` field is the position's current market/total dollar value as shown (NOT the share price) — " +
  "include it whenever a dollar amount for the holding is visible, as a plain number with no $ or commas. " +
  "Omit `shares` if the quantity isn't visible, and omit `value` if no dollar amount is visible. " +
  "Do not include cash balances, account totals, account names, or any prose. " +
  "No markdown, no code fences — just the JSON array.";

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

async function postVision(dataUrl: string, timeoutMs = 45_000): Promise<string> {
  const url = `${baseUrl()}/chat/completions`;
  const body = JSON.stringify({
    model: model(),
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${visionApiKey()}`,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Record exactly one settled call against the "vision" lane so the operator
  // data-source board shows real usage (vendorOf() buckets api.groq.com - and
  // any configured VITE_VISION_BASE_URL host - to "vision"). This client makes
  // its OWN fetch (not via src/data/http.ts), so it must self-report; recording
  // is fire-and-forget and never throws into this path.
  let ok = false;
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    const doFetch = isTauri()
      ? (await import("@tauri-apps/plugin-http")).fetch
      : fetch;
    const res = await doFetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) throw new Error(`Vision HTTP ${res.status}`);
    const text = await res.text();
    ok = true;
    return text;
  } finally {
    clearTimeout(timer);
    recordApiCall(url, ok);
  }
}

/** Coerce a model-provided number that may arrive as "1,875.20" or "$1,875". */
function toNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  if (typeof raw === "string") {
    const n = Number(raw.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/** Pull the first JSON array out of a model response that may include fences/prose. */
function parseHoldings(content: string): ExtractedHolding[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ExtractedHolding[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const ticker = typeof obj.ticker === "string" ? obj.ticker.trim().toUpperCase() : "";
    if (!ticker || !/^[A-Z.\-]{1,6}$/.test(ticker)) continue;
    out.push({ ticker, shares: toNumber(obj.shares), value: toNumber(obj.value) });
  }
  // De-dupe by ticker, keeping the first occurrence (within a single image).
  const seen = new Set<string>();
  return out.filter((h) => (seen.has(h.ticker) ? false : (seen.add(h.ticker), true)));
}

/** Merge holdings across several screenshots: same ticker → sum shares & values. */
function mergeHoldings(batches: ExtractedHolding[][]): ExtractedHolding[] {
  const byTicker = new Map<string, ExtractedHolding>();
  for (const batch of batches) {
    for (const h of batch) {
      const existing = byTicker.get(h.ticker);
      if (!existing) {
        byTicker.set(h.ticker, { ...h });
        continue;
      }
      if (h.shares != null) existing.shares = (existing.shares ?? 0) + h.shares;
      if (h.value != null) existing.value = (existing.value ?? 0) + h.value;
    }
  }
  return [...byTicker.values()];
}

export async function extractHoldingsFromImage(dataUrl: string): Promise<ExtractedHolding[]> {
  if (!isVisionConfigured()) {
    throw new Error("Vision not configured (set VITE_VISION_API_KEY).");
  }
  const text = await postVision(dataUrl);
  const json = JSON.parse(text) as ChatResponse;
  const content = json.choices?.[0]?.message?.content ?? "";
  return parseHoldings(content);
}

export interface MultiExtractResult {
  holdings: ExtractedHolding[];
  /** Per-image outcome so the UI can flag a screenshot that read nothing. */
  perImage: { index: number; count: number; error?: string }[];
}

/**
 * Extract from multiple screenshots and merge. Images are read sequentially to
 * stay within free-tier rate limits; a failure on one image doesn't abort the
 * rest - it's reported in `perImage`.
 */
export async function extractHoldingsFromImages(
  dataUrls: string[],
): Promise<MultiExtractResult> {
  if (!isVisionConfigured()) {
    throw new Error("Vision not configured (set VITE_VISION_API_KEY).");
  }
  const batches: ExtractedHolding[][] = [];
  const perImage: MultiExtractResult["perImage"] = [];
  for (let i = 0; i < dataUrls.length; i++) {
    try {
      const holdings = await extractHoldingsFromImage(dataUrls[i]);
      batches.push(holdings);
      perImage.push({ index: i, count: holdings.length });
    } catch (e) {
      perImage.push({ index: i, count: 0, error: e instanceof Error ? e.message : "Failed" });
    }
  }
  return { holdings: mergeHoldings(batches), perImage };
}
