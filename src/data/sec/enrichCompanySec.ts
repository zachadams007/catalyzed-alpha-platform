import type { CompanyData, SecActivity } from "@/types";
import { pooledMap } from "@/lib/concurrency";
import { fetchSecActivity } from "@/data/sec/secFilings";

/**
 * Fold real SEC EDGAR activity into a company record: attach the raw
 * `secActivity` (for the card / detail view) and annotate the summary with
 * insider (Form 4) and material-event (8-K) counts. Keeps the modeled baseline
 * when a ticker has no recent filings (or no CIK).
 */

function summarize(a: SecActivity): string {
  const parts: string[] = [];
  if (a.form4Count90d > 0) parts.push(`${a.form4Count90d} insider filing${a.form4Count90d === 1 ? "" : "s"}`);
  if (a.eightKCount90d > 0) parts.push(`${a.eightKCount90d} 8-K${a.eightKCount90d === 1 ? "" : "s"}`);
  return `SEC 90d: ${parts.join(", ")}`;
}

export function applySecToCompany(company: CompanyData, activity: SecActivity | null): CompanyData {
  if (!activity) return company;

  const note = summarize(activity);
  const base = company.social.summary?.trim();

  return {
    ...company,
    secActivity: activity,
    social: {
      ...company.social,
      summary: base ? `${base} · ${note}` : note,
    },
  };
}

export interface SecEnrichProgress {
  done: number;
  total: number;
  ticker?: string;
}

/**
 * Attach SEC filing activity across the universe. The first lookup triggers the
 * one-time ticker->CIK map load; each company then costs one submissions fetch,
 * so we keep concurrency low to respect SEC's fair-access policy.
 */
export async function enrichUniverseWithSec(
  companies: CompanyData[],
  onProgress?: (p: SecEnrichProgress) => void,
): Promise<CompanyData[]> {
  return pooledMap(
    companies,
    4,
    async (company) => {
      try {
        const activity = await fetchSecActivity(company.ticker);
        return applySecToCompany(company, activity);
      } catch {
        return company;
      }
    },
    (done, total) => onProgress?.({ done, total }),
  );
}
