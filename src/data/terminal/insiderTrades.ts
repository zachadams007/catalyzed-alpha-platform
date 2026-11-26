import { httpJson, nextFmpKey } from "@/data/http";
import type { TerminalEvent } from "@/types/terminal";
import { classifyTradeSeverity } from "./severity";

/**
 * Market-wide insider transactions (SEC Form 4) via Financial Modeling Prep's
 * current `stable` API:
 *   https://financialmodelingprep.com/stable/insider-trading/latest?page=0
 *
 * (The old `v4/insider-trading` path is now a dead "legacy endpoint" for keys
 * issued after Aug 2025, so it was migrated here.) This is the lightweight path
 * that needs no per-filing XML parsing and reuses the FMP key already configured.
 * It degrades to [] on any error; the richer, fully-parsed feed comes from the
 * Python deep-miner cache instead (see docs/bloomberg-terminal.md).
 *
 * We emphasize *purchases* - open-market insider BUYING is the signal - but also
 * surface large sales. Awards/grants and tax withholding are filtered out as noise.
 */

const FMP_STABLE = "https://financialmodelingprep.com/stable";

interface FmpInsiderRow {
  symbol?: string;
  filingDate?: string;
  transactionDate?: string;
  reportingName?: string;
  typeOfOwner?: string;
  transactionType?: string; // e.g. "P-Purchase", "S-Sale", "A-Award"
  acquisitionOrDisposition?: string; // "A" | "D"
  securitiesTransacted?: number;
  price?: number;
  securityName?: string;
  link?: string;
  url?: string; // stable API uses `url`; v4 used `link`
  formType?: string;
}

function safeIso(input?: string): string {
  if (!input) return new Date().toISOString();
  const ms = new Date(input).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

/** Map FMP's transaction codes to a buy/sell direction, or null to drop. */
function directionOf(row: FmpInsiderRow): "buy" | "sell" | null {
  const t = (row.transactionType ?? "").toUpperCase();
  // P = open-market/private purchase, S = sale. Prefer the explicit code.
  if (t.startsWith("P")) return "buy";
  if (t.startsWith("S")) return "sell";
  // Fall back to acquisition/disposition only for purchase/sale-like rows.
  const ad = (row.acquisitionOrDisposition ?? "").toUpperCase();
  if (ad === "A" && t.startsWith("P")) return "buy";
  if (ad === "D" && t.startsWith("S")) return "sell";
  return null; // awards (A-Award), gifts, tax (F), exercises (M) → noise
}

export async function fetchInsiderTrades(pages = 1): Promise<TerminalEvent[]> {
  const key = nextFmpKey();
  if (!key) return [];

  const batches = await Promise.all(
    Array.from({ length: Math.max(1, pages) }, (_, page) =>
      httpJson<FmpInsiderRow[]>(
        `${FMP_STABLE}/insider-trading/latest?page=${page}&apikey=${encodeURIComponent(key)}`,
        { timeoutMs: 12_000 },
      ).catch(() => [] as FmpInsiderRow[]),
    ),
  );

  // FMP returns an array on success; guard against an error object slipping through.
  const rows = batches.flat().filter((r): r is FmpInsiderRow => Boolean(r) && typeof r === "object");

  const out: TerminalEvent[] = [];
  for (const row of rows) {
    if (!row.symbol) continue;
    const direction = directionOf(row);
    if (!direction) continue;

    const shares = Number(row.securitiesTransacted) || 0;
    const price = Number(row.price) || 0;
    const valueUsd = shares > 0 && price > 0 ? shares * price : undefined;
    const { severity, reason } = classifyTradeSeverity(direction, valueUsd);

    const ticker = row.symbol.toUpperCase();
    const occurredAt = safeIso(row.transactionDate);
    out.push({
      id: `insider-${ticker}-${row.reportingName ?? "?"}-${row.transactionDate ?? row.filingDate}-${shares}`,
      kind: direction === "buy" ? "insider_buy" : "insider_sell",
      severity,
      ticker,
      headline:
        `${row.reportingName ?? "Insider"} ${direction === "buy" ? "bought" : "sold"} ` +
        `${shares.toLocaleString("en-US")} ${ticker} shares`,
      actor: { name: row.reportingName ?? "Insider", role: row.typeOfOwner || undefined },
      trade: {
        direction,
        valueUsd,
        shares: shares || undefined,
        pricePerShare: price || undefined,
        code: row.transactionType || undefined,
      },
      occurredAt,
      surfacedAt: safeIso(row.filingDate),
      source: {
        name: "SEC Form 4 · FMP",
        url:
          row.url ||
          row.link ||
          `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${ticker}&type=4`,
      },
      reason,
    });
  }
  return out;
}
