import { finnhubKey, httpJson } from "@/data/http";

const FINNHUB = "https://finnhub.io/api/v1";

export type FinnhubVerifyStatus = "ok" | "missing_key" | "invalid_key" | "error";

export interface FinnhubVerifyResult {
  status: FinnhubVerifyStatus;
  detail?: string;
  /** Sample quote used for the health check. */
  sampleSymbol?: string;
  samplePrice?: number;
}

/** Call Finnhub with the configured key - key present ≠ API accepting requests. */
export async function verifyFinnhub(): Promise<FinnhubVerifyResult> {
  const key = finnhubKey();
  if (!key) return { status: "missing_key" };

  try {
    const quote = await httpJson<{ c?: number }>(
      `${FINNHUB}/quote?symbol=AAPL&token=${encodeURIComponent(key)}`,
    );
    if (quote.c && quote.c > 0) {
      return { status: "ok", sampleSymbol: "AAPL", samplePrice: quote.c };
    }
    return { status: "invalid_key", detail: "Quote endpoint returned no price." };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (detail.includes("401") || detail.includes("403")) {
      return { status: "invalid_key", detail };
    }
    return { status: "error", detail };
  }
}
